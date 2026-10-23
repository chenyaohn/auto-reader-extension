/* 自动阅读助手 · 弹窗逻辑：所有设置都交给内容脚本执行，弹窗只负责展示与转发 */

const SPEED_MIN = 2;
const SPEED_MAX = 120;

const DEFAULTS = {
  speed: 12,
  smooth: true,
  autoNext: false,
  hoverPause: true,
  manualPause: true,
  resumeOnLoad: true,
  panelHidden: false
};

const statusEl = document.getElementById('status');
const speedNum = document.getElementById('speedNum');
const cpmNum = document.getElementById('cpmNum');
const range = document.getElementById('speedRange');
const etaEl = document.getElementById('eta');
const toggleBtn = document.getElementById('toggleBtn');
const panelBtn = document.getElementById('panelBtn');
const toggles = [...document.querySelectorAll('input[data-key]')];

let tabId = null;
let state = { ...DEFAULTS, running: false };

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function send(cmd, extra = {}) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'AR_CMD', cmd, ...extra });
  } catch (e) {
    return null;
  }
}

async function ensureInjected() {
  if (tabId == null) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (e) {
    return false;
  }
}

function render() {
  const on = !!state.running;
  statusEl.textContent = on ? '阅读中' : '已暂停';
  statusEl.classList.toggle('on', on);
  toggleBtn.textContent = on ? '暂停滚动' : '开始滚动';
  toggleBtn.classList.toggle('on', on);
  speedNum.textContent = String(state.speed);
  if (Number(range.value) !== state.speed) range.value = String(state.speed);
  const pct = ((state.speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100;
  range.style.setProperty('--pct', pct.toFixed(1) + '%');
  cpmNum.textContent = String(state.cpm != null ? state.cpm : Math.round(state.speed * 54));
  const canShowPanel = state.articleDetected !== false;
  panelBtn.textContent = state.panelHidden ? '显示控制条' : '隐藏控制条';
  panelBtn.disabled = !canShowPanel;
  panelBtn.title = canShowPanel ? '' : '当前页面未通过正文识别，不显示悬浮条';
  for (const input of toggles) input.checked = !!state[input.dataset.key];
}

function renderEta() {
  if (!state.running) {
    etaEl.textContent = '剩余时间 —';
    return;
  }
  const rest = state.remainingSeconds;
  if (rest == null || rest <= 0) {
    etaEl.textContent = '已读到底部';
    return;
  }
  const m = Math.floor(rest / 60);
  const s = rest % 60;
  etaEl.textContent = `本页剩余 ≈ ${m}:${String(s).padStart(2, '0')}`;
}

range.addEventListener('input', () => {
  const speed = Number(range.value);
  state.speed = speed;
  render();
  send('set', { patch: { speed } });
});

for (const btn of document.querySelectorAll('.presets button')) {
  btn.addEventListener('click', () => {
    const speed = Number(btn.dataset.speed);
    state.speed = speed;
    render();
    send('set', { patch: { speed } });
  });
}

for (const input of toggles) {
  input.addEventListener('change', () => {
    const key = input.dataset.key;
    state[key] = input.checked;
    send('set', { patch: { [key]: input.checked } });
  });
}

toggleBtn.addEventListener('click', async () => {
  const res = await send('toggle');
  if (res && res.state) {
    state = { ...state, ...res.state };
    render();
  }
});

document.getElementById('topBtn').addEventListener('click', () => send('scrollTop'));
panelBtn.addEventListener('click', async () => {
  const res = await send('togglePanel');
  if (res && res.state) {
    state = { ...state, ...res.state };
    render();
  }
});

(async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    statusEl.textContent = '无可用标签页';
    return;
  }
  tabId = tab.id;

  let res = await send('get');
  if (!res) {
    const injected = await ensureInjected();
    if (injected) res = await send('get');
  }

  if (!res || !res.state) {
    statusEl.textContent = '此页面不可用';
    toggleBtn.disabled = true;
    panelBtn.disabled = true;
    etaEl.textContent = '请在普通网页（http / https）上使用';
    return;
  }

  state = { ...state, ...res.state };
  render();
  renderEta();

  // 让「阅读中 / 剩余时间」保持实时
  setInterval(async () => {
    const live = await send('get');
    if (!live || !live.state) return;
    const { remainingSeconds, ...rest } = live.state;
    state = { ...state, ...rest, remainingSeconds };
    render();
    renderEta();
  }, 1000);
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const key of Object.keys(changes)) {
    if (key in DEFAULTS) state[key] = changes[key].newValue;
  }
  render();
});
