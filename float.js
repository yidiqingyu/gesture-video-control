// ============================================================
// float.js —— 悬浮窗（悬浮球）控制器
//
// 悬浮窗只是一个“视图 + 遥控器”：
//   - 摄像头与手势识别仍在不可见的离屏文档中运行，
//     因此隐藏画面 / 最小化 / 关闭悬浮窗都不影响手势控制；
//   - 预览画面由后台引擎按需发送（约 5 帧/秒）。
//
// 按钮：
//   👁 显示 / 隐藏摄像头画面
//   —  最小化为悬浮球（窗口缩到 72×72，识别不中断）
//   ✕  关闭悬浮窗（识别不中断）
// ============================================================

'use strict';

const els = {
  full: document.getElementById('full'),
  pill: document.getElementById('pill'),
  titlebar: document.getElementById('titlebar'),
  btnPreview: document.getElementById('btn-preview'),
  btnMin: document.getElementById('btn-min'),
  btnClose: document.getElementById('btn-close'),
  preview: document.getElementById('preview'),
  previewPlaceholder: document.getElementById('preview-placeholder'),
  gestureEmoji: document.getElementById('gesture-emoji'),
  gestureName: document.getElementById('gesture-name'),
  gestureDetail: document.getElementById('gesture-detail'),
  modelStatus: document.getElementById('model-status'),
  videoStatus: document.getElementById('video-status'),
  engineViewWrap: document.getElementById('engine-view-wrap'),
  engineView: document.getElementById('engine-view'),
  toggle: document.getElementById('control-toggle'),
  grantButton: document.getElementById('grant-button')
};

const state = {
  winId: null,
  tabId: null,           // 被控制的视频标签页（由弹窗打开时传入）
  controlOn: false,
  minimized: false,
  previewShown: true,
  debounceMs: 900,
  volumeStep: 0.1,
  volumeRepeatMs: 650,
  statusTimer: null
};

const WIN_W = 300;
const WIN_H = 480;
const WIN_W_MIN = 72;
const WIN_H_MIN = 72;

const GESTURE_EMOJI = {
  '打响指': '🤏',
  '食指向上': '☝️',
  '食指向下': '👇',
  '握拳': '✊',
  '手掌张开': '🖐️',
  '其他手势': '🫱',
  '未检测到手': '🙈',
  '等待识别…': '🖐️'
};

// ============================================================
// 初始化（先同步绑定按钮，确保任何异常都不会导致按钮失效）
// ============================================================
function init() {
  els.titlebar.addEventListener('mousedown', onTitlebarMouseDown);
  window.addEventListener('mousemove', onTitlebarMouseMove);
  window.addEventListener('mouseup', onTitlebarMouseUp);
  els.btnPreview.addEventListener('click', onTogglePreview);
  els.btnMin.addEventListener('click', minimize);
  els.btnClose.addEventListener('click', onClose);
  els.pill.addEventListener('click', restore);
  els.toggle.addEventListener('change', onToggleChange);
  if (els.grantButton) els.grantButton.addEventListener('click', onGrantClick);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  (async () => {
    const params = new URLSearchParams(location.search);
    const tab = parseInt(params.get('tab') || '', 10);
    state.tabId = (Number.isInteger(tab) && tab > 0) ? tab : null;

    const win = await chrome.windows.getCurrent();
    state.winId = win.id;

    const settings = await chrome.storage.local.get(['controlOn', 'previewShown', 'debounceMs', 'volumeStep', 'volumeRepeatMs']);
    state.controlOn = !!settings.controlOn;
    state.previewShown = settings.previewShown !== false;
    state.debounceMs = settings.debounceMs ?? 900;
    state.volumeStep = settings.volumeStep ?? 0.1;
    state.volumeRepeatMs = settings.volumeRepeatMs ?? 650;
    els.toggle.checked = state.controlOn;

    applyPreviewVisibility();
    refreshStatus();
    state.statusTimer = setInterval(refreshStatus, 2500);

    if (state.controlOn) {
      await startBackground();
    } else {
      setModelStatus('手势控制已关闭：打开开关即可在后台启动识别');
    }
  })().catch((e) => {
    setModelStatus('❌ 悬浮窗初始化失败：' + ((e && e.message) || e));
  });
}

