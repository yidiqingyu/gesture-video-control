// ============================================================
// background.js —— 后台 Service Worker（Manifest V3）
//
// 职责：
//   1. 扩展安装 / 更新时，把默认设置写入 chrome.storage.local
//   2. 消息路由：离屏文档（offscreen）只能使用 chrome.runtime API，
//      需要操作标签页的消息统一由这里转发给 content script，
//      再把结果回传给请求方。
//   3. **自检与自动恢复**（v1.1 新增，解决「用一段时间就不响应」）：
//      MV3 的 Service Worker 空闲约 30 秒会被浏览器回收，离屏识别页也可能
//      被关掉或被浏览器冻结降频；以前没有任何代码会去重建它，用户只能点一下
//      插件图标把它叫醒。现在用一个每分钟的闹钟做自检，发现异常就自动重建、
//      自动重启、自动补注入页面脚本，并把结果告诉界面。
//
// 闲时开销：闹钟只在「手势控制开着」时存在，关掉开关就清掉。
// ============================================================

'use strict';

// 自检决策是纯逻辑，单独放在 health.js 里（离线可测）
importScripts('health.js');

// 当前手势控制作用的标签页（悬浮面板 / 弹窗启动后台识别时记录）
let controlTabId = null;
// 当前控制页是否为 B 站首页（数字手势只在首页生效）
let currentIsBiliHome = false;

// ---------- 自检相关常量 ----------
const HEALTH_ALARM = 'gvc-health';
const HEALTH_PERIOD_MIN = 1;     // 每分钟自检一次（Chrome 对正式扩展的最小周期就是 1 分钟）
const PROBE_TIMEOUT_MS = 1500;   // 探测离屏引擎 / 页面脚本的等待上限
// 自检记录（stallCount / lastFrames / 健康状态）持久化，
// 因为 Service Worker 会被回收，内存变量靠不住
const HEALTH_KEY = 'gvcHealth';

// MV3 Service Worker 会休眠，内存变量会丢，控制目标要持久化到 storage
function saveControlTab(id) {
  controlTabId = id;
  chrome.storage.local.set({ controlTabId: id }).catch(() => {});
}

function loadControlTab() {
  return chrome.storage.local.get('controlTabId').then((r) => {
    controlTabId = r.controlTabId || null;
    return controlTabId;
  }).catch(() => {
    controlTabId = null;
    return null;
  });
}

// Service Worker 每次被唤醒时恢复控制目标
loadControlTab();

// ---------- 默认设置 ----------
const DEFAULT_SETTINGS = {
  // 一次性手势（OK / 食指切集 / 挥掌）触发后的冷却时间（毫秒）
  debounceMs: 900,
  // 每次调节音量的大小（0 ~ 1，即 10%）
  volumeStep: 0.1,
  // 食指向上/向下长按时，音量重复调节的间隔（毫秒）
  volumeRepeatMs: 650
};

// ---------- 安装 / 更新时写入默认设置 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (saved) => {
    const toSet = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (saved[key] === undefined) {
        toSet[key] = value;
      }
    }
    if (Object.keys(toSet).length > 0) {
      chrome.storage.local.set(toSet);
    }
  });

  // 扩展被重新加载 / 更新后，闹钟会被清掉：如果识别本来就是开着的，
  // 把自检闹钟恢复起来，下一次自检会自动把离屏识别页重建回来
  chrome.storage.session.get('engineActive').then((s) => {
    if (s && s.engineActive) setupHealthAlarm();
  }).catch(() => {});
});

// ============================================================
// 自检与自动恢复
//
// 为什么需要它：MV3 的 Service Worker 空闲约 30 秒会被浏览器回收，离屏识别页
// 也可能被关掉或被浏览器冻结降频（它是个不可见页面，最容易被降频）。
// 旧版没有任何代码会去检查、重建它 —— 所以用一段时间后手势就不响应了，
// 只能点一下插件图标把它叫醒。这里用每分钟一次的闹钟把它补上。
//
// 注意：闹钟只在「手势控制开着」时存在，关掉开关就清掉，不常驻后台。
// ============================================================

