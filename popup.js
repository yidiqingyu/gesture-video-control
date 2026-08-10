// ============================================================
// popup.js —— 弹窗控制器（遥控器）
//
// 摄像头与手势识别都运行在不可见的离屏文档（offscreen.html）
// 中，所以：
//   - 关闭本弹窗后，手势控制依然在后台生效，不遮挡视频；
//   - 弹窗只负责开关、状态显示和低帧率预览。
//
// 消息协议：
//   弹窗 -> offscreen : OFFSCREEN_START / OFFSCREEN_STOP / OFFSCREEN_GET_STATUS
//   offscreen -> 弹窗 : OFFSCREEN_UPDATE（状态）
// 摄像头预览由弹窗 / 悬浮窗各自直接打开实时流显示（不经过消息传递）
// ============================================================

'use strict';

// ---------- DOM 元素 ----------
const els = {
  preview: document.getElementById('preview'),
  cameraPlaceholder: document.getElementById('camera-placeholder'),
  grantButton: document.getElementById('grant-button'),
  openFloat: document.getElementById('open-float'),
  gestureEmoji: document.getElementById('gesture-emoji'),
  gestureName: document.getElementById('gesture-name'),
  gestureDetail: document.getElementById('gesture-detail'),
  modelStatus: document.getElementById('model-status'),
  videoStatus: document.getElementById('video-status'),
  toggle: document.getElementById('control-toggle'),
  shortToggle: document.getElementById('short-toggle')
};

// ---------- 状态 ----------
const state = {
  activeTabId: null,     // 当前（要控制的）标签页
  controlOn: false,
  debounceMs: 900,
  volumeStep: 0.1,
  volumeRepeatMs: 650,
  engineOwner: 'offscreen', // 'offscreen' | 'float' | 'none'
  shortVideoMode: false,
  statusTimer: null
};

// 手势对应的展示 emoji
const GESTURE_EMOJI = {
  'OK': '👌',
  '小拇指向上': '🤙',
  '小拇指向下': '🤙',
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
  els.toggle.addEventListener('change', onToggleChange);
  if (els.shortToggle) {
    els.shortToggle.addEventListener('change', onShortToggleChange);
  }
  if (els.grantButton) {
    els.grantButton.addEventListener('click', onGrantClick);
  }
  if (els.openFloat) {
    els.openFloat.addEventListener('click', onOpenFloat);
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  // 悬浮窗页面引擎的归属变化时，同步状态显示（避免后台引擎重复启动）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.engineOwner) {
      state.engineOwner = changes.engineOwner.newValue;
      if (state.engineOwner === 'float' && state.controlOn) {
        setModelStatus('✅ 识别由悬浮窗页面引擎运行中（后台引擎已暂停）');
      }
    }
    if (changes.shortVideoMode) {
      state.shortVideoMode = !!changes.shortVideoMode.newValue;
      if (els.shortToggle) els.shortToggle.checked = state.shortVideoMode;
    }
  });

  (async () => {
    // 1. 当前标签页（即要控制的视频页）
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    state.activeTabId = tabs[0] ? tabs[0].id : null;

    // 2. 读取设置
    const settings = await chrome.storage.local.get(['controlOn', 'debounceMs', 'volumeStep', 'volumeRepeatMs', 'engineOwner', 'shortVideoMode']);
    state.controlOn = !!settings.controlOn;
    state.debounceMs = settings.debounceMs ?? 900;
    state.volumeStep = settings.volumeStep ?? 0.1;
    state.volumeRepeatMs = settings.volumeRepeatMs ?? 650;
    state.engineOwner = settings.engineOwner || 'offscreen';
    state.shortVideoMode = !!settings.shortVideoMode;
    els.toggle.checked = state.controlOn;
    if (els.shortToggle) els.shortToggle.checked = state.shortVideoMode;

    // 3. 确保后台离屏文档存在
    await ensureOffscreen();

    // 4. 向当前页面注入内容脚本（activeTab 权限在点击图标时授予）
    await ensureContentScript();

    // 5. 开关状态恢复：打开着就继续后台识别，并显示实时预览
    if (state.controlOn) {
      await startBackground();
      startPreview();
    } else {
      setModelStatus('手势控制已关闭：打开开关即可在后台启动识别');
    }

    // 6. 周期性同步后台状态（防止漏消息）
    state.statusTimer = setInterval(refreshFromBackground, 2500);
  })().catch((e) => {
    setModelStatus('❌ 初始化失败：' + ((e && e.message) || e));
  });
}

// ============================================================
// 后台（offscreen）文档管理
// ============================================================
async function ensureOffscreen() {
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: '在后台运行摄像头手势识别，用户无需保持弹窗打开'
      });
      // 等待离屏文档加载完成（它的脚本注册消息监听后再发指令）
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
      if (msg && msg.type === 'OFFSCREEN_READY') {
        finish(true);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    setTimeout(() => finish(false), timeoutMs || 5000);
  });
}

function sendToBackground(message) {
  return chrome.runtime.sendMessage(message).catch(() => {});
}

async function startBackground() {
  const ok = await ensureOffscreen();
  if (!ok) {
    revertToggle();
    return;
  }
  const injected = await ensureContentScript();
  if (!injected) {
    revertToggle();
    return;
  }
  // 悬浮窗页面引擎在运行时，不再启动后台引擎，避免两处同时触发动作
  const owner = (await chrome.storage.local.get('engineOwner')).engineOwner;
  state.engineOwner = owner || 'offscreen';
  if (state.engineOwner === 'float') {
    setModelStatus('✅ 识别由悬浮窗页面引擎运行中（后台引擎已暂停）');
    return;
  }
  await sendToBackground({
    type: 'OFFSCREEN_START',
    tabId: state.activeTabId,
    shortVideoMode: state.shortVideoMode,
    volumeStep: state.volumeStep,
    debounceMs: state.debounceMs,
    volumeRepeatMs: state.volumeRepeatMs
  });
  setModelStatus('⏳ 正在启动后台识别…');
  setTimeout(refreshFromBackground, 800);
}

