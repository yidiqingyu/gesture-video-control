// ============================================================
// tests/hand-model.mjs —— 合成手部关键点模型（只用于离线自测）
//
// 为什么要有它：手势判定全是阈值逻辑，凭感觉调参必然按下葫芦浮起瓢。
// 这里用「正运动学」把一只手（21 个关键点）按真实尺寸搭出来，
// 再按指定的宽高比投影成 MediaPipe 的归一化坐标 + 世界坐标，
// 于是可以离线验证：直/弯/捏合、手倾斜、手转来转去、画面宽高比变化、
// 关键点抖动时，判定结果还对不对。
//
// 坐标约定：
//   手部局部坐标：x 向右、y 向上、z 朝向摄像头（米）
//   图像坐标：    x 向右、y 向下、z 朝向摄像头（MediaPipe 归一化值）
// ============================================================

// 四指：掌指关节(MCP)位置 + 张开角度 + 三节骨头长度（米）
const FINGERS = {
  index:  { mcpIdx: 5,  mcp: [-0.034, 0.088, 0.000], spread: -8,  bones: [0.040, 0.024, 0.019] },
  middle: { mcpIdx: 9,  mcp: [0.000, 0.092, 0.000],  spread: 0,   bones: [0.045, 0.027, 0.020] },
  ring:   { mcpIdx: 13, mcp: [0.031, 0.087, 0.000],  spread: 7,   bones: [0.041, 0.025, 0.019] },
  pinky:  { mcpIdx: 17, mcp: [0.056, 0.077, -0.002], spread: 16,  bones: [0.032, 0.019, 0.016] }
};

// 完全蜷曲（curl = 1）时各关节的屈曲角度
const FLEX_DEG = { mcp: 85, pip: 100, dip: 65 };

// 拇指取「收着」和「伸开」两套姿态，中间线性插值
const THUMB_TUCKED = {
  1: [-0.030, 0.020, 0.012],
  2: [-0.040, 0.048, 0.018],
  3: [-0.033, 0.066, 0.020],
  4: [-0.026, 0.080, 0.020]
};
const THUMB_EXTENDED = {
  1: [-0.032, 0.020, 0.012],
  2: [-0.062, 0.038, 0.010],
  3: [-0.082, 0.056, 0.008],
  4: [-0.096, 0.074, 0.006]
};

// 手部标准姿态：五指各自的蜷曲度（0 = 完全伸直，1 = 完全蜷起）+ 拇指伸展度
// thumb: 0 = 收在掌心，1 = 完全外展伸开；'pinch' = 指尖去捏食指指尖（OK 手势）
export const POSES = {
  fist:     { fingers: { index: 1.00, middle: 1.00, ring: 1.00, pinky: 1.00 }, thumb: 0.05 },
  openPalm: { fingers: { index: 0.00, middle: 0.00, ring: 0.00, pinky: 0.00 }, thumb: 1.00 },
  four:     { fingers: { index: 0.00, middle: 0.00, ring: 0.00, pinky: 0.00 }, thumb: 0.30 },
  three:    { fingers: { index: 0.00, middle: 0.00, ring: 0.00, pinky: 1.00 }, thumb: 0.30 },
  two:      { fingers: { index: 0.00, middle: 0.00, ring: 1.00, pinky: 1.00 }, thumb: 0.30 },
  indexUp:  { fingers: { index: 0.00, middle: 1.00, ring: 1.00, pinky: 1.00 }, thumb: 0.25 },
  pinkyUp:  { fingers: { index: 1.00, middle: 1.00, ring: 1.00, pinky: 0.00 }, thumb: 0.40 },
  thumbUp:  { fingers: { index: 1.00, middle: 1.00, ring: 1.00, pinky: 1.00 }, thumb: 1.00 },
  six:      { fingers: { index: 1.00, middle: 1.00, ring: 1.00, pinky: 0.00 }, thumb: 1.00 },
  rock:     { fingers: { index: 0.00, middle: 1.00, ring: 1.00, pinky: 0.00 }, thumb: 1.00 },
  // 半蜷的食指 + 收着的拇指：看着像 OK，其实没捏上，必须判成「其他手势」
  nearOk:   { fingers: { index: 0.70, middle: 0.00, ring: 0.00, pinky: 0.20 }, thumb: 0.30 },
  ok:       { fingers: { index: 0.75, middle: 0.00, ring: 0.00, pinky: 0.15 }, thumb: 'pinch' }
};

