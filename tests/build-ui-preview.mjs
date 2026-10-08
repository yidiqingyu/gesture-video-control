// ============================================================
// tests/build-ui-preview.mjs —— 生成"界面改版预览"（不用装扩展就能看）
//
// 为什么不手写一份预览页：
//   手写的预览页会跟真实样式慢慢走样（改了 popup.css 忘了改预览），最后变成
//   一份骗人的设计稿。所以这里全部从**真实文件**里抠：
//     - theme.css / popup.css / float.css / ui-icons.js：原文内联
//     - 弹窗 / 悬浮窗 / 授权页：取真实 HTML 的 <body>（去掉 <script>）
//     - 页面内面板 / 提示浮层：取 content.js 里 panelCss() / toastCss() 和 innerHTML 模板
//
// 为什么一个文件、还要 Shadow DOM：
//   popup.css 和 float.css 有同名类（.status / .switch-row …），放同一个页面里会
//   互相干扰，预览就不准了。每个界面塞进自己的 Shadow DOM，样式各自隔离 ——
//   这跟页面内面板的真实做法是同一套。顺带一个文件就能双击打开，不用起服务器。
//
// 跑法：node tests/build-ui-preview.mjs [输出路径] [dark|light]
//   - 不加第三个参数：预览跟随系统主题，页面上还有「跟随系统 / 深色 / 浅色」切换条
//   - 加了 dark / light：一打开就写死那个主题（**只用于截图核对**，比如无头浏览器默认浅色）
// 产物：assets/20261004_界面改版预览_v1.html（单个自包含文件）
//
// 说明：
//   1. 会把 CSS 里的元素选择器 body 改写成 :host，因为 Shadow DOM 里没有 body。
//   2. 默认输出到 assets/：这台机器上沙箱命令行进程写不进 memory/ 和 drafts/，
//      脚本产物必须落在命令行也能写的目录里（根目录 / tests / trash / content / assets）。
// ============================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => path.join(root, p);
const read = (p) => readFileSync(at(p), 'utf8');

const OUT = process.argv[2] || 'assets/20261004_界面改版预览_v1.html';
const FORCE_THEME = (process.argv[3] || '').toLowerCase();
const forced = (FORCE_THEME === 'dark' || FORCE_THEME === 'light') ? FORCE_THEME : '';

// ---------- 抽取工具 ----------
const bodyOf = (html) => {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) throw new Error('找不到 <body>');
  return m[1].replace(/<script[\s\S]*?<\/script>/gi, '').trim();
};

const styleOf = (html) => {
  const out = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) out.push(m[1]);
  return out.join('\n');
};