function setupHealthAlarm() {
  try {
    // 已经有闹钟就别重建：create 会重置计时，用户频繁开关弹窗会让自检永远不触发
    Promise.resolve(chrome.alarms.get(HEALTH_ALARM)).then((existing) => {
      if (existing) return undefined;
      return chrome.alarms.create(HEALTH_ALARM, {
        delayInMinutes: HEALTH_PERIOD_MIN,
        periodInMinutes: HEALTH_PERIOD_MIN
      });
    }).catch(() => {});
  } catch (e) {
    console.warn('[手势视频控制] 自检闹钟创建失败：', e);
  }
}

function clearHealthAlarm() {
  try {
    Promise.resolve(chrome.alarms.clear(HEALTH_ALARM)).catch(() => {});
  } catch (e) { /* 忽略 */ }
}

// 用户在本会话里启动过识别（storage.session 在浏览器重启后会清空，
// 用它来区分「同一次浏览会话中途断了」和「刚开机」——
// 后者不该自动把摄像头打开）
function markEngineActive() {
  chrome.storage.session.set({ engineActive: true }).catch(() => {});
  // 刚启动就别让界面继续显示上一轮的告警
  chrome.storage.local.set({
    [HEALTH_KEY]: { health: 'ok', stallCount: 0, lastFrames: -1, checkedAt: Date.now() }
  }).catch(() => {});
  setupHealthAlarm();
}

function markEngineStopped() {
  chrome.storage.session.remove('engineActive').catch(() => {});
  chrome.storage.local.set({
    [HEALTH_KEY]: { health: 'off', stallCount: 0, lastFrames: -1, checkedAt: Date.now() }
  }).catch(() => {});
  clearHealthAlarm();
}

// 给 Promise 加超时：离屏页被冻结时消息可能永远不回，自检不能卡死
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

// 探测离屏识别页：没响应返回 null
async function probeEngine() {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (!has) return null;
  const resp = await withTimeout(
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_GET_STATUS' }).catch(() => null),
    PROBE_TIMEOUT_MS,
    null
  );
  return resp && resp.type === 'OFFSCREEN_UPDATE' ? resp : null;
}

// 页面脚本还在不在（PING / PONG）
async function pingTab(tabId) {
  if (!tabId) return false;
  const resp = await withTimeout(
    chrome.tabs.sendMessage(tabId, { type: 'PING' }).catch(() => null),
    PROBE_TIMEOUT_MS,
    null
  );
  return !!(resp && resp.type === 'PONG');
}

// 内容脚本需要的一整套资源。
// 顺序不能乱：ui-icons.js（图标）、theme-mode.js（主题）、gesture-catalog.js（手势表数据）
// 都要排在 content.js 前面。
const CONTENT_FILES = ['gesture-catalog.js', 'ui-icons.js', 'theme-mode.js', 'content.js'];

// 补注入内容脚本时，连设计令牌 theme.css 一起插进去。
// 只走 executeScript 的话，页面里就没有 --gvc-* 令牌，页面内悬浮面板会退化成
// 没有样式的透明框（用 insertCSS 而不是往页面塞 <link>，不受网站 CSP 限制）。
async function injectContentAssets(tabId) {
  if (!tabId) return false;
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['theme.css'] }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  return true;
}

// 给标签页补注入内容脚本，并确认它真的活了
// （固定站点权限的网站一定能注入；任意网站要看 activeTab 还有没有效）
async function ensureScriptIn(tabId) {
  if (!tabId) return false;
  if (await pingTab(tabId)) return true;
  try {
    await injectContentAssets(tabId);
  } catch (e) {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return pingTab(tabId);
}

// 重新指定控制目标：指向当前活动标签页
// （用手势关掉当前页面后，旧目标就失效了，旧版不会重新指向 → 之后所有手势
//   都发给一个不存在的页面，表现就是"不响应了"）
async function repointControlTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const tab = tabs && tabs[0];
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
    // 活动标签页不是普通网页（比如刚关掉最后一个标签页）→ 先清空目标
    saveControlTab(null);
    currentIsBiliHome = false;
    chrome.runtime.sendMessage({ type: 'TARGET_CHANGED', tabId: null, isBiliHome: false }).catch(() => {});
    return { tabId: null, scriptOk: true };
  }
  saveControlTab(tab.id);
  currentIsBiliHome = false;
  const scriptOk = await ensureScriptIn(tab.id);
  chrome.runtime.sendMessage({ type: 'TARGET_CHANGED', tabId: tab.id, isBiliHome: false }).catch(() => {});
  return { tabId: tab.id, scriptOk };
}

