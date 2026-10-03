// ============================================================
// action-policy.js —— 「这个手势现在该不该执行」的判定表
//                    （纯逻辑，不碰 DOM / chrome，方便离线测）
//
// 起因：在 B 站首页（还没打开视频）比「数字 1」选视频，结果被当成「上一集」
// 乱点；音量、点赞这些只有看视频时才用得上 的手势，在没有视频的页面上也不该乱触发。
//
// 所以把手势动作分成三类：
//   · 视频类（播放暂停 / 音量 / 切集 / 点赞）：页面上必须真的在放视频
//   · 信息流类（短视频模式的 ↑↓ 滑动）：页面上至少要有视频元素
//   · 页面类（B 站首页数字选视频 / 🤟 换一换 / 666 锁定 / 关闭页面）：跟有没有视频无关
//
// 判定结果里带一句人话原因，界面直接显示给用户，不用再猜"为什么没反应"。
// ============================================================

'use strict';

const ActionPolicy = (() => {
  const VIDEO_ACTIONS = [
    'play_pause',   // OK
    'volume_up',    // 小拇指向上
    'volume_down',  // 小拇指向下
    'prev',         // 食指向上（长视频模式 = 上一集）
    'next',         // 食指向下（长视频模式 = 下一集）
    'like',         // 竖大拇指
    'like3'         // 双手点赞（一键三连）
  ];
  const FEED_ACTIONS = [
    'scroll_up',    // 短视频模式：↑
    'scroll_down'   // 短视频模式：↓
  ];
  const PAGE_ACTIONS = [
    'num_1', 'num_2', 'num_3', 'num_4', 'num_5', 'num_6', // B 站首页选第 N 个视频
    'bili_refresh', // 🤟 换一换
    'lock', 'unlock', // 666 锁定 / 解锁
    'close_tab'     // 双手食指交叉
  ];

  const NO_VIDEO_REASON = '当前页面没有正在播放的视频，这个手势不执行（音量 / 切集 / 点赞只在看视频时有效）';
  const NO_VIDEO_ELEMENT_REASON = '当前页面没有视频，滑动切视频不执行';
  const LOCKED_REASON = '🔒 已锁定：手势操作已暂停，比出 666 手势保持 1.5 秒解锁';

  const requiresVideo = (action) => VIDEO_ACTIONS.indexOf(action) !== -1;
  const requiresFeed = (action) => FEED_ACTIONS.indexOf(action) !== -1;
  const isPageAction = (action) => PAGE_ACTIONS.indexOf(action) !== -1;
  const isKnown = (action) => requiresVideo(action) || requiresFeed(action) || isPageAction(action);

  /**
   * 该不该执行这个动作。
   * @param {string} action 动作名（和 content.js 里 handleGestureAction 的 case 一致）
   * @param {object} ctx
   *        videoUsable 页面上是否真的在放视频：true / false / null(还没探测到)
   *        hasVideo    页面上有没有 <video> 元素：true / false / null
   *        locked      引擎是否处于 666 锁定状态
   * @returns {{ok: boolean, reason: string}}
   */
  function check(action, ctx) {
    const c = ctx || {};

    if (c.locked && action !== 'lock' && action !== 'unlock') {
      return { ok: false, reason: LOCKED_REASON };
    }

    if (requiresVideo(action)) {
      if (c.videoUsable === false) return { ok: false, reason: NO_VIDEO_REASON };
      // 探测还没结果（null）时一律放行：页面脚本没响应 / 刚启动，
      // 不能因为"没探测到"就把整个扩展变成不响应
      if (c.videoUsable == null && c.hasVideo === false) return { ok: false, reason: NO_VIDEO_REASON };
      return { ok: true, reason: '' };
    }

    if (requiresFeed(action)) {
      if (c.hasVideo === false) return { ok: false, reason: NO_VIDEO_ELEMENT_REASON };
      return { ok: true, reason: '' };
    }

    // 页面类动作（含未知动作）不拦：未知动作交给 content.js 自己回错误
    return { ok: true, reason: '' };
  }

  return {
    check,
    requiresVideo,
    requiresFeed,
    isPageAction,
    isKnown,
    VIDEO_ACTIONS,
    FEED_ACTIONS,
    PAGE_ACTIONS,
    NO_VIDEO_REASON,
    LOCKED_REASON
  };
})();

// 挂到全局：offscreen.html 用经典脚本加载，测试里手工加载
globalThis.ActionPolicy = ActionPolicy;
