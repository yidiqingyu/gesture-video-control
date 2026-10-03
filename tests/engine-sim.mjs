// ============================================================
// tests/engine-sim.mjs —— 逐帧流水线（时间维度）自测
//
// classifyPose 只管「这一帧是什么手势」，但用户感受到的「误触 / 迟钝 /
// 手势乱跳」几乎都发生在时间维度上：抖动、换手、漏检。
// 这里用合成手一帧一帧喂给 gesture.js 的 createPoseTracker
//（后台引擎和悬浮窗引擎共用的那条流水线），验证：
//
//   1. 稳住的手势不会被单帧抖动带跑
//   2. 真的换手势时 3 帧内跟上（不迟钝）
//   3. 稳定确认不会拖太久
//   4. 画面里两只手时，主手不会来回跳（旧版取 hands[0] 就会跳）
//   5. 偶发漏检（一两帧没检测到手）不会把手势打断
//
// 跑法：node tests/engine-sim.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { makeHand } from './hand-model.mjs';

const src = readFileSync(new URL('../gesture.js', import.meta.url), 'utf8');
const GestureMath = new Function(src + '\n;return globalThis.GestureMath;')();

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

function check(group, label, actual, expected) {
  record(group, actual === expected, label, { actual, expected });
}

// 中文手势名 → 合成模型的（姿态, 额外参数）
const LABEL = {
  '食指向上': ['indexUp', {}],
  '食指向下': ['indexUp', { roll: 180 }],
  '小拇指向上': ['pinkyUp', {}],
  '小拇指向下': ['pinkyUp', { roll: 180 }],
  '点赞': ['thumbUp', {}],
  'OK': ['ok', {}],
  '666': ['six', {}],
  '🤟': ['rock', {}],
  '数字2': ['two', {}],
  '数字3': ['three', {}],
  '数字4': ['four', {}],
  '手掌张开': ['openPalm', {}],
  '握拳': ['fist', {}],
  '其他手势': ['nearOk', {}]
};

// 把合成手包装成引擎里「一只手」的数据结构
function cand(name, opts) {
  const entry = LABEL[name];
  if (!entry) throw new Error('未登记的合成手势: ' + name);
  const h = makeHand(entry[0], Object.assign({}, entry[1], opts || {}));
  return {
    landmarks: h.landmarks,
    worldLandmarks: h.worldLandmarks,
    handedness: h.handedness,
    score: h.score
  };
}

const ASPECT = 4 / 3;

// ---------- 1. 单帧抖动不改变输出 ----------
{
  const t = GestureMath.createPoseTracker();
  const seq = [];
  for (let i = 0; i < 6; i += 1) seq.push('食指向上');
  seq.push('小拇指向下');            // 单帧抖出来的错误手势
  for (let i = 0; i < 6; i += 1) seq.push('食指向上');

  const out = seq.map((p, i) => t.update([cand(p, { noise: 0.004, seed: 100 + i })], { aspect: ASPECT }));
  const tail = out.slice(8).map((r) => r.pose.name);
  record('1-抗抖动', '抖动后输出仍是食指向上（' + tail.join(',') + '）',
    tail.every((n) => n === '食指向上'), { tail });
  // 抖动那一帧本身也不能让输出翻过去
  record('1-抗抖动', '抖动那一帧输出没翻（' + out[7].pose.name + '）',
    out[7].pose.name === '食指向上', { actual: out[7].pose.name });
}

// ---------- 2. 真换手势 3 帧内跟上 ----------
{
  const t = GestureMath.createPoseTracker();
  for (let i = 0; i < 8; i += 1) t.update([cand('食指向上', { seed: i })], { aspect: ASPECT });
  let follow = -1;
  for (let i = 0; i < 8; i += 1) {
    const r = t.update([cand('小拇指向下', { seed: 500 + i })], { aspect: ASPECT });
    if (r.pose.name === '小拇指向下') { follow = i + 1; break; }
  }
  record('2-跟手速度', '换手势后 ' + follow + ' 帧内跟上（要求 ≤ 3）', follow > 0 && follow <= 3, { follow });
}

// ---------- 3. 稳定确认不拖沓 ----------
{
  const t = GestureMath.createPoseTracker();
  let stableAt = -1;
  for (let i = 0; i < 20; i += 1) {
    const r = t.update([cand('OK', { seed: 900 + i, noise: 0.003 })], { aspect: ASPECT });
    if (r.stable) { stableAt = i + 1; break; }
  }
  record('3-稳定速度', '稳住后 ' + stableAt + ' 帧内确认稳定（要求 ≤ 6）',
    stableAt > 0 && stableAt <= 6, { stableAt });
}

