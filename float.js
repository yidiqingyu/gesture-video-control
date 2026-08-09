// ============================================================
// float.js —— 悬浮窗（悬浮球）控制器
//
// 悬浮窗是一个“视图 + 遥控器 + 识别引擎”：
//   - 悬浮窗打开时，识别引擎直接在悬浮窗页面运行（画面更稳定）；
//   - 关闭悬浮窗后，自动交回不可见的离屏文档继续识别，
//     因此隐藏画面 / 最小化 / 关闭悬浮窗都不中断手势控制。
//
// 按钮：
//   👁 显示 / 隐藏摄像头画面
//   —  最小化为悬浮球（窗口缩到 72×72，识别不中断）
//   ✕  关闭悬浮窗（识别不中断）
// ============================================================

// 官方 MediaPipe Tasks Vision（ES Module，随扩展本地打包）
import { FilesetResolver, HandLandmarker } from './vendor/mediapipe/vision_bundle.mjs';

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
  overlay: document.getElementById('overlay'),
  recVideo: document.getElementById('rec-video'),
  gestureEmoji: document.getElementById('gesture-emoji'),
  gestureName: document.getElementById('gesture-name'),
  gestureDetail: document.getElementById('gesture-detail'),
  modelStatus: document.getElementById('model-status'),
  videoStatus: document.getElementById('video-status'),
  engineViewWrap: document.getElementById('engine-view-wrap'),
  engineView: document.getElementById('engine-view'),
  toggle: document.getElementById('control-toggle'),
  shortToggle: document.getElementById('short-toggle'),
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
  statusTimer: null,
  // 页面内识别引擎状态
  recRunning: false,
  landmarker: null,
  recStream: null,
  recFrames: 0,
  recFrameErrors: 0,
  recProcessing: false,
  recTimer: null,        // 帧循环定时器（窗口被遮挡/离屏时 rAF 可能停摆，用定时器驱动）
  framesTimer: null,
  usedCpuDelegate: false,
  gpuFallbackTimer: null,
  lastActionTime: 0,
  lastVolumeTime: 0,
  stablePose: '',
  stableFrames: 0,
  okPinched: false,      // OK 手势捏合跳变检测
  handFoundFrames: 0,    // 连续检测到手的帧数（显示防抖用）
  handLostFrames: 0,     // 连续没检测到手的帧数（显示防抖用）
  shortVideoMode: false, // 短视频模式（默认长视频模式）
  palmHoldStart: null,   // 手掌张开保持计时的起点
  palmHoldTriggered: false // 本次保持是否已触发过模式切换
};

// 显示防抖：身体晃动造成的“疑似手”会一闪而过。
// 连续 3 帧检测到手才恢复手势显示；连续 6 帧没检测到手才显示“未检测到手”。
const FOUND_HAND_MIN_FRAMES = 3;
const LOST_HAND_MIN_FRAMES = 6;

