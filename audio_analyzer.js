class AudioAnalyzer {
  constructor(onPitch, options = {}) {
    this.onPitch = onPitch;
    this.audioCtx = null;
    this.analyser = null;
    this.stream = null;
    this.running = false;

    // 小さい音を無視するしきい値（この音量未満は無音扱い）＝唯一のノイズ対策
    this.rmsThreshold = options.rmsThreshold ?? 0.015;
    this.smoothing = options.smoothing ?? 5;   // メディアンフィルタのフレーム数（表示の安定化）

    this.monitor = options.monitor ?? false;   // マイク入力をスピーカーで再生するか
    this.monitorGain = null;

    this.minFreq = options.minFreq ?? 50;      // 検出する最低周波数
    this.maxFreq = options.maxFreq ?? 4500;    // 検出する最高周波数

    this._history = [];
  }

  async start() {
    // ブラウザ側のノイズ抑制・エコー除去は使わない。
    // autoGainControl だけはオフ（自動音量調整で小さい音が持ち上がると「無視」が効かないため）。
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: false },
      video: false
    });
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;

    const source = this.audioCtx.createMediaStreamSource(this.stream);
    source.connect(this.analyser);

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

    // 小さい音を無視：RMS（音量）がしきい値未満なら無音扱い
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
