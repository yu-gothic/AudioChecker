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

    this.monitor = options.monitor ?? false;               // マイク入力をスピーカーで再生するか
    this.monitorGain = null;

    this.noiseSuppression = options.noiseSuppression ?? true; // ブラウザ標準のノイズ抑制を使うか
    this.track = null;

    this.minFreq = options.minFreq ?? 70;     // 検出する最低周波数
    this.maxFreq = options.maxFreq ?? 1500;   // 検出する最高周波数

    this._history = [];
  }

  async start() {
    // ブラウザ標準のノイズ抑制・エコー除去（autoGainControlは音量変化を避けるためオフ）。
    // noiseSuppression は後から applyConstraints で切り替えられるようにする。
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        noiseSuppression: this.noiseSuppression,
        echoCancellation: this.noiseSuppression,
        autoGainControl: false
      },
      video: false
    });
    this.track = this.stream.getAudioTracks()[0];
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

    // モニター経路：マイク入力をそのままスピーカーへ。
    // ゲインを0/1で切り替えることでオン・オフする（接続し直しより滑らか）。
    this.monitorGain = this.audioCtx.createGain();
    this.monitorGain.gain.value = this.monitor ? 1 : 0;
    source.connect(this.monitorGain);
    this.monitorGain.connect(this.audioCtx.destination);

    this.running = true;
    this._history = [];
    this._buffer = new Float32Array(this.analyser.fftSize);
    this._loop();
  }

  // モニター（スピーカー再生）のオン・オフを切り替える
  setMonitor(on) {
    this.monitor = on;
    if (this.monitorGain) this.monitorGain.gain.value = on ? 1 : 0;
  }

  // ブラウザ標準のノイズ抑制を計測中でも切り替える（applyConstraintsで再取得なしに反映）
  setNoiseSuppression(on) {
    this.noiseSuppression = on;
    if (this.track && this.track.applyConstraints) {
      this.track.applyConstraints({
        noiseSuppression: on,
        echoCancellation: on,
        autoGainControl: false
      }).catch(() => {});
    }
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

    // 検出対象の周波数範囲をラグ幅に変換
    const MIN_LAG = Math.floor(sampleRate / this.maxFreq);
    const MAX_LAG = Math.min(Math.floor(sampleRate / this.minFreq), SIZE - 1);

    // 各ラグの自己相関をまとめて計算しておく
    const corr = new Float32Array(MAX_LAG + 1);
    let maxCorr = 0;
    let maxLag = MIN_LAG;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let sum = 0;
      const len = SIZE - lag;
      for (let i = 0; i < len; i++) sum += buffer[i] * buffer[i + lag];
      corr[lag] = sum;
      if (sum > maxCorr) {
        maxCorr = sum;
        maxLag = lag;
      }
    }

    if (maxCorr <= 0) return -1;

    // 明瞭度（clarity）チェック：ピッチがはっきりした音だけ採用する。
    // energy（=ラグ0の自己相関）でピーク値を正規化すると 0〜1 の指標になる。
    const clarity = maxCorr / energy;
    if (clarity < this.clarityThreshold) return -1;

    // オクターブエラー対策：最大ピークの一定割合を超える「最初の」ピークを選ぶ。
    // こうすると、2倍周期（＝1オクターブ下）の強い相関より、基本周期（より短いラグ）を
    // 優先して拾えるため、高音が半分の周波数に落ちる誤検出を抑えられる。
    const threshold = maxCorr * 0.9;
    let bestLag = maxLag;
    for (let lag = MIN_LAG + 1; lag < MAX_LAG; lag++) {
      if (corr[lag] > threshold && corr[lag] > corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
        bestLag = lag;
        break;
      }
    }

    // 放物線補間で精度向上
    const c0 = bestLag > MIN_LAG ? corr[bestLag - 1] : corr[bestLag];
    const c1 = corr[bestLag];
    const c2 = bestLag < MAX_LAG ? corr[bestLag + 1] : corr[bestLag];
    const denom = 2 * (2 * c1 - c0 - c2);
    const period = denom !== 0 ? bestLag + (c2 - c0) / denom : bestLag;

    return sampleRate / period;
  }
}