// ---------- 基础向量运算 ----------
function rotX([x, y, z], deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [x, y * c - z * s, y * s + z * c];
}
function rotY([x, y, z], deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c + z * s, y, -x * s + z * c];
}
function rotZ([x, y, z], deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c, z];
}
function rotate(p, { roll = 0, yaw = 0, pitch = 0 }) {
  return rotY(rotX(rotZ(p, roll), pitch), yaw);
}
function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------- 一根手指的正运动学 ----------
function buildFinger(def, curl) {
  const angles = [FLEX_DEG.mcp * curl, FLEX_DEG.pip * curl, FLEX_DEG.dip * curl];
  const base = rotZ([0, 1, 0], def.spread);
  const pts = [def.mcp.slice()];
  let pos = def.mcp.slice();
  let acc = 0;
  for (let i = 0; i < 3; i += 1) {
    acc += angles[i];
    const dir = rotX(base, acc);
    pos = [pos[0] + dir[0] * def.bones[i], pos[1] + dir[1] * def.bones[i], pos[2] + dir[2] * def.bones[i]];
    pts.push(pos);
  }
  return pts; // [MCP, PIP, DIP, TIP]
}

// ---------- 生成 21 个手部局部坐标（米，掌面朝向摄像头）----------
function buildLocal(spec) {
  const pts = new Array(21).fill(null);
  pts[0] = [0, 0, 0];

  const chains = {};
  for (const name of Object.keys(FINGERS)) {
    const chain = buildFinger(FINGERS[name], spec.fingers[name]);
    chains[name] = chain;
    const base = FINGERS[name].mcpIdx;
    pts[base] = chain[0];
    pts[base + 1] = chain[1];
    pts[base + 2] = chain[2];
    pts[base + 3] = chain[3];
  }

  // 拇指
  let t1 = THUMB_TUCKED[1], t2, t3, t4;
  if (spec.thumb === 'pinch') {
    const indexTip = chains.index[3];
    t1 = THUMB_TUCKED[1];
    t2 = lerp3(THUMB_TUCKED[2], indexTip, 0.55);
    t3 = lerp3(THUMB_TUCKED[3], indexTip, 0.80);
    t4 = indexTip.slice();
  } else {
    const t = Math.max(0, Math.min(1, spec.thumb));
    t2 = lerp3(THUMB_TUCKED[2], THUMB_EXTENDED[2], t);
    t3 = lerp3(THUMB_TUCKED[3], THUMB_EXTENDED[3], t);
    t4 = lerp3(THUMB_TUCKED[4], THUMB_EXTENDED[4], t);
  }
  pts[1] = t1; pts[2] = t2; pts[3] = t3; pts[4] = t4;
  return pts;
}

// ---------- 伪随机（固定种子，保证测试可复现）----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * 生成一帧「手」的识别结果。
 * @param {string|object} pose POSES 里的名字，或自定义 spec
 * @param {object} opts
 *   aspect      画面宽高比（视频宽度 / 高度），默认 4/3
 *   frameWidth  画面宽度对应的真实尺寸（米），越小手显得越大，默认 0.45
 *   roll/yaw/pitch  整只手的三维旋转（度）
 *   mirror      是否左手（x 镜像）
 *   offsetX/offsetY  整只手在画面里的平移（归一化坐标）
 *   noise       关键点抖动幅度（归一化坐标的标准差），模拟真实检测噪声
 *   seed        随机种子
 * @returns {{landmarks: object[], worldLandmarks: object[], handedness: string, score: number}}
 */
export function makeHand(pose, opts = {}) {
  const spec = typeof pose === 'string' ? POSES[pose] : pose;
  if (!spec) throw new Error('未知手势: ' + pose);
  const aspect = opts.aspect || 4 / 3;
  const frameWidth = opts.frameWidth || 0.45;
  const frameHeight = frameWidth / aspect;
  const noise = opts.noise || 0;
  const rand = mulberry32(opts.seed == null ? 20261003 : opts.seed);

  let local = buildLocal(spec);
  // 左手：镜像
  if (opts.mirror) local = local.map((p) => [-p[0], p[1], p[2]]);
  // 整只手旋转
  local = local.map((p) => rotate(p, opts));

  // 世界坐标：以手掌中心为原点（米），角度/比例不受影响
  const cx = local.reduce((s, p) => s + p[0], 0) / local.length;
  const cy = local.reduce((s, p) => s + p[1], 0) / local.length;
  const cz = local.reduce((s, p) => s + p[2], 0) / local.length;

  const landmarks = [];
  const worldLandmarks = [];
  for (const p of local) {
    const nx = (p[0] - cx) + (noise ? gaussian(rand) * noise : 0);
    const ny = (p[1] - cy) + (noise ? gaussian(rand) * noise : 0);
    const nz = (p[2] - cz) + (noise ? gaussian(rand) * noise : 0);
    worldLandmarks.push({ x: nx, y: ny, z: nz });
    landmarks.push({
      x: 0.5 + p[0] / frameWidth + (opts.offsetX || 0) + (noise ? gaussian(rand) * noise : 0),
      y: 0.5 - p[1] / frameHeight + (opts.offsetY || 0) + (noise ? gaussian(rand) * noise : 0),
      z: p[2] / frameWidth
    });
  }

  return {
    landmarks,
    worldLandmarks,
    handedness: opts.mirror ? 'Left' : 'Right',
    score: opts.score == null ? 0.95 : opts.score
  };
}
