class AudioAnalyzer {
  constructor(onPitch) {
    this.onPitch = onPitch;
    this.audioCtx = null;
    this.analyser = null;
    this.stream = null;
    this.running = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    source.connect(this.analyser);
    this.running = true;
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
    const freq = this._detectPitch(this._buffer, this.audioCtx.sampleRate);
    this.onPitch(freq);
    requestAnimationFrame(() => this._loop());
  }

  _detectPitch(buffer, sampleRate) {
    const SIZE = buffer.length;

    // 無音チェック
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1;

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