const WIN_W = 300;
const WIN_H = 480;
const WIN_W_MIN = 72;
const WIN_H_MIN = 72;

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
  els.titlebar.addEventListener('mousedown', onTitlebarMouseDown);
  window.addEventListener('mousemove', onTitlebarMouseMove);
  window.addEventListener('mouseup', onTitlebarMouseUp);
  els.btnPreview.addEventListener('click', onTogglePreview);
  els.btnMin.addEventListener('click', minimize);
  els.btnClose.addEventListener('click', onClose);
  els.pill.addEventListener('click', restore);
  els.toggle.addEventListener('change', onToggleChange);
  if (els.shortToggle) els.shortToggle.addEventListener('change', onShortToggleChange);
  if (els.grantButton) els.grantButton.addEventListener('click', onGrantClick);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  (async () => {
    const params = new URLSearchParams(location.search);
    const tab = parseInt(params.get('tab') || '', 10);
    state.tabId = (Number.isInteger(tab) && tab > 0) ? tab : null;

    const win = await chrome.windows.getCurrent();
    state.winId = win.id;

    // 已存在另一个悬浮窗时，关闭本窗口，避免两个页面引擎同时触发动作
    const winReg = await chrome.storage.local.get('floatWindowId');
    if (winReg.floatWindowId && winReg.floatWindowId !== win.id) {
      try {
        await chrome.windows.get(winReg.floatWindowId);
        setModelStatus('已有悬浮窗在运行，本窗口即将关闭');
        setTimeout(() => {
          if (state.winId) chrome.windows.remove(state.winId).catch(() => {});
        }, 300);
        return;
      } catch (e) {
        // 记录中的窗口已关闭（如浏览器异常退出留下的残留），清理后继续
        await chrome.storage.local.set({ floatWindowId: null }).catch(() => {});
      }
    }
    chrome.storage.local.set({ floatWindowId: win.id }).catch(() => {});

    const settings = await chrome.storage.local.get(['controlOn', 'previewShown', 'debounceMs', 'volumeStep', 'volumeRepeatMs', 'shortVideoMode']);
    state.controlOn = !!settings.controlOn;
    state.previewShown = settings.previewShown !== false;
    state.debounceMs = settings.debounceMs ?? 900;
    state.volumeStep = settings.volumeStep ?? 0.1;
    state.volumeRepeatMs = settings.volumeRepeatMs ?? 650;
    state.shortVideoMode = !!settings.shortVideoMode;
    els.toggle.checked = state.controlOn;
    if (els.shortToggle) els.shortToggle.checked = state.shortVideoMode;

    applyPreviewVisibility();
    refreshStatus();
    state.statusTimer = setInterval(refreshStatus, 2500);

    if (state.controlOn) {
      await startRecognition();
    } else {
      setModelStatus('手势控制已关闭：打开开关即可开始识别');
    }
  })().catch((e) => {
    setModelStatus('❌ 悬浮窗初始化失败：' + ((e && e.message) || e));
  });

  // 弹窗等其他界面修改开关时，同步本窗口的识别引擎
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.controlOn) {
      const on = !!changes.controlOn.newValue;
      if (on === state.controlOn) return;
      state.controlOn = on;
      els.toggle.checked = on;
      if (on) {
        startRecognition();
      } else {
        stopRecognition();
        setModelStatus('手势控制已关闭');
      }
    }
    if (changes.shortVideoMode) {
      state.shortVideoMode = !!changes.shortVideoMode.newValue;
      if (els.shortToggle) els.shortToggle.checked = state.shortVideoMode;
    }
  });
}

// 短视频模式开关
async function onShortToggleChange() {
  state.shortVideoMode = !!els.shortToggle.checked;
  await chrome.storage.local.set({ shortVideoMode: state.shortVideoMode });
  setModelStatus(state.shortVideoMode ? '已切换到短视频模式（食指上=下滑，食指下=上滑）' : '已切回长视频模式');
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
  // 控制开启时保留摄像头流（识别继续），只把窗口缩成悬浮球
  if (!state.controlOn) stopPreview();
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
    // 控制开启时保留摄像头流（识别继续在后台画面运行），只隐藏预览
    if (!state.controlOn) stopPreview();
    els.previewPlaceholder.style.display = 'flex';
    els.previewPlaceholder.textContent = state.previewShown ? '正在打开摄像头预览…' : '摄像头画面已隐藏';
  }
}