function notifyTab(tabId, text) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'SHOW_TOAST', text, duration: 2600 }).catch(() => {});
}

// 在离屏文档里重新启动识别引擎（设置从 storage 读回来）
async function restartEngine(tabId) {
  const settings = await chrome.storage.local
    .get(['shortVideoMode', 'volumeStep', 'debounceMs', 'volumeRepeatMs'])
    .catch(() => ({}));
  if (tabId) saveControlTab(tabId);
  const resp = await withTimeout(
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      tabId: controlTabId,
      isBiliHome: currentIsBiliHome,
      shortVideoMode: !!settings.shortVideoMode,
      volumeStep: typeof settings.volumeStep === 'number' ? settings.volumeStep : 0.1,
      debounceMs: typeof settings.debounceMs === 'number' ? settings.debounceMs : 900,
      volumeRepeatMs: typeof settings.volumeRepeatMs === 'number' ? settings.volumeRepeatMs : 650
    }).catch(() => null),
    PROBE_TIMEOUT_MS,
    null
  );
  return !!(resp && resp.ok);
}

// 按决策依次执行补救动作
async function executeHealthActions(actions, ctx) {
  let scriptOk = ctx.pageScriptOk;
  for (const action of actions) {
    if (action === 'repoint_tab') {
      const r = await repointControlTab();
      ctx.tabId = r.tabId;
      scriptOk = r.scriptOk;
    } else if (action === 'recreate_offscreen') {
      // 先关再建：页面被冻结时"叫它自己重启"是不通的，closeDocument 由
      // Service Worker 执行，不需要离屏页配合
      await chrome.offscreen.closeDocument().catch(() => {});
      try {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['USER_MEDIA'],
          justification: '自检发现后台手势识别已停止，重建离屏文档以恢复识别'
        });
        await waitForOffscreenReady();
      } catch (e) {
        // 已存在或创建失败：下面的 restart_engine 还会再试一次
      }
    } else if (action === 'restart_engine') {
      await restartEngine(ctx.tabId);
    } else if (action === 'ensure_script') {
      scriptOk = await ensureScriptIn(ctx.tabId);
    }
  }
  return { scriptOk };
}

