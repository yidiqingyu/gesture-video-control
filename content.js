// ============================================================
// content.js —— 内容脚本（注入到网页里）
//
// 职责：
//   1. 接收来自 popup 的手势动作消息（chrome.tabs.sendMessage）
//   2. 找到页面上的 <video> 元素并执行播放/暂停/音量/静音
//   3. 针对 YouTube / B 站做“下一集 / 上一集”按钮适配
//   4. 用 Shadow DOM 显示一个不干扰页面样式的小提示浮层
//
// 注意：
//   - 本脚本运行在“隔离世界”中，无法读取页面的 JS 变量，
//     但可以正常操作 DOM（video、播放器按钮等）。
//   - 本脚本由 popup 通过 chrome.scripting 按需注入（activeTab 权限），
//     不会常驻所有页面。
// ============================================================

(() => {
  'use strict';

  // ---------- 配置 ----------
  const TOAST_DURATION = 1500; // 提示浮层显示时长（毫秒）

  // “下一集 / 上一集”按钮选择器（按优先级排列）。
  // 遇到其它视频网站时，可以在这里补充对应的选择器。
  const NEXT_SELECTORS = [
    '.ytp-next-button',                  // YouTube 官方播放器
    '.bpx-player-ctrl-next',             // B 站新版播放器
    '.bilibili-player-video-btn-next',   // B 站旧版播放器
    '[aria-label*="下一" i]',            // 通用：aria-label 含“下一”
    '[aria-label*="Next" i]',            // 通用：aria-label 含 Next
    'button[class*="next" i], a[class*="next" i]' // 通用兜底
  ];
  const PREV_SELECTORS = [
    '.ytp-prev-button',
    '.bpx-player-ctrl-prev',
    '.bilibili-player-video-btn-prev',
    '[aria-label*="上一" i]',
    '[aria-label*="Previous" i]',
    'button[class*="prev" i], a[class*="prev" i]'
  ];

  // ---------- 视频查找 ----------
  // 找出页面上“最主要”的 <video>：
  //   优先选择可见面积最大、且已加载时长信息的播放器。
  function findMainVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;

    let best = null;
    let bestScore = -1;
    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      // 跳过过小或隐藏的播放器（避免选中站内小图标 / 广告视频）
      if (rect.width < 80 || rect.height < 60) continue;
      const area = rect.width * rect.height;
      const hasDuration = Number.isFinite(video.duration) && video.duration > 0;
      // 加权：已加载时长信息的视频权重更高，其次参考 readyState
      const score = area * (hasDuration ? 10 : 1) + video.readyState * 100;
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  // 汇总页面视频状态（供 popup 显示）
  function getVideoStatus() {
    const video = findMainVideo();
    return {
      type: 'STATUS',
      host: location.hostname,
      hasVideo: !!video,
      playing: video ? !video.paused && !video.ended : false,
      volume: video ? video.volume : 0,
      muted: video ? video.muted : false
    };
  }

  // ---------- 基础播放控制 ----------
  async function togglePlayPause() {
    const video = findMainVideo();
    if (!video) return { status: 'no_video' };

    if (video.paused) {
      try {
        await video.play();
      } catch (e) {
        // 常见原因：浏览器自动播放策略（扩展发起的 play() 不算用户手势）
        return {
          status: 'error',
          message: '播放失败：浏览器自动播放策略限制，请先在页面上手动点击一次视频'
        };
      }
    } else {
      video.pause();
    }
    return { status: 'ok' };
  }

  function changeVolume(delta) {
    const video = findMainVideo();
    if (!video) return { status: 'no_video' };
    video.muted = false; // 调音量时自动取消静音
    video.volume = Math.min(1, Math.max(0, Math.round((video.volume + delta) * 100) / 100));
    return { status: 'ok', volume: video.volume, muted: video.muted };
  }

  function toggleMute() {
    const video = findMainVideo();
    if (!video) return { status: 'no_video' };
    video.muted = !video.muted;
    return { status: 'ok', muted: video.muted };
  }

  // ---------- 切集（下一集 / 上一集）----------
  function clickBySelectors(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && typeof el.click === 'function') {
        el.click();
        return true;
      }
    }
    return false;
  }

  function nextVideo() {
    return clickBySelectors(NEXT_SELECTORS)
      ? { status: 'ok' }
      : { status: 'error', message: '未找到“下一集”按钮（该页面可能不支持切集）' };
  }

  function prevVideo() {
    return clickBySelectors(PREV_SELECTORS)
      ? { status: 'ok' }
      : { status: 'error', message: '未找到“上一集”按钮（该页面可能不支持切集）' };
  }

  // ---------- 短视频滑动（滚动 + 方向键双管齐下）----------
  // 抖音等短视频站：
  //   - 推荐流靠“滚动容器”把下一个视频滚进视口；
  //   - 视频详情页 / YouTube Shorts 靠“方向键”切换视频。
  // 两种都触发，总有一款生效。
  function findScrollContainer() {
    const root = document.scrollingElement || document.documentElement;
    const isScrollable = (el) => {
      if (!el || el.scrollHeight <= el.clientHeight + 80) return false;
      const style = getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(style.overflowY);
    };

    // 1) 优先找“主视频所在的可滚动容器”，跟着视频走，避免滚到侧边栏
    for (const v of document.querySelectorAll('video')) {
      let el = v.parentElement;
      while (el && el !== document.body) {
        if (isScrollable(el)) return el;
        el = el.parentElement;
      }
    }

    // 2) 页面主滚动条可用时用它
    if (isScrollable(root)) return root;

    // 3) 兜底：面积最大的可滚动容器（避开窄侧边栏）
    let best = root;
    let bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (isScrollable(el)) {
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
    }
    return best;
  }

  function sendDirectionKey(direction) {
    const key = direction === 'down' ? 'ArrowDown' : 'ArrowUp';
    const keyCode = direction === 'down' ? 40 : 38;
    // keydown/keyup 都派发，兼容不同监听方式；
    // 只派发到 document（事件会冒泡到 window），避免重复触发
    for (const type of ['keydown', 'keyup']) {
      const evt = new KeyboardEvent(type, {
        key, code: key, bubbles: true, cancelable: true
      });
      // 兼容只读 keyCode 的老式监听器
      Object.defineProperty(evt, 'keyCode', { get: () => keyCode });
      Object.defineProperty(evt, 'which', { get: () => keyCode });
      document.dispatchEvent(evt);
    }
  }

  function scrollPage(direction) {
    const el = findScrollContainer();
    const distance = (direction === 'down' ? 1 : -1) * Math.max(el.clientHeight || 480, 480);
    el.scrollBy({ top: distance, behavior: 'smooth' });
    return { status: 'ok' };
  }

  // 记录当前“正在播的视频”，用于判断一次切换是否真的生效
  function captureVideoState() {
    const v = findMainVideo();
    return {
      el: v,
      src: v ? v.currentSrc || v.src || '' : '',
      // 抖音网页版用 data-e2e="feed-active-video" 标记当前活动视频
      active: document.querySelector('[data-e2e="feed-active-video"]')
    };
  }

  function videoStateChanged(prev) {
    const now = captureVideoState();
    if (now.active && prev.active && now.active !== prev.active) return true;
    if (now.src && prev.src && now.src !== prev.src) return true;
    return false;
  }

  // 刷视频多路尝试：官方按钮 → 方向键 → 滚轮 → 滚动容器。
  // 每触发一路后等 120ms 检查页面是否真的切了视频，没切才继续下一路：
  // 既兼容不同站点，又避免一次手势同时触发多路导致切两个视频。
  function swipeVideo(direction) {
    const down = direction === 'down';
    const prevState = captureVideoState();

    // 1) 站点自带的“下一个 / 上一个”按钮
    //    抖音网页版：推荐流右侧箭头 [data-e2e="video-switch-next-arrow"] 等
    const nextSels = [
      '[data-e2e="video-switch-next-arrow"]',
      '[aria-label*="下一个" i]', '[aria-label*="下一条" i]', '[aria-label*="Next" i]',
      'button[class*="next" i]', 'a[class*="next" i]',
      '[class*="next-arrow" i]', '[class*="swiper-next" i]', '[class*="arrow-right" i]'
    ];
    const prevSels = [
      '[data-e2e="video-switch-prev-arrow"]',
      '[aria-label*="上一个" i]', '[aria-label*="上一条" i]', '[aria-label*="Prev" i]',
      'button[class*="prev" i]', 'a[class*="prev" i]',
      '[class*="prev-arrow" i]', '[class*="swiper-prev" i]', '[class*="arrow-left" i]'
    ];
    for (const sel of (down ? nextSels : prevSels)) {
      const el = document.querySelector(sel);
      // 不检查可见性：JS 的 click() 对隐藏按钮同样有效
      if (el && typeof el.click === 'function') {
        el.click();
        return;
      }
    }

    // 2) 方向键：抖音网页版全局监听 ↑↓ 切换视频
    sendDirectionKey(down ? 'down' : 'up');

    setTimeout(() => {
      if (videoStateChanged(prevState)) return;

      // 3) 滚轮事件（部分站点监听 wheel 切换视频）
      const mainVideo = findMainVideo();
      const wheelTarget = mainVideo || document;
      wheelTarget.dispatchEvent(new WheelEvent('wheel', {
        deltaY: down ? 240 : -240,
        deltaMode: 0,
        bubbles: true,
        cancelable: true
      }));

      setTimeout(() => {
        if (videoStateChanged(prevState)) return;

        // 4) 兜底：滚动主视频容器
        scrollPage(direction);
      }, 120);
    }, 120);
  }

  // ---------- 提示浮层（Shadow DOM 隔离样式）----------
  let toastHost = null;
  let toastBox = null;
  let toastTimer = null;

  function showToast(text) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = 'gesture-video-control-toast-host';
      // Shadow DOM：页面的 CSS 无法影响浮层，浮层也不会污染页面样式
      const shadow = toastHost.attachShadow({ mode: 'open' });
      toastBox = document.createElement('div');
      // 通过 CSSOM（style 属性）设置样式，不受页面 CSP 的限制
      Object.assign(toastBox.style, {
        position: 'fixed',
        top: '20px',
        right: '20px',
        padding: '10px 16px',
        borderRadius: '10px',
        background: 'rgba(10, 16, 28, 0.92)',
        color: '#ffffff',
        fontSize: '14px',
        fontFamily: '"Microsoft YaHei", system-ui, sans-serif',
        lineHeight: '1.5',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
        zIndex: '2147483647',
        pointerEvents: 'none',
        opacity: '0',
        transform: 'translateY(-8px)',
        transition: 'opacity 0.25s ease, transform 0.25s ease'
      });
      shadow.appendChild(toastBox);
      document.documentElement.appendChild(toastHost);
    }

    toastBox.textContent = text;
    toastBox.style.opacity = '1';
    toastBox.style.transform = 'translateY(0)';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastBox.style.opacity = '0';
      toastBox.style.transform = 'translateY(-8px)';
    }, TOAST_DURATION);
  }

  // ---------- 动作执行（含浮层反馈文案）----------
  async function handleGestureAction(message) {
    const action = message.action;
    const volumeStep = (typeof message.volumeStep === 'number') ? message.volumeStep : 0.1;

    switch (action) {
      case 'play_pause': {
        const r = await togglePlayPause();
        if (r.status === 'ok') {
          const video = findMainVideo();
          r.toast = (video && !video.paused) ? '▶ 播放' : '⏸ 暂停';
        }
        return r;
      }
      case 'volume_up':
      case 'volume_down': {
        const delta = (action === 'volume_up' ? 1 : -1) * volumeStep;
        const r = changeVolume(delta);
        if (r.status === 'ok') {
          r.toast = (action === 'volume_up' ? '🔊 音量 +' : '🔉 音量 -') + ' ' + Math.round(r.volume * 100) + '%';
        }
        return r;
      }
      case 'mute': {
        const r = toggleMute();
        if (r.status === 'ok') r.toast = r.muted ? '🔇 已静音' : '🔊 已取消静音';
        return r;
      }
      case 'next': {
        const r = nextVideo();
        if (r.status === 'ok') r.toast = '⏭ 下一集';
        return r;
      }
      case 'prev': {
        const r = prevVideo();
        if (r.status === 'ok') r.toast = '⏮ 上一集';
        return r;
      }
      // 短视频模式：像手指刷视频一样滚动页面（一屏）
      case 'scroll_down': {
        swipeVideo('down');
        return { status: 'ok', toast: '⬇ 向下滑动' };
      }
      case 'scroll_up': {
        swipeVideo('up');
        return { status: 'ok', toast: '⬆ 向上滑动' };
      }
      default:
        return { status: 'error', message: '未知动作: ' + action };
    }
  }

  // ---------- 消息监听 ----------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (!message || typeof message.type !== 'string') {
        return { status: 'error', message: '未知消息' };
      }
      switch (message.type) {
        case 'PING':
          return { type: 'PONG' };
        case 'GET_STATUS':
          return getVideoStatus();
        case 'GESTURE_ACTION': {
          const result = await handleGestureAction(message);
          // 页面提示浮层反馈
          if (result.status === 'ok') {
            showToast(result.toast || message.gesture || '已执行');
          } else if (result.status === 'no_video') {
            showToast('当前页面未检测到视频');
          }
          return result;
        }
        default:
          return { status: 'error', message: '未知消息类型: ' + message.type };
      }
    })().then(sendResponse).catch((err) => {
      sendResponse({ status: 'error', message: String((err && err.message) || err) });
    });
    return true; // 异步响应
  });
})();
