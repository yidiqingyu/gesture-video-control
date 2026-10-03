// ============================================================
// tests/health-selftest.mjs —— 自检决策自测
//
// 覆盖「过一段时间就不响应」的各种成因，确认自检能认出来并给出正确的补救动作：
//   · 离屏识别页被关掉 / 没响应        → 重建 + 重启
//   · 识别循环卡死（帧数不涨）          → 观察一轮后重建重启
//   · 控制目标标签页被关掉（关页面手势）→ 重新指向活动标签页
//   · 页面脚本失效                      → 补注入；补不上就提示用户点图标
//   · 浏览器刚重启                      → 不自动开摄像头，提示打开一次弹窗
//   · 正常运行时不能乱动作（误判会导致手势被打断）
//
// 跑法：node tests/health-selftest.mjs
// ============================================================

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../health.js', import.meta.url), 'utf8');
const HealthDecide = new Function(src + '\n;return globalThis.HealthDecide;')();

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

// 一次「一切正常」的自检输入，各用例在此基础上改
const HEALTHY = {
  controlOn: true,
  sessionActive: true,
  engineState: 'running',
  engineFrames: 1000,
  lastFrames: 900,
  stallCount: 0,
  targetTabOk: true,
  pageScriptOk: true
};
function decide(patch) {
  return HealthDecide.check(Object.assign({}, HEALTHY, patch));
}

const has = (r, action) => r.actions.indexOf(action) !== -1;

// ---------- 1. 正常运行不能乱动 ----------
{
  const r = decide({});
  record('1-正常', '正常时不做任何补救动作（' + JSON.stringify(r.actions) + '）',
    r.actions.length === 0, r);
  record('1-正常', '正常时健康状态是 ok', r.health === 'ok', r);
}

// ---------- 2. 离线识别页被关掉/没响应 ----------
{
  const r = decide({ engineState: 'missing' });
  record('2-识别页没了', '重建离屏页', has(r, 'recreate_offscreen'), r);
  record('2-识别页没了', '重启引擎', has(r, 'restart_engine'), r);
  record('2-识别页没了', '状态标记为正在恢复', r.health === 'recovering', r);

  const idle = decide({ engineState: 'idle' });
  record('2-识别页没了', '识别页在但引擎没跑：也要重建重启',
    has(idle, 'recreate_offscreen') && has(idle, 'restart_engine'), idle);
}

// ---------- 3. 帧数不涨 = 卡死/被冻结 ----------
{
  const first = decide({ engineFrames: 1000, lastFrames: 1000, stallCount: 0 });
  record('3-卡死检测', '第一轮只观察，不立刻重建（避免误判）',
    !has(first, 'recreate_offscreen'), first);
  record('3-卡死检测', '第一轮记为可疑', first.health === 'suspect', first);
  record('3-卡死检测', '卡死计数 +1', first.stallCount === 1, first);

  const second = decide({ engineFrames: 1000, lastFrames: 1000, stallCount: first.stallCount });
  record('3-卡死检测', '第二轮确认卡死 → 重建重启',
    has(second, 'recreate_offscreen') && has(second, 'restart_engine'), second);
  record('3-卡死检测', '重建后计数清零', second.stallCount === 0, second);
  record('3-卡死检测', '重建后帧数基准清零（新引擎从 0 开始，不能拿旧数字比出"卡死"）',
    second.lastFrames === 0, second);

  const recovered = decide({ engineFrames: 1200, lastFrames: 1000, stallCount: 1 });
  record('3-卡死检测', '帧数恢复增长 → 计数清零、不动作',
    recovered.stallCount === 0 && recovered.actions.length === 0, recovered);

  // 第一轮自检（还没有记录）不能误判成卡死
  const firstEver = decide({ engineFrames: 500, lastFrames: -1 });
  record('3-卡死检测', '第一次自检（没有历史记录）不判卡死',
    firstEver.actions.length === 0 && firstEver.lastFrames === 500, firstEver);

  // 引擎一直 0 帧（模型没加载起来 / 摄像头没出图）也要能发现
  const zeroFirst = decide({ engineFrames: 0, lastFrames: 0, stallCount: 0 });
  record('3-卡死检测', '一直 0 帧也算异常（模型/摄像头没起来）', zeroFirst.health === 'suspect', zeroFirst);
  const zeroSecond = decide({ engineFrames: 0, lastFrames: 0, stallCount: zeroFirst.stallCount });
  record('3-卡死检测', '连续 0 帧 → 重建重启',
    has(zeroSecond, 'recreate_offscreen') && has(zeroSecond, 'restart_engine'), zeroSecond);
}