// 一次完整的自检
async function runHealthCheck() {
  const local = await chrome.storage.local
    .get(['controlOn', 'controlTabId', HEALTH_KEY])
    .catch(() => ({}));
  const sess = await chrome.storage.session.get('engineActive').catch(() => ({}));
  const prev = local[HEALTH_KEY] || {};

  controlTabId = local.controlTabId || null;
  let tab = null;
  if (controlTabId) {
    tab = await chrome.tabs.get(controlTabId).catch(() => null);
    if (!tab) controlTabId = null;
  }

  const engine = await probeEngine();
  const engineState = engine ? (engine.running ? 'running' : 'idle') : 'missing';
  const pageScriptOk = tab ? await pingTab(tab.id) : undefined;

  const decision = HealthDecide.check({
    controlOn: !!local.controlOn,
    sessionActive: !!sess.engineActive,
    engineState,
    engineFrames: engine ? (engine.frames || 0) : 0,
    // -1 表示"还没记录过"，第一轮只记录不判卡死
    lastFrames: typeof prev.lastFrames === 'number' ? prev.lastFrames : -1,
    stallCount: prev.stallCount || 0,
    targetTabOk: !!tab,
    pageScriptOk,
    recoverFailures: prev.recoverFailures || 0
  });

  const willRestart = decision.actions.indexOf('restart_engine') !== -1;
  const after = await executeHealthActions(decision.actions, {
    tabId: tab ? tab.id : null,
    pageScriptOk
  });

  // 重建重启到底有没有救回来？要等几秒再探一次才算数 ——
  // 顺便避免"没救回来却在页面上报喜"，以及摄像头坏掉时每分钟空转一轮
  let recoverFailures = prev.recoverFailures || 0;
  if (willRestart) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const again = await probeEngine();
    if (again && again.running) {
      recoverFailures = 0;
      notifyTab(tab ? tab.id : null, '🔄 手势识别已自动恢复');
    } else {
      recoverFailures += 1;
    }
  } else if (engine && engine.running) {
    recoverFailures = 0;
  }

  let health = decision.health;
  if (after.scriptOk === false && (health === 'recovering' || health === 'ok')) {
    // 页面脚本补不进去（多半是任意网站被刷新过，activeTab 授权已失效）
    health = HealthDecide.afterScriptInjectionFailed().health;
  }

  await chrome.storage.local.set({
    [HEALTH_KEY]: {
      health,
      stallCount: decision.stallCount,
      lastFrames: decision.lastFrames,
      engineState,
      scriptOk: after.scriptOk !== false,
      recoverFailures,
      checkedAt: Date.now()
    }
  }).catch(() => {});

  // 让弹窗 / 悬浮面板立刻能看到状态变化
  chrome.runtime.sendMessage({ type: 'HEALTH_UPDATE', health, engineState }).catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== HEALTH_ALARM) return;
  runHealthCheck().catch((e) => console.warn('[手势视频控制] 自检失败：', e));
});

