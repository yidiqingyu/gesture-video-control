// ============================================================
// background.js —— 后台 Service Worker（Manifest V3）
//
// 职责：
//   1. 扩展安装 / 更新时，把默认设置写入 chrome.storage.local
//   2. 消息路由：离屏文档（offscreen）只能使用 chrome.runtime API，
//      需要操作标签页的消息统一由这里转发给 content script，
//      再把结果回传给请求方。
// ============================================================

'use strict';

// 当前手势控制作用的标签页（悬浮面板 / 弹窗启动后台识别时记录）
let controlTabId = null;

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
});

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  // 后台识别引擎的状态广播 → 转发给控制中的标签页（悬浮面板显示用）
  if (message.type === 'OFFSCREEN_UPDATE' && controlTabId) {
    chrome.tabs.sendMessage(controlTabId, {
      type: 'PANEL_STATUS',
      payload: message
    }).catch(() => {});
    return; // 广播消息，不异步响应
  }

  // 离屏文档 -> 标签页 content script 的转发请求
  if (message.type === 'TAB_MESSAGE') {
    chrome.tabs.sendMessage(message.tabId, message.payload)
      .then((resp) => sendResponse(resp))
      .catch((err) => {
        sendResponse({ status: 'error', message: String((err && err.message) || err) });
      });
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
          controlTabId = tabId || controlTabId;
          await chrome.storage.local.set({ controlOn: true });
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_START',
            tabId: controlTabId,
            shortVideoMode: message.shortVideoMode,
            volumeStep: message.volumeStep,
            debounceMs: message.debounceMs,
            volumeRepeatMs: message.volumeRepeatMs
          }).catch(() => {});
          sendResponse({ ok: true });
        } else {
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
          await chrome.storage.local.set({ controlOn: false });
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
    if (tabId) controlTabId = tabId;
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
