// ============================================================
// tests/integration-check.mjs —— 静态体检（不开浏览器）
//
// 这里没法真的启动 Chrome 跑扩展，但「引用关系写错」这类致命问题
// 完全可以在本地静态查出来，而且它们一旦写错就是整个扩展打不开：
//
//   1. manifest.json 里声明的每个文件是否真的存在 / 权限是否合法
//   2. HTML 里 <script src> / <link href> 指向的文件是否存在
//   3. offscreen.js / float.js 用到的 GestureMath.xxx 是否真的被导出
//   3b. background.js 用到的 HealthDecide.xxx 是否真的被导出
//   4. gesture.js / health.js 能否脱离浏览器加载
//   5. 权限与站点清单是否和代码里的 SITES 一致 / 没申请全站权限
//   5b. 注入 content.js 的地方是否连带注入了数据 / 图标 / 设计令牌
//   6. popup.js 里 getElementById 用到的 id 是否真的存在
//   7. 编码体检（防"中文变乱码"）
//   8. 手势对照表数据自检
//   9. 动作闸门分类是否齐全
//  10. 打包排除清单不会把运行需要的文件排掉
//  11. 设计令牌（theme.css）是否完整、浅色两处是否一致、三处界面用到的变量是否都有定义
//  12. 主题模式（theme-mode.js）的纯逻辑：点一下外观一定变、三步内能转回跟随系统
//
// 跑法：node tests/integration-check.mjs
//
// ⚠️ 编写本文件时的约定：record(分组, 说明, 条件, 附加信息) —— 条件是第三个参数。
//    写成 record(分组, 条件, 说明) 会让"说明字符串"落入条件位置、永远为真，
//    检查就全部变成"永远通过"。文件开头有「0-断言器自检」专门盯着这件事。
// ============================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => path.join(root, p);
// 统一转成 LF 再比对：仓库里存的是 LF，但 git 在 Windows 上检出时可能写成 CRLF
// （core.autocrlf），那样带 \n 的正则就匹配不上 —— 这类"换台机器就红"的坑在这里堵掉。
const read = (p) => readFileSync(at(p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];
const groups = new Map();

// ---------- 断言器 ----------
function record(group, label, ok, extra) {
  if (!groups.has(group)) groups.set(group, { ok: 0, total: 0 });
  const g = groups.get(group);
  g.total += 1;
  if (ok) {
    g.ok += 1;
    passed += 1;
  } else {
    failures.push({ group, label, extra });
  }
}

// ---------- 0. 断言器自检 ----------
// 故意喂一个假条件，确认它真的会被记成失败；否则后面所有检查都是白做。
{
  const before = failures.length;
  record('0-断言器自检', '（内部探测，这一条必须被判定为失败）', false, {});
  const works = failures.length === before + 1;
  if (works) failures.pop();
  groups.delete('0-断言器自检');
  record('0-断言器自检', '断言器能识别失败（否则所有检查都是白做）', works, {});
}

// ---------- 1. manifest 声明的文件 ----------
let manifest = null;
try {
  manifest = JSON.parse(read('manifest.json'));
  record('1-manifest', 'manifest.json 是合法 JSON', true, {});
} catch (e) {
  record('1-manifest', 'manifest.json 是合法 JSON', false, { error: String(e.message) });
}

if (manifest) {
  const declared = [];
  if (manifest.background && manifest.background.service_worker) declared.push(manifest.background.service_worker);
  if (manifest.action && manifest.action.default_popup) declared.push(manifest.action.default_popup);
  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) declared.push(f);
    for (const f of cs.css || []) declared.push(f);
  }
  for (const entry of Object.values(manifest.icons || {})) declared.push(entry);
  for (const entry of Object.values((manifest.action && manifest.action.default_icon) || {})) declared.push(entry);

  for (const f of declared) {
    record('1-manifest', '声明的文件存在：' + f, existsSync(at(f)), { file: f });
  }

  const KNOWN_PERMISSIONS = [
    'activeTab', 'scripting', 'storage', 'offscreen', 'debugger', 'tabs', 'windows', 'alarms'
  ];
  const unknown = (manifest.permissions || []).filter((p) => KNOWN_PERMISSIONS.indexOf(p) === -1);
  record('1-manifest', '权限都在已知清单里' + (unknown.length ? '（可疑：' + unknown.join(',') + '）' : ''),
    unknown.length === 0, { unknown });

  record('1-manifest', '版本号形如 x.y.z', /^\d+\.\d+\.\d+$/.test(manifest.version || ''),
    { version: manifest.version });
}

