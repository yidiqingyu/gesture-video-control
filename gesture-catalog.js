// ============================================================
// gesture-catalog.js —— 手势对照表（数据 + 渲染，弹窗和悬浮面板共用）
//
// 以前这张表只存在于 README 里，用户得跳出浏览器去看。现在插件内可点开查看。
// 数据和渲染都放在这一个文件里，弹窗（popup）和页面内悬浮面板（content.js）
// 都从这里取 —— 改一处两边都对，不会出现"改了 README 忘了插件"的情况。
//
// 用法：
//   GestureCatalog.toHTML()   → 一段 HTML 字符串（分组的手势列表 + 小贴士）
//   GestureCatalog.css()      → 配套样式（弹窗塞进 <style>，面板塞进 Shadow DOM）
//
// 注意：这里的文案是写死的常量，没有用户输入，但渲染时仍然做了转义，
//      免得以后有人往里面塞动态内容时忘了转义。
// ============================================================

'use strict';

const GestureCatalog = (() => {
  // ---------- 手势数据 ----------
  // action = 这个手势干什么；note = 触发条件 / 注意事项
  const groups = [
    {
      title: '播放控制',
      items: [
        {
          emoji: '👌',
          name: 'OK（拇指 + 食指捏成圈）',
          action: '播放 / 暂停',
          note: '捏合瞬间触发一次（防抖 0.9 秒），捏住不放不会重复触发'
        },
        {
          emoji: '👍',
          name: '竖大拇指',
          action: '给视频点赞',
          note: '拇指要朝上（倒过来不算）；保持一下触发一次'
        },
        {
          emoji: '👍👍',
          name: '双手同时竖大拇指',
          action: '一键三连（B 站）',
          note: '两只手都竖起大拇指；其它站点退化为点赞'
        }
      ]
    },
    {
      title: '音量（单个小拇指）',
      items: [
        {
          emoji: '🤙',
          name: '小拇指向上',
          action: '音量 +10%',
          note: '保持姿势可连续调高（约 0.65 秒一次）'
        },
        {
          emoji: '🤙',
          name: '小拇指向下',
          action: '音量 -10%',
          note: '保持姿势可连续调低'
        }
      ]
    },
    {
      title: '切视频（单个食指）',
      items: [
        {
          emoji: '☝️',
          name: '食指向上',
          action: '长视频：上一集',
          note: '短视频模式下改为按 ↑ 键切上一个视频'
        },
        {
          emoji: '👇',
          name: '食指向下',
          action: '长视频：下一集',
          note: '短视频模式下改为按 ↓ 键切下一个视频'
        }
      ]
    },
    {
      title: '模式与锁定',
      items: [
        {
          emoji: '🖐️',
          name: '手掌张开，保持 2 秒',
          action: '切换长 / 短视频模式',
          note: '切换一次后要松手重新比，才会切下一次'
        },
        {
          emoji: '6️⃣6️⃣6️⃣',
          name: '666（拇指 + 小指伸直）',
          action: '锁定 / 解锁所有手势',
          note: '保持 1.5 秒锁定，期间任何手势都不操作页面；再保持 1.5 秒解锁'
        }
      ]
    },
    {
      title: 'B 站专属',
      items: [
        {
          emoji: '🤟',
          name: '摇滚（拇指 + 食指 + 小指）',
          action: '点首页「换一换」',
          note: '刷新推荐流，仅 B 站首页有效'
        },
        {
          emoji: '🤞',
          name: '双手食指交叉',
          action: '关闭当前页面',
          note: '两只手的食指都伸直并交叉（或指尖相触）'
        },
        {
          emoji: '1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣',
          name: '数字手势 1~6',
          action: '选第 N 个视频',
          note: '仅 B 站首页有效，对应「换一换」旁 6 个视频：1 2 3 / 4 5 6'
        }
      ]
    }
  ];

  // ---------- 识别小贴士 ----------
  const tips = [
    '手指要基本竖直：和竖直方向夹角超过 55° 会被判为「方向不明」而不动作（宁可不动，也不会把向上猜成向下）',
    '手势要稳住约 0.17 秒才会触发（多帧投票 + 稳定确认），这样才不会误触',
    '手掌正对镜头，距离 40~80cm，光线充足，整只手入镜',
    '数字 4 和手掌张开只差拇指：拇指收进掌心 = 4，完全张开 = 5；半伸时不会动作',
    '画面里出现两只手时，扩展会锁定「更靠画面中间、离镜头更近」的那只手，不会两只手乱抢'
  ];

  // ---------- 渲染 ----------
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toHTML() {
    const parts = [];
    for (const group of groups) {
      parts.push('<div class="gh-group">');
      parts.push('<div class="gh-group-title">' + esc(group.title) + '</div>');
      for (const item of group.items) {
        parts.push(
          '<div class="gh-item">' +
            '<span class="gh-emoji">' + esc(item.emoji) + '</span>' +
            '<div class="gh-info">' +
              '<div class="gh-name">' + esc(item.name) + '</div>' +
              '<div class="gh-act">' + esc(item.action) + '</div>' +
              '<div class="gh-note">' + esc(item.note) + '</div>' +
            '</div>' +
          '</div>'
        );
      }
      parts.push('</div>');
    }
    parts.push('<div class="gh-tips">');
    parts.push('<div class="gh-group-title">识别小贴士</div>');
    parts.push('<ul>');
    for (const tip of tips) parts.push('<li>' + esc(tip) + '</li>');
    parts.push('</ul></div>');
    return parts.join('');
  }

  function css() {
    return `
      .gh-group { margin-bottom: 12px; }
      .gh-group-title {
        display: flex; align-items: center; gap: 8px;
        margin: 10px 0 7px;
        font-size: 10.5px; font-weight: 700; letter-spacing: .16em;
        color: var(--gvc-text-mute, #66738A);
      }
      /* 标题右侧一条渐隐细线，分组看得更清楚 */
      .gh-group-title::after {
        content: ''; flex: 1; height: 1px;
        background-image: linear-gradient(90deg, var(--gvc-line-strong, rgba(255, 255, 255, .14)), transparent);
      }
      .gh-item {
        display: flex; align-items: flex-start; gap: 9px;
        padding: 7px 9px; margin-bottom: 5px;
        background: var(--gvc-surface-hi, #1B232E);
        border: 1px solid var(--gvc-line, rgba(255, 255, 255, .07));
        border-radius: var(--gvc-radius-sm, 9px);
      }
      /* 手势图标坐在一个圆角小方块里，比裸 emoji 整齐。
         底色用 surface：深色下比行底色更深、浅色下更亮，两种主题都能看出"一块芯片" */
      .gh-emoji {
        flex: none; display: grid; place-items: center;
        width: 26px; height: 26px;
        font-size: 15px; line-height: 1;
        background: var(--gvc-surface, #141A22);
        border: 1px solid var(--gvc-line, rgba(255, 255, 255, .07));
        border-radius: var(--gvc-radius-xs, 6px);
      }
      .gh-info { flex: 1; min-width: 0; }
      .gh-name { font-size: 12px; font-weight: 600; line-height: 1.4; }
      .gh-act { font-size: 12px; line-height: 1.4; color: var(--gvc-accent, #4F8BFF); }
      .gh-note { margin-top: 2px; font-size: 11px; line-height: 1.5; color: var(--gvc-text-mute, #66738A); }
      .gh-tips {
        margin-top: 12px; padding-top: 10px;
        border-top: 1px solid var(--gvc-line, rgba(255, 255, 255, .07));
      }
      .gh-tips ul { margin: 0; padding-left: 16px; }
      .gh-tips li { margin-bottom: 4px; font-size: 11px; line-height: 1.65; color: var(--gvc-text-dim, #8E9CB0); }
      .gh-tips li::marker { color: var(--gvc-accent, #4F8BFF); }
    `;
  }

  return { groups, tips, toHTML, css };
})();

// 挂到全局：popup.js / content.js 都从这里取
globalThis.GestureCatalog = GestureCatalog;
