/**
 * 手机端聊天功能「静态接线」校验
 *
 * 这类检查很便宜但极有效：把所有「引用了但不存在」的元素/函数/通道一次性抓出来，
 * 避免要跑到真机上才发现某个 id 拼错、某个 api 方法没暴露。
 *
 * 用法：node scripts/verify-chat-mobile.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ', name, extra === undefined ? '' : `= ${JSON.stringify(extra)}`); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : `= ${JSON.stringify(extra)}`); }
};
const section = (t) => console.log(`\n[${t}]`);

const html = read('mobile/index.html');
const app = read('mobile/src/ui/app.js');
const client = read('mobile/src/core/client.js');
const store = read('mobile/src/core/chat-store.js');
const css = read('mobile/src/ui/style.css');
const mjs = read('shared/protocol.mjs');

const idSet = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

// ── 1. app.js 里 $('xxx') 引用的元素必须在 index.html 里存在 ──
section('1. app.js 引用的 DOM id 全部存在');
{
  const refs = new Set();
  for (const m of app.matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
  const missing = [...refs].filter((id) => !idSet.has(id));
  ok('无悬空 id 引用', missing.length === 0, missing);
}

// ── 2. 聊天相关 id 齐备 ──
section('2. 聊天 UI 结构齐备');
{
  const need = [
    'mainSeg', 'pane-files', 'pane-chat',
    'chatTimeline', 'chatEmpty', 'chatInput', 'btnChatSend', 'btnChatAttach',
    'chatUnreadBadge', 'chatDayHint',
    'offerTrust', 'offerTrustWrap',
  ];
  const missing = need.filter((x) => !idSet.has(x));
  ok('聊天所需 id 全部存在', missing.length === 0, missing);
  ok('有 传输/聊天 分段切换', /class="seg-btn/.test(html) && html.includes('data-pane="chat"'));
  ok('composer 含 textarea 输入框', /<textarea[^>]*id="chatInput"/.test(html));
}

// ── 3. 聊天样式类都有定义 ──
section('3. 聊天样式类已定义');
{
  const need = [
    '.seg', '.seg-btn', '.seg-badge', '.pane',
    '.chat-timeline', '.chat-empty', '.chat-day',
    '.msg', '.msg.out', '.msg-avatar', '.msg-body',
    '.bubble', '.bubble.is-file', '.msg-meta',
    '.file-card', '.file-card-name', '.file-card-bar',
    '.chat-composer', '.chat-input', '.chat-send', '.chat-attach',
    '.offer-trust',
  ];
  const missing = need.filter((c) => !css.includes(c));
  ok('聊天样式类齐全', missing.length === 0, missing);
  // hidden 必须压过 display:flex/block
  ok('[hidden] 覆盖规则存在（badge/empty/bar）',
    css.includes('.seg-badge[hidden]') && css.includes('.chat-empty[hidden]') && css.includes('.file-card-bar[hidden]'));
}

// ── 4. client.js 暴露聊天 API ──
section('4. MobileClient 暴露聊天 API');
{
  ok('sendChat 已定义', /sendChat\s*\(/.test(client));
  ok('sendChatAck 已定义', /sendChatAck\s*\(/.test(client));
  ok('sendChatRead 已定义', /sendChatRead\s*\(/.test(client));
  ok('处理 CHAT_SEND', client.includes('P.MSG.CHAT_SEND'));
  ok('处理 CHAT_ACK', client.includes('P.MSG.CHAT_ACK'));
  ok('处理 CHAT_READ', client.includes('P.MSG.CHAT_READ'));
  ok('sendOffer 支持 chatId 透传', /opts\.chatId/.test(client) && /fields\.chatId/.test(client));
  ok('sendOffer 支持 origin 透传', /opts\.origin/.test(client) && /fields\.origin/.test(client));
}

// ── 5. app.js 订阅了 client 的聊天事件 ──
section('5. app.js 订阅聊天事件并处理');
{
  ok("监听 'chat'", client.includes("'chat'") && /addEventListener\('chat'/.test(app));
  ok("监听 'chat_ack'", /addEventListener\('chat_ack'/.test(app));
  ok("监听 'chat_read'", /addEventListener\('chat_read'/.test(app));
  ok('onChatMessage 已定义', /function onChatMessage\s*\(/.test(app));
  ok('onChatAck 已定义', /function onChatAck\s*\(/.test(app));
  ok('onChatRead 已定义', /function onChatRead\s*\(/.test(app));
}

// ── 6. app.js 调用的 client 方法都真实存在 ──
section('6. app.js 调用的 client 方法均已实现');
{
  const called = new Set([...app.matchAll(/state\.client\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const missing = [...called].filter((fn) => !new RegExp(`\\b${fn}\\s*\\(`).test(client));
  ok('无未实现的方法调用', missing.length === 0, missing);
}

// ── 7. chat-store 与电脑端语义对齐 ──
section('7. ChatStore 语义对齐（与 desktop/src/main/chat.js）');
{
  const need = [
    'openChat', 'append', 'list', 'updateStatus', 'markLocalRead', 'markPeerRead',
    'acceptSession', 'canAutoAccept', 'summary', 'totalUnread', 'clear', 'deleteChat',
  ];
  const missing = need.filter((fn) => !new RegExp(`\\b${fn}\\s*\\(`).test(store));
  ok('方法齐全', missing.length === 0, missing);
  ok('导出 ChatStore / DELIVERY / MESSAGES_PER_CHAT',
    /export class ChatStore/.test(store) && /export const DELIVERY/.test(store) && /export const MESSAGES_PER_CHAT/.test(store));
  ok('append 后不重置 _messages 缓存（防丢消息回归）',
    /if \(!this\._messages\.has\(peerId\)\) this\._messages\.set\(peerId, \[\]\)/.test(store));
  ok('DELIVERY 含 pending/sent/delivered/read/failed',
    ['pending', 'sent', 'delivered', 'read', 'failed'].every((k) => store.includes(`'${k}'`)));
}

// ── 8. 协议层导出可用 ──
section('8. shared/protocol.mjs 导出聊天能力');
{
  ['CHAT_SEND', 'CHAT_ACK', 'CHAT_READ', 'CHAT_TEXT_MAX', 'CHAT_SILENT_MAX_BYTES',
    'CHAT_SILENT_MAX_FILES', 'makeChatId', 'makeMsgId'].forEach((k) => {
    ok(`导出 ${k}`, new RegExp(`\\b${k}\\b`).test(mjs));
  });
}

// ── 9. 静默接收策略两端一致 ──
section('9. 静默接收授权链路');
{
  ok('acceptOffer 读取信任勾选', /\$\('offerTrust'\)/.test(app));
  ok('勾选后调用 acceptSession', /chatStore\.acceptSession\(/.test(app));
  ok('canAutoAccept 受文件数/字节阈值约束',
    /maxFiles/.test(store) && /maxBytes/.test(store));
}

console.log('\n──────────────────────────────');
console.log(`  通过 ${pass} · 失败 ${fail}`);
console.log('──────────────────────────────\n');
process.exit(fail ? 1 : 0);