// ============================================================
// 后台消息：状态 / 预览帧
// ============================================================
function onRuntimeMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  // 页面内识别运行期间，忽略后台引擎的状态（避免互相覆盖）
  if (state.recRunning) return;
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
  if (state.recRunning) return;
  if (s.gesture) {
    els.gestureName.textContent = s.gesture;
    els.gestureEmoji.textContent = GESTURE_EMOJI[s.gesture] || '🖐️';
  }
  if (els.gestureDetail) {
    if (s.handDetected === false && s.running) {
      els.gestureDetail.textContent = '未检测到手：把张开的手掌放到摄像头正前方，预览里能看到整只手';
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
    await startRecognition();
  } else {
    stopRecognition();
    setModelStatus('手势控制已关闭');
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

// ============================================================
// 页面内识别引擎（在悬浮窗页面直接跑 MediaPipe，
// 使用和预览一样可用的摄像头流，绕开后台离屏文档的兼容问题）
// ============================================================
async function startRecognition() {
  if (state.recRunning) return;
  const injected = await ensureContentScript();
  if (!injected) {
    revertToggle();
    return;
  }
  state.recRunning = true;
  // 暂停后台离屏引擎，避免两处同时触发动作
  sendToBackground({ type: 'OFFSCREEN_STOP' });
  setModelStatus('⏳ 正在启动识别引擎…');
  try {
    if (typeof FilesetResolver !== 'function' || typeof HandLandmarker !== 'function') {
      setModelStatus('⏳ 正在加载 MediaPipe 运行时…');
      await waitForVision();
    }
    if (typeof FilesetResolver !== 'function' || typeof HandLandmarker !== 'function') {
      throw new Error('MediaPipe 未加载（vendor/mediapipe/vision_bundle.js）');
    }

    // 优先复用预览流（这台机器上已验证可用），避免同时打开多路摄像头
    let stream = els.preview.srcObject;
    if (!stream || !stream.getVideoTracks || stream.getVideoTracks().length === 0) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      if (!els.preview.srcObject) {
        els.preview.srcObject = stream;
      }
    }
    state.recStream = stream;
    els.recVideo.srcObject = state.recStream;
    await els.recVideo.play();

    const fileset = await FilesetResolver.forVisionTasks(
      chrome.runtime.getURL('vendor/mediapipe/wasm')
    );
    const baseOptions = {
      modelAssetPath: chrome.runtime.getURL('vendor/mediapipe/hand_landmarker.task')
    };
    const commonOptions = {
      baseOptions: baseOptions,
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    };
    let landmarker;
    let usedCpu = false;
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...commonOptions,
        baseOptions: { ...baseOptions, delegate: 'GPU' }
      });
    } catch (gpuErr) {
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...commonOptions,
        baseOptions: { ...baseOptions, delegate: 'CPU' }
      });
      usedCpu = true;
    }
    state.landmarker = landmarker;
    state.usedCpuDelegate = usedCpu;
    scheduleRecCpuFallback();
    setModelStatus('✅ 识别运行中（页面引擎' + (usedCpu ? '·CPU' : '·GPU') + '）');
    document.body.classList.add('running');
    // 声明“页面引擎在运行”，弹窗据此不再启动后台引擎，避免重复触发
    chrome.storage.local.set({ engineOwner: 'float' }).catch(() => {});
    state.recTimer = setTimeout(recLoop, 33);
    // 周期性显示已处理帧数，便于确认引擎是否在跑
    clearInterval(state.framesTimer);
    state.framesTimer = setInterval(() => {
      setModelStatus('✅ 识别运行中（页面引擎' + (state.usedCpuDelegate ? '·CPU' : '·GPU') + '）｜已处理 ' + state.recFrames + ' 帧');
    }, 2000);
  } catch (err) {
    state.recRunning = false;
    setModelStatus('❌ 识别引擎加载失败（' + (err && err.name || 'Error') + '）：' + ((err && err.message) || err));
    revertToggle();
  }
}

function stopRecognition() {
  state.recRunning = false;
  if (state.recTimer) clearTimeout(state.recTimer);
  state.recTimer = null;
  if (state.framesTimer) clearInterval(state.framesTimer);
  state.framesTimer = null;
  if (state.gpuFallbackTimer) clearTimeout(state.gpuFallbackTimer);
  state.gpuFallbackTimer = null;
  if (state.landmarker) {
    try { state.landmarker.close(); } catch (e) { /* 忽略 */ }
  }
  state.landmarker = null;
  // 若识别流与预览共用，则交给预览管理；否则释放独立流
  if (state.recStream && state.recStream !== els.preview.srcObject) {
    state.recStream.getTracks().forEach((track) => track.stop());
  }
  state.recStream = null;
  els.recVideo.srcObject = null;
  drawLandmarks(null);
  document.body.classList.remove('running');
  setGestureLocal('等待识别…', '');
  // 若开关仍为开（如关闭悬浮窗时交还后台引擎），标记引擎归属；关闭开关则为 none
  chrome.storage.local.set({ engineOwner: state.controlOn ? 'offscreen' : 'none' }).catch(() => {});
}

function waitForVision(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (typeof FilesetResolver === 'function' && typeof HandLandmarker === 'function') {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start > (timeoutMs || 20000)) {
        clearInterval(timer);
        resolve(false);
      }
    }, 200);
  });
}

function scheduleRecCpuFallback() {
  if (state.usedCpuDelegate) return;
  clearTimeout(state.gpuFallbackTimer);
  state.gpuFallbackTimer = setTimeout(async () => {
    if (state.usedCpuDelegate || !state.recRunning) return;
    if (state.recFrames < 30) return;
    state.usedCpuDelegate = true;
    setModelStatus('⚠️ GPU 模式未检测到手，正在切换 CPU 模式…');
    try {
      const fileset = await FilesetResolver.forVisionTasks(
        chrome.runtime.getURL('vendor/mediapipe/wasm')
      );
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: chrome.runtime.getURL('vendor/mediapipe/hand_landmarker.task'),
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      if (state.landmarker) {
        try { state.landmarker.close(); } catch (e) { /* 忽略 */ }
      }
      state.landmarker = landmarker;
      setModelStatus('✅ 识别运行中（页面引擎·CPU）');
    } catch (err) {
      setModelStatus('❌ CPU 模式切换失败：' + ((err && err.message) || err));
    }
  }, 5000);
}

