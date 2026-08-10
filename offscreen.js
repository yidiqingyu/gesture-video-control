// 官方 MediaPipe Tasks Vision（ES Module，随扩展本地打包）
import { FilesetResolver, HandLandmarker } from './vendor/mediapipe/vision_bundle.mjs';

// ============================================================
// offscreen.js —— 后台手势识别引擎（在不可见的离屏文档中运行）
//
// 职责：
//   1. 获取摄像头并加载 MediaPipe Hands，逐帧识别手势
//   2. 识别到动作后，把指令发给目标标签页的 content script
//   3. 把当前手势 / 模型状态 / 页面视频状态通知给弹窗
//   4. 按需给弹窗发送低帧率预览帧（弹窗关闭后自动停止发送）
//
// 这样设计后，用户关闭弹窗也能继续用手势控制视频，且不遮挡画面。
// ============================================================

'use strict';

const GestureMath = globalThis.GestureMath;

// ---------- 元素与状态 ----------
const els = {
  camera: document.getElementById('camera')
};

const state = {
  targetTabId: null,     // 被控制的视频标签页
  controlOn: false,      // 手势控制开关（由弹窗同步）
  hands: null,           // MediaPipe Hands 实例
  modelReady: false,
  cameraStream: null,
  running: false,
  processing: false,     // 防止同一帧重复处理
  lastActionTime: 0,     // 一次性手势防抖
  lastVolumeTime: 0,     // 音量长按重复
  stablePose: '',
  stableFrames: 0,
  okPinched: false,      // OK 手势捏合跳变检测
  handFoundFrames: 0,    // 连续检测到手的帧数（显示防抖用）
  handLostFrames: 0,     // 连续没检测到手的帧数（显示防抖用）
  shortVideoMode: false, // 短视频模式（默认长视频模式）
  palmHoldStart: null,   // 手掌张开保持计时的起点
  palmHoldTriggered: false, // 本次保持是否已触发过模式切换
  debounceMs: 900,
  volumeStep: 0.1,
  volumeRepeatMs: 650,
  currentGesture: '等待识别…',
  currentDetail: '',
  handDetected: false,
  frames: 0,             // 已成功处理的帧数（诊断用：判断引擎是否在跑）
  frameErrors: 0,        // 连续失败的帧数（诊断用：静默失败不再吞掉）
  frameTimer: null,      // 帧循环定时器（离屏文档不可见，rAF 不触发，必须用定时器）
  usedCpuDelegate: false,// 是否已使用 CPU 委托（部分机器 GPU 模式检测为空）
  gpuFallbackTimer: null,// GPU 无检测结果时自动切 CPU 的定时器
  errorText: '',
  videoStatus: { text: '正在检测当前页面…', kind: '' }
};

// 显示防抖：身体晃动造成的“疑似手”会一闪而过。
// 连续 3 帧检测到手才恢复手势显示；连续 6 帧没检测到手才显示“未检测到手”。
const FOUND_HAND_MIN_FRAMES = 3;
const LOST_HAND_MIN_FRAMES = 6;

// ============================================================
// 消息处理（来自弹窗）
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'OFFSCREEN_START':
      if (message.tabId) state.targetTabId = message.tabId;
      state.controlOn = true;
      // 离屏文档不能直接访问 chrome.storage，模式由弹窗/悬浮窗随消息传入
      if (typeof message.shortVideoMode === 'boolean') {
        state.shortVideoMode = message.shortVideoMode;
      }
      if (typeof message.volumeStep === 'number') state.volumeStep = message.volumeStep;
      if (typeof message.debounceMs === 'number') state.debounceMs = message.debounceMs;
      if (typeof message.volumeRepeatMs === 'number') state.volumeRepeatMs = message.volumeRepeatMs;
      startEngine();
      sendResponse({ ok: true });
      break;
    case 'OFFSCREEN_STOP':
      state.controlOn = false;
      stopEngine();
      sendResponse({ ok: true });
      break;
    case 'OFFSCREEN_SET_MODE':
      // 弹窗 / 悬浮面板切换短视频模式时即时同步（离屏文档无法直接读 storage）
      if (typeof message.shortVideoMode === 'boolean') {
        state.shortVideoMode = message.shortVideoMode;
      }
      if (typeof message.volumeStep === 'number') state.volumeStep = message.volumeStep;
      if (typeof message.debounceMs === 'number') state.debounceMs = message.debounceMs;
      if (typeof message.volumeRepeatMs === 'number') state.volumeRepeatMs = message.volumeRepeatMs;
      notify();
      sendResponse({ ok: true });
      break;
    case 'OFFSCREEN_GET_STATUS':
      sendResponse(buildStatus());
      break;
  }
});

// 通知弹窗：本离屏文档已加载完成（避免消息在脚本加载完成前丢失）
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