// 浏览器刚启动：storage.session 已经清空，这里不会自动开摄像头；
// 但如果是「扩展被重新加载」（storage.session 还在），就把闹钟恢复起来
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session.get('engineActive').then((s) => {
    if (s && s.engineActive) setupHealthAlarm();
  }).catch(() => {});
});

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  // 弹窗 / 悬浮面板启动、停止识别时，记录会话状态并管理自检闹钟。
  // 真正的启停由离屏文档自己处理，这里只是"旁听"。
  if (message.type === 'OFFSCREEN_START') {
    if (message.tabId) saveControlTab(message.tabId);
    markEngineActive();
    return;
  }
  if (message.type === 'OFFSCREEN_STOP') {
    markEngineStopped();
    return;
  }

  // 弹窗 / 面板查询自检结果
  if (message.type === 'HEALTH_GET') {
    chrome.storage.local.get(HEALTH_KEY)
      .then((r) => sendResponse(r[HEALTH_KEY] || null))
      .catch(() => sendResponse(null));
    return true;
  }

  // 后台识别引擎的状态广播 → 转发给控制中的标签页（悬浮面板显示用）
  if (message.type === 'OFFSCREEN_UPDATE') {
    loadControlTab().then(() => {
      if (!controlTabId) return;
      chrome.tabs.sendMessage(controlTabId, {
        type: 'PANEL_STATUS',
        payload: message
      }).catch(() => {});
    });
    return; // 广播消息，不异步响应
  }

  // 离屏文档 -> 标签页 content script 的转发请求
  if (message.type === 'TAB_MESSAGE') {
    (async () => {
      try {
        const resp = await chrome.tabs.sendMessage(message.tabId, message.payload);
        sendResponse(resp);
        return;
      } catch (err) {
        // 页面脚本可能因为页面导航没了 → 补注入一次再试一次
        const ok = await ensureScriptIn(message.tabId).catch(() => false);
        if (ok) {
          try {
            const resp2 = await chrome.tabs.sendMessage(message.tabId, message.payload);
            sendResponse(resp2);
            return;
          } catch (e2) { /* 落到下面统一报错 */ }
        }
        sendResponse({ status: 'error', message: String((err && err.message) || err) });
      }
    })();
    return true; // 异步响应
  }

  // 弹窗请求：打开悬浮窗（在 Service Worker 中创建窗口，
  // 避免 Chrome 在弹窗里调用 windows.create 时因焦点变化导致弹窗被关闭/创建失败）
  if (message.type === 'OPEN_FLOAT') {
    const url = chrome.runtime.getURL('float.html' + (message.tabId ? '?tab=' + encodeURIComponent(message.tabId) : ''));
    (async () => {
      try {
        // 已有一个悬浮窗时，直接聚焦它，避免两个页面引擎同时运行
        const reg = await chrome.storage.local.get('floatWindowId');
        if (reg.floatWindowId) {
          try {
            await chrome.windows.get(reg.floatWindowId);
            await chrome.windows.update(reg.floatWindowId, { focused: true });
            sendResponse({ ok: true, reused: true });
            return;
          } catch (e) {
            // 记录中的窗口已关闭，继续创建新窗口
            await chrome.storage.local.set({ floatWindowId: null });
          }
        }
        const win = await chrome.windows.getLastFocused();
        const created = await chrome.windows.create({
          url: url,
          type: 'popup',
          frame: 'none',
          width: 300,
          height: 480,
          left: (win.left || 0) + Math.max(0, (win.width || 1280) - 340),
          top: (win.top || 0) + 80,
          focused: true
        });
        if (created && created.id) {
          await chrome.storage.local.set({ floatWindowId: created.id });
        }
        sendResponse({ ok: !!created });
      } catch (e) {
        // 某些环境不允许创建悬浮窗时，退化为普通标签页
        try {
          await chrome.tabs.create({ url: url, active: true });
          sendResponse({ ok: false, fallback: true });
        } catch (e2) {
          sendResponse({ ok: false, error: String((e2 && e2.message) || e2) });
        }
      }
    })();
    return true; // 异步响应
  }

  // 预留：处理内容脚本上报的错误
  if (message.type === 'ERROR_REPORT') {
    console.warn('[手势视频控制] 内容脚本上报错误：', message.error);
  }

  // 双手食指交叉：关闭当前标签页（content script 无法直接关闭，由后台执行）
  if (message.type === 'CLOSE_TAB') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
    sendResponse({ ok: !!tabId });
    return;
  }

  // 原生级鼠标点击（B 站“换一换”等只响应 isTrusted 的真实事件，
  // 页面内合成事件无效，必须用 CDP Input.dispatchMouseEvent）
  if (message.type === 'CLICK_AT') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId || typeof message.x !== 'number' || typeof message.y !== 'number') {
      sendResponse({ ok: false, error: '缺少点击坐标' });
      return;
    }
    (async () => {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: message.x, y: message.y, button: 'left', clickCount: 1
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: message.x, y: message.y, button: 'left', clickCount: 1
        });
        await chrome.debugger.detach({ tabId });
        sendResponse({ ok: true });
      } catch (e) {
        try { await chrome.debugger.detach({ tabId }); } catch (e2) { /* 忽略 */ }
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步响应
  }

  // 内容脚本上报页面类型（是否 B 站首页），存下来并广播给识别引擎
  if (message.type === 'PAGE_INFO') {
    // 只更新页面类型状态；控制目标由标签切换（onActivated/onUpdated）绑定，
    // 避免后台标签加载时抢占当前控制目标
    currentIsBiliHome = !!message.isBiliHome;
    chrome.runtime.sendMessage({ type: 'PAGE_INFO_SET', isBiliHome: currentIsBiliHome }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  // 离屏文档无法直接访问 chrome.storage，由后台代为写入短视频模式状态
  if (message.type === 'SHORT_VIDEO_MODE_SET') {
    chrome.storage.local.set({ shortVideoMode: !!message.value });
    sendResponse({ ok: true });
  }

  // 悬浮面板：开启 / 关闭手势控制（由后台统一管理离屏识别引擎）
  if (message.type === 'PANEL_CONTROL') {
    (async () => {
      try {
        const tabId = message.tabId || (sender && sender.tab && sender.tab.id);
        if (message.on) {
          const ok = await ensureOffscreen();
          if (!ok) {
            sendResponse({ ok: false, error: '后台识别页创建失败' });
            return;
          }
          if (tabId) saveControlTab(tabId);
          await chrome.storage.local.set({ controlOn: true });
          // 面板这条路是 Service Worker 自己发的 OFFSCREEN_START，
          // 自己发的消息自己收不到，所以要显式记录会话状态并开自检闹钟
          markEngineActive();
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_START',
            tabId: controlTabId,
            isBiliHome: currentIsBiliHome,
            shortVideoMode: message.shortVideoMode,
            volumeStep: message.volumeStep,
            debounceMs: message.debounceMs,
            volumeRepeatMs: message.volumeRepeatMs
          }).catch(() => {});
          sendResponse({ ok: true });
        } else {
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
          await chrome.storage.local.set({ controlOn: false });
          markEngineStopped();
          sendResponse({ ok: true });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步响应
  }

  // 悬浮面板显示时注册状态转发目标（引擎可能已由弹窗启动）
  if (message.type === 'PANEL_ATTACH') {
    const tabId = message.tabId || (sender && sender.tab && sender.tab.id);
    if (tabId) saveControlTab(tabId);
    // 把当前后台引擎状态立即回给面板
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_GET_STATUS' }, (resp) => {
      if (resp && resp.type === 'OFFSCREEN_UPDATE') {
        chrome.tabs.sendMessage(tabId, { type: 'PANEL_STATUS', payload: resp }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
  }
});

// ---------- 离屏文档管理（供悬浮面板使用）----------
async function ensureOffscreen() {
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: '在后台运行摄像头手势识别，用户无需保持弹窗打开'
      });
      await waitForOffscreenReady();
    }
    return true;
  } catch (e) {
    console.warn('[手势视频控制] 离屏文档创建失败：', e);
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

// 悬浮窗被关闭时，清理记录的窗口 id（下次可重新创建）
chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.local.get('floatWindowId', (data) => {
    if (data.floatWindowId === windowId) {
      chrome.storage.local.set({ floatWindowId: null });
    }
  });
});