function recLoop() {
  if (!state.recRunning || !state.landmarker) {
    state.recTimer = null;
    return;
  }
  if (!state.recProcessing && els.recVideo.readyState >= 2) {
    state.recProcessing = true;
    try {
      const result = state.landmarker.detectForVideo(els.recVideo, performance.now());
      state.recFrames += 1;
      handleRecResult(result);
    } catch (e) {
      state.recFrameErrors += 1;
      if (state.recFrameErrors === 10) {
        setModelStatus('⚠️ 识别引擎异常：' + ((e && e.message) || e));
      }
    }
    state.recProcessing = false;
  }
  state.recTimer = setTimeout(recLoop, 33);
}

function handleRecResult(result) {
  const hands = result && result.landmarks;
  if (!hands || hands.length === 0) {
    state.handFoundFrames = 0;
    state.handLostFrames += 1;
    // 偶发漏检（一两帧没跟上）不立即切换显示，避免 UI 闪烁
    if (state.handLostFrames < LOST_HAND_MIN_FRAMES) return;
    drawLandmarks(null);
    setGestureLocal('未检测到手', '把张开的手掌放到摄像头正前方，预览里能看到整只手');
    state.okPinched = false;
    state.palmHoldStart = null;
    state.palmHoldTriggered = false;
    state.stablePose = '';
    state.stableFrames = 0;
    return;
  }

  state.handLostFrames = 0;
  state.handFoundFrames += 1;
  // 刚“出现”的手需要连续几帧确认，过滤身体误检的闪现
  if (state.handFoundFrames < FOUND_HAND_MIN_FRAMES) return;

  const lm = hands[0];
  drawLandmarks(lm);
  const pose = GestureMath.classifyPose(lm);
  setGestureLocal(pose.name, pose.detail);

  if (pose.name === state.stablePose) {
    state.stableFrames += 1;
  } else {
    state.stablePose = pose.name;
    state.stableFrames = 1;
  }
  const stable = state.stableFrames >= 3;
  const now = Date.now();

  // OK：捏合跳变触发播放/暂停
  if (pose.ok) {
    if (!state.okPinched && stable) {
      state.okPinched = true;
      if (now - state.lastActionTime >= state.debounceMs) {
        state.lastActionTime = now;
        sendAction('play_pause', 'OK');
      }
    }
  } else {
    state.okPinched = false;
  }

  // 小拇指上/下：长按连续调音量
  if (stable && (pose.name === '小拇指向上' || pose.name === '小拇指向下')) {
    if (now - state.lastVolumeTime >= state.volumeRepeatMs) {
      state.lastVolumeTime = now;
      sendAction(pose.name === '小拇指向上' ? 'volume_up' : 'volume_down', pose.name);
    }
  } else {
    state.lastVolumeTime = 0;
  }

  // 单个食指上/下（一次性）：
  //   长视频模式 = 上一个/下一个视频；短视频模式 = 按 ↑/↓ 方向键切换视频
  if (stable && (pose.name === '食指向上' || pose.name === '食指向下') &&
      now - state.lastActionTime >= state.debounceMs) {
    state.lastActionTime = now;
    if (state.shortVideoMode) {
      sendAction(pose.name === '食指向上' ? 'scroll_up' : 'scroll_down', pose.name);
    } else {
      sendAction(pose.name === '食指向上' ? 'prev' : 'next', pose.name);
    }
  }

  // 握拳：不再触发任何动作（保留识别，避免握拳被误判成其它手势）

  // 手掌张开：保持 2 秒切换长/短视频模式（上下挥动切集已移除）
  if (pose.name === '手掌张开') {
    // 保持 2 秒：切换长/短视频模式（切换一次后需松手重新比才算下一次）
    if (state.palmHoldStart === null) {
      state.palmHoldStart = now;
    } else if (!state.palmHoldTriggered && now - state.palmHoldStart >= 2000) {
      state.palmHoldTriggered = true;
      toggleShortVideoMode();
    }
  } else {
    state.palmHoldStart = null;
    state.palmHoldTriggered = false;
  }
}

