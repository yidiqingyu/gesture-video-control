// ============================================================
// tests/gesture-inspect.mjs —— 把手势判定的中间量打出来，方便调阈值
//
// 跑法：
//   node tests/gesture-inspect.mjs            看所有预置手势
//   node tests/gesture-inspect.mjs ok four    只看指定手势
// ============================================================

import { readFileSync } from 'node:fs';
import { makeHand, POSES } from './hand-model.mjs';

const src = readFileSync(new URL('../gesture.js', import.meta.url), 'utf8');
const GestureMath = new Function(src + '\n;return globalThis.GestureMath;')();

const wanted = process.argv.slice(2).filter((a) => a !== '-v');
const names = (wanted.length ? wanted : Object.keys(POSES));

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));

console.log(pad('手势', 10) + pad('判定结果', 12) + pad('拇指', 7) + pad('食指', 7) +
  pad('中指', 7) + pad('无名', 7) + pad('小指', 7) + pad('捏合', 7) + '方向(食/小/拇)');
console.log('-'.repeat(90));

for (const name of names) {
  const hand = makeHand(name, {});
  const pose = GestureMath.classifyPose(hand.landmarks, {
    aspect: 4 / 3,
    world: hand.worldLandmarks
  });
  const d = pose.debug;
  console.log(
    pad(name, 10) + pad(pose.name, 12) +
    pad(num(d.ext.thumb), 7) + pad(num(d.ext.index), 7) + pad(num(d.ext.middle), 7) +
    pad(num(d.ext.ring), 7) + pad(num(d.ext.pinky), 7) + pad(num(d.pinch), 7) +
    d.dir.index + '/' + d.dir.pinky + '/' + d.dir.thumb
  );
}

// ---------- 明细：拇指到底怎么算出来的 ----------
if (process.argv.includes('-v')) {
  console.log('\n拇指明细（伸展度 = 0.4×IP夹角分 + 0.6×外展分）');
  console.log(pad('手势', 10) + pad('拇指(图/世界)', 16) + pad('IP夹角(图/世界)', 18) +
    pad('外展比(图/世界)', 18) + 'detail');
  console.log('-'.repeat(100));
  for (const name of names) {
    const hand = makeHand(name, {});
    const img = GestureMath.imageMetrics(hand.landmarks, 4 / 3);
    const w = hand.worldLandmarks;
    const T = GestureMath.THUMB;
    const F = GestureMath.FINGERS;
    const pose = GestureMath.classifyPose(hand.landmarks, { aspect: 4 / 3, world: w });
    const iA = GestureMath.analyze(img);
    const wA = GestureMath.analyze(w);
    const angI = GestureMath.angleAt(img[T.mcp], img[T.ip], img[T.tip]);
    const angW = GestureMath.angleAt(w[T.mcp], w[T.ip], w[T.tip]);
    const spI = GestureMath.dist3(img[T.tip], img[F.index.mcp]) / iA.size;
    const spW = GestureMath.dist3(w[T.tip], w[F.index.mcp]) / wA.size;
    console.log(pad(name, 10) +
      pad(num(iA.ext.thumb) + '/' + num(wA.ext.thumb), 16) +
      pad(angI.toFixed(0) + '°/' + angW.toFixed(0) + '°', 18) +
      pad(spI.toFixed(2) + '/' + spW.toFixed(2), 18) + pose.detail);
  }
}