// Shadow DOM 里没有 body / html，把它们改写成 :host
const forShadow = (css) => css.replace(/(^|[^.\w-])(?:html\s*,\s*)?body(?=\s*[{,])/g, '$1:host');

const contentJs = read('content.js');
const pickFromContent = (re, what) => {
  const m = contentJs.match(re);
  if (!m) throw new Error('从 content.js 里取不到' + what + '（改了结构就同步改本脚本）');
  return m[1];
};
const PANEL_CSS = pickFromContent(/function panelCss\(\) \{\s*return `([\s\S]*?)`;\s*\}/, 'panelCss()');
const PANEL_HTML = pickFromContent(/root\.innerHTML = `([\s\S]*?)`;/, '面板的 innerHTML 模板');
const TOAST_CSS = pickFromContent(/function toastCss\(\) \{\s*return `([\s\S]*?)`;\s*\}/, 'toastCss()');

const floatBody = bodyOf(read('float.html'));
const pillMarkup = (() => {
  const m = floatBody.match(/<div id="pill"[\s\S]*?<\/div>/);
  if (!m) throw new Error('从 float.html 里取不到悬浮球');
  return m[0].replace(/\shidden(?=[\s>])/, '');
})();

// ---------- 每个界面：样式 + 结构 + 预览时需要补的那几行 ----------
const mocks = {
  popup: {
    title: '工具栏弹窗',
    note: '点扩展图标弹出的那个（示意状态：识别运行中）',
    css: forShadow(read('popup.css')),
    html: bodyOf(read('popup.html')),
    setup: `
      shadow.querySelector('.gesture-emoji').textContent = '👌';
      shadow.querySelector('.gesture-name').textContent = 'OK';
      shadow.querySelector('.gesture-detail').textContent = '播放 / 暂停（捏合一次触发）';
      const ms = shadow.querySelector('#model-status');
      ms.className = 'status ok';
      ms.textContent = '后台识别运行中';
      const vs = shadow.querySelector('#video-status');
      vs.className = 'status ok';
      vs.textContent = 'B 站 · 已检测到视频';
      shadow.querySelector('#control-toggle').checked = true;
      // 展开手势对照表，一次看清列表样式
      const help = shadow.querySelector('#gesture-help-body');
      help.innerHTML = GestureCatalog.toHTML();
      help.hidden = false;
      shadow.querySelector('#gesture-help-label').textContent = '收起手势对照表';
    `
  },
  float: {
    title: '独立悬浮窗',
    note: '可拖动 / 可缩放的窗口',
    css: forShadow(read('float.css')),
    html: floatBody.replace(/<div id="pill"[\s\S]*?<\/div>/, ''),
    setup: `
      shadow.querySelector('.gesture-emoji').textContent = '🤙';
      shadow.querySelector('.gesture-name').textContent = '小拇指向上';
      shadow.querySelector('.gesture-detail').textContent = '音量 +10%（保持可连调）';
      const ms = shadow.querySelector('#model-status');
      ms.className = 'status ok';
      ms.textContent = '后台识别运行中';
      const vs = shadow.querySelector('#video-status');
      vs.className = 'status ok';
      vs.textContent = 'B 站 · 已检测到视频';
      shadow.querySelector('#control-toggle').checked = true;
    `
  },
  pill: {
    title: '悬浮球',
    note: '最小化后，绿点呼吸 = 识别中',
    css: forShadow(read('float.css')) + `
      /* 预览用：真实页面里是 body.running 触发的，Shadow DOM 里没有 body */
      .pill-icon::after { background: var(--gvc-ok); animation: var(--gvc-pulse-anim); }
    `,
    html: pillMarkup,
    setup: ''
  },
  panel: {
    title: '页面内悬浮面板',
    note: '页面里那一块（已展开手势对照表）',
    css: PANEL_CSS + `
      /* 预览用：真实面板是 position:fixed 贴着窗口的，这里改成贴在框里 */
      .gvc-panel { position: absolute; }
    `,
    html: '<div class="gvc-panel">' + PANEL_HTML + '</div>',
    setup: `
      const panel = shadow.querySelector('.gvc-panel');
      panel.style.left = '10px';
      panel.style.top = '12px';
      /* 真实面板高度由 JS 恢复成用户上次拖的大小；这里给高一点，好把对照表也看到 */
      panel.style.height = '530px';
      panel.querySelector('.gvc-gesture-emoji').textContent = '☝️';
      panel.querySelector('.gvc-gesture-name').textContent = '食指向上';
      panel.querySelector('.gvc-gesture-detail').textContent = '长视频：上一集';
      const st = panel.querySelector('.gvc-status');
      st.className = 'gvc-status ok';
      st.textContent = '后台识别运行中';
      panel.querySelector('[data-ctl="control"]').checked = true;
      const help = panel.querySelector('.gvc-help');
      help.innerHTML = GestureCatalog.toHTML();
      help.hidden = false;
      panel.querySelector('[data-act="help"]').classList.add('active');
    `
  },
  toast: {
    title: '提示浮层（Toast）',
    note: '手势触发后右上角弹出的一条反馈',
    css: TOAST_CSS + `
      /* 预览用：真实浮层是 position:fixed 贴窗口右上角的，这里改贴画框 */
      .gvc-toast { position: absolute; right: 16px; top: 16px; }
    `,
    html: '<div class="gvc-toast on">已切换到短视频模式（食指上=↑，食指下=↓）</div>',
    setup: ''
  },
  grant: {
    title: '摄像头授权页',
    note: '一次性授权用的页面（示意状态：授权成功）',
    css: forShadow(styleOf(read('grant.html'))) + `
      /* 预览用：授权页原本要占满整屏（min-height:100vh），这里改回画框高度 */
      :host { min-height: 0; }
    `,
    html: bodyOf(read('grant.html')),
    setup: `
      const msg = shadow.querySelector('#msg');
      msg.className = 'ok';
      msg.textContent = '摄像头授权成功！后台手势识别已准备启动，可以关闭本页面。';
      shadow.querySelector('#done').hidden = false;
    `
  }
};

// 每个界面在预览页里占多大
const SIZES = {
  popup: [360, 980], float: [300, 520], pill: [72, 72],
  panel: [330, 560], toast: [420, 110], grant: [560, 300]
};

// ---------- 生成 ----------
// 把内容塞进 <script> 时把 < 转义掉，避免内容里出现 </script> 把脚本截断
const js = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const frames = Object.entries(mocks).map(([key, mock]) => {
  const [w, h] = SIZES[key];
  return `    <figure class="frame">
      <figcaption><b>${mock.title}</b><span>${mock.note}</span></figcaption>
      <div class="stage" data-mock="${key}" style="width:${w}px;height:${h}px"></div>
    </figure>`;
}).join('\n');

const mockData = JSON.stringify(Object.fromEntries(
  Object.entries(mocks).map(([key, mock]) => [key, { css: mock.css, html: mock.html, setup: mock.setup }])
)).replace(/</g, '\\u003c');

const html = `<!DOCTYPE html>
<html lang="zh-CN"${forced ? ' data-gvc-theme="' + forced + '"' : ''}>
<head>
<meta charset="UTF-8">
<title>手势视频控制 · 界面改版预览</title>
<!-- 本文件由 tests/build-ui-preview.mjs 自动生成，不要手改；改了样式重新跑一次即可 -->
<style>
${read('theme.css')}
</style>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 26px 26px 44px;
    background-color: var(--gvc-bg);
    background-image: radial-gradient(90% 40% at 50% 0%, var(--gvc-accent-soft), transparent 60%);
    background-repeat: no-repeat;
    color: var(--gvc-text);
    font-family: var(--gvc-font);
    -webkit-font-smoothing: antialiased;
  }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; letter-spacing: .01em; }
  .lead { margin: 0 0 18px; max-width: 780px; font-size: 13px; line-height: 1.85; color: var(--gvc-text-dim); }
  .lead b { color: var(--gvc-text); }
  .lead code {
    padding: 2px 6px; border-radius: 6px;
    background: var(--gvc-surface-hi); border: 1px solid var(--gvc-line);
    font-family: var(--gvc-mono); font-size: 12px;
  }
  /* 主题切换条：和插件里那个按钮走的是同一套逻辑（data-gvc-theme） */
  .theme-bar {
    display: flex; align-items: center; gap: 8px;
    margin: 0 0 22px; font-size: 12.5px; color: var(--gvc-text-dim);
  }
  .theme-bar button {
    padding: 6px 12px;
    border: 1px solid var(--gvc-line-strong);
    border-radius: 999px;
    background: var(--gvc-surface);
    color: var(--gvc-text-dim);
    font-family: inherit; font-size: 12.5px; cursor: pointer;
    transition: background var(--gvc-fast) var(--gvc-ease), color var(--gvc-fast) var(--gvc-ease),
                border-color var(--gvc-fast) var(--gvc-ease);
  }
  .theme-bar button:hover { background: var(--gvc-surface-hi); color: var(--gvc-text); }
  .theme-bar button[aria-pressed="true"] {
    background: var(--gvc-accent);
    border-color: transparent;
    color: var(--gvc-on-accent);
    box-shadow: 0 8px 18px -10px var(--gvc-accent-glow);
  }
  .grid { display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start; }
  .frame { margin: 0; }
  figcaption { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; font-size: 12.5px; }
  figcaption span { font-size: 11.5px; color: var(--gvc-text-mute); }
  .stage {
    position: relative;
    border: 1px solid var(--gvc-line);
    border-radius: var(--gvc-radius);
    background: var(--gvc-bg-soft);
    box-shadow: var(--gvc-shadow-lg);
    overflow: hidden;
  }
  /* 摄像头区域在预览里没有真实画面，给个深色底，别看起来像坏了 */
  .stage::before {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background-image: radial-gradient(120% 80% at 50% 0%, rgba(79, 139, 255, .07), transparent 60%);
  }
</style>
</head>
<body>
  <h1>手势视频控制 · 界面改版预览</h1>
  <p class="lead">
    这个文件把各个界面并排摆出来，<b>双击就能看，不用装扩展、不用起服务器</b>。<br>
    样式和结构都是从真实文件里抠出来的（<code>theme.css</code>、<code>popup.css</code>、
    <code>float.css</code>、<code>content.js</code> 的面板 / 浮层样式），每个界面各在自己的
    Shadow DOM 里、互不干扰，所以看到的就是装进浏览器后的样子。<br>
    摄像头区域显示的是"还没开摄像头"的占位状态；文字内容是示意状态，方便看清排版。
  </p>
  <div class="theme-bar">
    <span>主题：</span>
    <button type="button" data-theme-pick="auto">跟随系统</button>
    <button type="button" data-theme-pick="dark">深色</button>
    <button type="button" data-theme-pick="light">浅色</button>
    <span>（这里调的就是插件里那个主题按钮的逻辑；界面标题栏上那个小图标也能点）</span>
  </div>
  <div class="grid">
${frames}
  </div>

<script>
${read('ui-icons.js')}
</script>
<script>
${read('gesture-catalog.js')}
</script>
<script>
${read('theme-mode.js')}
</script>
<script>
const MOCKS = ${mockData};
for (const [key, mock] of Object.entries(MOCKS)) {
  const host = document.querySelector('.stage[data-mock="' + key + '"]');
  if (!host) continue;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = mock.css + (key === 'panel' ? GestureCatalog.css() : '');
  shadow.appendChild(style);
  const box = document.createElement('div');
  box.innerHTML = mock.html;
  while (box.firstChild) shadow.appendChild(box.firstChild);
  if (window.UIIcons) UIIcons.mount(shadow);
  // 主题按钮：用真实的渲染器画图标，并接上点击循环（点它就能在这里换主题）
  if (window.ThemeMode) {
    for (const btn of shadow.querySelectorAll('[data-theme-toggle]')) ThemeMode.trackButton(btn);
  }
  try {
    new Function('shadow', 'GestureCatalog', 'UIIcons', mock.setup)(shadow, window.GestureCatalog, window.UIIcons);
  } catch (e) {
    // 补状态失败就把错误画在画框里：不然预览会静静地显示成默认状态，看起来"没问题"
    const err = document.createElement('div');
    err.textContent = '补状态失败：' + e.message;
    err.style.cssText = 'position:absolute;left:8px;bottom:6px;z-index:99;' +
      'font:11px/1.4 ui-monospace,Consolas,monospace;color:#F87171;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:6px';
    host.appendChild(err);
    console.warn('预览补状态失败：' + key, e);
  }
}

// 预览页自己的主题切换条：走的是和插件完全相同的 ThemeMode + data-gvc-theme
ThemeMode.init({ root: document.documentElement });
if (${JSON.stringify(forced)}) ThemeMode.set(${JSON.stringify(forced)}, { persist: false });
const pickButtons = Array.from(document.querySelectorAll('[data-theme-pick]'));
function markActive() {
  for (const b of pickButtons) {
    b.setAttribute('aria-pressed', b.getAttribute('data-theme-pick') === ThemeMode.current() ? 'true' : 'false');
  }
}
for (const b of pickButtons) {
  b.addEventListener('click', () => ThemeMode.set(b.getAttribute('data-theme-pick'), { persist: false }));
}
// 点界面里那些主题按钮也会改属性，这里跟着更新高亮
new MutationObserver(markActive).observe(document.documentElement, {
  attributes: true, attributeFilter: ['data-gvc-theme']
});
markActive();
</script>
</body>
</html>
`;

writeFileSync(at(OUT), html, 'utf8');
console.log('已生成预览：' + OUT.replace(/\\/g, '/') + '（' + (html.length / 1024).toFixed(1) + ' KB）');
console.log('打开方式：在文件管理器里双击它');
