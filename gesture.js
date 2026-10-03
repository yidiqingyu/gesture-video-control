// ============================================================
// gesture.js —— 手势分类（纯逻辑，不依赖 DOM，方便单独测试）
//
// 输入：MediaPipe HandLandmarker 的输出
//   lm    —— 21 个归一化图像关键点 { x, y, z }（x/y 为 0~1）
//   opts  —— { aspect, world }
//     aspect: 画面宽高比（视频宽 / 高），用于把归一化坐标换算成等尺度，
//             不传按 4:3 处理
//     world : 同一只手的 21 个「世界坐标」关键点（米制 3D），
//             有它时和图像坐标取平均，判定更稳
//
// 关键点索引（MediaPipe Hands 官方定义）：
//   0       手腕
//   1~4     拇指：CMC / MCP / IP / 指尖
//   5~8     食指：MCP / PIP / DIP / 指尖
//   9~12    中指：MCP / PIP / DIP / 指尖
//   13~16   无名指：MCP / PIP / DIP / 指尖
//   17~20   小指：MCP / PIP / DIP / 指尖
//
// 输出：{ name, ok, detail, debug }
//   name   —— 手势中文名称
//   ok     —— 是否为「拇指尖 + 食指尖」捏合成圈（OK 手势，播放/暂停用）
//   detail —— 当前判定的简要说明（用于弹窗提示 / 排查）
//   debug  —— 五根手指的伸展度、捏合比例、方向（排查用，界面不显示）
//
// ── 判定思路（v2 重写）────────────────────────────────────────
// 旧版用「指尖到指根距离 ÷ PIP 到指根距离」这个比值判断手指伸没伸直，
// 有两个致命问题：
//   1. 手掌正对镜头时，蜷起的手指是朝镜头方向弯的，PIP 在画面上几乎和
//      指根重合 → 分母趋近 0 → 比值暴涨 → 蜷着的手指被判成「伸直」。
//      实测蜷曲的中指该比值为 7.6（而门槛只要 1.25）。
//   2. 归一化坐标 x/y 尺度不同（x 按画面宽、y 按画面高），算距离本身就失真。
// 新版改成：
//   · 用「关节夹角」判断伸没伸直（伸直≈180°，蜷曲≈50°），投影不会说谎；
//   · 图像坐标先乘宽高比换算成等尺度；再和世界坐标（米制 3D）取平均；
//   · 方向（上/下）要求手指轴线落在一个「竖直圆锥」内，接近水平时判为
//     方向不明 —— 宁可不动作，也不猜错方向；
//   · 容易混的手势之间留「死区」，落进死区一律返回「其他手势」不动作。
// ============================================================

'use strict';

