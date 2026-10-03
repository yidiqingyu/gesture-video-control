// ============================================================
// tests/policy-selftest.mjs —— 「手势该不该执行」判定表自测
//
// 对应的问题：在 B 站首页（还没打开视频）比"数字 1"选视频，被当成"上一集"；
// 音量、点赞这些只有看视频时才用得上 的手势，在没有视频的页面上也不该乱触发。
//
// 跑法：node tests/policy-selftest.mjs
// ============================================================

import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../action-policy.js', import.meta.url), 'utf8');
const ActionPolicy = new Function(source + '\n;return globalThis.ActionPolicy;')();

let passed = 0;
const failures = [];
const groups = new Map();

// ⚠️ 约定：record(分组, 说明, 条件, 附加信息)
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

// 断言器自检
{
  const before = failures.length;
  record('0-断言器自检', '（内部探测，这一条必须被判定为失败）', false, {});
  const works = failures.length === before + 1;
  if (works) failures.pop();
  groups.delete('0-断言器自检');
  record('0-断言器自检', '断言器能识别失败（否则所有检查都是白做）', works, {});
}

const allow = (action, ctx) => ActionPolicy.check(action, ctx).ok;
const reason = (action, ctx) => ActionPolicy.check(action, ctx).reason;

// ---------- 1. 观看类手势：没在放视频就不执行 ----------
const VIDEO_CASES = [
  ['play_pause', 'OK 播放/暂停'],
  ['volume_up', '小拇指向上调音量'],
  ['volume_down', '小拇指向下调音量'],
  ['prev', '上一集'],
  ['next', '下一集'],
  ['like', '点赞'],
  ['like3', '一键三连']
];
for (const [action, name] of VIDEO_CASES) {
  record('1-观看类', name + '：页面上有视频且像在放 → 执行',
    allow(action, { videoUsable: true, hasVideo: true }), { action });
  record('1-观看类', name + '：页面上没在放视频 → 不执行',
    !allow(action, { videoUsable: false, hasVideo: true }), { action });
  record('1-观看类', name + '：页面根本没有视频 → 不执行',
    !allow(action, { videoUsable: null, hasVideo: false }), { action });
  record('1-观看类', name + '：还没探测到（页面脚本没响应）→ 放行，不能整个失灵',
    allow(action, { videoUsable: null, hasVideo: null }), { action });
  record('1-观看类', name + '：不执行时给一句人话原因',
    reason(action, { videoUsable: false }).length > 5, { reason: reason(action, { videoUsable: false }) });
}

// ---------- 2. 信息流滑动：只要有视频元素就允许 ----------
for (const action of ['scroll_up', 'scroll_down']) {
  record('2-信息流滑动', action + '：有视频元素 → 执行',
    allow(action, { hasVideo: true, videoUsable: false }), { action });
  record('2-信息流滑动', action + '：完全没有视频元素 → 不执行',
    !allow(action, { hasVideo: false, videoUsable: null }), { action });
}

// ---------- 3. 页面类手势：跟有没有视频无关 ----------
const PAGE_CASES = [
  ['num_1', '首页选第 1 个视频'],
  ['num_2', '首页选第 2 个视频'],
  ['num_3', '首页选第 3 个视频'],
  ['num_4', '首页选第 4 个视频'],
  ['num_5', '首页选第 5 个视频'],
  ['num_6', '首页选第 6 个视频'],
  ['bili_refresh', '🤟 换一换'],
  ['close_tab', '双手食指交叉关闭页面']
];
for (const [action, name] of PAGE_CASES) {
  record('3-页面类', name + '：页面上没视频也照常执行（这次问题的关键）',
    allow(action, { videoUsable: false, hasVideo: false }), { action });
}
for (const action of ['lock', 'unlock']) {
  record('3-页面类', action + '：锁定/解锁不受视频与锁定状态影响',
    allow(action, { videoUsable: false, hasVideo: false, locked: true }), { action });
}

// ---------- 4. 锁定状态下：除了 lock/unlock，其它一律不动 ----------
for (const action of ActionPolicy.VIDEO_ACTIONS.concat(ActionPolicy.FEED_ACTIONS, ['num_1', 'bili_refresh', 'close_tab'])) {
  record('4-锁定', '锁定时 ' + action + ' 不执行',
    !allow(action, { videoUsable: true, hasVideo: true, locked: true }), { action });
}

// ---------- 5. 动作分类表本身要完整 ----------
{
  const all = ActionPolicy.VIDEO_ACTIONS.concat(ActionPolicy.FEED_ACTIONS, ActionPolicy.PAGE_ACTIONS);
  check('5-分类表', '动作清单没有重复', new Set(all).size, all.length);
  for (const action of all) {
    record('5-分类表', action + ' 被归入唯一一类', ActionPolicy.isKnown(action), { action });
  }
  // 三类互不重叠
  for (const action of ActionPolicy.VIDEO_ACTIONS) {
    record('5-分类表', action + ' 不会同时被当成信息流/页面类',
      !ActionPolicy.requiresFeed(action) && !ActionPolicy.isPageAction(action), { action });
  }
  record('5-分类表', '未知动作不拦（交给页面脚本回错误）', allow('some_unknown_action', {}), {});
}

// ---------- 汇总 ----------
console.log('\n===== 动作闸门自测 =====');
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