// ============================================================
// 启动 / 停止
// ============================================================
async function startEngine() {
  if (state.running) return;
  state.running = true;
  state.errorText = '';
  notify();
  try {
    if (!state.cameraStream) {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
    }
    els.camera.srcObject = state.cameraStream;
    await els.camera.play();
    await loadHandsModel();
    await refreshVideoStatus();
  } catch (err) {
    state.running = false;
    state.errorText = '摄像头启动失败（错误码：' + (err && err.name || '未知') + '）：' + ((err && err.message) || err);
    notify();
  }
}

function stopEngine() {
  state.running = false;
  state.processing = false;
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  state.hands = null;
  state.modelReady = false;
  if (state.gpuFallbackTimer) {
    clearTimeout(state.gpuFallbackTimer);
    state.gpuFallbackTimer = null;
  }
  if (state.frameTimer) {
    clearTimeout(state.frameTimer);
    state.frameTimer = null;
  }
  state.currentGesture = '等待识别…';
  state.errorText = '';
  notify();
}

// ============================================================
// MediaPipe Hands
// ============================================================
async function loadHandsModel() {
  if (typeof FilesetResolver !== 'function' || typeof HandLandmarker !== 'function') {
    state.errorText = 'MediaPipe 加载失败：vendor/mediapipe/vision_bundle.js 缺失';
    notify();
    return;
  }
  try {
    // 初始化 wasm 运行时
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
    // GPU 优先；部分显卡/驱动上 GPU 委托失败时自动回退 CPU
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
    state.hands = landmarker;
    state.usedCpuDelegate = usedCpu;
    state.modelReady = true;
    // GPU 模式跑一会儿仍检测不到手 → 自动切换 CPU（更兼容）
    scheduleGpuFallback();
    notify();
    scheduleNextFrame();
  } catch (err) {
    state.errorText = '模型加载失败：' + ((err && err.message) || err);
    notify();
  }
}

async function processFrame() {
  if (!state.running) {
    state.frameTimer = null;
    return;
  }
  if (!state.processing && state.hands && els.camera.readyState >= 2) {
    state.processing = true;
    try {
      // 新版 API：同步检测当前视频帧（时间戳需单调递增）
      const result = state.hands.detectForVideo(els.camera, performance.now());
      state.frames += 1;
      if (state.frameErrors >= 10) {
        state.frameErrors = 0;
        state.errorText = '';
        notify();
      }
      onHandsResults(result);
    } catch (e) {
      // 单帧失败不中断循环，但连续失败时上报，避免“静默不识别”
      state.frameErrors += 1;
      if (state.frameErrors === 10 || state.frameErrors % 50 === 0) {
        state.errorText = '识别引擎异常：' + ((e && e.message) || e);
        notify();
      }
    }
    state.processing = false;
  }
  scheduleNextFrame();
}

// 离屏文档是不可见页面：requestAnimationFrame 不触发（本机实测 15 秒仅 1 次），
// 必须用定时器驱动逐帧识别；约 30fps 足够手势检测。
const FRAME_INTERVAL_MS = 33;

function scheduleNextFrame() {
  if (state.frameTimer) clearTimeout(state.frameTimer);
  state.frameTimer = setTimeout(processFrame, FRAME_INTERVAL_MS);
}

// GPU 模式几秒内检测不到手时，自动重建为 CPU 委托（部分机器 GPU/WebGL 渲染异常）
function scheduleGpuFallback() {
  if (state.usedCpuDelegate) return;
  clearTimeout(state.gpuFallbackTimer);
  state.gpuFallbackTimer = setTimeout(async () => {
    if (state.usedCpuDelegate || state.handDetected || !state.running) return;
    if (state.frames < 30) return; // 帧数太少说明仍在启动，继续等待
    state.usedCpuDelegate = true;
    state.errorText = 'GPU 模式下未检测到手，已自动切换 CPU 模式（更兼容，切换需几秒）';
    notify();
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
      state.hands = landmarker;
      state.errorText = '';
      notify();
    } catch (err) {
      state.errorText = 'CPU 模式切换失败：' + ((err && err.message) || err);
      notify();
    }
  }, 5000);
}

