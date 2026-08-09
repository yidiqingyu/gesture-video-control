// ============================================================
// gesture.js —— 手势分类（纯逻辑，不依赖 DOM，方便单独测试）
//
// 输入：MediaPipe Hands 输出的 21 个手部关键点 landmarks，
//       每个关键点是 { x, y, z }，x/y 为 0~1 的归一化坐标。
//
// 关键点索引（MediaPipe Hands 官方定义）：
//   0       手腕
//   1~4     拇指：CMC / MCP / IP / 指尖
//   5~8     食指：MCP / PIP / DIP / 指尖
//   9~12    中指：MCP / PIP / DIP / 指尖
//   13~16   无名指：MCP / PIP / DIP / 指尖
//   17~20   小指：MCP / PIP / DIP / 指尖
//
// 输出：{ name, ok, detail }
//   name   —— 手势中文名称
//   ok     —— 是否为“拇指尖 + 食指尖”捏合成圈（OK 手势，播放/暂停用）
//   detail —— 当前判定的简要说明（用于弹窗提示 / 排查）
//
// 分类策略：给每根手指算一个“伸展度”（指尖到指根的距离 ÷ 指根到
// PIP 关节的距离），数值越大越接近伸直。用“比值对比”而不是绝对
// 阈值，所以手指朝上 / 朝下 / 朝侧面都有效，手离摄像头远近也不影响。
// ============================================================

'use strict';

const GestureMath = (() => {
  // ---------- 基础几何 ----------
  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // 手的“尺寸”：手腕到中指根部的距离（尺度归一化用）
  function handSize(lm) {
    return Math.max(dist(lm[0], lm[9]), 1e-4);
  }

  // 手指伸展度：tipMcp / pipMcp
  // 伸直时指尖明显远离指根，比值通常在 1.5 以上；
  // 弯曲时指尖收向掌心，比值通常小于 1。
  function extensionScore(lm, tipIdx, pipIdx, mcpIdx) {
    const tipMcp = dist(lm[tipIdx], lm[mcpIdx]);
    const pipMcp = dist(lm[pipIdx], lm[mcpIdx]);
    return tipMcp / Math.max(pipMcp, 1e-4);
  }

  // 阈值定义
  const EXT_WEAK = 1.25;   // 伸展度大于此值视为“伸直”
  const CURLED = 1.1;      // 伸展度小于此值视为“弯曲”
  const EXT_STRONG = 1.6;  // “明显伸直”（用于食指上/下判定）

  function fingerLabel(score) {
    if (score > EXT_WEAK) return '伸直';
    if (score < CURLED) return '弯曲';
    return '半弯';
  }

  // ---------- 主分类函数 ----------
  function classifyPose(lm) {
    const sz = handSize(lm);

    const idx = extensionScore(lm, 8, 6, 5);
    const mid = extensionScore(lm, 12, 10, 9);
    const ring = extensionScore(lm, 16, 14, 13);
    const pinky = extensionScore(lm, 20, 18, 17);

    const indexExt = idx > EXT_WEAK;
    const middleExt = mid > EXT_WEAK;
    const ringExt = ring > EXT_WEAK;
    const pinkyExt = pinky > EXT_WEAK;

    // 握拳：四指都明显弯曲
    const allCurled = idx < CURLED && mid < CURLED && ring < CURLED && pinky < CURLED;
    // 手掌张开：四指都伸直
    const palmOpen = indexExt && middleExt && ringExt && pinkyExt &&
                     Math.min(idx, mid, ring, pinky) > EXT_STRONG * 0.9;

    // OK：拇指尖（4）与食指尖（8）捏合成圈，且食指是弯的
    // （食指伸直时即使拇指靠近也不当 OK，避免和“单个食指”混淆）
    const okPose = !allCurled && idx < EXT_WEAK && dist(lm[4], lm[8]) < sz * 0.38;

    // 原来的“打响指”（拇指尖 + 中指尖捏合）已停用：
    // 识别出来但不触发任何动作，防止残留手型误判成别的指令
    const thumbMiddlePinch = !allCurled && dist(lm[4], lm[12]) < sz * 0.38;

    // 单个食指：食指明显伸直，其余三指都收着
    const indexSolo = idx > EXT_STRONG &&
      mid < EXT_WEAK && ring < EXT_WEAK && pinky < EXT_WEAK &&
      mid < idx * 0.8 && ring < idx * 0.8 && pinky < idx * 0.8;
    const indexUp = indexSolo && lm[8].y < lm[6].y - 0.015;
    const indexDown = indexSolo && lm[8].y > lm[6].y + 0.015;

    // 单个小拇指：小指伸直，其余三指都收着（小指较短，比例放宽一点）
    const pinkySolo = pinky > EXT_WEAK &&
      idx < EXT_WEAK && mid < EXT_WEAK && ring < EXT_WEAK &&
      idx < pinky * 0.85 && mid < pinky * 0.85 && ring < pinky * 0.85;
    const pinkyUp = pinkySolo && lm[20].y < lm[18].y - 0.012;
    const pinkyDown = pinkySolo && lm[20].y > lm[18].y + 0.012;

    if (okPose) return { name: 'OK', ok: true, detail: '拇指+食指捏合成圈' };
    if (thumbMiddlePinch) return { name: '其他手势', ok: false, detail: '拇指+中指捏合（原打响指，已停用）' };
    if (indexUp) return { name: '食指向上', ok: false, detail: '单个食指伸直朝上' };
    if (indexDown) return { name: '食指向下', ok: false, detail: '单个食指伸直朝下' };
    if (pinkyUp) return { name: '小拇指向上', ok: false, detail: '单个小拇指伸直朝上' };
    if (pinkyDown) return { name: '小拇指向下', ok: false, detail: '单个小拇指伸直朝下' };
    if (allCurled) return { name: '握拳', ok: false, detail: '四指收拢' };
    if (palmOpen) return { name: '手掌张开', ok: false, detail: '四指张开' };
    return {
      name: '其他手势',
      ok: false,
      detail: '食指' + fingerLabel(idx) + '·中指' + fingerLabel(mid) +
              '·无名指' + fingerLabel(ring) + '·小指' + fingerLabel(pinky)
    };
  }

  return { classifyPose, dist, handSize, extensionScore };
})();

// 暴露给 ES Module（offscreen.js）使用：
// 经典脚本的顶层 const 不会挂到 globalThis，这里显式挂载一次
globalThis.GestureMath = GestureMath;
