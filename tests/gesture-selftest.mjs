// ============================================================
// tests/gesture-selftest.mjs —— 手势判定离线自测
//
// 跑法：node tests/gesture-selftest.mjs
//
// 覆盖：
//   1. 每个手势在正对镜头时判对
//   2. 手歪一点 / 转一点（roll/yaw/pitch）仍判对
//   3. 换宽高比（4:3 / 16:9）仍判对
//   4. 关键点抖动时仍有 90% 以上判对率
//   5. 方向手势：手翻过来就是「向下」，不是「向上」
//   6. 安全：容易混的手势宁可判「其他手势」，也不能误触发别的动作
//   7. 主手选择：画面里两只手时，盯住该盯的那只，不要来回跳
//   8. 姿态平滑：单帧抖动不能把结果带跑偏
// ============================================================

import { readFileSync } from 'node:fs';
import { makeHand, POSES } from './hand-model.mjs';

// gesture.js 是经典脚本（挂 globalThis），这里手工加载，顺便验证它不依赖 DOM
const src = readFileSync(new URL('../gesture.js', import.meta.url), 'utf8');
const GestureMath = new Function(src + '\n;return globalThis.GestureMath;')();

// ---------- 极简测试框架 ----------
let passed = 0;
const failures = [];
const groups = new Map();

// ⚠️ 约定：record(分组, 说明, 条件, 附加信息) —— 条件是第三个参数。
// 写成 record(分组, 条件, 说明) 会让"说明字符串"落到条件位置、永远为真，
// 检查就全变成"永远通过"。文件开头的「0-断言器自检」专门盯着这件事。
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

function check(group, label, actual, expected) {
  record(group, label, actual === expected, { actual, expected });
}

// 断言器自检：故意喂一个假条件，确认真的会被记为失败
{
  const before = failures.length;
  record('0-断言器自检', '（内部探测，这一条必须被判定为失败）', false, {});
  const works = failures.length === before + 1;
  if (works) failures.pop();
  groups.delete('0-断言器自检');
  record('0-断言器自检', '断言器能识别失败（否则所有检查都是白做）', works, {});
}

function classify(poseName, opts) {
  const hand = makeHand(poseName, opts);
  return GestureMath.classifyPose(hand.landmarks, {
    aspect: (opts && opts.aspect) || 4 / 3,
    world: hand.worldLandmarks
  });
}

// ---------- 1. 正对镜头：每个手势都要判对 ----------
const NEUTRAL = [
  ['fist', '握拳'],
  ['openPalm', '手掌张开'],
  ['four', '数字4'],
  ['three', '数字3'],
  ['two', '数字2'],
  ['indexUp', '食指向上'],
  ['pinkyUp', '小拇指向上'],
  ['thumbUp', '点赞'],
  ['six', '666'],
  ['rock', '🤟'],
  ['ok', 'OK'],
  ['nearOk', '其他手势']
];
for (const [pose, expected] of NEUTRAL) {
  const pose2 = classify(pose);
  check('1-正对镜头', pose + ' → ' + expected, pose2.name, expected);
}

// ---------- 2. 手歪 / 手转：结果不能变 ----------
const ROTATIONS = [
  { tag: 'roll+20', roll: 20 },
  { tag: 'roll-20', roll: -20 },
  { tag: 'yaw+20', yaw: 20 },
  { tag: 'yaw-20', yaw: -20 },
  { tag: 'pitch+15', pitch: 15 },
  { tag: 'pitch-15', pitch: -15 },
  { tag: 'roll25+yaw15', roll: 25, yaw: 15 },
  { tag: 'roll-25+yaw-15', roll: -25, yaw: -15 }
];
for (const rot of ROTATIONS) {
  for (const [pose, expected] of NEUTRAL) {
    const pose2 = classify(pose, rot);
    check('2-手歪手转(' + rot.tag + ')', pose + ' → ' + expected, pose2.name, expected);
  }
}

// ---------- 3. 宽高比 / 手离镜头远近 ----------
const VIEWS = [
  { tag: '16:9', aspect: 16 / 9 },
  { tag: '4:3', aspect: 4 / 3 },
  { tag: '3:4竖屏', aspect: 3 / 4 },
  { tag: '手远', frameWidth: 0.75 },
  { tag: '手近', frameWidth: 0.28 },
  { tag: '左手', mirror: true },
  { tag: '左手+手歪', mirror: true, roll: -18, yaw: 12 }
];
for (const view of VIEWS) {
  for (const [pose, expected] of NEUTRAL) {
    const pose2 = classify(pose, view);
    check('3-视角变化(' + view.tag + ')', pose + ' → ' + expected, pose2.name, expected);
  }
}

// ---------- 4. 抖动容忍 ----------
const NOISE_TRIALS = 30;
for (const [pose, expected] of NEUTRAL) {
  let ok = 0;
  for (let i = 0; i < NOISE_TRIALS; i += 1) {
    const p = classify(pose, { noise: 0.005, seed: 1000 + i * 7 });
    if (p.name === expected) ok += 1;
  }
  record('4-抖动容忍(轻抖)', pose + ' 抖动 30 次命中率 ' + ok + '/30 ≥ 27', ok >= 27, { ok, expected });
}
// 重度抖动 + 手还歪着：真实摄像头下最坏大概就是这个量级
for (const [pose, expected] of NEUTRAL) {
  let ok = 0;
  for (let i = 0; i < NOISE_TRIALS; i += 1) {
    const p = classify(pose, { noise: 0.008, roll: 15, yaw: 10, seed: 2000 + i * 13 });
    if (p.name === expected) ok += 1;
  }
  record('4-抖动容忍(重抖+手歪)', pose + ' 命中率 ' + ok + '/30 ≥ 24', ok >= 24, { ok, expected });
}

