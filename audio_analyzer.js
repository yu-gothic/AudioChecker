let audioCtx, analyser, source, stream, noiseGate;
let animId, isRecording = false;
let ncEnabled = false, ncThreshold = 20;

const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんあいうえおかきくけこさしすせそ'.split('').slice(0, 50);
const FREQ_MIN = 160, FREQ_MAX = 1300;

function freqToKana(hz) {
  if (hz < FREQ_MIN || hz > FREQ_MAX) return '—';
  const step = (FREQ_MAX - FREQ_MIN) / 49;
  const idx = Math.round((hz - FREQ_MIN) / step);
  return KANA[Math.min(Math.max(idx, 0), 49)];
}

function toggleNC() {
  ncEnabled = document.getElementById('nc-toggle').checked;
  if (analyser) applyNC();
}

function updateThresh(v) {
  ncThreshold = +v;
  document.getElementById('noise-level').textContent = v;
}

function applyNC() {
  if (!audioCtx) return;
  if (ncEnabled) {
    noiseGate = audioCtx.createDynamicsCompressor();
    noiseGate.threshold.value = -90 + ncThreshold;
    noiseGate.knee.value = 0;
    noiseGate.ratio.value = 20;
    noiseGate.attack.value = 0.005;
    noiseGate.release.value = 0.1;
    source.disconnect();
    source.connect(noiseGate);
    noiseGate.connect(analyser);
  } else {
    source.disconnect();
    if (noiseGate) { noiseGate.disconnect(); noiseGate = null; }
    source.connect(analyser);
  }
}

function getPeak(freq, bufLen, sr) {
  let max = 0, idx = 0;
  for (let i = 1; i < bufLen; i++) if (freq[i] > max) { max = freq[i]; idx = i; }
  return Math.round(idx * sr / (2 * bufLen));
}

function getRMS(time) {
  let s = 0;
  for (let i = 0; i < time.length; i++) { const v = (time[i]-128)/128; s += v*v; }
  return Math.round(Math.sqrt(s/time.length)*100);
}

function loop() {
  const bufLen = analyser.frequencyBinCount;
  const freq = new Uint8Array(bufLen);
  const time = new Uint8Array(bufLen);
  analyser.getByteFrequencyData(freq);
  analyser.getByteTimeDomainData(time);
  const peak = getPeak(freq, bufLen, audioCtx.sampleRate);
  const maxV = Math.max(...freq);
  const db = maxV === 0 ? '—' : Math.round(20*Math.log10(maxV/255));
  document.getElementById('big-display').textContent = peak;
  document.getElementById('big-kana').textContent = freqToKana(peak);
  document.getElementById('db').textContent = db;
  document.getElementById('rms').textContent = getRMS(time);
  animId = requestAnimationFrame(loop);
}

async function toggleRecording() {
  const btn = document.getElementById('btn-start');
  if (!isRecording) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      source = audioCtx.createMediaStreamSource(stream);
      applyNC();
      isRecording = true;
      btn.textContent = 'STOP';
      btn.classList.add('active');
      loop();
    } catch(e) {
      btn.textContent = 'MIC ERROR';
    }
  } else {
    cancelAnimationFrame(animId);
    stream.getTracks().forEach(t => t.stop());
    audioCtx.close();
    analyser = source = noiseGate = null;
    isRecording = false;
    btn.textContent = 'START';
    btn.classList.remove('active');
    document.getElementById('big-display').textContent = '—';
    document.getElementById('big-kana').textContent = '—';
    ['db','rms'].forEach(id => document.getElementById(id).textContent = '—');
  }
}