async function stopBackground() {
  await sendToBackground({ type: 'OFFSCREEN_STOP' });
  setModelStatus('已停止后台识别');
}

async function refreshFromBackground() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_GET_STATUS' });
    if (resp && resp.type === 'OFFSCREEN_UPDATE') {
      applyBackgroundStatus(resp);
    }
  } catch (e) {
    // offscreen 文档不存在时忽略，稍后由 ensureOffscreen 重建
  }
}

// ============================================================
// 开关
// ============================================================
async function onToggleChange() {
  state.controlOn = els.toggle.checked;
  await chrome.storage.local.set({ controlOn: state.controlOn });

  if (state.controlOn) {
    await startBackground();
    startPreview();
  } else {
    await stopBackground();
    stopPreview();
  }
}

// 短视频模式开关（引擎侧通过 storage 监听同步）
async function onShortToggleChange() {
  state.shortVideoMode = !!els.shortToggle.checked;
  await chrome.storage.local.set({ shortVideoMode: state.shortVideoMode });
  // 离屏引擎无法直接读 storage，通过消息即时同步
  sendToBackground({
    type: 'OFFSCREEN_SET_MODE',
    shortVideoMode: state.shortVideoMode,
    volumeStep: state.volumeStep,
    debounceMs: state.debounceMs,
    volumeRepeatMs: state.volumeRepeatMs
  });
  setModelStatus(state.shortVideoMode ? '已切换到短视频模式（食指上=下滑，食指下=上滑）' : '已切回长视频模式');
}

function revertToggle() {
  els.toggle.checked = false;
  state.controlOn = false;
  chrome.storage.local.set({ controlOn: false });
}

// ============================================================
// 内容脚本注入
// ============================================================
async function ensureContentScript() {
  if (!state.activeTabId) {
    setVideoStatus('无法获取当前标签页', 'error');
    return false;
  }
  try {
    await chrome.tabs.sendMessage(state.activeTabId, { type: 'PING' });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.activeTabId },
        files: ['content.js']
      });
      return true;
    } catch (err) {
      setVideoStatus('无法注入脚本（浏览器内部页面或特殊页面）', 'error');
      return false;
    }
  }
}

// ============================================================
// 后台状态 / 预览帧处理
// ============================================================
function onRuntimeMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'OFFSCREEN_UPDATE') {
    applyBackgroundStatus(message);
  }
}

function applyBackgroundStatus(s) {
  if (s.gesture) setGesture(s.gesture);
  if (els.gestureDetail) {
    if (s.handDetected === false && s.running) {
      els.gestureDetail.textContent = '未检测到手：把张开的手掌放到摄像头正前方，预览里能看到整只手';
    } else {
      els.gestureDetail.textContent = s.detail || '';
    }
  }

  if (s.errorText) {
    setModelStatus('❌ ' + s.errorText);
    // 权限被拒时，引导用户到标签页授权
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
    setVideoStatus(s.videoStatus.text, s.videoStatus.kind);
  }

}

// ============================================================
// 弹窗自己的实时摄像头预览（识别仍在后台离屏文档中运行）
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
    els.cameraPlaceholder.style.display = 'none';
  } catch (e) {
    els.cameraPlaceholder.textContent = '预览不可用（识别仍在后台运行）';
    els.cameraPlaceholder.style.display = 'flex';
  }
}

function stopPreview() {
  if (els.preview.srcObject) {
    els.preview.srcObject.getTracks().forEach((track) => track.stop());
    els.preview.srcObject = null;
  }
  els.cameraPlaceholder.style.display = 'flex';
}

function setGesture(name) {
  els.gestureName.textContent = name;
  els.gestureEmoji.textContent = GESTURE_EMOJI[name] || '🖐️';
}

function setModelStatus(text) {
  els.modelStatus.textContent = text;
}

function setVideoStatus(text, kind) {
  els.videoStatus.textContent = text;
  els.videoStatus.className = 'status ' + (kind || '');
}

// ============================================================
// 摄像头授权兜底：在标签页里授权（Chrome 弹窗权限提示易被丢弃）
// ============================================================
function onGrantClick() {
  const tabId = state.activeTabId;
  const url = chrome.runtime.getURL('grant.html' + (tabId ? '?tab=' + encodeURIComponent(tabId) : ''));
  chrome.tabs.create({ url: url, active: true });
  window.close();
}

// 打开悬浮面板：在当前页面注入可拖动 / 缩放 / 隐藏画面的悬浮面板
async function onOpenFloat() {
  setModelStatus('⏳ 正在打开悬浮面板…');
  try {
    const injected = await ensureContentScript();
    if (!injected) {
      setModelStatus('❌ 无法在此页面打开悬浮面板');
      return;
    }
    const resp = await chrome.tabs.sendMessage(state.activeTabId, { type: 'SHOW_FLOAT_PANEL' });
    if (resp && resp.status === 'ok') {
      setModelStatus('✅ 悬浮面板已打开（可关闭本弹窗）');
    } else {
      setModelStatus('❌ 打开悬浮面板失败：' + ((resp && resp.error) || '未知错误'));
    }
  } catch (e) {
    setModelStatus('❌ 打开悬浮面板失败：' + ((e && e.message) || e));
  }
}

// 弹窗关闭时：停止预览帧请求、清理定时器
window.addEventListener('pagehide', () => {
  stopPreview();
  clearInterval(state.statusTimer);
});

// 启动
init();