// ============================================================
// 窗口拖动（无边框窗口需要自己实现）
// ============================================================
let drag = null;

async function onTitlebarMouseDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('button')) return;
  const win = await chrome.windows.getCurrent();
  drag = { sx: e.screenX, sy: e.screenY, wx: win.left, wy: win.top };
  e.preventDefault();
}

function onTitlebarMouseMove(e) {
  if (!drag || !state.winId) return;
  chrome.windows.update(state.winId, {
    left: drag.wx + (e.screenX - drag.sx),
    top: drag.wy + (e.screenY - drag.sy)
  });
}

function onTitlebarMouseUp() {
  drag = null;
}

// ============================================================
// 最小化 / 恢复
// ============================================================
async function minimize() {
  state.minimized = true;
  els.full.style.display = 'none';
  els.pill.style.display = 'flex';
  if (state.winId) {
    await chrome.windows.update(state.winId, { width: WIN_W_MIN, height: WIN_H_MIN });
  }
  stopPreview();
}

async function restore() {
  state.minimized = false;
  els.full.style.display = 'flex';
  els.pill.style.display = 'none';
  if (state.winId) {
    await chrome.windows.update(state.winId, { width: WIN_W, height: WIN_H });
  }
  applyPreviewVisibility();
}

// ============================================================
// 预览显示 / 隐藏
// ============================================================
function onTogglePreview() {
  state.previewShown = !state.previewShown;
  chrome.storage.local.set({ previewShown: state.previewShown });
  applyPreviewVisibility();
}

function applyPreviewVisibility() {
  if (state.previewShown && !state.minimized) {
    els.preview.style.display = 'block';
    els.previewPlaceholder.style.display = 'none';
    startPreview();
  } else {
    stopPreview();
    els.previewPlaceholder.style.display = 'flex';
    els.previewPlaceholder.textContent = state.previewShown ? '正在打开摄像头预览…' : '摄像头画面已隐藏';
  }
}

// ============================================================
// 后台消息：状态 / 预览帧
// ============================================================
function onRuntimeMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'OFFSCREEN_UPDATE') {
    applyBackgroundStatus(message);
  } else if (message.type === 'OFFSCREEN_SNAPSHOT') {
    if (els.engineView && message.dataUrl) {
      els.engineView.src = message.dataUrl;
      if (els.engineViewWrap) els.engineViewWrap.hidden = false;
    }
  }
}

function applyBackgroundStatus(s) {
  if (s.gesture) {
    els.gestureName.textContent = s.gesture;
    els.gestureEmoji.textContent = GESTURE_EMOJI[s.gesture] || '🖐️';
  }
  if (els.gestureDetail) {
    if (s.handDetected === false && s.running) {
      els.gestureDetail.textContent = '未检测到手：请将手掌完整放入摄像头画面';
    } else {
      els.gestureDetail.textContent = s.detail || '';
    }
  }

  if (s.errorText) {
    setModelStatus('❌ ' + s.errorText);
    if (els.grantButton && /权限|NotAllowed|Security|MediaPipe|加载失败|启动失败/i.test(s.errorText)) {
      els.grantButton.hidden = false;
    }
  } else if (s.modelReady) {
    setModelStatus('✅ 后台手势识别运行中（已处理 ' + (s.frames || 0) + ' 帧）');
    if (els.grantButton) els.grantButton.hidden = true;
  } else if (s.running) {
    setModelStatus('⏳ 正在启动后台识别…');
  }

  if (s.videoStatus) {
    els.videoStatus.textContent = s.videoStatus.text;
    els.videoStatus.className = 'status ' + (s.videoStatus.kind || '');
  }

  // 悬浮球状态圆点：后台运行中变绿
  document.body.classList.toggle('running', !!s.modelReady);

  // 一旦检测到手，隐藏“引擎视角”诊断图
  if (s.handDetected && els.engineViewWrap) {
    els.engineViewWrap.hidden = true;
  }
}