// ---------- 4. 用手势关掉页面后：控制目标没了 ----------
{
  const r = decide({ targetTabOk: false });
  record('4-目标页没了', '重新指向活动标签页', has(r, 'repoint_tab'), r);
  record('4-目标页没了', '不因为目标页没了就重启整个引擎（浪费摄像头）',
    !has(r, 'recreate_offscreen'), r);
}

// ---------- 5. 页面脚本失效 ----------
{
  const r = decide({ pageScriptOk: false });
  record('5-页面脚本', '补注入 content.js', has(r, 'ensure_script'), r);
  record('5-页面脚本', '不重启引擎（引擎是好的）', !has(r, 'restart_engine'), r);

  const fail = HealthDecide.afterScriptInjectionFailed();
  record('5-页面脚本', '补注入失败 → 明确提示用户点图标', fail.health === 'need_click', fail);
}

// ---------- 6. 浏览器刚重启 ----------
{
  const r = decide({ sessionActive: false, engineState: 'missing' });
  record('6-浏览器重启', '不自动开摄像头（不重建不重启）',
    r.actions.length === 0, r);
  record('6-浏览器重启', '状态提示需要打开一次弹窗', r.health === 'need_popup', r);
}

// ---------- 7. 开关关着 ----------
{
  const r = decide({ controlOn: false, engineState: 'missing' });
  record('7-开关关闭', '关着就什么都不做', r.actions.length === 0 && r.health === 'off', r);
}

// ---------- 8. 反复恢复失败就别再折腾 ----------
{
  const r = decide({ engineState: 'missing', recoverFailures: HealthDecide.RECOVER_FAIL_LIMIT });
  record('8-反复失败', '连续多次没救回来 → 不再重建重启（别每分钟折腾一次）',
    r.actions.length === 0, r);
  record('8-反复失败', '状态标为 engine_failed，界面会提示查摄像头',
    r.health === 'engine_failed', r);

  const okAgain = decide({ recoverFailures: 0 });
  record('8-反复失败', '恢复正常后计数清零', okAgain.health === 'ok' && okAgain.actions.length === 0, okAgain);
}

// ---------- 9. 网址识别（决定补注入/跟随哪些站）----------
{
  const cases = [
    ['https://www.bilibili.com/video/BV1xx', true],
    ['https://bilibili.com/', true],
    ['https://www.youtube.com/watch?v=abc', true],
    ['https://m.youtube.com/watch', true],
    ['https://www.douyin.com/?recommend=1', true],
    ['https://v.qq.com/x/cover/abc.html', true],
    ['https://www.iqiyi.com/v_abc.html', true],
    ['https://v.youku.com/v_show/id_x.html', true],
    ['https://www.ixigua.com/123', true],
    ['https://www.mgtv.com/b/123/456.html', true],
    // 不能误判成视频站
    ['https://evil-bilibili.com.attacker.net/', false],
    ['https://notyoutube.com/', false],
    ['chrome://extensions', false],
    ['about:blank', false],
    ['', false],
    [null, false]
  ];
  for (const [url, expected] of cases) {
    const actual = HealthDecide.isControllableUrl(url);
    record('9-网址识别', (url || '(空)') + ' → ' + expected, actual === expected, { url, actual, expected });
  }
}

// ---------- 汇总 ----------
console.log('\n===== 自检决策自测 =====');
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
