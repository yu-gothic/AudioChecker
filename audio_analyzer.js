class AudioAnalyzer {
  constructor(onPitch, options = {}) {
    this.onPitch = onPitch;
    this.audioCtx = null;
    this.analyser = null;
    this.stream = null;
    this.running = false;

    // ノイズ除去まわりの調整パラメータ
    this.rmsThreshold = options.rmsThreshold ?? 0.015;     // この音量未満は無音扱い
    this.clarityThreshold = options.clarityThreshold ?? 0.9; // ピッチの明瞭度の下限（0〜1）
    this.smoothing = options.smoothing ?? 5;                // メディアンフィルタのフレーム数

    this._history = [];
  }

  async start() {
    // ブラウザ標準のノイズ抑制・エコー除去を有効化（autoGainControlは音量変化を避けるためオフ）
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: false
      },
      video: false
    });
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;

    const source = this.audioCtx.createMediaStreamSource(this.stream);

    // 低周波のハム・暗騒音を落とすハイパスフィルタ
    const highpass = this.audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 70;

    source.connect(highpass);
    highpass.connect(this.analyser);

    this.running = true;
    this._history = [];
    this._buffer = new Float32Array(this.analyser.fftSize);
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.audioCtx) this.audioCtx.close();
  }

  _loop() {
    if (!this.running) return;
    this.analyser.getFloatTimeDomainData(this._buffer);
    const raw = this._detectPitch(this._buffer, this.audioCtx.sampleRate);
    const freq = this._smooth(raw);
    this.onPitch(freq);
    requestAnimationFrame(() => this._loop());
  }

  // 直近フレームのメディアンを取り、単発の誤検出（スパイク）を除去する
  _smooth(freq) {
    this._history.push(freq);
    if (this._history.length > this.smoothing) this._history.shift();

    // 有効値（無音=-1 以外）が過半数なければ無音とみなす
    const valid = this._history.filter(f => f > 0).sort((a, b) => a - b);
    if (valid.length <= this._history.length / 2) return -1;

    return valid[Math.floor(valid.length / 2)];
  }

  _detectPitch(buffer, sampleRate) {
    const SIZE = buffer.length;

    // 音量（RMS）チェック：小さすぎる入力は無音扱い
    let energy = 0;
    for (let i = 0; i < SIZE; i++) energy += buffer[i] * buffer[i];
    const rms = Math.sqrt(energy / SIZE);
    if (rms < this.rmsThreshold) return -1;

    // 検出対象の周波数範囲（80Hz〜1200Hz）をラグ幅に変換
    const MIN_LAG = Math.floor(sampleRate / 1200);
    const MAX_LAG = Math.min(Math.floor(sampleRate / 80), SIZE - 1);

    // 自己相関法でピッチ検出
    let maxCorr = 0;
    let bestLag = -1;

    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let corr = 0;
      const len = SIZE - lag;
      for (let i = 0; i < len; i++) {
        corr += buffer[i] * buffer[i + lag];
      }
      if (corr > maxCorr) {
        maxCorr = corr;
        bestLag = lag;
      }
    }

    if (bestLag === -1) return -1;

    // 明瞭度（clarity）チェック：ピッチがはっきりした音だけ採用する。
    // energy（=ラグ0の自己相関）でピーク値を正規化すると 0〜1 の指標になる。
    // 雑音や複数音が混ざると値が下がるので、閾値未満は無音扱い＝ノイズ除去になる。
    const clarity = maxCorr / energy;
    if (clarity < this.clarityThreshold) return -1;

    // 放物線補間で精度向上
    const c0 = bestLag > 0 ? this._corrAt(buffer, SIZE, bestLag - 1) : 0;
    const c1 = maxCorr;
    const c2 = bestLag < MAX_LAG ? this._corrAt(buffer, SIZE, bestLag + 1) : 0;
    const denom = 2 * (2 * c1 - c0 - c2);
    const period = denom !== 0 ? bestLag + (c2 - c0) / denom : bestLag;

    return sampleRate / period;
  }

  _corrAt(buffer, size, lag) {
    let sum = 0;
    const len = size - lag;
    for (let i = 0; i < len; i++) sum += buffer[i] * buffer[i + lag];
    return sum;
  }
}
