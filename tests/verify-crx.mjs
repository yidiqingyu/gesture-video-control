// ============================================================
// tests/verify-crx.mjs —— 打包后核对 .crx 里的东西（不开浏览器、不用装工具）
//
// 为什么需要它：.crx 的 manifest.json 是压缩在 ZIP 里的，肉眼看不见版本号，
// 光看"打包成功"没法确认新包到底是不是这一版（历史上就出现过"以为打的是新版、
// 其实拿到的是旧包"）。这个脚本拆开 CRX3 头和里面的 ZIP，把版本号和关键文件列出来。
//
// 用法：
//   node tests/verify-crx.mjs                          # 默认查 dist/gesture-video-control.crx
//   node tests/verify-crx.mjs dist/xxx.crx --expect 1.4.0
//
// 顺带用 dist 里的 .pem 算出扩展 ID —— 换私钥就会换 ID，老用户装新包会变成两个扩展，
// 所以每次打包完顺手核一眼比较省心。
// ============================================================

import { readFileSync, existsSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => path.join(root, p);

const args = process.argv.slice(2);
const crxPath = args.find((a) => !a.startsWith('--') && !/^\d+\.\d+\.\d+$/.test(a)) || 'dist/gesture-video-control.crx';
const expectIndex = args.indexOf('--expect');
const expectVersion = expectIndex > -1 ? args[expectIndex + 1] : null;

const problems = [];
const note = (label, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '   ' + extra : ''));
  if (!ok) problems.push(label);
};

// ---------- 1. CRX3 头 ----------
if (!existsSync(at(crxPath))) {
  console.error('找不到文件：' + crxPath);
  process.exit(1);
}
const buf = readFileSync(at(crxPath));
console.log('\n===== 核对 ' + crxPath + ' =====');
console.log('文件大小: ' + (buf.length / 1024 / 1024).toFixed(1) + ' MB');

if (buf.subarray(0, 4).toString('latin1') !== 'Cr24') {
  console.error('❌ 不是 CRX 文件（开头不是 Cr24）');
  process.exit(1);
}
const crxVersion = buf.readUInt32LE(4);
const headerLen = buf.readUInt32LE(8);
note('CRX 版本是 3', crxVersion === 3, '（读到 ' + crxVersion + '）');

const zipStart = 12 + headerLen;
const zip = buf.subarray(zipStart);

// ---------- 2. ZIP 中央目录 ----------
let eocd = -1;
for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 65535; i--) {
  if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd === -1) {
  console.error('❌ 找不到 ZIP 中央目录（End of Central Directory）');
  process.exit(1);
}
const entryCount = zip.readUInt16LE(eocd + 10);
let p = zip.readUInt32LE(eocd + 16);

const files = new Map(); // 名字 → { method, compSize, size, localOffset }
for (let i = 0; i < entryCount; i++) {
  if (zip.readUInt32LE(p) !== 0x02014b50) break;
  const method = zip.readUInt16LE(p + 10);
  const compSize = zip.readUInt32LE(p + 20);
  const size = zip.readUInt32LE(p + 24);
  const nameLen = zip.readUInt16LE(p + 28);
  const extraLen = zip.readUInt16LE(p + 30);
  const commentLen = zip.readUInt16LE(p + 32);
  const localOffset = zip.readUInt32LE(p + 42);
  const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
  files.set(name, { method, compSize, size, localOffset });
  p += 46 + nameLen + extraLen + commentLen;
}
console.log('压缩包内文件数: ' + files.size + '（目录项声明 ' + entryCount + '）');

// 读某个条目（解压）
function readEntry(name) {
  const e = files.get(name);
  if (!e) return null;
  const lh = zip.subarray(e.localOffset);
  if (lh.readUInt32LE(0) !== 0x04034b50) return null;
  const nameLen = lh.readUInt16LE(26);
  const extraLen = lh.readUInt16LE(28);
  const data = zip.subarray(e.localOffset + 30 + nameLen + extraLen, e.localOffset + 30 + nameLen + extraLen + e.compSize);
  return e.method === 0 ? data : inflateRawSync(data);
}

// ---------- 3. 版本号与关键文件 ----------
let manifest = null;
try {
  manifest = JSON.parse(readEntry('manifest.json').toString('utf8'));
  note('manifest.json 能解析，版本 = ' + manifest.version,
    !!expectVersion ? manifest.version === expectVersion : /^\d+\.\d+\.\d+$/.test(manifest.version),
    expectVersion ? '（期望 ' + expectVersion + '）' : '');
} catch (e) {
  note('manifest.json 能解析', false, String(e.message));
}

for (const f of ['theme.css', 'ui-icons.js', 'theme-mode.js', 'content.js', 'gesture.js',
                 'background.js', 'popup.html', 'popup.css', 'float.html', 'grant.html']) {
  note('包含 ' + f, files.has(f));
}
note('没有把源码/工作记录带进去（无 tests/、memory/、.git/）',
  !Array.from(files.keys()).some((n) => /^(tests|memory|drafts|trash|assets|\.git)\//.test(n)));
note('没有把私钥/产物带进去（无 .pem、.crx）',
  !Array.from(files.keys()).some((n) => /\.(pem|crx)$/i.test(n)));
note('带了 MediaPipe 运行时与模型', files.has('vendor/mediapipe/hand_landmarker.task') && files.has('vendor/mediapipe/vision_bundle.mjs'));

// ---------- 4. 扩展 ID（由 .pem 决定）----------
const pemPath = at('dist/gesture-video-control.pem');
if (existsSync(pemPath)) {
  try {
    const pem = readFileSync(pemPath, 'utf8');
    const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
    const hash = createHash('sha256').update(der).digest('hex').slice(0, 32);
    const id = hash.split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    note('扩展 ID（由 dist/gesture-video-control.pem 算出）', true, id);
    console.log('     ↳ 换私钥就会换 ID，老用户装新包会变成两个扩展，别丢这个 .pem');
  } catch (e) {
    note('能从 .pem 算出扩展 ID', false, String(e.message));
  }
} else {
  console.log('  ⚠️  没找到 dist/gesture-video-control.pem，跳过扩展 ID 核对');
}

console.log('------------------------------');
if (problems.length) {
  console.log('❌ 有 ' + problems.length + ' 项没通过：' + problems.join('；'));
  process.exitCode = 1;
} else {
  console.log('✅ 全部通过' + (manifest ? '（版本 ' + manifest.version + '）' : ''));
}
