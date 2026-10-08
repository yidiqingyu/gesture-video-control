// ============================================================
// ui-icons.js —— 内联矢量图标集（弹窗 / 悬浮窗 / 页面内面板共用）
//
// 以前界面上的 logo、👁、—、✕、📖 全是 emoji：不同系统画出来的样子不一样，
// 粗细不统一，放到深色玻璃卡片上很"玩具"。这里换成一套统一线宽（1.6）的描边
// 图标，颜色用 currentColor，所以图标颜色跟着文字颜色走，深浅主题都自动适配。
//
// 用法：
//   HTML 里写占位：<span data-icon="camera" data-size="15"></span>
//   脚本里调用一次：UIIcons.mount(某个根元素)   // 不传参数就是整个文档
//   需要现成的 SVG 字符串：UIIcons.svg('logo', 24)
//
// 注意：这里只做静态字符串拼接，没有用户输入；插进 DOM 用的是 innerHTML，
//      不涉及内联脚本，所以不违反扩展的 CSP。
// ============================================================

'use strict';

const UIIcons = (() => {
  // 24×24 视框，stroke 描边路径（改 viewBox 时记得同步 stroke-width 观感）
  const PATHS = {
    // 手（品牌标记）
    logo:
      '<path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/>' +
      '<path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2"/>' +
      '<path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/>' +
      '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    // 显示 / 隐藏摄像头画面
    eye:
      '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/>' +
      '<circle cx="12" cy="12" r="3"/>',
    eyeOff:
      '<path d="M4 4l16 16"/>' +
      '<path d="M10.3 5.8A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a18 18 0 0 1-3.2 4"/>' +
      '<path d="M6.6 7.7A18 18 0 0 0 2 12s3.6 6.5 10 6.5a9.8 9.8 0 0 0 3.6-.7"/>' +
      '<path d="M9.9 10a3 3 0 0 0 4.1 4.1"/>',
    minus: '<path d="M5 12h14"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    // 手势对照表
    book:
      '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
      '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
    camera:
      '<path d="M22 8.6V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.6a2 2 0 0 1 2-2h2.6l1.7-2.4a1 1 0 0 1 .8-.4h5.8a1 1 0 0 1 .8.4L17.4 6.6H20a2 2 0 0 1 2 2Z"/>' +
      '<circle cx="12" cy="12.8" r="3.6"/>',
    // 悬浮面板
    panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16.5V11"/><path d="M12 7.8h.01"/>',
    // 科技感点缀（锁定 / 脉冲）
    spark: '<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/>',
    lock:
      '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/>' +
      '<path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/>',
    // 主题切换（浅色 / 深色 / 跟随系统）
    sun:
      '<circle cx="12" cy="12" r="4"/>' +
      '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    autoTheme:
      '<circle cx="12" cy="12" r="9"/>' +
      '<path d="M12 3v18"/>' +
      '<path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>'
  };

  // 生成一个图标的 SVG 字符串；未知名字退回 logo，避免出现空洞
  function svg(name, size) {
    const body = PATHS[name] || PATHS.logo;
    const px = Number(size) > 0 ? Number(size) : 16;
    return '<svg class="gvc-icon" viewBox="0 0 24 24" width="' + px + '" height="' + px + '"' +
      ' fill="none" stroke="currentColor" stroke-width="1.6"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      body + '</svg>';
  }

  // 把根元素（默认整个文档）里所有 <... data-icon="名字" data-size="16"> 填成 SVG
  function mount(root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const slots = scope.querySelectorAll('[data-icon]');
    for (const slot of slots) {
      const size = Number(slot.getAttribute('data-size')) || 16;
      slot.innerHTML = svg(slot.getAttribute('data-icon'), size);
    }
    return slots.length;
  }

  return { PATHS, svg, mount };
})();

globalThis.UIIcons = UIIcons;
