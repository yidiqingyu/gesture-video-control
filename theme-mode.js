// ============================================================
// theme-mode.js —— 主题模式（跟随系统 / 深色 / 浅色）
//
// 弹窗、悬浮窗、授权页、页面内悬浮面板共用这一份：
//   - 默认「跟随系统」；用户点按钮可以强制深色或浅色，选择记在
//     chrome.storage.local 的 themeMode 里（三个界面同时生效）。
//   - 落地的形式就是在元素上写 data-gvc-theme="dark|light"，
//     具体色值由 theme.css 的属性选择器接管（见那个文件的说明）。
//
// 为什么要写 data-gvc-theme，而不是直接改颜色：
//   页面内面板长在别人的网页里，而它的颜色是从页面的 :root 继承进 Shadow DOM 的；
//   把属性写在**面板宿主元素**上，它自己的声明就会盖掉继承来的值 ——
//   这样面板可以单独换主题，而且完全不碰网站自己的 DOM（不写 <html>）。
//
// 用法：
//   扩展页面（弹窗 / 悬浮窗 / 授权页）：
//     ThemeMode.init({ button: 某个按钮 })          // 不传 button 也能用，只是没按钮
//   页面内（content.js）：
//     ThemeMode.init({ root: false });              // 别碰网页的 <html>
//     ThemeMode.track(面板宿主); ThemeMode.track(浮层宿主);
//     ThemeMode.trackButton(面板标题栏的按钮);
// ============================================================

'use strict';

const ThemeMode = (() => {
  const KEY = 'themeMode';
  const MODES = ['auto', 'dark', 'light'];
  const LABEL = { auto: '跟随系统', dark: '深色', light: '浅色' };
  const ICON = { auto: 'autoTheme', dark: 'moon', light: 'sun' };

  let mode = 'auto';
  let started = false;
  const roots = new Set();    // 要跟着换主题的元素（Shadow DOM 宿主）
  const buttons = new Set();  // 主题切换按钮

  function normalize(value) {
    return MODES.indexOf(value) === -1 ? 'auto' : value;
  }

  // 系统现在是不是浅色
  function systemLight() {
    return !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-color-scheme: light)').matches);
  }

  // 解析成最终外观：'dark' | 'light'
  // （lightNow 可以显式传进来，这样这条纯逻辑能脱离浏览器做自测）
  function resolve(value, lightNow) {
    const m = normalize(value);
    if (m !== 'auto') return m;
    const light = (typeof lightNow === 'boolean') ? lightNow : systemLight();
    return light ? 'light' : 'dark';
  }

  // 点一下按钮下一步去哪。
  //   循环固定是「跟随系统 → 与系统相反 → 与系统相同 → 回到跟随系统」，
  //   顺序随系统主题换向，好处是：从默认的「跟随系统」点第一下**外观一定会变**
  //   （不然用户点了没反应，会以为按钮坏了）。
  //   三步必定回到「跟随系统」，所以这个功能不会丢。
  //   注意：三格里必然有一格"回到跟随系统"是看不出颜色变化的（那时候它本来就等于
  //   系统主题）—— 这是三态循环的固有性质，不是 bug。
  function nextMode(value, lightNow) {
    const m = normalize(value);
    const light = (typeof lightNow === 'boolean') ? lightNow : systemLight();
    const sys = light ? 'light' : 'dark';   // 系统现在长什么样
    const opp = light ? 'dark' : 'light';   // 与系统相反的那个
    const order = ['auto', opp, sys];
    return order[(order.indexOf(m) + 1) % order.length];
  }

  // 把结果写成属性（默认写在 <html> 上）
  function apply(value, el) {
    const target = el || (typeof document === 'undefined' ? null : document.documentElement);
    if (target && target.setAttribute) {
      target.setAttribute('data-gvc-theme', resolve(value === undefined ? mode : value));
    }
  }

  function title(value, lightNow) {
    const m = normalize(value === undefined ? mode : value);
    return '主题：' + LABEL[m] + '（点击切换为' + LABEL[nextMode(m, lightNow)] + '）';
  }

  // 按钮上显示当前状态：🌓 跟随系统 / ☾ 深色 / ☀ 浅色
  function renderButton(btn, value, lightNow) {
    if (!btn) return;
    const m = normalize(value === undefined ? mode : value);
    const size = Number(btn.getAttribute('data-size')) || 15;
    if (globalThis.UIIcons) btn.innerHTML = globalThis.UIIcons.svg(ICON[m], size);
    else btn.textContent = ICON[m] === 'sun' ? '☀' : (ICON[m] === 'moon' ? '☾' : '◐');
    const text = title(m, lightNow);
    btn.title = text;
    btn.setAttribute('aria-label', text);
    btn.setAttribute('data-theme-mode', m);
  }

  // 把所有登记过的元素 / 按钮刷成当前主题
  function refresh() {
    for (const el of roots) apply(mode, el);
    for (const btn of buttons) renderButton(btn, mode);
  }

  function track(el) {
    if (!el) return el;
    roots.add(el);
    apply(mode, el);
    return el;
  }

  function untrack(el) {
    roots.delete(el);
    buttons.delete(el);
    return el;
  }

  function trackButton(btn) {
    if (!btn) return btn;
    if (!buttons.has(btn)) {
      buttons.add(btn);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        cycle();
      });
    }
    renderButton(btn, mode);
    return btn;
  }

  // 改主题：立即生效 + 记忆 + 通知其它界面（storage.onChanged）
  function set(value, opts) {
    mode = normalize(value);
    refresh();
    if (!opts || opts.persist !== false) {
      try {
        chrome.storage.local.set({ [KEY]: mode });
      } catch (e) { /* 不在扩展环境里（预览页）就只改当前页面 */ }
    }
    return mode;
  }

  function cycle() {
    return set(nextMode(mode));
  }

  function init(opts) {
    const o = opts || {};
    // root 传 false 表示"别碰这个文档的 <html>"（页面内面板场景）
    if (o.root !== false) track(o.root || (typeof document === 'undefined' ? null : document.documentElement));
    if (o.button) trackButton(o.button);

    if (started) return mode;
    started = true;

    try {
      chrome.storage.local.get(KEY, (s) => {
        mode = normalize(s && s[KEY]);
        refresh();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[KEY]) return;
        mode = normalize(changes[KEY].newValue);
        refresh();
      });
    } catch (e) {
      refresh();
    }

    // 跟随系统时，系统主题变了要立刻跟上（不需要重开弹窗）
    if (globalThis.matchMedia) {
      const mq = globalThis.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => {
        if (mode === 'auto') refresh();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    refresh();
    return mode;
  }

  // 当前模式（给需要知道状态的调用方）
  function current() {
    return mode;
  }

  return {
    KEY, MODES, LABEL, ICON,
    normalize, systemLight, resolve, nextMode, title,
    apply, track, untrack, trackButton, renderButton,
    set, cycle, init, current
  };
})();

globalThis.ThemeMode = ThemeMode;