// 把手势控制目标切换到指定标签，并通知识别引擎
function switchControlTab(tabId) {
  saveControlTab(tabId);
  currentIsBiliHome = false;
  injectContentAssets(tabId).catch(() => {});
  chrome.runtime.sendMessage({
    type: 'TARGET_CHANGED',
    tabId,
    isBiliHome: false
  }).catch(() => {});
}

// 标签加载完成：
//  1) 是当前控制标签 → 兜底重新注入 content（固定站点权限的网站一定能注入）
//  2) 是其它「能控制的视频站」标签且当前正被激活 → 把手势控制目标跟过去
//     （首页点视频常开新标签，onActivated 触发时新标签 URL 可能还没就绪，
//       这里在加载完成后补刀切换，避免引擎一直绑着旧标签）
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  await loadControlTab();
  if (!tab || !tab.url) return;
  if (tabId === controlTabId) {
    injectContentAssets(tabId).catch(() => {});
    currentIsBiliHome = false;
    chrome.runtime.sendMessage({ type: 'TARGET_CHANGED', tabId, isBiliHome: false }).catch(() => {});
    return;
  }
  if (!HealthDecide.isControllableUrl(tab.url)) return;
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (active && active[0] && active[0].id === tabId) {
    switchControlTab(tabId);
  }
});

// 用户切到其它「能控制的视频站」标签页时，立即尝试跟随（URL 已就绪的情况）
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await loadControlTab();
  if (!controlTabId || activeInfo.tabId === controlTabId) return;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    if (!HealthDecide.isControllableUrl(tab.url)) return;
    switchControlTab(activeInfo.tabId);
  });
});

// 控制目标标签页被关掉了（很可能就是「双手食指交叉关闭当前页面」这个手势）
// → 立刻把控制权交给当前活动标签页。
// 旧版没有这一步：目标页一关，之后所有手势指令都发给一个已经不存在的页面，
// 表现就是"手势不响应了"，必须点一下插件图标才能恢复。
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  await loadControlTab();
  if (!controlTabId || closedTabId !== controlTabId) return;
  await repointControlTab();
});