// ============================================================
// 手势分类与动作触发（防抖 / 稳定帧 / 连续调节）
// ============================================================
function onHandsResults(results) {
  if (!state.running) return;

  // 新版 HandLandmarker 的结果结构：results.landmarks = [每只手的 21 个关键点]
  const hands = results && results.landmarks;
  if (!hands || hands.length === 0) {
    state.handFoundFrames = 0;
    state.handLostFrames += 1;
    // 偶发漏检（一两帧没跟上）不立即切换显示，避免 UI 闪烁
    if (state.handLostFrames < LOST_HAND_MIN_FRAMES) return;
    if (state.handDetected) {
      state.handDetected = false;
      notify();
    }
    setGesture('未检测到手', '请将手掌完整放入摄像头画面');
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
  const pose = GestureMath.classifyPose(lm);
  if (!state.handDetected) {
    state.handDetected = true;
    if (state.gpuFallbackTimer) {
      clearTimeout(state.gpuFallbackTimer);
      state.gpuFallbackTimer = null;
    }
    notify();
  }
  setGesture(pose.name, pose.detail);

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
        triggerAction('play_pause', 'OK');
      }
    }
  } else {
    state.okPinched = false;
  }

  // 小拇指上/下：长按连续调音量
  if (stable && (pose.name === '小拇指向上' || pose.name === '小拇指向下')) {
    if (now - state.lastVolumeTime >= state.volumeRepeatMs) {
      state.lastVolumeTime = now;
      triggerAction(pose.name === '小拇指向上' ? 'volume_up' : 'volume_down', pose.name);
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
      triggerAction(pose.name === '食指向上' ? 'scroll_up' : 'scroll_down', pose.name);
    } else {
      triggerAction(pose.name === '食指向上' ? 'prev' : 'next', pose.name);
    }
  }

  // 点赞（竖大拇指）：给当前视频点赞
  if (stable && pose.name === '点赞' && now - state.lastActionTime >= state.debounceMs) {
    state.lastActionTime = now;
    triggerAction('like', '点赞');
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
  const next = !state.shortVideoMode;
  state.shortVideoMode = next;
  // 离屏文档无法直接写 storage，交给后台 Service Worker 落盘并通知其他界面
  chrome.runtime.sendMessage({ type: 'SHORT_VIDEO_MODE_SET', value: next }).catch(() => {});
  setGesture('手掌张开', next ? '已切换到短视频模式（食指上=↑，食指下=↓）' : '已切回长视频模式');
  notify();
}

function setGesture(name, detail) {
  detail = detail || '';
  if (name !== state.currentGesture || detail !== state.currentDetail) {
    state.currentGesture = name;
    state.currentDetail = detail;
    notify();
  }
}

// ============================================================
// 发送动作到 content script（操作视频）
// ============================================================
async function triggerAction(action, gestureName) {
  if (!state.controlOn || !state.targetTabId) return;
  try {
    // 离屏文档只能使用 chrome.runtime，因此通过 Service Worker 转发给页面
    const resp = await chrome.runtime.sendMessage({
      type: 'TAB_MESSAGE',
      tabId: state.targetTabId,
      payload: {
        type: 'GESTURE_ACTION',
        action: action,
        gesture: gestureName,
        volumeStep: state.volumeStep
      }
    });
    if (resp && resp.status === 'no_video') {
      state.videoStatus = { text: '当前页面未检测到视频', kind: 'error' };
    } else if (resp && resp.status === 'ok') {
      await refreshVideoStatus();
      return;
    } else if (resp && resp.status === 'error') {
      state.videoStatus = { text: '⚠️ 无法连接页面（请重新打开扩展图标后再试）', kind: 'warn' };
    }
  } catch (e) {
    state.videoStatus = { text: '⚠️ 无法操作页面（请重新打开扩展图标后再试）', kind: 'warn' };
  }
  notify();
}

async function refreshVideoStatus() {
  if (!state.targetTabId) return;
  try {
    // 同样通过 Service Worker 转发
    const resp = await chrome.runtime.sendMessage({
      type: 'TAB_MESSAGE',
      tabId: state.targetTabId,
      payload: { type: 'GET_STATUS' }
    });
    if (resp && resp.type === 'STATUS') {
      if (resp.hasVideo) {
        const vol = Math.round((resp.volume || 0) * 100);
        state.videoStatus = {
          text: '✅ 已检测到视频（' + resp.host + '）｜' +
                (resp.playing ? '▶ 播放中' : '⏸ 已暂停') +
                '｜音量 ' + vol + '%' +
                (resp.muted ? '｜🔇 已静音' : ''),
          kind: 'ok'
        };
      } else {
        state.videoStatus = { text: '当前页面未检测到视频', kind: 'error' };
      }
    } else if (resp && resp.status === 'error') {
      state.videoStatus = { text: '无法连接页面（请重新打开扩展图标后开启）', kind: 'warn' };
    }
  } catch (e) {
    state.videoStatus = { text: '无法连接页面（请重新打开扩展图标后开启）', kind: 'warn' };
  }
  notify();
}

// ============================================================
// 状态通知 / 预览帧（发给弹窗）
// ============================================================
function buildStatus() {
  return {
    type: 'OFFSCREEN_UPDATE',
    gesture: state.currentGesture,
    detail: state.currentDetail,
    handDetected: state.handDetected,
    frames: state.frames,
    frameErrors: state.frameErrors,
    running: state.running,
    modelReady: state.modelReady,
    errorText: state.errorText,
    videoStatus: state.videoStatus
  };
}

function notify() {
  chrome.runtime.sendMessage(buildStatus()).catch(() => {});
}
