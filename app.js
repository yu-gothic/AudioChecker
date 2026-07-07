const imgEl  = document.getElementById('pitch-image');
const hzEl   = document.getElementById('hz-readout');
const btn    = document.getElementById('start-btn');
const status = document.getElementById('status');

const MIN_FREQ = 50;
const MAX_FREQ = 4500;
// 音高の知覚は対数的（オクターブ＝周波数比）なので、対数でマッピングする。
// これで低域が広がり、高域ほど画像の上昇幅が抑えられる。
const LOG_MIN = Math.log(MIN_FREQ);
const LOG_MAX = Math.log(MAX_FREQ);

// 音の低い順 → 高い順に並べた画像ファイル名（0.jpg=低音/深い, 25.jpg=高音/高い）
const IMAGE_FILES = [];
for (let i = 0; i <= 25; i++) IMAGE_FILES.push(`${i}.jpg`);

// プリロードしておき、表示時のちらつきを防ぐ
const preloaded = IMAGE_FILES.map(name => {
  const im = new Image();
  im.src = 'images/' + name;
  return im;
});

let analyzer    = null;
let running     = false;
let currentIdx  = -1;

// 調整可能なパラメータ（スライダーと連動）
// ノイズ対策は「小さい音を無視する（音量しきい値）」のみ。
const settings = {
  rmsThreshold: 0.003,
  smoothing: 5
};

// スライダー1つを settings の1キーに結びつける
function bindSlider(rangeId, valId, key, decimals) {
  const range = document.getElementById(rangeId);
  const valEl = document.getElementById(valId);
  range.value = settings[key];
  valEl.textContent = Number(settings[key]).toFixed(decimals);
  range.addEventListener('input', () => {
    const v = Number(range.value);
    settings[key] = v;
    valEl.textContent = v.toFixed(decimals);
    // 計測中なら即座に反映
    if (analyzer) analyzer[key] = v;
  });
}

bindSlider('rms-range', 'rms-val', 'rmsThreshold', 3);
bindSlider('smoothing-range', 'smoothing-val', 'smoothing', 0);

document.getElementById('settings-toggle').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  panel.hidden = !panel.hidden;
});

function updateVisual(freq) {
  if (freq < 0) {
    imgEl.classList.remove('visible');
    hzEl.textContent = '-- Hz';
    return;
  }
  hzEl.textContent = Math.round(freq) + ' Hz';
  const t   = Math.max(0, Math.min(1, (Math.log(freq) - LOG_MIN) / (LOG_MAX - LOG_MIN)));
  const idx = Math.min(IMAGE_FILES.length - 1, Math.floor(t * IMAGE_FILES.length));
  if (idx !== currentIdx) {
    currentIdx = idx;
    imgEl.src  = preloaded[idx].src;
  }
  imgEl.classList.add('visible');
}

btn.addEventListener('click', async () => {
  if (!running) {
    try {
      status.textContent = '起動中...';
      analyzer = new AudioAnalyzer(updateVisual, settings);
      await analyzer.start();
      running = true;
      btn.textContent    = 'マイクOFF';
      status.textContent = '声や音を入力してください';
    } catch {
      status.textContent = 'マイクへのアクセスが拒否されました';
    }
  } else {
    analyzer.stop();
    running = false;
    currentIdx = -1;
    btn.textContent    = 'マイクON';
    status.textContent = '';
    imgEl.classList.remove('visible');
    hzEl.textContent   = '-- Hz';
  }
});
