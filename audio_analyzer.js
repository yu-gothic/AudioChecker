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

  // McLeod Pitch Method (MPM) でピッチを検出する。
  // 生の自己相関ではなく NSDF（正規化二乗差関数）を使うことで、
  // 振幅に依存せず 0〜1 に正規化された安定したピークが得られ、精度が上がる。
  _detectPitch(buffer, sampleRate) {
    const SIZE = buffer.length;

    // 小さい音を無視：RMS（音量）がしきい値未満なら無音扱い
    let power = 0;
    for (let i = 0; i < SIZE; i++) power += buffer[i] * buffer[i];
    const rms = Math.sqrt(power / SIZE);
    if (rms < this.rmsThreshold) return -1;

    // 検出対象の周波数範囲をラグ幅に変換
    const MIN_LAG = Math.floor(sampleRate / this.maxFreq);
    const MAX_LAG = Math.min(Math.floor(sampleRate / this.minFreq), SIZE - 1);

    // NSDF を計算する。
    //   nsdf(tau) = 2 * Σ x[i]x[i+tau]  /  Σ (x[i]^2 + x[i+tau]^2)
    // 分母で正規化するため、値は -1〜1 に収まり、ピッチの明瞭度がそのまま高さに出る。
    const nsdf = new Float32Array(MAX_LAG + 1);
    for (let tau = MIN_LAG; tau <= MAX_LAG; tau++) {
      let acf = 0;
      let denom = 0;
      const len = SIZE - tau;
      for (let i = 0; i < len; i++) {
        const a = buffer[i];
        const b = buffer[i + tau];
        acf += a * b;
        denom += a * a + b * b;
      }
      nsdf[tau] = denom > 0 ? (2 * acf) / denom : 0;
    }

    // キー極大（key maxima）を集める：NSDF が正の各区間ごとに、その区間の最大値を1つ拾う。
    const maxima = [];
    let tau = MIN_LAG;
    while (tau < MAX_LAG && nsdf[tau] > 0) tau++;   // 最初の正の山（tau≈0側の自明なピーク）を飛ばす
    while (tau < MAX_LAG) {
      if (nsdf[tau] > 0) {
        let localMax = tau;
        while (tau < MAX_LAG && nsdf[tau] > 0) {
          if (nsdf[tau] > nsdf[localMax]) localMax = tau;
          tau++;
        }
        maxima.push(localMax);
      } else {
        tau++;
      }
    }
    if (maxima.length === 0) return -1;

    // オクターブエラー対策：最大の極大の一定割合を超える「最初の」極大を採用する。
    // これで基本周期（より短いラグ）が優先され、1オクターブ下への誤検出を防ぐ。
    let highest = 0;
    for (const t of maxima) if (nsdf[t] > highest) highest = nsdf[t];
    const threshold = highest * 0.9;
    let bestTau = maxima[0];
    for (const t of maxima) {
      if (nsdf[t] >= threshold) { bestTau = t; break; }
    }

    // 放物線補間で tau をサブサンプル精度に高める
    const x0 = bestTau > MIN_LAG ? nsdf[bestTau - 1] : nsdf[bestTau];
    const x1 = nsdf[bestTau];
    const x2 = bestTau < MAX_LAG ? nsdf[bestTau + 1] : nsdf[bestTau];
    const a = (x0 + x2 - 2 * x1) / 2;
    const b = (x2 - x0) / 2;
    const period = a !== 0 ? bestTau - b / (2 * a) : bestTau;

    return sampleRate / period;
  }
}
