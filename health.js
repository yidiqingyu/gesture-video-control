// ============================================================
// health.js —— 自检决策（纯逻辑，不碰 chrome API，方便单独测试）
//
// 背景：这个扩展以前是「断了就再也回不来」——后台 Service Worker 空闲约
// 30 秒会被浏览器回收，离屏识别页也可能被关掉/冻结，而全项目没有任何一处
// 会去重建它；用户只能点一下插件图标把它叫醒。
//
// 现在由 background.js 每分钟做一次自检，把「探测结果」交给这里的纯函数，
// 由它算出该做什么补救动作。决策和「怎么执行」分开，才能离线测。
//
// 输入（探测结果）：
//   controlOn      手势控制开关是否打开（storage）
//   sessionActive  本次浏览器会话里引擎是否启动过（storage.session，
//                  浏览器重启后为空 —— 这时不自动开摄像头，避免"自己偷偷开摄像头"）
//   engineState    离屏识别页的状态：'running' | 'idle' | 'missing'
//   engineFrames   离屏引擎自报的已处理帧数
//   lastFrames     上次自检记录的帧数（-1 = 还没记录过，这一轮不判卡死）
//   stallCount     上次自检累计的「帧数没涨」次数
//   targetTabOk    控制目标标签页是否还存在
//   pageScriptOk   控制标签页里的 content.js 是否响应
//   recoverFailures 连续几次「重建重启后引擎仍没跑起来」（摄像头坏了就别反复折腾）
//
// 输出：
//   health   给界面显示用的健康状态：
//            'off' 未开启 | 'ok' 正常 | 'recovering' 正在自动恢复
//            | 'suspect' 可疑（再观察一轮）| 'need_popup' 需要打开一次弹窗
//            | 'need_click' 需要点一下扩展图标（页面脚本补不进去）
//            | 'engine_failed' 反复恢复失败，多半是摄像头/权限问题
//   actions  要执行的动作，按顺序：
//            'repoint_tab' 重新指向当前活动标签页
//            'ensure_script' 给控制标签页补注入 content.js
//            'restart_engine' 让离屏引擎重新开始（带上持久化的设置）
//            'recreate_offscreen' 关掉并重建离屏识别页
//            'notify_recovered' 在页面上提示"已自动恢复"
// ============================================================

'use strict';

const HealthDecide = (() => {
  // 连续两轮自检发现帧数没涨，就认定识别循环卡死/被冻结，直接重建
  const STALL_LIMIT = 2;
  // 连续这么多轮"重建重启后还是没跑起来"就不再折腾（多半是摄像头本身有问题），
  // 免得每分钟重建一次，把用户的浏览器折腾得吱吱响
  const RECOVER_FAIL_LIMIT = 3;

  // 有固定站点权限的网站（必须和 manifest.json 里的 content_scripts /
  // host_permissions 保持一致，tests/integration-check.mjs 会核对）
  const SITES = [
    'bilibili.com',
    'youtube.com',
    'youtube-nocookie.com',
    'douyin.com',
    'v.qq.com',
    'iqiyi.com',
    'youku.com',
    'ixigua.com',
    'mgtv.com'
  ];

  // 这个网址是不是「能控制的视频站」：认域名后缀，且必须是 http/https
  function isControllableUrl(url) {
    if (!url || !/^https?:/i.test(url)) return false;
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (e) {
      return false;
    }
    for (const site of SITES) {
      if (host === site || host.endsWith('.' + site)) return true;
    }
    return false;
  }

  /**
   * @param {object} input 见文件头说明
   * @returns {{health: string, actions: string[], stallCount: number, lastFrames: number}}
   */
  function check(input) {
    const i = input || {};
    const out = {
      health: 'ok',
      actions: [],
      stallCount: i.stallCount || 0,
      lastFrames: i.engineFrames || 0
    };

    // 开关关着：什么都不用管（闹钟本身也会被清掉）
    if (!i.controlOn) {
      out.health = 'off';
      return out;
    }

    // 浏览器刚重启：识别当然没在跑，但也不该自动把摄像头打开。
    // 交给用户打开一次弹窗恢复（弹窗里会说清楚）。
    if (!i.sessionActive) {
      out.health = 'need_popup';
      return out;
    }

    // 反复重建重启都起不来（比如摄像头被占用 / 权限被拒）→ 别再折腾，
    // 把真实原因留给引擎自报的错误信息（弹窗里会显示）
    if ((i.recoverFailures || 0) >= RECOVER_FAIL_LIMIT) {
      out.health = 'engine_failed';
      return out;
    }

    // 控制目标标签页没了（比如刚用手势关掉了当前页面）→ 重新指向活动标签页
    if (!i.targetTabOk) {
      out.actions.push('repoint_tab');
      out.health = 'recovering';
    }

    // 离屏识别页
    if (i.engineState !== 'running') {
      // 没响应 / 没在跑：整个重建再重启，比"叫它自己重启"靠谱
      //（页面被冻结时它连消息都处理不了）
      out.actions.push('recreate_offscreen', 'restart_engine');
      out.health = 'recovering';
      out.stallCount = 0;
      out.lastFrames = 0; // 新引擎的帧数从 0 开始计，别拿旧数字比出"卡死"
    } else if (i.lastFrames >= 0 && i.engineFrames <= i.lastFrames) {
      // 在跑、但帧数不涨：说明循环卡死或被浏览器冻结降频了。
      //（含"一直是 0 帧"—— 模型没加载起来 / 摄像头没出图，同样要重建）
      out.stallCount += 1;
      if (out.stallCount >= STALL_LIMIT) {
        out.actions.push('recreate_offscreen', 'restart_engine');
        out.stallCount = 0;
        out.health = 'recovering';
        out.lastFrames = 0;
      } else {
        out.health = 'suspect';
      }
    } else {
      out.stallCount = 0;
    }

    // 页面脚本（content.js）没响应 → 补注入
    if (i.targetTabOk && i.pageScriptOk === false) {
      out.actions.push('ensure_script');
      if (out.health === 'ok') out.health = 'recovering';
    }

    return out;
  }

  // 补注入也失败时（没权限，例如任意网站的页面被刷新过），
  // 只能请用户点一下扩展图标 —— 这时界面要明确告诉他
  function afterScriptInjectionFailed() {
    return {
      health: 'need_click',
      hint: '页面脚本已失效，点一下扩展图标即可恢复控制'
    };
  }

  return { check, isControllableUrl, afterScriptInjectionFailed, SITES, STALL_LIMIT, RECOVER_FAIL_LIMIT };
})();

// 同时挂到全局（Service Worker 用 importScripts 加载，测试里手工加载）
globalThis.HealthDecide = HealthDecide;
