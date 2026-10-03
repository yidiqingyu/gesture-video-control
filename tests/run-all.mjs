// ============================================================
// tests/run-all.mjs —— 一次跑完所有自测
//
// 跑法：node tests/run-all.mjs
// 全绿才算通过（任何一项失败都会让退出码变成 1）
// ============================================================

import './integration-check.mjs';
import './gesture-selftest.mjs';
import './engine-sim.mjs';

console.log('\n================ 全部自测结束 ================');
if (process.exitCode) {
  console.log('❌ 有测试未通过，先修好再提交');
} else {
  console.log('✅ 全部通过');
}
