// ============================================================
// grant.js —— 一次性“摄像头授权页”
//
// 用途：Chrome 的扩展弹窗里请求摄像头时，权限提示有时会被
//       自动丢弃（直接返回 NotAllowedError）。此时弹窗会引导用户
//       打开本页面，在标签页里正常授权一次；授权后即可关闭本页，
//       后台（offscreen）识别会自动接管摄像头。
// ============================================================

'use strict';

const params = new URLSearchParams(location.search);
const tabId = parseInt(params.get('tab') || '', 10);
const msgEl = document.getElementById('msg');
const doneBtn = document.getElementById('done');

(async () => {
  try {
    // 只要拿到一次流，就说明权限已授予；随后立即释放，交给后台识别使用
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach((track) => track.stop());

    msgEl.textContent = '✅ 摄像头授权成功！后台手势识别已准备启动，可以关闭本页面。';

    // 通知后台识别引擎启动（目标标签页由弹窗传入）
    if (Number.isInteger(tabId) && tabId > 0) {
      await ensureOffscreen();
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_START',
        tabId: tabId,
        volumeStep: 0.1,
        debounceMs: 900,
        volumeRepeatMs: 650
      }).catch(() => {});
    }
    doneBtn.hidden = false;
  } catch (err) {
    msgEl.textContent =
      '❌ 摄像头授权失败（错误码：' + (err && err.name || '未知') + '）。' +
      '请检查 Windows「设置 → 隐私和安全性 → 相机」是否允许桌面应用访问相机，然后关闭本页重试。';
  }
})();

doneBtn.addEventListener('click', () => window.close());

// 确保离屏文档存在（授权页可能在离屏文档被关闭后打开）
async function ensureOffscreen() {
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: '在后台运行摄像头手势识别，用户无需保持弹窗打开'
      });
      // 等离屏文档加载完成，避免 START 消息丢失
      await new Promise((resolve) => {
        const onMsg = (msg) => {
          if (msg && msg.type === 'OFFSCREEN_READY') {
            chrome.runtime.onMessage.removeListener(onMsg);
            resolve();
          }
        };
        chrome.runtime.onMessage.addListener(onMsg);
        setTimeout(() => {
          chrome.runtime.onMessage.removeListener(onMsg);
          resolve();
        }, 5000);
      });
    }
    return true;
  } catch (e) {
    return false;
  }
}