// 手掌张开保持 2 秒：切换长视频模式 <-> 短视频模式
async function toggleShortVideoMode() {
  const data = await chrome.storage.local.get('shortVideoMode');
  const next = !data.shortVideoMode;
  state.shortVideoMode = next;
  await chrome.storage.local.set({ shortVideoMode: next });
  if (els.shortToggle) els.shortToggle.checked = next;
  setGestureLocal('手掌张开', next ? '已切换到短视频模式（食指上=↑，食指下=↓）' : '已切回长视频模式');
}

// 在预览画面上叠加显示手部 21 个关键点（绿色骨架），用于直观确认检测效果
function drawLandmarks(lm) {
  const canvas = els.overlay;
  if (!canvas) return;
  const w = canvas.width = els.preview.clientWidth || 320;
  const h = canvas.height = els.preview.clientHeight || 240;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  const px = (x) => (1 - x) * w; // 预览已镜像，坐标同步翻转
  const py = (y) => y * h;
  const chains = [
    [0, 1, 2, 3, 4],
    [0, 5, 6, 7, 8],
    [0, 9, 10, 11, 12],
    [0, 13, 14, 15, 16],
    [0, 17, 18, 19, 20]
  ];
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (const chain of chains) {
    ctx.beginPath();
    for (let i = 0; i < chain.length; i++) {
      const p = lm[chain[i]];
      const x = px(p.x);
      const y = py(p.y);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#00ff88';
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(px(p.x), py(p.y), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function setGestureLocal(name, detail) {
  els.gestureName.textContent = name;
  els.gestureEmoji.textContent = GESTURE_EMOJI[name] || '🖐️';
  els.gestureDetail.textContent = detail || '';
}

async function sendAction(action, gestureName) {
  if (!state.tabId) return;
  try {
    const resp = await chrome.tabs.sendMessage(state.tabId, {
      type: 'GESTURE_ACTION',
      action: action,
      gesture: gestureName,
      volumeStep: state.volumeStep
    });
    if (resp && resp.status === 'no_video') {
      els.videoStatus.textContent = '当前页面未检测到视频';
      els.videoStatus.className = 'status error';
    } else if (resp && resp.status === 'ok') {
      await refreshPageVideoStatus();
    } else if (resp && resp.status === 'error') {
      els.videoStatus.textContent = '⚠️ 无法连接页面（请重新打开扩展图标后再试）';
      els.videoStatus.className = 'status warn';
    }
  } catch (e) {
    els.videoStatus.textContent = '⚠️ 无法操作页面（请重新打开扩展图标后再试）';
    els.videoStatus.className = 'status warn';
  }
}

async function refreshPageVideoStatus() {
  if (!state.tabId) return;
  try {
    const resp = await chrome.tabs.sendMessage(state.tabId, { type: 'GET_STATUS' });
    if (resp && resp.type === 'STATUS') {
      if (resp.hasVideo) {
        const vol = Math.round((resp.volume || 0) * 100);
        els.videoStatus.textContent =
          '✅ 已检测到视频（' + resp.host + '）｜' +
          (resp.playing ? '▶ 播放中' : '⏸ 已暂停') +
          '｜音量 ' + vol + '%' +
          (resp.muted ? '｜🔇 已静音' : '');
        els.videoStatus.className = 'status ok';
      } else {
        els.videoStatus.textContent = '当前页面未检测到视频';
        els.videoStatus.className = 'status error';
      }
    }
  } catch (e) {
    // 忽略：下次动作时再刷新
  }
}

// 关闭 / 卸载时：如果控制开启，交回后台离屏引擎继续识别；并释放本页资源
window.addEventListener('pagehide', () => {
  chrome.storage.local.get('floatWindowId').then((data) => {
    if (data.floatWindowId === state.winId) {
      chrome.storage.local.set({ floatWindowId: null }).catch(() => {});
    }
  }).catch(() => {});
  if (state.controlOn && state.tabId) {
    sendToBackground({
      type: 'OFFSCREEN_START',
      tabId: state.tabId,
      shortVideoMode: state.shortVideoMode,
      volumeStep: state.volumeStep,
      debounceMs: state.debounceMs,
      volumeRepeatMs: state.volumeRepeatMs
    });
  }
  stopRecognition();
  stopPreview();
  clearInterval(state.statusTimer);
});

// 启动
init();
