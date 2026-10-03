// ============================================================
// tests/integration-check.mjs —— 静态体检（不开浏览器）
//
// 这里没法真的启动 Chrome 跑扩展，但「引用关系写错」这类致命问题
// 完全可以在本地静态查出来，而且它们一旦写错就是整个扩展打不开：
//
//   1. manifest.json 里声明的每个文件是否真的存在
//   2. HTML 里 <script src> / <link href> 指向的文件是否存在
//   3. offscreen.js / float.js 用到的 GestureMath.xxx 是否真的被导出
//      （改了 gesture.js 的对外接口、忘了同步引擎 → 运行时报
//        "GestureMath.xxx is not a function"，这里直接拦住）
//   4. manifest 里声明的权限是否都是已知的合法权限
//
// 跑法：node tests/integration-check.mjs
// ============================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => path.join(root, p);

let passed = 0;
const failures = [];
const groups = new Map();

function record(group, ok, label, extra) {
  if (!ok) failures.push({ group, label, extra });
  else passed += 1;
  if (!groups.has(group)) groups.set(group, { ok: 0, total: 0 });
  const g = groups.get(group);
  g.total += 1;
  if (ok) g.ok += 1;
}

const read = (p) => readFileSync(at(p), 'utf8');

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
    'activeTab', 'scripting', 'storage', 'offscreen', 'debugger', 'tabs', 'windows'
  ];
  const unknown = (manifest.permissions || []).filter((p) => KNOWN_PERMISSIONS.indexOf(p) === -1);
  record('1-manifest', '权限都在已知清单里' + (unknown.length ? '（可疑：' + unknown.join(',') + '）' : ''),
    unknown.length === 0, { unknown });
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
const src = read('gesture.js');
const GestureMath = new Function(src + '\n;return globalThis.GestureMath;')();
const exported = Object.keys(GestureMath);

for (const file of ['offscreen.js', 'float.js', 'content.js', 'popup.js']) {
  if (!existsSync(at(file))) continue;
  const text = read(file);
  const used = new Set();
  for (const m of text.matchAll(/GestureMath\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  for (const name of used) {
    record('3-接口一致', file + ' 用到的 GestureMath.' + name, exported.indexOf(name) !== -1,
      { missing: name, exported });
  }
}

// ---------- 4. gesture.js 自己必须能被独立加载（不依赖 DOM）----------
record('4-可加载', 'gesture.js 能脱离浏览器加载并给出 classifyPose',
  typeof GestureMath.classifyPose === 'function' && typeof GestureMath.createPoseTracker === 'function',
  { exported });

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