// ---------- 5. 手翻过来 = 向下 ----------
for (const [pose, expected] of [
  ['indexUp', '食指向下'],
  ['pinkyUp', '小拇指向下']
]) {
  const pose2 = classify(pose, { roll: 180 });
  check('5-翻手方向', pose + '@180° → ' + expected, pose2.name, expected);
}

// ---------- 6. 安全：宁可不动，也不能误触发 ----------
// 6.1 666 手势倒过来（小指朝下 + 拇指伸开）：手型和「小拇指向下」本来就一样，
//     判成音量减可以接受，但绝不能判成 666（那会直接锁住整个引擎）
record('6-安全（宁可不动作）', 'six@180° 不能判成 666（避免误锁）',
  classify('six', { roll: 180 }).name !== '666', { actual: classify('six', { roll: 180 }).name });
// 6.2 大拇指向下（点赞手势倒过来）：不能算点赞
record('6-安全（宁可不动作）', 'thumbUp@180° 不能判成点赞',
  classify('thumbUp', { roll: 180 }).name !== '点赞', { actual: classify('thumbUp', { roll: 180 }).name });
// 6.3 拇指朝侧面（roll 90）：不能算点赞
record('6-安全（宁可不动作）', 'thumbUp@90° 不能判成点赞',
  classify('thumbUp', { roll: 90 }).name !== '点赞', { actual: classify('thumbUp', { roll: 90 }).name });
// 6.4 手掌侧过来（roll 90，食指水平）：方向不明，不能产生切集动作
record('6-安全（宁可不动作）', 'indexUp@90° 不产生方向动作',
  ['食指向上', '食指向下'].indexOf(classify('indexUp', { roll: 90 }).name) === -1,
  { actual: classify('indexUp', { roll: 90 }).name });
// 6.5 nearOk（半蜷食指 + 收着的拇指，看着像 OK）绝不能判成 OK
record('6-安全（宁可不动作）', 'nearOk 不能判成 OK',
  classify('nearOk').name !== 'OK', { actual: classify('nearOk').name });

// ---------- 7. 主手选择 ----------
if (typeof GestureMath.pickPrimaryHand !== 'function') {
  record('7-主手选择', '提供了 pickPrimaryHand()', false, { actual: '缺失', expected: 'function' });
} else {
  const centered = makeHand('openPalm', { frameWidth: 0.45, offsetX: 0, seed: 11 });
  const sideHand = makeHand('pinkyUp', { frameWidth: 0.45, offsetX: 0.22, seed: 12 });

  // 没有历史：选画面中间那只
  check('7-主手选择', '无历史时选居中那只', GestureMath.pickPrimaryHand([sideHand, centered], { aspect: 4 / 3 }).index, 1);

  // 有历史且历史在侧边那只上：跟着历史走（避免和另一只手抢）
  check('7-主手选择', '有历史时保持盯住同一只手',
    GestureMath.pickPrimaryHand([centered, sideHand], { aspect: 4 / 3, prev: center(sideHand) }).index, 1);

  // 手大（离得近）优先：两只都在中间时选近的
  const near = makeHand('openPalm', { frameWidth: 0.26, offsetX: 0.02, seed: 13 });
  const far = makeHand('pinkyUp', { frameWidth: 0.70, offsetX: 0.02, seed: 14 });
  check('7-主手选择', '两只手都在中间时选近的（更大）', GestureMath.pickPrimaryHand([far, near], { aspect: 4 / 3 }).index, 1);
}

function center(hand) {
  const lm = hand.landmarks;
  let x = 0, y = 0;
  for (const p of lm) { x += p.x; y += p.y; }
  return { x: x / lm.length, y: y / lm.length, handedness: hand.handedness };
}

// ---------- 8. 姿态平滑 ----------
if (typeof GestureMath.createSmoother !== 'function') {
  record('8-姿态平滑', '提供了 createSmoother()', false, { actual: '缺失', expected: 'function' });
} else {
  const sm = GestureMath.createSmoother();
  const seq = ['食指向上', '食指向上', '其他手势', '食指向上', '食指向上'];
  const out = seq.map((n) => sm.push(n));
  record('8-姿态平滑', '单帧抖动不改变输出', out[out.length - 1] === '食指向上', { out });

  const sm2 = GestureMath.createSmoother();
  const seq2 = ['食指向上', '小拇指向下', '小拇指向下', '小拇指向下', '小拇指向下'];
  const out2 = seq2.map((n) => sm2.push(n));
  record('8-姿态平滑', '真切换在 3 帧内跟上', out2[out2.length - 1] === '小拇指向下', { out: out2 });
}

// ---------- 汇总 ----------
console.log('\n===== 手势判定自测 =====');
for (const [group, g] of groups) {
  console.log((g.ok === g.total ? '✅' : '❌') + ' ' + group + '  ' + g.ok + '/' + g.total);
}
console.log('------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');

if (failures.length > 0) {
  console.log('\n----- 失败明细（最多 40 条）-----');
  for (const f of failures.slice(0, 40)) {
    console.log('❌ [' + f.group + '] ' + f.label + '  实际=' + JSON.stringify(f.extra.actual) +
      ' 期望=' + JSON.stringify(f.extra.expected));
  }
  process.exitCode = 1;
}
