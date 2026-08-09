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
  // 深度收集所有 <video>：穿透 Shadow DOM（抖音播放器 xgplayer 等可能用）
  function collectVideos(root) {
    const found = [];
    const walk = (node) => {
      if (!node) return;
      if (node instanceof HTMLVideoElement) {
        found.push(node);
      }
      if (node.children) {
        for (const child of Array.from(node.children)) walk(child);
      }
      // open 的 Shadow DOM 可通过 shadowRoot 访问；closed 的取不到就跳过
      if (node.shadowRoot) {
        walk(node.shadowRoot);
      }
    };
    walk(root || document);
    return found;
  }

  // 找出页面上“最主要”的 <video>：
  //   1) 优先视口中心的 video（抖音推荐流当前视频居中，命中率最高）
  //   2) 其次在全部 video（含 Shadow DOM）里选“正在播放 + 面积大”的那个
  function findMainVideo() {
    // 1) 视口中心命中测试：点击屏幕中心，向上找 video
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    if (hit && typeof hit.closest === 'function') {
      const v = hit.closest('video');
      if (v && v.getBoundingClientRect().width > 40) return v;
    }

    // 2) 深度收集所有 video（含 Shadow DOM）
    const videos = collectVideos(document);
    if (videos.length === 0) return null;

    let best = null;
    let bestScore = -1;
    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      // 跳过过小或隐藏的播放器（避免选中站内小图标 / 广告视频）
      if (rect.width < 40 || rect.height < 30) continue;
      const area = rect.width * rect.height;
      const hasDuration = Number.isFinite(video.duration) && video.duration > 0;
      // 加权：正在播放的优先，其次已加载时长，再其次面积
      const score = area * (hasDuration ? 10 : 1)
        + video.readyState * 100
        + (!video.paused && !video.ended ? 500 : 0);
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

  // ============================================================
  // 悬浮面板（页面内画中画：可拖动 / 缩放 / 隐藏摄像头画面）
  // ============================================================
  const PANEL_DEFAULT_W = 300;
  const PANEL_DEFAULT_H = 470;
  const PANEL_MIN_W = 220;
  const PANEL_MIN_H = 180;

  const GESTURE_EMOJI = {
    'OK': '👌',
    '小拇指向上': '🤙',
    '小拇指向下': '🤙',
    '食指向上': '☝️',
    '食指向下': '👇',
    '手掌张开': '🖐️',
    '握拳': '✊',
    '未检测到手': '🚫',
    '其他手势': '🖐️'
  };

  let panelHost = null;
  let panelShadow = null;
  let panelPreview = null;
  let panelPreviewStream = null;
  let panelMinimized = false;

  function panelCss() {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .gvc-panel {
        position: fixed; z-index: 2147483646;
        width: 300px; height: 470px;
        min-width: 220px; min-height: 180px;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 12px 36px rgba(0,0,0,.28);
        display: flex; flex-direction: column;
        overflow: hidden;
        font-family: "Microsoft YaHei", system-ui, sans-serif;
        color: #1f2328;
        user-select: none;
      }
      .gvc-panel.minimized { display: none; }
      .gvc-bar {
        height: 38px; flex: none;
        background: linear-gradient(135deg, #165dff, #4f8bff);
        color: #fff;
        display: flex; align-items: center;
        padding: 0 8px 0 12px;
        cursor: move;
        gap: 4px;
      }
      .gvc-title { font-size: 13px; font-weight: 600; flex: 1; overflow: hidden; white-space: nowrap; }
      .gvc-bar button {
        width: 24px; height: 24px; border: none; border-radius: 6px;
        background: rgba(255,255,255,.16); color: #fff;
        font-size: 12px; cursor: pointer; line-height: 1;
      }
      .gvc-bar button:hover { background: rgba(255,255,255,.32); }
      .gvc-preview-wrap {
        flex: none; height: 170px; background: #0b0e14;
        display: flex; align-items: center; justify-content: center;
        position: relative; overflow: hidden;
      }
      .gvc-preview-wrap.hidden { display: none; }
      .gvc-preview { width: 100%; height: 100%; object-fit: cover; display: block; }
      .gvc-placeholder { color: #9aa3af; font-size: 12px; text-align: center; padding: 0 12px; }
      .gvc-body {
        flex: 1; padding: 10px 12px 12px;
        display: flex; flex-direction: column; gap: 8px;
        overflow-y: auto;
      }
      .gvc-gesture { display: flex; align-items: center; gap: 10px; }
      .gvc-gesture-emoji { font-size: 24px; }
      .gvc-gesture-name { font-size: 15px; font-weight: 600; }
      .gvc-gesture-detail { font-size: 11px; color: #8a919b; }
      .gvc-status { font-size: 12px; color: #57606a; background: #f6f8ff; border-radius: 8px; padding: 6px 10px; }
      .gvc-row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
      .gvc-row input { width: 34px; height: 18px; accent-color: #165dff; cursor: pointer; }
      .gvc-resize {
        position: absolute; right: 0; bottom: 0;
        width: 18px; height: 18px; cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 50%, #b9c2d0 50%);
        border-bottom-right-radius: 12px;
      }
      .gvc-pill {
        position: fixed; z-index: 2147483647;
        right: 18px; bottom: 18px;
        width: 52px; height: 52px; border-radius: 50%;
        background: linear-gradient(135deg, #165dff, #4f8bff);
        color: #fff; display: flex; align-items: center; justify-content: center;
        font-size: 24px; cursor: pointer;
        box-shadow: 0 8px 24px rgba(22,93,255,.4);
      }
      .gvc-pill.hidden { display: none; }
    `;
  }

  async function showFloatPanel() {
    if (panelHost && panelHost.isConnected) {
      // 已打开：从最小化状态恢复
      const root = panelShadow && panelShadow.querySelector('.gvc-panel');
      const pill = panelShadow && panelShadow.querySelector('.gvc-pill');
      if (root) root.classList.remove('minimized');
      if (pill) pill.classList.add('hidden');
      panelMinimized = false;
      return;
    }

    panelHost = document.createElement('div');
    panelHost.id = 'gesture-video-control-panel-host';
    panelShadow = panelHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = panelCss();
    panelShadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'gvc-panel';
    root.innerHTML = `
      <div class="gvc-bar">
        <span class="gvc-title">🎮 手势视频控制</span>
        <button data-act="preview" title="显示 / 隐藏摄像头画面">👁</button>
        <button data-act="min" title="最小化">—</button>
        <button data-act="close" title="关闭悬浮面板">✕</button>
      </div>
      <div class="gvc-preview-wrap">
        <video class="gvc-preview" autoplay muted playsinline></video>
        <div class="gvc-placeholder">正在打开摄像头预览…</div>
      </div>
      <div class="gvc-body">
        <div class="gvc-gesture">
          <span class="gvc-gesture-emoji">🖐️</span>
          <div>
            <div class="gvc-gesture-name">等待识别…</div>
            <div class="gvc-gesture-detail"></div>
          </div>
        </div>
        <div class="gvc-status">正在连接后台识别…</div>
        <label class="gvc-row"><span>手势控制</span><input type="checkbox" data-ctl="control"></label>
        <label class="gvc-row"><span>短视频模式</span><input type="checkbox" data-ctl="short"></label>
      </div>
      <div class="gvc-resize"></div>
    `;
    panelShadow.appendChild(root);

    const pill = document.createElement('div');
    pill.className = 'gvc-pill hidden';
    pill.textContent = '🎮';
    pill.title = '恢复悬浮面板';
    panelShadow.appendChild(pill);

    // 位置与尺寸（记忆上次，否则默认右上角）
    const saved = await chrome.storage.local.get(['gvcPanelPos', 'gvcPanelSize']).catch(() => ({}));
    const w = (saved.gvcPanelSize && saved.gvcPanelSize.width >= PANEL_MIN_W) ? saved.gvcPanelSize.width : PANEL_DEFAULT_W;
    const h = (saved.gvcPanelSize && saved.gvcPanelSize.height >= PANEL_MIN_H) ? saved.gvcPanelSize.height : PANEL_DEFAULT_H;
    let left = (saved.gvcPanelPos && typeof saved.gvcPanelPos.left === 'number') ? saved.gvcPanelPos.left : window.innerWidth - w - 20;
    let top = (saved.gvcPanelPos && typeof saved.gvcPanelPos.top === 'number') ? saved.gvcPanelPos.top : 80;
    left = Math.max(4, Math.min(left, window.innerWidth - 60));
    top = Math.max(4, Math.min(top, window.innerHeight - 40));
    root.style.width = w + 'px';
    root.style.height = h + 'px';
    root.style.left = left + 'px';
    root.style.top = top + 'px';

    panelPreview = root.querySelector('.gvc-preview');
    initPanelInteractions(root, pill);
    document.documentElement.appendChild(panelHost);
    startPanelPreview();

    // 初始化开关状态
    chrome.storage.local.get(['controlOn', 'shortVideoMode', 'volumeStep', 'debounceMs', 'volumeRepeatMs'], (s) => {
      const ctl = root.querySelector('[data-ctl="control"]');
      const short = root.querySelector('[data-ctl="short"]');
      if (ctl) ctl.checked = !!s.controlOn;
      if (short) short.checked = !!s.shortVideoMode;
      panelSettings = {
        volumeStep: typeof s.volumeStep === 'number' ? s.volumeStep : 0.1,
        debounceMs: typeof s.debounceMs === 'number' ? s.debounceMs : 900,
        volumeRepeatMs: typeof s.volumeRepeatMs === 'number' ? s.volumeRepeatMs : 650
      };
    });

    // 注册状态转发目标，并立即拉一次后台状态
    chrome.runtime.sendMessage({ type: 'PANEL_ATTACH' }).catch(() => {});
    showToast('悬浮面板已打开');
  }

  // 面板当前使用的设置（开关启动引擎时传给后台）
  let panelSettings = { volumeStep: 0.1, debounceMs: 900, volumeRepeatMs: 650 };

  function initPanelInteractions(root, pill) {
    const bar = root.querySelector('.gvc-bar');
    const resize = root.querySelector('.gvc-resize');
    const ctl = root.querySelector('[data-ctl="control"]');
    const short = root.querySelector('[data-ctl="short"]');
    let drag = null;

    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      drag = {
        type: 'move',
        startX: e.clientX, startY: e.clientY,
        left: root.offsetLeft, top: root.offsetTop
      };
      e.preventDefault();
    });
    resize.addEventListener('mousedown', (e) => {
      drag = {
        type: 'resize',
        startX: e.clientX, startY: e.clientY,
        w: root.offsetWidth, h: root.offsetHeight
      };
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      if (drag.type === 'move') {
        const left = Math.max(4, Math.min(drag.left + (e.clientX - drag.startX), window.innerWidth - 60));
        const top = Math.max(4, Math.min(drag.top + (e.clientY - drag.startY), window.innerHeight - 40));
        root.style.left = left + 'px';
        root.style.top = top + 'px';
      } else {
        root.style.width = Math.max(PANEL_MIN_W, drag.w + (e.clientX - drag.startX)) + 'px';
        root.style.height = Math.max(PANEL_MIN_H, drag.h + (e.clientY - drag.startY)) + 'px';
      }
    });
    document.addEventListener('mouseup', () => {
      if (drag) {
        chrome.storage.local.set({
          gvcPanelPos: { left: root.offsetLeft, top: root.offsetTop },
          gvcPanelSize: { width: root.offsetWidth, height: root.offsetHeight }
        }).catch(() => {});
        drag = null;
      }
    });

    root.querySelector('[data-act="preview"]').addEventListener('click', () => {
      root.querySelector('.gvc-preview-wrap').classList.toggle('hidden');
    });
    root.querySelector('[data-act="min"]').addEventListener('click', () => {
      root.classList.add('minimized');
      pill.classList.remove('hidden');
      panelMinimized = true;
    });
    root.querySelector('[data-act="close"]').addEventListener('click', hideFloatPanel);
    pill.addEventListener('click', () => {
      pill.classList.add('hidden');
      root.classList.remove('minimized');
      panelMinimized = false;
    });

    ctl.addEventListener('change', () => {
      const on = ctl.checked;
      chrome.runtime.sendMessage({
        type: 'PANEL_CONTROL', on,
        shortVideoMode: short.checked,
        volumeStep: panelSettings.volumeStep,
        debounceMs: panelSettings.debounceMs,
        volumeRepeatMs: panelSettings.volumeRepeatMs
      }).then((r) => {
        if (r && r.ok === false) {
          ctl.checked = !on;
          setPanelStatusText('❌ ' + ((r.error) || '启动失败'));
        }
      }).catch(() => {});
    });
    short.addEventListener('change', () => {
      const value = short.checked;
      chrome.storage.local.set({ shortVideoMode: value }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_SET_MODE', shortVideoMode: value }).catch(() => {});
      showToast(value ? '已切换到短视频模式（食指上=↑，食指下=↓）' : '已切回长视频模式');
    });
  }

  function setPanelStatusText(text) {
    if (!panelShadow) return;
    const s = panelShadow.querySelector('.gvc-status');
    if (s) s.textContent = text;
  }

  function applyPanelStatus(s) {
    if (!panelShadow) return;
    const root = panelShadow.querySelector('.gvc-panel');
    if (!root) return;
    const name = root.querySelector('.gvc-gesture-name');
    const detail = root.querySelector('.gvc-gesture-detail');
    const emoji = root.querySelector('.gvc-gesture-emoji');
    if (s.gesture) {
      name.textContent = s.gesture;
      emoji.textContent = GESTURE_EMOJI[s.gesture] || '🖐️';
    }
    if (s.detail) detail.textContent = s.detail;
    if (s.running) {
      setPanelStatusText(s.errorText ? '❌ ' + s.errorText : '✅ 后台识别运行中');
    } else {
      setPanelStatusText('⏸ 后台识别未运行');
    }
  }

  async function startPanelPreview() {
    if (!panelPreview) return;
    const placeholder = panelShadow.querySelector('.gvc-placeholder');
    try {
      panelPreviewStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      panelPreview.srcObject = panelPreviewStream;
      await panelPreview.play().catch(() => {});
      if (placeholder) placeholder.textContent = '';
    } catch (e) {
      if (placeholder) placeholder.textContent = '预览不可用（识别仍在后台运行）';
    }
  }

  function stopPanelPreview() {
    if (panelPreviewStream) {
      panelPreviewStream.getTracks().forEach((t) => t.stop());
      panelPreviewStream = null;
    }
    if (panelPreview) panelPreview.srcObject = null;
  }

  function hideFloatPanel() {
    stopPanelPreview();
    if (panelHost && panelHost.parentNode) {
      panelHost.parentNode.removeChild(panelHost);
    }
    panelHost = null;
    panelShadow = null;
    panelPreview = null;
    panelMinimized = false;
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
        case 'SHOW_FLOAT_PANEL': {
          showFloatPanel();
          return { status: 'ok' };
        }
        case 'PANEL_STATUS': {
          applyPanelStatus(message.payload || {});
          return { status: 'ok' };
        }
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
