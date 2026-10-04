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
//   5b. 注入 content.js 的地方是否连带注入了 gesture-catalog.js
//   6. popup.js 里 getElementById 用到的 id 是否真的存在
//   7. 编码体检（防"中文变乱码"）
//   8. 手势对照表数据自检
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
const read = (p) => readFileSync(at(p), 'utf8');

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

// ---------- 5b. 注入 content.js 的地方必须连数据文件一起注入 ----------
// content.js 里的手势对照表要用 gesture-catalog.js 的数据；
// 少注入一处，那个场景下手势表就是空的。
{
  for (const file of ['background.js', 'popup.js', 'float.js']) {
    if (!existsSync(at(file))) continue;
    const text = read(file);
    const lists = [];
    for (const m of text.matchAll(/files:\s*\[([^\]]*)\]/g)) lists.push(m[1]);
    record('5b-注入清单', file + ' 至少有一处注入 content.js', lists.length > 0, { lists });
    for (const list of lists) {
      if (list.indexOf('content.js') === -1) continue;
      record('5b-注入清单', file + ' 注入 content.js 时带上 gesture-catalog.js',
        list.indexOf('gesture-catalog.js') !== -1, { list: list.trim() });
    }
  }
  if (manifest) {
    for (const cs of manifest.content_scripts || []) {
      const js = cs.js || [];
      if (js.indexOf('content.js') === -1) continue;
      record('5b-注入清单', 'manifest 的 content_scripts 带上 gesture-catalog.js',
        js.indexOf('gesture-catalog.js') !== -1, { js });
      record('5b-注入清单', 'manifest 里数据文件排在 content.js 前面',
        js.indexOf('gesture-catalog.js') < js.indexOf('content.js'), { js });
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
    'grant.js', 'grant.html', 'README.md', '.gitignore', 'AGENTS.md',
    'tests/run-all.mjs', 'tests/integration-check.mjs', 'tests/gesture-selftest.mjs',
    'tests/engine-sim.mjs', 'tests/health-selftest.mjs', 'tests/policy-selftest.mjs',
    'tests/hand-model.mjs', 'tests/gesture-inspect.mjs'
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

  record('10-打包清单', '能解析出排除目录（' + excludedDirs.length + ' 个）', excludedDirs.length > 0, { excludedDirs });
  record('10-打包清单', '排除了 .git（否则用户的 .crx 里会带上完整提交历史）',
    excludedDirs.indexOf('.git') !== -1, { excludedDirs });
  record('10-打包清单', '排除了 memory（本机工作记录不该发给用户）',
    excludedDirs.indexOf('memory') !== -1, { excludedDirs });
  record('10-打包清单', '排除了 tests（自测不进 .crx）',
    excludedDirs.indexOf('tests') !== -1, { excludedDirs });
  record('10-打包清单', '排除了 dist（产物本身不该再进包）',
    excludedDirs.indexOf('dist') !== -1, { excludedDirs });
  record('10-打包清单', '没有把 vendor/ 排掉（MediaPipe 运行时与模型都在里面）',
    excludedDirs.indexOf('vendor') === -1, { excludedDirs });
  record('10-打包清单', '没有把 icons/ 排掉', excludedDirs.indexOf('icons') === -1, { excludedDirs });

  // 逐个核对"运行时必须的文件"不会被排除规则命中
  const needed = new Set(['health.js', 'gesture.js', 'action-policy.js', 'gesture-catalog.js']);
  if (manifest) {
    if (manifest.background && manifest.background.service_worker) needed.add(manifest.background.service_worker);
    if (manifest.action && manifest.action.default_popup) needed.add(manifest.action.default_popup);
    for (const cs of manifest.content_scripts || []) for (const f of cs.js || []) needed.add(f);
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
