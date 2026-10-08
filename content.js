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

  // 防止同一页面重复注入（popup / 悬浮窗 / 导航后自动注入可能多次执行）
  if (window.__gvcInjected) return;
  window.__gvcInjected = true;

  // ---------- 配置 ----------
  const TOAST_DURATION = 1500; // 提示浮层显示时长（毫秒）

  // ---------- 主题 ----------
  // 面板 / 提示浮层长在别人的网页里，颜色是从页面 :root 继承进 Shadow DOM 的。
  // root:false = 不要碰网站的 <html>；改成把 data-gvc-theme 写在**我们自己的宿主元素**上，
  // 它自己的声明会盖掉继承来的值，于是面板能单独跟用户的主题选择走。
  function initContentTheme() {
    if (!globalThis.ThemeMode) return;
    ThemeMode.init({ root: false });
  }

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

  // 这个 <video> 像不像"用户正在看的播放器"？
  // 用来挡掉 B 站首页那种卡片预览的小视频（没有时长、没在播、尺寸也小），
  // 免得在首页比手势被当成"上一集 / 调音量"。
  function isUsableVideo(video) {
    if (!video) return false;
    if (Number.isFinite(video.duration) && video.duration > 0) return true;
    if (video.currentTime > 0) return true;
    if (!video.paused && !video.ended) return true;
    const rect = video.getBoundingClientRect();
    return rect.width >= 320 && rect.height >= 180;
  }

  // 汇总页面视频状态（供 popup 显示 + 后台判断"手势该不该执行"）
  function getVideoStatus() {
    const video = findMainVideo();
    return {
      type: 'STATUS',
      host: location.hostname,
      hasVideo: !!video,
      // 是否像"真的在看视频"，后台的动作闸门用它
      usable: isUsableVideo(video),
      playing: video ? !video.paused && !video.ended : false,
      volume: video ? video.volume : 0,
      muted: video ? video.muted : false,
      // 是不是 B 站首页（数字手势只在首页生效）。
      // 跟着状态一起回传，后台每次刷新就能拿到最新值 ——
      // 以前只在"页面类型变化"时推一次，引擎重启后就一直是旧的
      isBiliHome: isBiliHome()
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
        // 浏览器自动播放策略会拒绝脚本发起的 play()（不算用户手势），
        // 但 pause() 不受限——所以出现“只能暂停不能播放”。
        // 抖音等网页播放器支持空格键播放/暂停，用合成空格键兜底
        sendCharKey(' ', 'Space', 32);
        // 等一拍让页面响应，再确认是否真的播起来了
        await new Promise((resolve) => setTimeout(resolve, 350));
        const v2 = findMainVideo();
        if (v2 && !v2.paused) {
          return { status: 'ok' };
        }
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

  // 模拟按一个字符键（抖音网页版：Z = 点赞）
  function sendCharKey(key, code, keyCode) {
    for (const type of ['keydown', 'keyup']) {
      const evt = new KeyboardEvent(type, {
        key, code: code || key, bubbles: true, cancelable: true
      });
      Object.defineProperty(evt, 'keyCode', { get: () => keyCode });
      Object.defineProperty(evt, 'which', { get: () => keyCode });
      document.dispatchEvent(evt);
    }
  }

  // 长按键盘键：keydown → 保持 ms 毫秒 → keyup（B 站长按 R = 一键三连）
  function holdCharKey(key, code, keyCode, ms) {
    const make = (type) => {
      const evt = new KeyboardEvent(type, {
        key, code: code || key, bubbles: true, cancelable: true
      });
      Object.defineProperty(evt, 'keyCode', { get: () => keyCode });
      Object.defineProperty(evt, 'which', { get: () => keyCode });
      return evt;
    };
    document.dispatchEvent(make('keydown'));
    setTimeout(() => document.dispatchEvent(make('keyup')), ms);
  }

  // 按住元素约 ms 毫秒再松开（B 站长按点赞按钮 = 一键三连）
  function holdAndRelease(el, ms) {
    const rect = el.getBoundingClientRect();
    const common = {
      bubbles: true, cancelable: true, composed: true,
      button: 0, buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    try { el.dispatchEvent(new PointerEvent('pointerdown', common)); } catch (e) { /* 忽略 */ }
    el.dispatchEvent(new MouseEvent('mousedown', common));
    setTimeout(() => {
      if (!el.isConnected) return;
      const up = Object.assign({}, common, { buttons: 0 });
      try { el.dispatchEvent(new PointerEvent('pointerup', up)); } catch (e) { /* 忽略 */ }
      el.dispatchEvent(new MouseEvent('mouseup', up));
      if (typeof el.click === 'function') el.click();
    }, ms);
  }

  // 点赞：优先点站点的点赞按钮，找不到就按 Z 键（抖音等支持）
  function likeVideo() {
    const likeSels = [
      '[data-e2e="feed-like"]',                              // 抖音推荐流点赞按钮
      '[aria-label*="点赞"]',                                // B 站等中文站点
      'button[aria-label*="like this video" i]',             // YouTube
      'button[aria-label*="like" i]:not([aria-label*="dislike" i])', // YouTube 通用
      '[aria-label*="赞" i]',                                // 通用中文兜底
      '.video-like',                                         // B 站旧版
      'button[class*="like" i]'                              // 通用兜底
    ];
    for (const sel of likeSels) {
      const el = document.querySelector(sel);
      if (el && typeof el.click === 'function') {
        el.click();
        return { status: 'ok' };
      }
    }
    sendCharKey('z', 'KeyZ', 90);
    return { status: 'ok' };
  }

  // 页面是否有“换一换”按钮（B 站首页特征，数字手势只在首页生效）
  function hasRollButton() {
    const btn = document.querySelector('button.roll-btn');
    return !!(btn && btn.textContent && btn.textContent.indexOf('换一换') !== -1);
  }

  // 是否 B 站首页（数字手势只在首页生效）。
  // URL 和 DOM 双重确认：即使 URL 像首页（SPA 内嵌播放），没有“换一换”按钮也不算。
  function isBiliHome() {
    return location.hostname.includes('bilibili.com') &&
      (location.pathname === '/' || location.pathname === '/index.html') &&
      hasRollButton();
  }

  // B 站首页“换一换”旁边的推荐卡片（2 行 3 列，DOM 顺序即 1~6）
  function getBiliHomeCards() {
    const cards = [];
    for (const a of document.querySelectorAll('.bili-video-card a[href*="/video/"]')) {
      const card = a.closest('.bili-video-card');
      if (card && cards.indexOf(card) === -1) cards.push(card);
    }
    return cards;
  }

  // 滚动到元素中心并通知后台用 CDP 原生点击（B 站只响应真实鼠标事件）
  function nativeClickAt(el, toast) {
    el.scrollIntoView({ block: 'center' });
    setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      chrome.runtime.sendMessage({ type: 'CLICK_AT', x, y }).catch(() => {});
    }, 400);
    return { status: 'ok', toast };
  }

  // 一键三连（B 站）：长按点赞按钮 → 快捷键 R → 找不到就退化为点赞
  function tripleLike() {
    const isBili = location.hostname.includes('bilibili.com');

    // 1) B 站网页版：按住点赞按钮约 2 秒松开 = 一键三连
    if (isBili) {
      // B 站新版点赞按钮是 div.video-like，title 为“点赞（Q）”，没有 aria-label
      const likeBtn = document.querySelector(
        '.video-toolbar-left-item.video-like, .video-like, [title*="点赞"], [aria-label*="点赞"], [aria-label*="赞" i]'
      );
      if (likeBtn && typeof likeBtn.dispatchEvent === 'function') {
        holdAndRelease(likeBtn, 2200);
        return { status: 'ok' };
      }
      // 2) B 站快捷键：长按 R 可触发一键三连
      holdCharKey('r', 'KeyR', 82, 2200);
      return { status: 'ok' };
    }

    // 3) 其它站点：找“三连”按钮，找不到退化为点赞
    const tripleSels = [
      '[aria-label*="三连"]', '[title*="三连"]', '[aria-label*="triple" i]'
    ];
    for (const sel of tripleSels) {
      const el = document.querySelector(sel);
      if (el && typeof el.click === 'function') {
        el.click();
        return { status: 'ok' };
      }
    }
    return likeVideo();
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

  // 浮层样式写进 Shadow DOM 自己的 <style> 里：不碰页面的 CSS，也不会被页面 CSS 影响。
  // 颜色走 theme.css 的令牌（页面 :root 上的自定义属性会继承进 Shadow DOM）。
  function toastCss() {
    return `
      .gvc-toast {
        position: fixed; top: 20px; right: 20px;
        max-width: 320px;
        padding: 10px 15px 10px 13px;
        border-radius: var(--gvc-radius, 12px);
        background: var(--gvc-surface, #141A22);
        color: var(--gvc-text, #E6EDF6);
        border: 1px solid var(--gvc-line, rgba(255,255,255,.07));
        border-left: 3px solid var(--gvc-accent, #4F8BFF);
        box-shadow: var(--gvc-shadow-lg, 0 26px 60px -22px rgba(0,0,0,.9));
        font-family: var(--gvc-font, system-ui, sans-serif);
        font-size: 13.5px; line-height: 1.5;
        z-index: 2147483647; pointer-events: none;
        opacity: 0; transform: translateY(-8px);
        transition: opacity var(--gvc-base, 180ms) var(--gvc-ease, ease),
                    transform var(--gvc-base, 180ms) var(--gvc-ease, ease);
      }
      .gvc-toast.on { opacity: 1; transform: translateY(0); }
    `;
  }

  function ensureToast() {
    if (toastHost) return;
    toastHost = document.createElement('div');
    toastHost.id = 'gesture-video-control-toast-host';
    // 浮层也跟着用户选的主题（属性写在宿主上，不碰网站 DOM）
    if (globalThis.ThemeMode) ThemeMode.track(toastHost);
    // Shadow DOM：页面的 CSS 无法影响浮层，浮层也不会污染页面样式
    const shadow = toastHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = toastCss();
    toastBox = document.createElement('div');
    toastBox.className = 'gvc-toast';
    shadow.appendChild(style);
    shadow.appendChild(toastBox);
    document.documentElement.appendChild(toastHost);
  }

  function showToast(text, duration) {
    ensureToast();
    toastBox.textContent = text;
    toastBox.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastBox.classList.remove('on');
    }, duration || TOAST_DURATION);
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
    '点赞': '👍',
    '双手点赞': '👍👍',
    '🤟': '🤟',
    '双手食指交叉': '🤞',
    '数字2': '2️⃣',
    '数字3': '3️⃣',
    '数字4': '4️⃣',
    '手掌张开': '🖐️',
    '666': '6️⃣6️⃣6️⃣',
    '🔒 已锁定': '🔒',
    '握拳': '✊',
    '未检测到手': '🚫',
    '其他手势': '🖐️'
  };

  let panelHost = null;
  let panelShadow = null;
  let panelPreview = null;
  let panelPreviewStream = null;
  let panelMinimized = false;

  // 面板样式：注进 Shadow DOM 的 <style>，和弹窗（popup.css）/ 悬浮窗（float.css）
  // 是同一套观感 —— 颜色全部走 theme.css 的 --gvc-* 令牌。
  // 令牌来自页面 :root（manifest 的 content_scripts.css 注入），自定义属性会继承
  // 进 Shadow DOM；var() 里的兜底值则是万一令牌没到位也不至于变成一个透明框。
  function panelCss() {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .gvc-icon { display: block; }

      /* ---------- 面板本体：玻璃卡片 ---------- */
      .gvc-panel {
        position: fixed; z-index: 2147483646;
        width: 300px; height: 470px;
        min-width: 220px; min-height: 180px;
        display: flex; flex-direction: column;
        overflow: hidden;
        background: var(--gvc-bg, #0A0D12);
        color: var(--gvc-text, #E6EDF6);
        border: 1px solid var(--gvc-line, rgba(255, 255, 255, .07));
        border-radius: var(--gvc-radius, 12px);
        box-shadow: var(--gvc-shadow-lg, 0 26px 60px -22px rgba(0, 0, 0, .9));
        font-family: var(--gvc-font, system-ui, sans-serif);
        font-size: 13px;
        user-select: none;
        -webkit-font-smoothing: antialiased;
      }
      .gvc-panel.minimized { display: none; }
      .gvc-panel :focus-visible { outline: 2px solid var(--gvc-accent, #4F8BFF); outline-offset: 2px; }

      /* ---------- 标题栏 ---------- */
      .gvc-bar {
        flex: none; height: 40px;
        display: flex; align-items: center; gap: 4px;
        padding: 0 6px 0 11px;
        background: var(--gvc-bg-soft, #0E1218);
        border-bottom: 1px solid var(--gvc-line, rgba(255, 255, 255, .07));
        cursor: move;
      }
      .gvc-title {
        flex: 1; min-width: 0;
        display: flex; align-items: center; gap: 7px;
        font-size: 12.5px; font-weight: 600; letter-spacing: .01em;
        white-space: nowrap; overflow: hidden;
      }
      .gvc-logo { display: grid; place-items: center; color: var(--gvc-accent, #4F8BFF); }
      .gvc-bar button {
        display: grid; place-items: center;
        width: 27px; height: 27px;
        border: none; border-radius: var(--gvc-radius-xs, 6px);
        background: transparent; color: var(--gvc-text-dim, #8E9CB0);
        font-family: inherit; cursor: pointer;
        transition: background var(--gvc-fast, 120ms) var(--gvc-ease, ease),
                    color var(--gvc-fast, 120ms) var(--gvc-ease, ease);
      }
      .gvc-bar button:hover { background: var(--gvc-surface-hi, #1B232E); color: var(--gvc-text, #E6EDF6); }
      .gvc-bar button.active { background: var(--gvc-accent-soft, rgba(79, 139, 255, .15)); color: var(--gvc-accent-hi, #78A6FF); }

      /* ---------- 摄像头画面（取景框 + 扫描线）---------- */
      .gvc-preview-wrap {
        position: relative; flex: none; height: 170px;
        display: flex; align-items: center; justify-content: center;
        overflow: hidden;
        background: var(--gvc-stage, #07090D);
      }
      .gvc-preview-wrap.hidden { display: none; }
      /* 四角取景框 */
      .gvc-preview-wrap::before {
        content: ''; position: absolute; inset: 8px; z-index: 3; pointer-events: none;
        background-image:
          linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor),
          linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor),
          linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor),
          linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor);
        background-repeat: no-repeat;
        background-position: 0 0, 0 0, 100% 0, 100% 0, 0 100%, 0 100%, 100% 100%, 100% 100%;
        background-size: 14px 1.5px, 1.5px 14px, 14px 1.5px, 1.5px 14px,
                         14px 1.5px, 1.5px 14px, 14px 1.5px, 1.5px 14px;
        color: var(--gvc-stage-mark, rgba(255, 255, 255, .32));
      }
      /* 缓慢上移的扫描线 */
      .gvc-preview-wrap::after {
        content: ''; position: absolute; left: 0; right: 0; top: -36%; height: 36%;
        z-index: 3; pointer-events: none;
        background-image: linear-gradient(180deg, transparent, var(--gvc-accent-soft, rgba(79, 139, 255, .15)) 50%, transparent);
        animation: var(--gvc-scan-anim, none);
      }
      @keyframes gvc-scan { from { top: -36%; } to { top: 100%; } }

      .gvc-preview {
        width: 100%; height: 100%; object-fit: cover; display: block;
        will-change: transform;
      }
      .gvc-preview-wrap.zoomed .gvc-preview { cursor: grab; }
      .gvc-preview-wrap.dragging .gvc-preview { cursor: grabbing; }
      .gvc-placeholder {
        /* 必须绝对定位：video 是 width/height 100% 的弹性子项，会把同级的
           占位层挤成一条缝（文字变竖排）。和弹窗里的 .camera-placeholder 同一套做法。 */
        position: absolute; inset: 0; z-index: 4;
        display: flex; align-items: center; justify-content: center;
        padding: 0 14px; text-align: center;
        color: var(--gvc-stage-text, #7C8AA0);
        font-size: 12px; letter-spacing: .02em;
      }
      .gvc-zoom-badge {
        position: absolute; right: 6px; bottom: 6px; z-index: 4;
        padding: 2px 7px; border-radius: 999px;
        background: rgba(0, 0, 0, .55); color: #FFFFFF;
        border: 1px solid rgba(255, 255, 255, .14);
        font-family: var(--gvc-mono, monospace); font-size: 10.5px;
        font-variant-numeric: tabular-nums;
        pointer-events: none;
      }
      .gvc-preview-resize {
        position: absolute; left: 0; right: 0; bottom: 0; z-index: 5;
        height: 10px; cursor: ns-resize;
        background: rgba(255, 255, 255, .05);
        transition: background var(--gvc-fast, 120ms) var(--gvc-ease, ease);
      }
      .gvc-preview-resize:hover { background: var(--gvc-accent-soft, rgba(79, 139, 255, .15)); }
      .gvc-preview-resize::after {
        content: ''; position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: 28px; height: 3px; border-radius: 2px;
        background: rgba(255, 255, 255, .40);
      }

      /* ---------- 内容区 ---------- */
      .gvc-body {
        flex: 1; min-height: 0;
        padding: 10px 12px 12px;
        display: flex; flex-direction: column; gap: 8px;
        overflow-y: auto;
      }
      .gvc-body::-webkit-scrollbar { width: 8px; }
      .gvc-body::-webkit-scrollbar-thumb { background: var(--gvc-line-strong, rgba(255,255,255,.14)); border-radius: 4px; }
      .gvc-body::-webkit-scrollbar-track { background: transparent; }

      .gvc-gesture {
        display: flex; align-items: center; gap: 10px;
        padding: 9px 11px;
        background: var(--gvc-surface, #141A22);
        border: 1px solid var(--gvc-line, rgba(255, 255, 255, .07));
        border-radius: var(--gvc-radius, 12px);
        box-shadow: var(--gvc-hairline, inset 0 1px 0 rgba(255, 255, 255, .06));
      }
      .gvc-gesture-info { min-width: 0; }
      .gvc-gesture-emoji { flex: none; font-size: 24px; line-height: 1; }
      .gvc-label { display: block; font-size: 10px; letter-spacing: .14em; color: var(--gvc-text-mute, #66738A); }
      .gvc-gesture-name { display: block; margin-top: 2px; font-size: 14px; font-weight: 600; }
      .gvc-gesture-detail { display: block; margin-top: 3px; font-size: 11px; line-height: 1.45; color: var(--gvc-text-dim, #8E9CB0); }

      /* 状态行：彩色圆点 + 文字（和弹窗一致） */
      .gvc-status {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 7px 10px;
        font-size: 11.5px; line-height: 1.5;
        background: var(--gvc-surface, #141A22);
        border: 1px solid var(--gvc-line, rgba(255, 255, 255, .07));
        border-radius: var(--gvc-radius-sm, 9px);
        color: var(--gvc-text-dim, #8E9CB0);
      }
      .gvc-status::before { content: ''; flex: none; width: 6px; height: 6px; margin-top: 5px; border-radius: 50%; background: var(--gvc-text-mute, #66738A); }
      .gvc-status.ok { background: var(--gvc-ok-soft, rgba(52, 211, 153, .13)); border-color: transparent; color: var(--gvc-ok-text, #6EE7B7); }
      .gvc-status.ok::before { background: var(--gvc-ok, #34D399); }
      .gvc-status.warn { background: var(--gvc-warn-soft, rgba(251, 191, 36, .13)); border-color: transparent; color: var(--gvc-warn-text, #FCD34D); }
      .gvc-status.warn::before { background: var(--gvc-warn, #FBBF24); }
      .gvc-status.error { background: var(--gvc-err-soft, rgba(248, 113, 113, .13)); border-color: transparent; color: var(--gvc-err-text, #FCA5A5); }
      .gvc-status.error::before { background: var(--gvc-err, #F87171); }

      /* 开关行：和弹窗用同一套轨道 / 滑块 */
      .gvc-row {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 9px 12px;
        font-size: 12.5px; font-weight: 600;
        background: var(--gvc-surface, #141A22);
        border: 1px solid var(--gvc-line, rgba(255, 255, 255, .07));
        border-radius: var(--gvc-radius, 12px);
        box-shadow: var(--gvc-hairline, inset 0 1px 0 rgba(255, 255, 255, .06));
        cursor: pointer;
        transition: background var(--gvc-fast, 120ms) var(--gvc-ease, ease);
      }
      .gvc-row:hover { background: var(--gvc-surface-hi, #1B232E); }
      .gvc-row input { display: none; }
      .gvc-switch-track {
        flex: none; position: relative;
        width: 44px; height: 24px; border-radius: 999px;
        background: var(--gvc-line-strong, rgba(255, 255, 255, .14));
        box-shadow: inset 0 1px 2px rgba(0, 0, 0, .35);
        transition: background var(--gvc-base, 180ms) var(--gvc-ease, ease),
                    box-shadow var(--gvc-base, 180ms) var(--gvc-ease, ease);
      }
      .gvc-switch-thumb {
        position: absolute; top: 3px; left: 3px;
        width: 18px; height: 18px; border-radius: 50%;
        background: #FFFFFF;
        box-shadow: 0 1px 3px rgba(0, 0, 0, .45);
        transition: transform var(--gvc-base, 180ms) var(--gvc-ease, ease);
      }
      .gvc-row input:checked + .gvc-switch-track {
        background-image: linear-gradient(180deg, var(--gvc-accent-hi, #78A6FF), var(--gvc-accent, #4F8BFF));
        box-shadow: 0 0 0 3px var(--gvc-accent-soft, rgba(79, 139, 255, .15)), inset 0 1px 1px rgba(255, 255, 255, .25);
      }
      .gvc-row input:checked + .gvc-switch-track .gvc-switch-thumb { transform: translateX(20px); }
      .gvc-row input:focus-visible + .gvc-switch-track { outline: 2px solid var(--gvc-accent, #4F8BFF); outline-offset: 2px; }

      /* 手势对照表（内部 .gh-* 样式由 gesture-catalog.js 提供） */
      .gvc-help { border-top: 1px solid var(--gvc-line, rgba(255, 255, 255, .07)); padding-top: 8px; }
      .gvc-help[hidden] { display: none; }

      /* ---------- 缩放手柄 ---------- */
      .gvc-resize {
        position: absolute; right: 0; bottom: 0;
        width: 18px; height: 18px; cursor: nwse-resize;
        color: var(--gvc-line-strong, rgba(255, 255, 255, .14));
        background-image: linear-gradient(135deg, transparent 55%, currentColor 55%);
        border-bottom-right-radius: var(--gvc-radius, 12px);
        transition: color var(--gvc-fast, 120ms) var(--gvc-ease, ease);
      }
      .gvc-resize:hover { color: var(--gvc-accent, #4F8BFF); }

      /* ---------- 最小化悬浮球 ---------- */
      .gvc-pill {
        position: fixed; z-index: 2147483647;
        right: 18px; bottom: 18px;
        width: 52px; height: 52px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        background: var(--gvc-surface, #141A22);
        color: var(--gvc-accent, #4F8BFF);
        border: 1px solid var(--gvc-line-strong, rgba(255, 255, 255, .14));
        box-shadow: var(--gvc-shadow-lg, 0 26px 60px -22px rgba(0, 0, 0, .9)),
                    var(--gvc-hairline, inset 0 1px 0 rgba(255, 255, 255, .06));
        transition: transform var(--gvc-fast, 120ms) var(--gvc-ease, ease),
                    border-color var(--gvc-fast, 120ms) var(--gvc-ease, ease);
      }
      .gvc-pill:hover { transform: translateY(-1px); border-color: var(--gvc-accent, #4F8BFF); }
      .gvc-pill.hidden { display: none; }
      /* 状态小圆点：识别中变绿并缓慢呼吸 */
      .gvc-pill::after {
        content: ''; position: absolute; right: 4px; bottom: 4px;
        width: 10px; height: 10px; border-radius: 50%;
        background: var(--gvc-text-mute, #66738A);
        border: 2px solid var(--gvc-surface, #141A22);
      }
      .gvc-pill.running::after { background: var(--gvc-ok, #34D399); animation: var(--gvc-pulse-anim, none); }
      @keyframes gvc-pulse {
        0% { box-shadow: 0 0 0 0 var(--gvc-ok-soft, rgba(52, 211, 153, .13)); }
        70% { box-shadow: 0 0 0 7px transparent; }
        100% { box-shadow: 0 0 0 0 transparent; }
      }
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
    // 手势对照表的数据/渲染/样式在 gesture-catalog.js 里，和弹窗共用同一份
    const catalogCss = globalThis.GestureCatalog ? globalThis.GestureCatalog.css() : '';
    style.textContent = panelCss() + catalogCss;
    panelShadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'gvc-panel';
    root.innerHTML = `
      <div class="gvc-bar">
        <span class="gvc-title"><span class="gvc-logo" data-icon="logo" data-size="14"></span>手势视频控制</span>
        <button data-act="theme" data-theme-toggle data-size="14" title="切换主题"></button>
        <button data-act="help" title="手势对照表"><span data-icon="book" data-size="14"></span></button>
        <button data-act="preview" title="显示 / 隐藏摄像头画面"><span data-icon="eye" data-size="14"></span></button>
        <button data-act="min" title="最小化"><span data-icon="minus" data-size="14"></span></button>
        <button data-act="close" title="关闭悬浮面板"><span data-icon="close" data-size="14"></span></button>
      </div>
      <div class="gvc-preview-wrap" title="滚轮缩放画面，双击重置，放大后按住拖动">
        <video class="gvc-preview" autoplay muted playsinline></video>
        <div class="gvc-placeholder">正在打开摄像头预览…</div>
        <span class="gvc-zoom-badge">1.0x</span>
        <div class="gvc-preview-resize" title="拖动调整画面大小"></div>
      </div>
      <div class="gvc-body">
        <div class="gvc-gesture">
          <span class="gvc-gesture-emoji">🖐️</span>
          <div class="gvc-gesture-info">
            <span class="gvc-label">当前手势</span>
            <div class="gvc-gesture-name">等待识别…</div>
            <div class="gvc-gesture-detail"></div>
          </div>
        </div>
        <div class="gvc-status">正在连接后台识别…</div>
        <label class="gvc-row"><span>手势控制</span><input type="checkbox" data-ctl="control"><span class="gvc-switch-track"><span class="gvc-switch-thumb"></span></span></label>
        <label class="gvc-row"><span>短视频模式</span><input type="checkbox" data-ctl="short"><span class="gvc-switch-track"><span class="gvc-switch-thumb"></span></span></label>
        <div class="gvc-help" hidden></div>
      </div>
      <div class="gvc-resize"></div>
    `;
    // 标题栏图标：把 data-icon 占位换成内联 SVG（ui-icons.js）
    if (globalThis.UIIcons) globalThis.UIIcons.mount(root);
    // 主题：让面板宿主跟着用户选的主题走，并接管标题栏那个按钮
    if (globalThis.ThemeMode) {
      ThemeMode.track(panelHost);
      ThemeMode.trackButton(root.querySelector('[data-theme-toggle]'));
    }
    panelShadow.appendChild(root);

    const pill = document.createElement('div');
    pill.className = 'gvc-pill hidden';
    pill.innerHTML = globalThis.UIIcons ? globalThis.UIIcons.svg('logo', 24) : '🎮';
    pill.title = '恢复悬浮面板';
    panelShadow.appendChild(pill);

    // 位置与尺寸（记忆上次，否则默认右上角）
    const saved = await chrome.storage.local.get(['gvcPanelPos', 'gvcPanelSize', 'gvcPanelZoom', 'gvcPanelPreviewH']).catch(() => ({}));
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
    // 恢复上次的画面高度（90 ~ 320px，默认 170px）
    const ph = (typeof saved.gvcPanelPreviewH === 'number') ? saved.gvcPanelPreviewH : 170;
    root.querySelector('.gvc-preview-wrap').style.height = Math.max(90, Math.min(320, ph)) + 'px';

    panelPreview = root.querySelector('.gvc-preview');
    initPanelInteractions(root, pill, saved.gvcPanelZoom);
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

  function initPanelInteractions(root, pill, savedZoom) {
    const bar = root.querySelector('.gvc-bar');
    const resize = root.querySelector('.gvc-resize');
    const ctl = root.querySelector('[data-ctl="control"]');
    const short = root.querySelector('[data-ctl="short"]');
    const previewWrap = root.querySelector('.gvc-preview-wrap');
    const preview = root.querySelector('.gvc-preview');
    const zoomBadge = root.querySelector('.gvc-zoom-badge');
    const previewResize = root.querySelector('.gvc-preview-resize');
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 4;
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let panDrag = null;
    let drag = null;

    // 拖动底部分隔条：调整摄像头画面大小（90 ~ 320px，自动记忆）
    previewResize.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startH = previewWrap.offsetHeight;
      const onMove = (ev) => {
        previewWrap.style.height = Math.max(90, Math.min(320, startH + (ev.clientY - startY))) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        chrome.storage.local.set({ gvcPanelPreviewH: previewWrap.offsetHeight }).catch(() => {});
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    function applyZoom() {
      preview.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
      previewWrap.classList.toggle('zoomed', zoom > 1.01);
      zoomBadge.textContent = zoom.toFixed(1) + 'x';
    }

    function saveZoom() {
      chrome.storage.local.set({ gvcPanelZoom: { zoom: zoom, panX: panX, panY: panY } }).catch(() => {});
    }

    // 恢复上次的缩放 / 平移
    if (savedZoom && typeof savedZoom.zoom === 'number') {
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, savedZoom.zoom));
      panX = savedZoom.panX || 0;
      panY = savedZoom.panY || 0;
      applyZoom();
    }

    // 滚轮缩放：以鼠标位置为锚点，画面内容不跑偏
    previewWrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = previewWrap.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
      const ratio = next / zoom;
      panX = mx - (mx - panX) * ratio;
      panY = my - (my - panY) * ratio;
      zoom = next;
      applyZoom();
      saveZoom();
    }, { passive: false });

    // 双击重置为 100%
    previewWrap.addEventListener('dblclick', () => {
      zoom = 1;
      panX = 0;
      panY = 0;
      applyZoom();
      saveZoom();
    });

    // 放大后按住画面拖动平移
    previewWrap.addEventListener('mousedown', (e) => {
      if (zoom <= 1.01) return;
      panDrag = { sx: e.clientX, sy: e.clientY, px: panX, py: panY };
      previewWrap.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!panDrag) return;
      const rect = previewWrap.getBoundingClientRect();
      const maxX = ((zoom - 1) * rect.width) / 2;
      const maxY = ((zoom - 1) * rect.height) / 2;
      panX = Math.max(-maxX, Math.min(maxX, panDrag.px + (e.clientX - panDrag.sx)));
      panY = Math.max(-maxY, Math.min(maxY, panDrag.py + (e.clientY - panDrag.sy)));
      applyZoom();
    });
    document.addEventListener('mouseup', () => {
      if (panDrag) {
        panDrag = null;
        previewWrap.classList.remove('dragging');
        saveZoom();
      }
    });

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

    // 手势对照表：点标题栏的 📖 展开 / 收起（内容来自 gesture-catalog.js）
    const helpBtn = root.querySelector('[data-act="help"]');
    const helpBox = root.querySelector('.gvc-help');
    if (helpBox && globalThis.GestureCatalog) {
      helpBox.innerHTML = globalThis.GestureCatalog.toHTML();
    }
    if (helpBtn && helpBox) {
      helpBtn.addEventListener('click', () => {
        helpBox.hidden = !helpBox.hidden;
        // 展开时按钮常亮（用类名，别写死浅色背景，否则浅色主题下会发白）
        helpBtn.classList.toggle('active', !helpBox.hidden);
      });
    }

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
          setPanelStatusText((r.error) || '启动失败', 'error');
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

  // kind: 'ok' | 'warn' | 'error' —— 决定状态行左侧小圆点的颜色
  function setPanelStatusText(text, kind) {
    if (!panelShadow) return;
    const s = panelShadow.querySelector('.gvc-status');
    if (!s) return;
    s.textContent = text;
    s.className = 'gvc-status' + (kind ? ' ' + kind : '');
  }

  function applyPanelStatus(s) {
    if (!panelShadow) return;
    const root = panelShadow.querySelector('.gvc-panel');
    if (!root) return;
    const pill = panelShadow.querySelector('.gvc-pill');
    // 悬浮球上的小圆点：识别运行中变绿并缓慢呼吸
    if (pill) pill.classList.toggle('running', !!s.running);
    const name = root.querySelector('.gvc-gesture-name');
    const detail = root.querySelector('.gvc-gesture-detail');
    const emoji = root.querySelector('.gvc-gesture-emoji');
    if (s.gesture) {
      name.textContent = s.gesture;
      emoji.textContent = GESTURE_EMOJI[s.gesture] || '🖐️';
    }
    if (s.detail) detail.textContent = s.detail;
    if (s.running) {
      // 状态本身已经用圆点颜色区分了，文案里就不用再塞 emoji
      if (s.errorText) setPanelStatusText(s.errorText, 'error');
      else setPanelStatusText('后台识别运行中', 'ok');
    } else {
      setPanelStatusText('后台识别未运行', 'warn');
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
    // 面板要销毁了：从主题登记表里摘掉，免得一直留着引用
    if (globalThis.ThemeMode) ThemeMode.untrack(panelHost);
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
      case 'like': {
        const r = likeVideo();
        if (r.status === 'ok') r.toast = '👍 已点赞';
        return r;
      }
      case 'like3': {
        const r = tripleLike();
        if (r.status === 'ok') r.toast = '🔥 一键三连';
        return r;
      }
      case 'lock':
      case 'unlock': {
        // 引擎本地锁定/解锁：不操作页面，只返回浮层提示（显示 2.5 秒）
        return {
          status: 'ok',
          toastDuration: 2500,
          toast: action === 'lock'
            ? '🔒 已锁定：手势操作已暂停（再比 666 手势 1.5 秒解锁）'
            : '🔓 已解锁：手势操作已恢复'
        };
      }
      case 'bili_refresh': {
        // 🤟：点击 B 站首页的“换一换”按钮刷新推荐流
        const rollBtns = document.querySelectorAll('button.roll-btn, [class*="roll-btn"]');
        for (const btn of rollBtns) {
          if (btn.textContent && btn.textContent.indexOf('换一换') !== -1) {
            return nativeClickAt(btn, '🔄 换一换');
          }
        }
        return { status: 'error', message: '未找到“换一换”按钮（需在 B 站首页使用）' };
      }
      case 'num_1': case 'num_2': case 'num_3':
      case 'num_4': case 'num_5': case 'num_6': {
        // 数字手势（1~6）：B 站首页选“换一换”旁边的第 N 个视频
        const n = parseInt(action.slice(4), 10);
        if (!isBiliHome()) {
          return { status: 'error', message: '数字手势仅在 B 站首页可用' };
        }
        const card = getBiliHomeCards()[n - 1];
        if (!card) {
          return { status: 'error', message: '未找到第 ' + n + ' 个视频卡片' };
        }
        return nativeClickAt(card, '▶ 打开第 ' + n + ' 个视频');
      }
      case 'close_tab': {
        // 双手食指交叉：关闭当前页面（由后台 Service Worker 执行）
        chrome.runtime.sendMessage({ type: 'CLOSE_TAB' }).catch(() => {});
        return { status: 'ok', toast: '❌ 关闭当前页面' };
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
        // 后台自检发现识别中断并自动恢复后，在页面上说一声
        //（否则用户只会觉得"手势突然不灵了"，不知道它已经自己修好了）
        case 'SHOW_TOAST': {
          showToast(message.text || '手势视频控制', message.duration || TOAST_DURATION);
          return { status: 'ok' };
        }
        case 'GESTURE_ACTION': {
          const result = await handleGestureAction(message);
          // 页面提示浮层反馈
          if (result.status === 'ok') {
            showToast(result.toast || message.gesture || '已执行', result.toastDuration);
          } else if (result.status === 'no_video') {
            showToast('当前页面未检测到视频');
          } else if (result.status === 'error') {
            showToast('⚠️ ' + (result.message || '操作失败'));
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

  // ---------- 页面类型上报（数字手势需要知道是否 B 站首页）----------
  function currentBiliHome() {
    return isBiliHome();
  }
  let lastReportedHome = null;
  function reportPageInfo() {
    const isHome = currentBiliHome();
    if (isHome !== lastReportedHome) {
      lastReportedHome = isHome;
      chrome.runtime.sendMessage({ type: 'PAGE_INFO', isBiliHome: isHome }).catch(() => {});
    }
  }
  reportPageInfo();
  // SPA 内部跳转时 URL 会变，轮询检测变化后重新上报
  setInterval(reportPageInfo, 3000);

  // 主题：读一次用户的选择，之后显隐面板 / 浮层都跟着走（不碰网站自己的 DOM）
  initContentTheme();
})();