// ---------- 2. HTML 里的资源引用 ----------
const htmlFiles = ['offscreen.html', 'popup.html', 'float.html', 'grant.html'];
for (const html of htmlFiles) {
  if (!existsSync(at(html))) continue;
  const text = read(html);
  const refs = [];
  for (const m of text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) refs.push(m[1]);
  for (const m of text.matchAll(/<link[^>]+href=["']([^"']+)["']/g)) refs.push(m[1]);
  for (const ref of refs) {
    if (/^https?:/i.test(ref)) continue;
    const clean = ref.split('?')[0].split('#')[0];
    record('2-HTML引用', html + ' → ' + clean, existsSync(at(clean)), { ref: clean });
  }
}

// ---------- 3. 引擎用到的 GestureMath 接口是否都存在 ----------
const GestureMath = new Function(read('gesture.js') + '\n;return globalThis.GestureMath;')();
const exported = Object.keys(GestureMath);

for (const file of ['offscreen.js', 'float.js', 'content.js', 'popup.js']) {
  if (!existsSync(at(file))) continue;
  const text = read(file);
  const used = new Set();
  for (const m of text.matchAll(/GestureMath\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  for (const name of used) {
    record('3-接口一致', file + ' 用到的 GestureMath.' + name,
      exported.indexOf(name) !== -1, { missing: name, exported });
  }
}

// ---------- 3b. 后台用到的 HealthDecide 接口是否都存在 ----------
const HealthDecide = new Function(read('health.js') + '\n;return globalThis.HealthDecide;')();
const healthExported = Object.keys(HealthDecide);
{
  const text = read('background.js');
  const used = new Set();
  for (const m of text.matchAll(/HealthDecide\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  for (const name of used) {
    record('3b-自检接口', 'background.js 用到的 HealthDecide.' + name,
      healthExported.indexOf(name) !== -1, { missing: name, healthExported });
  }
  record('3b-自检接口', 'background.js 用 importScripts 加载了 health.js',
    /importScripts\(\s*['"]health\.js['"]\s*\)/.test(text), {});
}

// ---------- 4. 纯逻辑模块必须能脱离浏览器加载 ----------
record('4-可加载', 'gesture.js 能加载并给出 classifyPose / createPoseTracker',
  typeof GestureMath.classifyPose === 'function' && typeof GestureMath.createPoseTracker === 'function',
  { exported });
record('4-可加载', 'health.js 能加载并给出 check / isControllableUrl',
  typeof HealthDecide.check === 'function' && typeof HealthDecide.isControllableUrl === 'function',
  { healthExported });

// ---------- 5. 权限与站点清单要对得上 ----------
if (manifest) {
  const perms = manifest.permissions || [];
  record('5-权限', '声明了 alarms 权限（自检闹钟要用）', perms.indexOf('alarms') !== -1, { perms });

  const hosts = (manifest.host_permissions || []).join(' ');
  const allMatches = (manifest.content_scripts || []).flatMap((cs) => cs.matches || []);
  const declared = allMatches.concat(manifest.host_permissions || []);

  for (const site of HealthDecide.SITES) {
    const bare = declared.some((p) => p === 'https://' + site + '/*');
    const wildcard = declared.some((p) => p === 'https://*.' + site + '/*');
    record('5-权限', '站点清单与 manifest 一致（含裸域名与通配）：' + site, bare && wildcard,
      { site, bare, wildcard });
    record('5-权限', 'content_scripts 覆盖：' + site,
      allMatches.indexOf('https://*.' + site + '/*') !== -1, { site, allMatches });
  }
  record('5-权限', '没有申请全站权限 <all_urls>（保持最小权限承诺）',
    hosts.indexOf('<all_urls>') === -1 && allMatches.join(' ').indexOf('<all_urls>') === -1,
    { hosts, allMatches });
}

// ---------- 5b. 注入 content.js 的地方必须连数据 / 图标 / 令牌一起注入 ----------
// content.js 里的手势对照表用 gesture-catalog.js 的数据、标题栏图标用 ui-icons.js，
// 页面内面板的颜色来自 theme.css（用 insertCSS 插进页面）。
// 少注入一处，那个场景下面板就会"空一块 / 没样式"，而且很难查。
{
  const collectLists = (text) => {
    const lists = [];
    for (const m of text.matchAll(/files:\s*\[([^\]]*)\]/g)) lists.push(m[1]);
    // background.js 把清单抽成了命名常量：const CONTENT_FILES = [...]
    for (const m of text.matchAll(/CONTENT_FILES\s*=\s*\[([^\]]*)\]/g)) lists.push(m[1]);
    return lists;
  };
  const REQUIRED = ['gesture-catalog.js', 'ui-icons.js', 'theme-mode.js'];

  for (const file of ['background.js', 'popup.js', 'float.js']) {
    if (!existsSync(at(file))) continue;
    const text = read(file);
    const lists = collectLists(text);
    const contentLists = lists.filter((l) => l.indexOf('content.js') !== -1);
    record('5b-注入清单', file + ' 至少有一处注入 content.js', contentLists.length > 0, { lists });
    for (const list of contentLists) {
      for (const need of REQUIRED) {
        record('5b-注入清单', file + ' 注入 content.js 时带上 ' + need,
          list.indexOf(need) !== -1, { list: list.trim() });
      }
      const before = REQUIRED.every((need) => list.indexOf(need) < list.indexOf('content.js'));
      record('5b-注入清单', file + ' 的数据 / 图标 / 主题排在 content.js 前面', before, { list: list.trim() });
    }
    // 补注入时还要把 theme.css 插进去，否则页面里没有 --gvc-* 令牌
    record('5b-注入清单', file + ' 注入内容脚本时一并插入 theme.css',
      /insertCSS\([\s\S]{0,240}theme\.css/.test(text), {});
  }
  if (manifest) {
    for (const cs of manifest.content_scripts || []) {
      const js = cs.js || [];
      if (js.indexOf('content.js') === -1) continue;
      for (const need of REQUIRED) {
        record('5b-注入清单', 'manifest 的 content_scripts 带上 ' + need,
          js.indexOf(need) !== -1, { js });
      }
      record('5b-注入清单', 'manifest 里数据 / 图标 / 主题排在 content.js 前面',
        REQUIRED.every((need) => js.indexOf(need) < js.indexOf('content.js')), { js });
      record('5b-注入清单', 'manifest 的 content_scripts 注入 theme.css（页面内面板的令牌来源）',
        (cs.css || []).indexOf('theme.css') !== -1, { css: cs.css });
    }
  }
}

// ---------- 6. getElementById 的 id 必须真的存在 ----------
for (const [js, html] of [['popup.js', 'popup.html'], ['grant.js', 'grant.html']]) {
  if (!existsSync(at(js)) || !existsSync(at(html))) continue;
  const jsText = read(js);
  const htmlText = read(html);
  const ids = new Set();
  for (const m of jsText.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
  for (const id of ids) {
    record('6-DOM id', js + ' → #' + id, htmlText.indexOf('id="' + id + '"') !== -1, { id });
  }
}

// ---------- 7. 编码体检（防"中文变乱码"）----------
// 背景：用 PowerShell 的文本替换处理 UTF-8 源码时，PowerShell 5.1 会按系统
// 代码页（GBK）读、按 UTF-8 写回 —— 整个文件的中文变乱码，而语法检查照样通过
//（乱码也是合法字符串）。这里用「U+FFFD + 典型 GBK 乱码专用字」兜底。
// 标记字故意用 \u 转义写，这样本文件自己也能被体检。
{
  const MOJIBAKE = '\u951B\u93C2\u93B5\u7481\u93C4\u9428\u6D93\u935C\u6D63\u9366\u59E3\u7ECB\u6434\u935A\u93C3\u93C7\u93B6\u9350\u74BA\u705E\u93CD\u9352\u7EE0\u9354\u9473\u7487\u93AC\u7F03\u7F01\u7F02\u93BB\u934F';
  const countMojibake = (text) => {
    let n = 0;
    for (const ch of text) if (MOJIBAKE.indexOf(ch) !== -1) n += 1;
    return n;
  };

  // 先确认这个检测本身有效：拿一段带乱码字的样本，必须查得出来
  // （样本直接用标记字拼，避免手写 \u 转义写错导致"检测器自检"自己失真）
  const sample = MOJIBAKE.slice(0, 4) + ' Service Worker ' + MOJIBAKE.slice(10, 12);
  record('7-编码', '乱码检测器本身有效（样本命中 ' + countMojibake(sample) + ' 字，要求 ≥3）',
    countMojibake(sample) >= 3, { sample });

  const textFiles = [
    'manifest.json', 'background.js', 'health.js', 'gesture.js', 'gesture-catalog.js',
    'action-policy.js', 'content.js', 'offscreen.js', 'offscreen.html', 'popup.js',
    'popup.html', 'popup.css', 'float.js', 'float.html', 'float.css',
    'theme.css', 'ui-icons.js', 'theme-mode.js',
    'grant.js', 'grant.html', 'README.md', '.gitignore', 'AGENTS.md',
    'tests/run-all.mjs', 'tests/integration-check.mjs', 'tests/gesture-selftest.mjs',
    'tests/engine-sim.mjs', 'tests/health-selftest.mjs', 'tests/policy-selftest.mjs',
    'tests/hand-model.mjs', 'tests/gesture-inspect.mjs', 'tests/build-ui-preview.mjs',
    'tests/verify-crx.mjs'
  ];
  for (const file of textFiles) {
    if (!existsSync(at(file))) continue;
    const text = read(file);
    const hasReplacement = text.indexOf('\uFFFD') !== -1;
    const marker = countMojibake(text);
    record('7-编码', file + ' 是正常 UTF-8 中文（乱码字 ' + marker + ' 个）',
      !hasReplacement && marker === 0, { file, hasReplacement, marker });
  }
}

// ---------- 8. 手势对照表数据自检 ----------
{
  const Catalog = new Function(read('gesture-catalog.js') + '\n;return globalThis.GestureCatalog;')();
  const items = Catalog.groups.flatMap((g) => g.items);
  record('8-手势表', '手势条目数量合理（' + items.length + ' 条 ≥ 10）', items.length >= 10, { count: items.length });

  for (const group of Catalog.groups) {
    record('8-手势表', '分组「' + group.title + '」有内容', (group.items || []).length > 0, {});
    for (const item of group.items) {
      record('8-手势表', '条目「' + item.name + '」字段完整（图标/名称/动作/说明）',
        !!(item.emoji && item.name && item.action && item.note), { item });
    }
  }
  record('8-手势表', '小贴士非空', Catalog.tips.length > 0, {});

  const html = Catalog.toHTML();
  record('8-手势表', 'toHTML 渲染条数与数据一致',
    (html.match(/gh-item/g) || []).length === items.length,
    { rendered: (html.match(/gh-item/g) || []).length, items: items.length });
  for (const item of items) {
    record('8-手势表', '渲染结果包含「' + item.name + '」', html.indexOf(item.name) !== -1, {});
  }
  record('8-手势表', 'css() 返回样式', Catalog.css().indexOf('.gh-item') !== -1, {});

  // 渲染必须转义：用一份带尖括号的假数据替换掉真数据，重新加载一次
  const fake = 'const groups = ' + JSON.stringify([
    { title: 't', items: [{ emoji: '<b>', name: '<i>', action: '<u>', note: '<s>' }] }
  ]) + ';';
  const CATALOG_START = /const groups = \[[\s\S]*?\n  \];/;
  const source = read('gesture-catalog.js');
  const patched = source.indexOf('const groups = [') !== -1
    ? source.replace(CATALOG_START, fake)
      .replace(/const tips = \[[\s\S]*?\n  \];/, 'const tips = [];')
    : source;
  const Escaped = new Function(patched + '\n;return globalThis.GestureCatalog;')();
  const out = Escaped.toHTML();
  record('8-手势表', '渲染时对特殊字符做了转义',
    out.indexOf('<b>') === -1 && out.indexOf('&lt;b&gt;') !== -1, { head: out.slice(0, 100) });
}

// ---------- 9. 动作闸门：引擎发出的每个动作都要在 action-policy 里分好类 ----------
// 加了新动作却忘了分类，就会绕过「没在放视频就别执行观看类手势」这道闸门。
{
  const Policy = new Function(read('action-policy.js') + '\n;return globalThis.ActionPolicy;')();
  const text = read('offscreen.js');

  // 只看 triggerAction(...) 参数里"长得像动作名"的字面量（下划线小写）：
  // 手势名（OK / 点赞 / 🤟 / 双手点赞 …）不是动作，不参与判定
  const ACTION_LIKE = /^[a-z][a-z0-9]*_[a-z0-9_]+$/;
  const found = new Set();
  for (const call of text.matchAll(/triggerAction\(([^)]*)\)/g)) {
    for (const lit of call[1].matchAll(/'([^']*)'/g)) {
      const value = lit[1];
      if (value.endsWith('_')) {
        // 'num_' 这种前缀：展开成闸门表里对应的具体动作
        for (const action of Policy.PAGE_ACTIONS) {
          if (action.indexOf(value) === 0) found.add(action);
        }
      } else if (ACTION_LIKE.test(value)) {
        found.add(value);
      }
    }
  }

  record('9-动作闸门', '引擎里识别出足够多的动作（' + found.size + ' 个）', found.size >= 6,
    { actions: Array.from(found).sort() });
  for (const action of found) {
    record('9-动作闸门', '动作已分类：' + action, Policy.isKnown(action), { action });
  }
  // 反向：闸门表里的动作应当都在引擎里真的用到（避免表里留下死条目）
  for (const action of Policy.VIDEO_ACTIONS.concat(Policy.FEED_ACTIONS)) {
    record('9-动作闸门', '闸门表里的 ' + action + ' 在引擎里有用到',
      text.indexOf("'" + action + "'") !== -1, { action });
  }
  record('9-动作闸门', 'offscreen.html 加载了 action-policy.js',
    read('offscreen.html').indexOf('action-policy.js') !== -1, {});
  record('9-动作闸门', 'offscreen.js 取到了 ActionPolicy',
    /const ActionPolicy = globalThis\.ActionPolicy/.test(text), {});
  // 最关键的一条：动作统一在 triggerAction 里过闸门，任何分支都绕不过去
  {
    const body = text.slice(text.indexOf('async function triggerAction'));
    const head = body.slice(0, body.indexOf('try {'));
    record('9-动作闸门', 'triggerAction 内部统一过闸门（忘了在分支里判断也漏不掉）',
      /actionGate\(action/.test(head), { head: head.slice(0, 200) });
  }
}

// ---------- 10. 打包排除清单不能把运行需要的文件排掉 ----------
// pack-crx.ps1 会先复制一份"只含运行必需文件"的快照再打包；如果排除清单写错
//（比如把 vendor/ 或 icons/ 排掉），打出来的 .crx 就是坏的，而且很难查。
{
  const packText = read('pack-crx.ps1');
  const pick = (name) => {
    const m = packText.match(new RegExp('\\$' + name + '\\s*=\\s*@\\(([^)]*)\\)'));
    return m ? Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]) : [];
  };
  const excludedDirs = pick('excludeDirs');
  const excludedFiles = pick('excludeFiles');

  // pack-crx.ps1 里全是中文注释：没有 UTF-8 BOM 时 Windows PowerShell 5.1
  // 会按 GBK 读，脚本直接语法报错。（编辑工具保存时会吃掉 BOM，所以必须自动盯着。）
  const packBytes = readFileSync(at('pack-crx.ps1'));
  record('10-打包清单', 'pack-crx.ps1 带 UTF-8 BOM（否则 PowerShell 5.1 读中文会乱码）',
    packBytes[0] === 0xEF && packBytes[1] === 0xBB && packBytes[2] === 0xBF,
    { first3: Array.from(packBytes.slice(0, 3)) });

  record('10-打包清单', '能解析出排除目录（' + excludedDirs.length + ' 个）', excludedDirs.length > 0, { excludedDirs });
  record('10-打包清单', '排除了 .git（否则用户的 .crx 里会带上完整提交历史）',
    excludedDirs.indexOf('.git') !== -1, { excludedDirs });
  record('10-打包清单', '排除了 memory（本机工作记录不该发给用户）',
    excludedDirs.indexOf('memory') !== -1, { excludedDirs });
  record('10-打包清单', '排除了 tests（自测不进 .crx）',
    excludedDirs.indexOf('tests') !== -1, { excludedDirs });
  record('10-打包清单', '排除了 dist（产物本身不该再进包）',
    excludedDirs.indexOf('dist') !== -1, { excludedDirs });
  record('10-打包清单', '排除了 assets（设计预览页这类素材不该进 .crx）',
    excludedDirs.indexOf('assets') !== -1, { excludedDirs });
  record('10-打包清单', '没有把 vendor/ 排掉（MediaPipe 运行时与模型都在里面）',
    excludedDirs.indexOf('vendor') === -1, { excludedDirs });
  record('10-打包清单', '没有把 icons/ 排掉', excludedDirs.indexOf('icons') === -1, { excludedDirs });

  // 逐个核对"运行时必须的文件"不会被排除规则命中
  const needed = new Set(['health.js', 'gesture.js', 'action-policy.js', 'gesture-catalog.js']);
  if (manifest) {
    if (manifest.background && manifest.background.service_worker) needed.add(manifest.background.service_worker);
    if (manifest.action && manifest.action.default_popup) needed.add(manifest.action.default_popup);
    for (const cs of manifest.content_scripts || []) {
      for (const f of cs.js || []) needed.add(f);
      for (const f of cs.css || []) needed.add(f);
    }
    for (const v of Object.values(manifest.icons || {})) needed.add(v);
    for (const v of Object.values((manifest.action && manifest.action.default_icon) || {})) needed.add(v);
  }
  for (const html of ['offscreen.html', 'popup.html', 'float.html', 'grant.html']) {
    if (!existsSync(at(html))) continue;
    for (const m of read(html).matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const ref = m[1];
      if (/^https?:/i.test(ref)) continue;
      needed.add(ref.split('?')[0].split('#')[0]);
    }
  }
  needed.add('vendor/mediapipe/hand_landmarker.task');
  needed.add('vendor/mediapipe/vision_bundle.mjs');

  for (const file of needed) {
    const top = file.split('/')[0];
    record('10-打包清单', '运行需要的文件不会被排除：' + file,
      excludedDirs.indexOf(top) === -1 && excludedFiles.indexOf(file) === -1,
      { file, top, excludedDirs, excludedFiles });
  }
}

// ---------- 11. 设计令牌（theme.css）与主题切换 ----------
// 四处界面（弹窗 / 悬浮窗 / 授权页 / 页面内面板）都只写 var(--gvc-xxx)，色值全在 theme.css。
// 这里查：
//   1) 令牌确实定义了，深浅两套都有，且和主题无关的那批（圆角/字体/动效）也在；
//   2) 用到的每个令牌都真的有定义（写错一个名字就会静默掉色）；反向也没有死令牌；
//   3) 浅色值写了两遍（跟随系统一份、手动指定一份），两处必须逐字一致；
//   4) 关闭动画偏好有降级（不然有人会被一直动的扫描线晃到）。
{
  const theme = read('theme.css');
  const parseTokens = (text) => {
    const map = new Map();
    for (const m of text.matchAll(/(--gvc-[\w-]+)\s*:\s*([^;}]+)/g)) map.set(m[1], m[2].trim());
    return map;
  };
  // 从某个片段起点切到该规则结束（第一个顶格的 }）
  const blockFrom = (start) => {
    const i = theme.indexOf(start);
    if (i === -1) return '';
    const j = theme.indexOf('\n}', i);
    return theme.slice(i, j === -1 ? theme.length : j);
  };

  const base = parseTokens(blockFrom(':root {'));                            // 与主题无关的令牌
  const dark = parseTokens(blockFrom(':root,\n[data-gvc-theme="dark"]'));    // 深色（默认 + 手动深色）
  const lightMedia = parseTokens(blockFrom('@media (prefers-color-scheme: light)')); // 浅色：跟随系统
  const lightAttr = parseTokens(blockFrom('[data-gvc-theme="light"]'));      // 浅色：手动指定
  const defined = new Map([...base, ...dark]);

  record('11-主题令牌', 'theme.css 定义了令牌（' + defined.size + ' 个，要求 ≥ 20）',
    defined.size >= 20, { base: base.size, dark: dark.size });
  record('11-主题令牌', '深色写在同一处规则里，且手动指定深色也生效',
    /:root,\s*\n\[data-gvc-theme="dark"\]\s*\{/.test(theme), {});

  const MUST_SWITCH = [
    '--gvc-bg', '--gvc-surface', '--gvc-surface-hi', '--gvc-line', '--gvc-text',
    '--gvc-text-dim', '--gvc-accent', '--gvc-ok', '--gvc-warn', '--gvc-err',
    '--gvc-hairline', '--gvc-shadow-sm', '--gvc-stage', '--gvc-stage-text'
  ];
  for (const name of MUST_SWITCH) {
    record('11-主题令牌', '浅色主题覆盖了 ' + name, lightMedia.has(name) && lightAttr.has(name), { name });
  }
  record('11-主题令牌', '浅色的底色 / 文字确实和深色不同（防止把深色块复制粘贴过去）',
    lightMedia.get('--gvc-bg') !== dark.get('--gvc-bg') &&
    lightMedia.get('--gvc-text') !== dark.get('--gvc-text'),
    { darkBg: dark.get('--gvc-bg'), lightBg: lightMedia.get('--gvc-bg') });

  // 浅色值写了两遍（媒体查询一份、属性选择器一份）：必须逐条一致
  {
    record('11-主题令牌', '浅色值两处都能解析出来（跟随系统 ' + lightMedia.size + ' 项 / 手动指定 ' + lightAttr.size + ' 项）',
      lightMedia.size > 10 && lightAttr.size > 10, { media: lightMedia.size, attr: lightAttr.size });
    const diff = [];
    for (const [k, v] of lightAttr) if (lightMedia.get(k) !== v) diff.push(k + '（手动 ' + v + ' / 系统 ' + lightMedia.get(k) + '）');
    for (const [k] of lightMedia) if (!lightAttr.has(k)) diff.push(k + '（只在跟随系统那份里）');
    record('11-主题令牌', '两处浅色值逐条一致（改一处忘一处会被这里抓住）', diff.length === 0, { diff });
  }

  record('11-主题令牌', '有关闭动画偏好的降级（prefers-reduced-motion → 动画 none）',
    /prefers-reduced-motion/.test(theme) && /--gvc-pulse-anim:\s*none/.test(theme) &&
    /--gvc-scan-anim:\s*none/.test(theme), {});

  const surfaces = {
    'popup.css': read('popup.css'),
    'float.css': read('float.css'),
    'content.js（页面内面板）': read('content.js'),
    'gesture-catalog.js': read('gesture-catalog.js')
  };
  for (const [name, text] of Object.entries(surfaces)) {
    const used = new Set();
    for (const m of text.matchAll(/var\(\s*(--gvc-[\w-]+)/g)) used.add(m[1]);
    const missing = Array.from(used).filter((v) => !defined.has(v));
    record('11-主题令牌', name + ' 用到的 ' + used.size + ' 个令牌都有定义',
      used.size > 0 && missing.length === 0, { missing });
  }
  record('11-主题令牌', 'popup.html 与 float.html 都引了 theme.css',
    read('popup.html').indexOf('theme.css') !== -1 && read('float.html').indexOf('theme.css') !== -1, {});
  record('11-主题令牌', '页面内面板的颜色走令牌（.gvc-panel 用的是 var(--gvc-*)）',
    /\.gvc-panel \{[\s\S]{0,400}?var\(--gvc-bg/.test(read('content.js')), {});
  record('11-主题令牌', '弹窗 / 悬浮窗的图标都是内联 SVG（不再用 emoji 当图标）',
    read('popup.html').indexOf('data-icon=') !== -1 && read('float.html').indexOf('data-icon=') !== -1 &&
    read('content.js').indexOf('data-icon=') !== -1, {});

  // 反向：定义了的令牌必须有人用 —— 免得 theme.css 里堆一堆没人用的死色值
  {
    const surfacesWithTokens = [
      'popup.css', 'float.css', 'content.js', 'gesture-catalog.js',
      'grant.html', 'popup.html', 'float.html'
    ];
    const usedAll = new Set();
    for (const f of surfacesWithTokens) {
      if (!existsSync(at(f))) continue;
      for (const m of read(f).matchAll(/var\(\s*(--gvc-[\w-]+)/g)) usedAll.add(m[1]);
    }
    const unused = Array.from(defined.keys()).filter((v) => !usedAll.has(v));
    record('11-主题令牌', 'theme.css 里的令牌都有人用（没有死令牌）', unused.length === 0, { unused });
  }
}

// ---------- 12. 主题模式（theme-mode.js 的纯逻辑）----------
// 主题按钮点一下必须"看得见变化"，而且要能转回「跟随系统」——
// 这两条是纯逻辑，可以脱离浏览器直接测。
{
  const Mode = new Function(read('theme-mode.js') + '\n;return globalThis.ThemeMode;')();
  record('12-主题模式', 'theme-mode.js 能加载并给出 resolve / nextMode',
    typeof Mode.resolve === 'function' && typeof Mode.nextMode === 'function', {});

  record('12-主题模式', '跟随系统 + 系统浅色 → 浅色', Mode.resolve('auto', true) === 'light', {});
  record('12-主题模式', '跟随系统 + 系统深色 → 深色', Mode.resolve('auto', false) === 'dark', {});
  record('12-主题模式', '手动选了浅色就不再受系统影响', Mode.resolve('light', false) === 'light', {});
  record('12-主题模式', '手动选了深色就不再受系统影响', Mode.resolve('dark', true) === 'dark', {});
  record('12-主题模式', '乱七八糟的值当跟随系统处理', Mode.resolve('rainbow', false) === 'dark', {});

  for (const systemLight of [false, true]) {
    const tag = systemLight ? '（系统浅色）' : '（系统深色）';
    // 从默认的「跟随系统」点第一下，外观必须变（否则用户以为按钮坏了）
    record('12-主题模式', '从「跟随系统」点一下外观一定变' + tag,
      Mode.resolve(Mode.nextMode('auto', systemLight), systemLight) !== Mode.resolve('auto', systemLight),
      { next: Mode.nextMode('auto', systemLight) });

    // 从任意状态出发，连点三次必须回到起点，且三种状态都出现过（说明这是个真循环）
    for (const start of Mode.MODES) {
      let cur = start;
      const seen = [cur];
      for (let i = 0; i < Mode.MODES.length; i++) {
        cur = Mode.nextMode(cur, systemLight);
        seen.push(cur);
      }
      record('12-主题模式', '连点三次回到原状态：' + seen.join(' → ') + tag,
        seen[0] === seen[Mode.MODES.length] && new Set(seen).size === Mode.MODES.length, { seen });
    }

    // 三格里最多只有一格"看不出颜色变化"，而且那一格必须是回到「跟随系统」
    // （它本来就等于系统主题，这是三态循环的固有性质）
    {
      const invisible = [];
      for (const from of Mode.MODES) {
        const to = Mode.nextMode(from, systemLight);
        if (Mode.resolve(to, systemLight) === Mode.resolve(from, systemLight)) invisible.push(from + ' → ' + to);
      }
      record('12-主题模式', '看不出颜色变化的那一格最多只有一个' + tag + '：' + (invisible.join('；') || '没有'),
        invisible.length <= 1, { invisible });
      record('12-主题模式', '而那一格必须是"回到跟随系统"' + tag,
        invisible.every((edge) => edge.endsWith('→ auto')), { invisible });
    }
  }

  record('12-主题模式', '按钮提示会写明当前状态和下一步',
    Mode.title('auto', false).indexOf('跟随系统') !== -1 && Mode.title('auto', false).indexOf('浅色') !== -1, 
    { title: Mode.title('auto', false) });
  record('12-主题模式', '三种状态各有自己的图标',
    new Set(Mode.MODES.map((m) => Mode.ICON[m])).size === Mode.MODES.length, { icons: Mode.MODES.map((m) => Mode.ICON[m]) });

  // 接线：三个界面都要加载 theme-mode.js，主题按钮都要带统一的 data-theme-toggle
  // （预览页和这条自测都靠这个属性找按钮；漏一个就会出现"按钮是空的"）
  record('12-主题模式', '弹窗 / 悬浮窗 / 授权页都加载了 theme-mode.js',
    read('popup.html').indexOf('theme-mode.js') !== -1 &&
    read('float.html').indexOf('theme-mode.js') !== -1 &&
    read('grant.html').indexOf('theme-mode.js') !== -1, {});
  record('12-主题模式', '三处界面的主题按钮都带 data-theme-toggle',
    read('popup.html').indexOf('data-theme-toggle') !== -1 &&
    read('float.html').indexOf('data-theme-toggle') !== -1 &&
    read('content.js').indexOf('data-theme-toggle') !== -1, {});
  record('12-主题模式', '页面内面板把主题写在宿主元素上（不碰网站自己的 <html>）',
    /ThemeMode\.init\(\{\s*root:\s*false\s*\}\)/.test(read('content.js')) &&
    /ThemeMode\.track\(/.test(read('content.js')), {});
}

// ---------- 汇总 ----------
console.log('\n===== 静态体检 =====');
for (const [group, g] of groups) {
  console.log((g.ok === g.total ? '✅' : '❌') + ' ' + group + '  ' + g.ok + '/' + g.total);
}
console.log('------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  console.log('\n----- 失败明细 -----');
  for (const f of failures) console.log('❌ [' + f.group + '] ' + f.label + '  ' + JSON.stringify(f.extra));
  process.exitCode = 1;
}