function setModelStatus(text) {
  els.modelStatus.textContent = text;
}

// ============================================================
// 后台（offscreen）管理
// ============================================================
function sendToBackground(message) {
  return chrome.runtime.sendMessage(message).catch(() => {});
}

async function ensureOffscreen() {
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: '在后台运行摄像头手势识别，用户无需保持弹窗或悬浮窗打开'
      });
      await waitForOffscreenReady();
    }
    return true;
  } catch (e) {
    setModelStatus('❌ 后台识别页创建失败：' + ((e && e.message) || e));
    return false;
  }
}

function waitForOffscreenReady(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        chrome.runtime.onMessage.removeListener(onMsg);
        resolve(ok);
      }
    };
    const onMsg = (msg) => {
      if (msg && msg.type === 'OFFSCREEN_READY') finish(true);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    setTimeout(() => finish(false), timeoutMs || 5000);
  });
}

async function ensureContentScript() {
  if (!state.tabId) {
    setModelStatus('⚠️ 未指定要控制的视频页面，请从扩展弹窗打开悬浮窗');
    return false;
  }
  try {
    await chrome.tabs.sendMessage(state.tabId, { type: 'PING' });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        files: ['content.js']
      });
      return true;
    } catch (err) {
      setModelStatus('⚠️ 无法注入脚本（浏览器内部页面或特殊页面）');
      return false;
    }
  }
}

async function startBackground() {
  const ok = await ensureOffscreen();
  if (!ok) { revertToggle(); return; }
  const injected = await ensureContentScript();
  if (!injected) { revertToggle(); return; }
  await sendToBackground({
    type: 'OFFSCREEN_START',
    tabId: state.tabId,
    volumeStep: state.volumeStep,
    debounceMs: state.debounceMs,
    volumeRepeatMs: state.volumeRepeatMs
  });
  setModelStatus('⏳ 正在启动后台识别…');
  setTimeout(refreshStatus, 800);
}

async function stopBackground() {
  await sendToBackground({ type: 'OFFSCREEN_STOP' });
  setModelStatus('已停止后台识别');
}

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_GET_STATUS' });
    if (resp && resp.type === 'OFFSCREEN_UPDATE') {
      applyBackgroundStatus(resp);
    }
  } catch (e) {
    // offscreen 不存在时忽略
  }
}

// ============================================================
// 开关 / 授权
// ============================================================
async function onToggleChange() {
  state.controlOn = els.toggle.checked;
  await chrome.storage.local.set({ controlOn: state.controlOn });
  if (state.controlOn) {
    await startBackground();
  } else {
    await stopBackground();
  }
}

function revertToggle() {
  els.toggle.checked = false;
  state.controlOn = false;
  chrome.storage.local.set({ controlOn: false });
}

function onGrantClick() {
  const url = chrome.runtime.getURL('grant.html' + (state.tabId ? '?tab=' + encodeURIComponent(state.tabId) : ''));
  chrome.tabs.create({ url: url, active: true });
}

function onClose() {
  if (state.winId) {
    chrome.windows.remove(state.winId).catch(() => {});
  }
  window.close();
}

// ============================================================
// 悬浮窗自己的实时摄像头预览（识别仍在后台离屏文档中运行）
// ============================================================
async function startPreview() {
  try {
    if (!els.preview.srcObject) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      els.preview.srcObject = stream;
      await els.preview.play().catch(() => {});
    }
    els.preview.style.display = 'block';
    els.previewPlaceholder.style.display = 'none';
  } catch (e) {
    els.previewPlaceholder.textContent = '预览不可用（识别仍在后台运行）';
    els.previewPlaceholder.style.display = 'flex';
  }
}

function stopPreview() {
  if (els.preview.srcObject) {
    els.preview.srcObject.getTracks().forEach((track) => track.stop());
    els.preview.srcObject = null;
  }
}

// 关闭 / 卸载时：暂停预览帧
window.addEventListener('pagehide', () => {
  clearInterval(state.statusTimer);
  stopPreview();
});

// 启动
init();