const GestureMath = (() => {
  const DEFAULT_ASPECT = 4 / 3;

  const WRIST = 0;
  const MIDDLE_MCP = 9;

  const FINGERS = {
    index:  { mcp: 5,  pip: 6,  dip: 7,  tip: 8  },
    middle: { mcp: 9,  pip: 10, dip: 11, tip: 12 },
    ring:   { mcp: 13, pip: 14, dip: 15, tip: 16 },
    pinky:  { mcp: 17, pip: 18, dip: 19, tip: 20 }
  };
  const FINGER_KEYS = ['index', 'middle', 'ring', 'pinky'];
  const THUMB = { cmc: 1, mcp: 2, ip: 3, tip: 4 };
  const ALL_KEYS = ['thumb'].concat(FINGER_KEYS);

  // ---------- 阈值（伸展度 0~1）----------
  const EXT_STRONG = 0.65; // 明显伸直
  const EXT_WEAK = 0.50;   // 伸直（放宽）
  const EXT_CURLED = 0.45; // 明显弯曲
  // 主指要比其它手指明显更伸，才算「单指手势」
  const DOMINANCE = 0.18;

  // ---------- 方向 ----------
  // 手指轴线与画面竖直方向的夹角上限：超过就认为「方向不明」
  const DIR_MAX_DEG = 55;
  // 拇指天生是斜的（自然竖起时轴线离竖直就有 40° 左右），
  // 再叠上手腕一歪就会超过 55°，所以拇指的锥角放宽到 76°
  //（仍然要求「明显偏上」，倒过来或横着的拇指依旧不算）
  const THUMB_DIR_MAX_DEG = 76;
  // 指根到指尖的投影长度至少要有这么多（相对手掌长度），
  // 否则说明手指基本指着镜头，方向不可信
  const DIR_MIN_LEN = 0.45;

  // ---------- OK 捏合 ----------
  const PINCH_MAX = 0.30;    // 拇指尖到食指尖 ÷ 手掌长度
  const OK_INDEX_MAX = 0.70; // OK 时食指是弯的（指尖去够拇指），不能是伸直状态

  // ---------- 拇指收 / 伸的死区 ----------
  const THUMB_OUT = 0.62; // 大于它才算「拇指伸开」
  const THUMB_IN = 0.42;  // 小于它才算「拇指收着」

  // ============================================================
  // 基础几何
  // ============================================================
  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function dist3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // 把归一化图像坐标换算到「等尺度」空间：
  // x 乘宽高比之后，x/y 的比例和真实画面一致，算距离才不会失真
  function imageMetrics(lm, aspect) {
    const a = aspect > 0 ? aspect : DEFAULT_ASPECT;
    const out = new Array(lm.length);
    for (let i = 0; i < lm.length; i += 1) {
      const p = lm[i];
      out[i] = { x: p.x * a, y: p.y, z: (p.z || 0) * a };
    }
    return out;
  }

  // ∠abc（b 为顶点），返回角度（度）
  function angleAt(a, b, c) {
    const v1x = a.x - b.x, v1y = a.y - b.y, v1z = (a.z || 0) - (b.z || 0);
    const v2x = c.x - b.x, v2y = c.y - b.y, v2z = (c.z || 0) - (b.z || 0);
    const n1 = Math.hypot(v1x, v1y, v1z);
    const n2 = Math.hypot(v2x, v2y, v2z);
    if (n1 < 1e-9 || n2 < 1e-9) return 0;
    const cos = (v1x * v2x + v1y * v2y + v1z * v2z) / (n1 * n2);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  }

  // 手掌长度：手腕 → 中指根（尺度归一化用）
  function handSize(points) {
    return Math.max(dist3(points[WRIST], points[MIDDLE_MCP]), 1e-6);
  }

  // 两根线段是否相交（含端点接触）。用于「双手食指交叉」判定。
  function segmentsIntersect(a, b, c, d) {
    const det = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
    if (Math.abs(det) < 1e-9) return false; // 平行或共线
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / det;
    const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / det;
    return t >= -0.05 && t <= 1.05 && u >= -0.05 && u <= 1.05;
  }

  // ============================================================
  // 伸展度
  // ============================================================
  // 单根手指的伸展度 0~1：关节夹角为主（占 0.75），
  // 「指尖到手腕 ÷ PIP 到手腕」的距离比为辅（占 0.25，抗噪）。
  // 夹角在 PIP 处量：伸直时两节骨头共线 → 接近 180°
  function fingerScore(points, name) {
    const ids = FINGERS[name];
    const ang = angleAt(points[ids.mcp], points[ids.pip], points[ids.tip]);
    const angScore = clamp01((ang - 95) / 70); // 95° → 0，165° → 1

    const r = dist3(points[ids.tip], points[WRIST]) /
      Math.max(dist3(points[ids.pip], points[WRIST]), 1e-6);
    const ratioScore = clamp01((r - 0.85) / 0.55); // 0.85 → 0，1.40 → 1

    return clamp01(0.75 * angScore + 0.25 * ratioScore);
  }

  // 拇指伸展度：以外展程度为主（拇指尖离食指根多远），IP 关节夹角只占一点点。
  // 为什么角度权重压到 0.15：拇指「收在掌心」是内收动作，关节本身往往是直的
  //（实测夹角 172°），角度分不出来；真正区分「收」和「伸」的是外展距离。
  function thumbScore(points, size) {
    const ang = angleAt(points[THUMB.mcp], points[THUMB.ip], points[THUMB.tip]);
    const angScore = clamp01((ang - 115) / 55); // 115° → 0，170° → 1
    const spread = dist3(points[THUMB.tip], points[FINGERS.index.mcp]) / Math.max(size, 1e-6);
    const spreadScore = clamp01((spread - 0.35) / 0.25); // 0.35 → 0，0.60 → 1
    return clamp01(0.85 * spreadScore + 0.15 * angScore);
  }

  // 一套坐标里五根手指的伸展度 + 手掌长度
  function analyze(points) {
    const size = handSize(points);
    const ext = {};
    for (const key of FINGER_KEYS) ext[key] = fingerScore(points, key);
    ext.thumb = thumbScore(points, size);
    return { ext, size, points };
  }

  // ============================================================
  // 方向（上 / 下 / 不明）
  // ============================================================
  function fingerDir(lm, name, opts) {
    const a = opts && opts.aspect > 0 ? opts.aspect : DEFAULT_ASPECT;
    const ids = name === 'thumb'
      ? { mcp: THUMB.mcp, tip: THUMB.tip }
      : { mcp: FINGERS[name].mcp, tip: FINGERS[name].tip };
    const mcp = lm[ids.mcp];
    const tip = lm[ids.tip];
    if (!mcp || !tip) return 'none';

    const dx = (tip.x - mcp.x) * a;
    const dy = tip.y - mcp.y; // 图像 y 向下
    const len = Math.hypot(dx, dy);
    const size = handSize(imageMetrics(lm, a));
    // 手指基本指着镜头（投影太短）→ 方向不可信
    if (len < size * DIR_MIN_LEN) return 'none';

    const up = -dy;
    const maxDeg = name === 'thumb' ? THUMB_DIR_MAX_DEG : DIR_MAX_DEG;
    // 落在竖直圆锥之外（接近水平）→ 方向不明，宁可不动作
    if (Math.abs(up) < Math.abs(dx) / Math.tan((maxDeg * Math.PI) / 180)) return 'none';
    return up > 0 ? 'up' : 'down';
  }

  // ============================================================
  // 主分类
  // ============================================================
  function label(v) {
    if (v > EXT_STRONG) return '伸直';
    if (v > EXT_CURLED) return '半弯';
    return '弯曲';
  }

  function detailText(ext) {
    return '食指' + label(ext.index) + '·中指' + label(ext.middle) +
      '·无名指' + label(ext.ring) + '·小指' + label(ext.pinky);
  }

  function classifyPose(lm, opts) {
    const o = opts || {};
    const aspect = o.aspect > 0 ? o.aspect : DEFAULT_ASPECT;
    if (!lm || lm.length < 21) {
      return { name: '其他手势', ok: false, detail: '关键点不足 21 个', debug: null };
    }

    const img = analyze(imageMetrics(lm, aspect));
    const world = o.world && o.world.length >= 21 ? analyze(o.world) : null;

    // 两套坐标各算一遍再平均：图像坐标最准，世界坐标不受透视影响，
    // 平均之后对抖动和手部朝向都更稳
    const ext = {};
    for (const key of ALL_KEYS) {
      ext[key] = world ? (img.ext[key] + world.ext[key]) / 2 : img.ext[key];
    }

    const idx = ext.index, mid = ext.middle, ring = ext.ring, pinky = ext.pinky;
    const thumb = ext.thumb;

    const strong = (v) => v > EXT_STRONG;
    const weak = (v) => v > EXT_WEAK;
    const curled = (v) => v < EXT_CURLED;

    const allFourCurled = curled(idx) && curled(mid) && curled(ring) && curled(pinky);
    const allFourOpen = strong(idx) && strong(mid) && strong(ring) && strong(pinky);

    // 捏合程度：拇指尖到食指尖的距离 ÷ 手掌长度（用图像空间，看的是画面上的圈）
    const pinch = dist3(img.points[THUMB.tip], img.points[FINGERS.index.tip]) /
      Math.max(img.size, 1e-6);

    const idxDir = fingerDir(lm, 'index', { aspect });
    const pinkyDir = fingerDir(lm, 'pinky', { aspect });
    const thumbDir = fingerDir(lm, 'thumb', { aspect });

    const debug = {
      ext: {
        thumb: +thumb.toFixed(3), index: +idx.toFixed(3), middle: +mid.toFixed(3),
        ring: +ring.toFixed(3), pinky: +pinky.toFixed(3)
      },
      pinch: +pinch.toFixed(3),
      dir: { index: idxDir, pinky: pinkyDir, thumb: thumbDir }
    };

    const result = (name, ok, detail) => ({ name, ok: !!ok, detail, debug });

    // ---- 1) OK：拇指尖和食指尖捏上，另外几指是伸开的 ----
    // 食指此时是弯的（去够拇指），所以要求 idx 不高；中指/无名指伸开，
    // 这一条同时把「小拇指」「666」「点赞」「🤟」都排除掉了
    if (pinch < PINCH_MAX && idx < OK_INDEX_MAX && weak(mid) && weak(ring)) {
      return result('OK', true, '拇指+食指捏合成圈');
    }

    // ---- 2) 点赞：四指全蜷 + 拇指明显外展伸直 + 拇指朝上 ----
    // 要求朝上：倒过来比的手不算点赞，避免误点赞
    if (allFourCurled && strong(thumb) && thumbDir === 'up') {
      return result('点赞', false, '竖大拇指点赞');
    }

    // ---- 3) 666（拇指 + 小指伸直，中间三指收着）----
    // 小指不能朝下：朝下那是「小拇指向下」的音量手势
    if (strong(thumb) && strong(pinky) && curled(idx) && curled(mid) && curled(ring) &&
        pinkyDir !== 'down') {
      return result('666', false, '666 手势：拇指+小指伸直');
    }

    // ---- 4) 🤟（拇指 + 食指 + 小指伸直）----
    if (strong(thumb) && strong(idx) && strong(pinky) &&
        curled(mid) && curled(ring) && pinkyDir !== 'down') {
      return result('🤟', false, '拇指+食指+小指伸直（摇滚）');
    }

    // ---- 5) 数字 2 / 3 / 4 / 手掌张开 ----
    if (strong(idx) && strong(mid) && curled(ring) && curled(pinky)) {
      return result('数字2', false, '食指+中指伸出（数字 2）');
    }
    if (strong(idx) && strong(mid) && strong(ring) && curled(pinky)) {
      return result('数字3', false, '食中无名指伸出（数字 3）');
    }
    if (allFourOpen) {
      // 数字 4 和手掌张开只差拇指：收着 = 4，伸开 = 5；
      // 中间状态不猜（返回「其他手势」），免得在 B 站首页选错视频
      if (thumb < THUMB_IN) return result('数字4', false, '四指伸出、拇指收（数字 4）');
      if (thumb > THUMB_OUT) return result('手掌张开', false, '四指张开、拇指伸开');
      return result('其他手势', false, '四指伸出但拇指收伸不明（4 还是 5？）');
    }

    // ---- 6) 单手指示：食指 / 小拇指，方向必须明确 ----
    const othersForIndex = Math.max(mid, ring, pinky);
    if (strong(idx) && idx > othersForIndex + DOMINANCE) {
      if (idxDir === 'up') return result('食指向上', false, '单个食指伸直朝上');
      if (idxDir === 'down') return result('食指向下', false, '单个食指伸直朝下');
      return result('其他手势', false, '食指伸直但方向不明（倾斜过大）');
    }
    const othersForPinky = Math.max(idx, mid, ring);
    if (strong(pinky) && pinky > othersForPinky + DOMINANCE) {
      if (pinkyDir === 'up') return result('小拇指向上', false, '单个小拇指伸直朝上');
      if (pinkyDir === 'down') return result('小拇指向下', false, '单个小拇指伸直朝下');
      return result('其他手势', false, '小指伸直但方向不明（倾斜过大）');
    }

    if (allFourCurled) return result('握拳', false, '四指收拢');

    return result('其他手势', false, detailText(ext));
  }

  // ============================================================
  // 主手选择：画面里有多只手（或误检）时，盯住「该盯的那只」。
  // 旧版直接用 hands[0]，画面里一出现第二只手，主手势就在两手之间跳。
  // ============================================================
  function centroid(lm) {
    const ids = [0, 5, 9, 13, 17];
    let x = 0, y = 0;
    for (const i of ids) {
      x += lm[i].x;
      y += lm[i].y;
    }
    return { x: x / ids.length, y: y / ids.length };
  }

  /**
   * @param {Array} candidates 每项可以是关键点数组，也可以是
   *        { landmarks, worldLandmarks, handedness, score }
   * @param {object} opts { aspect, prev: { x, y, handedness } }
   * @returns {{ index: number, center: object|null }}
   */
  function pickPrimaryHand(candidates, opts) {
    const o = opts || {};
    const aspect = o.aspect > 0 ? o.aspect : DEFAULT_ASPECT;
    const list = candidates || [];
    let best = -1;
    let bestScore = -Infinity;
    let bestCenter = null;

    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      const lm = Array.isArray(item) ? item : (item && item.landmarks);
      if (!lm || lm.length < 21) continue;
      const ctr = centroid(lm);
      const size = handSize(imageMetrics(lm, aspect));
      // 越靠画面中间，越像「正在比划的那只手」
      const centered = 1 - Math.min(1, Math.hypot(ctr.x - 0.5, ctr.y - 0.5) / 0.5);
      let s = size * (0.55 + 0.45 * centered);

      if (!Array.isArray(item) && typeof item.score === 'number') {
        s *= 0.85 + 0.3 * item.score;
      }
      if (o.prev) {
        // 和上一帧的主手越近越优先，避免两只手抢来抢去
        const d = Math.hypot(ctr.x - o.prev.x, ctr.y - o.prev.y);
        s *= 1 + 0.6 * Math.exp(-(d * d) / (2 * 0.13 * 0.13));
        const handed = Array.isArray(item) ? '' : (item && item.handedness);
        if (handed && o.prev.handedness && handed === o.prev.handedness) s *= 1.15;
      }
      if (s > bestScore) {
        bestScore = s;
        best = i;
        bestCenter = ctr;
      }
    }
    return { index: best, center: bestCenter };
  }

  // ============================================================
  // 姿态平滑：最近 N 帧多数投票。
  // 单帧抖动不改变输出；真换了手势 3 帧内跟上。
  // ============================================================
  function createSmoother(opts) {
    const o = opts || {};
    const windowSize = o.window || 5;
    const minVotes = o.votes || 3;
    let buf = [];
    let current = '';

    return {
      push(name) {
        buf.push(name);
        if (buf.length > windowSize) buf.shift();
        const count = {};
        let top = '';
        let topN = 0;
        for (const n of buf) {
          count[n] = (count[n] || 0) + 1;
          if (count[n] > topN) {
            topN = count[n];
            top = n;
          }
        }
        // 票数不够就保持上一次的输出（hold），不跟着抖动走
        if (topN >= minVotes) current = top;
        return current;
      },
      reset() {
        buf = [];
        current = '';
      },
      get() {
        return current;
      }
    };
  }

  // ============================================================
  // 逐帧追踪器：把「挑主手 → 判定 → 平滑 → 稳定确认」串成一条流水线，
  // 后台离屏引擎和悬浮窗引擎共用同一份实现（旧版两个文件各抄一份，
  // 改一处漏一处，就是 bug 温床）。
  // ============================================================
  function createPoseTracker(opts) {
    const o = opts || {};
    const stableFrames = o.stableFrames || 2;
    let smoother = createSmoother({ window: o.window || 5, votes: o.votes || 3 });
    let center = null;
    let lastName = '';
    let sameCount = 0;

    return {
      reset() {
        smoother.reset();
        center = null;
        lastName = '';
        sameCount = 0;
      },
      /**
       * @param {Array} candidates 每只手 { landmarks, worldLandmarks, handedness, score }
       * @param {object} view { aspect }
       * @returns {object|null} 没有可用手时返回 null（调用方自行决定是否重置）
       */
      update(candidates, view) {
        const aspect = view && view.aspect > 0 ? view.aspect : DEFAULT_ASPECT;
        const list = candidates || [];
        if (list.length === 0) return null;

        const picked = pickPrimaryHand(list, { aspect, prev: center });
        const hand = list[picked.index >= 0 ? picked.index : 0];
        center = picked.center;

        const raw = classifyPose(hand.landmarks, { aspect, world: hand.worldLandmarks });
        const name = smoother.push(raw.name) || raw.name;

        if (name === lastName) sameCount += 1;
        else {
          lastName = name;
          sameCount = 1;
        }

        return {
          pose: { name, ok: name === 'OK', detail: raw.detail, debug: raw.debug },
          rawPose: raw,
          hand,
          center,
          hands: list,
          stable: sameCount >= stableFrames
        };
      }
    };
  }

  // 对外暴露单指伸展度（「双手食指交叉」判定等地方要用）
  function fingerExt(lm, name, opts) {
    const o = opts || {};
    const aspect = o.aspect > 0 ? o.aspect : DEFAULT_ASPECT;
    const img = fingerScore(imageMetrics(lm, aspect), name);
    if (o.world && o.world.length >= 21) {
      return (img + fingerScore(o.world, name)) / 2;
    }
    return img;
  }

  return {
    classifyPose,
    fingerDir,
    fingerExt,
    pickPrimaryHand,
    createSmoother,
    createPoseTracker,
    imageMetrics,
    analyze,
    angleAt,
    handSize,
    dist,
    dist3,
    segmentsIntersect,
    FINGERS,
    THUMB,
    THRESHOLDS: {
      EXT_STRONG, EXT_WEAK, EXT_CURLED, DOMINANCE,
      DIR_MAX_DEG, THUMB_DIR_MAX_DEG, DIR_MIN_LEN,
      PINCH_MAX, OK_INDEX_MAX, THUMB_OUT, THUMB_IN
    }
  };
})();

// 暴露给 ES Module（offscreen.js / float.js）使用：
// 经典脚本的顶层 const 不会挂到 globalThis，这里显式挂载一次
globalThis.GestureMath = GestureMath;