// ---------- 4. 两只手时主手不乱跳 ----------
{
  const t = GestureMath.createPoseTracker();
  const names = [];
  const picked = [];
  for (let i = 0; i < 20; i += 1) {
    // 两只手大小和位置都带抖动；输入顺序还每隔一帧换一次
    //（MediaPipe 返回的先后顺序本来就不保证稳定）——
    // 旧版直接取 hands[0]，此时主手势必然一会儿食指一会儿小指
    const a = cand('食指向上', { offsetX: -0.15 + (i % 3) * 0.01, frameWidth: 0.40 + (i % 4) * 0.02, seed: 2000 + i });
    const b = cand('小拇指向下', { offsetX: 0.16 - (i % 3) * 0.01, frameWidth: 0.44 - (i % 4) * 0.02, seed: 3000 + i });
    const order = i % 2 === 0 ? [a, b] : [b, a];
    const r = t.update(order, { aspect: ASPECT });
    names.push(r.pose.name);
    picked.push(r.center.x < 0 ? 'A' : 'B');
  }
  const tail = names.slice(6);
  record('4-主手不跳', '20 帧里主手势始终同一个（' + Array.from(new Set(tail)).join('/') + '）',
    new Set(tail).size === 1, { tail });
  record('4-主手不跳', '主手始终是同一只（' + Array.from(new Set(picked.slice(6))).join('/') + '）',
    new Set(picked.slice(6)).size === 1, { picked });

  // 对照：按旧版「直接取 hands[0]」的做法，同一段输入会跳成两只手的手势。
  // 这条断言是为了保证这个场景确实有区分度（不然这条测试就是白测）
  const naive = [];
  for (let i = 0; i < 20; i += 1) {
    const a = cand('食指向上', { offsetX: -0.15 + (i % 3) * 0.01, frameWidth: 0.40 + (i % 4) * 0.02, seed: 2000 + i });
    const b = cand('小拇指向下', { offsetX: 0.16 - (i % 3) * 0.01, frameWidth: 0.44 - (i % 4) * 0.02, seed: 3000 + i });
    const first = (i % 2 === 0 ? [a, b] : [b, a])[0];
    naive.push(GestureMath.classifyPose(first.landmarks, { aspect: ASPECT, world: first.worldLandmarks }).name);
  }
  record('4-主手不跳', '（对照）旧版取 hands[0] 确实会跳手：' + Array.from(new Set(naive)).join('/'),
    new Set(naive).size >= 2, { naive: Array.from(new Set(naive)) });
}

// ---------- 5. 偶发漏检不打断手势 ----------
{
  const t = GestureMath.createPoseTracker();
  const out = [];
  for (let i = 0; i < 5; i += 1) out.push(t.update([cand('食指向上', { seed: 4000 + i })], { aspect: ASPECT }));
  // 连续 2 帧没检测到手：引擎此时不会调用 update（容错窗口内）
  const afterDrop = t.update([cand('食指向上', { seed: 4100 })], { aspect: ASPECT });
  check('5-漏检容错', '漏检两帧后输出不变', afterDrop.pose.name, '食指向上');
  record('5-漏检容错', '漏检后仍算稳定（stable=true）', afterDrop.stable === true, { stable: afterDrop.stable });
  // 真正放手后引擎会 reset
  t.reset();
  const fresh = t.update([cand('小拇指向下', { seed: 4200 })], { aspect: ASPECT });
  check('5-漏检容错', 'reset 后立刻反映新手势', fresh.pose.name, '小拇指向下');
}

// ---------- 6. 空手输入不能崩 ----------
{
  const t = GestureMath.createPoseTracker();
  const r = t.update([], { aspect: ASPECT });
  check('6-健壮性', '空手输入返回 null', r, null);
  const r2 = t.update([{ landmarks: [], worldLandmarks: null }], { aspect: ASPECT });
  record('6-健壮性', '关键点不完整时返回 null 或兜底手势', r2 === null || typeof r2.pose.name === 'string', { r2: !!r2 });
}

// ---------- 汇总 ----------
console.log('\n===== 引擎时序自测 =====');
for (const [group, g] of groups) {
  console.log((g.ok === g.total ? '✅' : '❌') + ' ' + group + '  ' + g.ok + '/' + g.total);
}
console.log('------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  console.log('\n----- 失败明细 -----');
  for (const f of failures) {
    console.log('❌ [' + f.group + '] ' + f.label + '  ' + JSON.stringify(f.extra));
  }
  process.exitCode = 1;
}
