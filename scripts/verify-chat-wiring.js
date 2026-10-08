/**
 * 静态接线检查：app.js 里 $('id') / getElementById('id') 引用的 id
 * 必须在 index.html 中存在（这类「引用了不存在的元素」是致命 bug，
 * 却往往要等到运行时点击才暴露）。
 *
 * 用法：node scripts/verify-chat-wiring.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'desktop', 'src', 'renderer', 'index.html');
const JS = path.join(ROOT, 'desktop', 'src', 'renderer', 'app.js');

const html = fs.readFileSync(HTML, 'utf8');
const js = fs.readFileSync(JS, 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

const preload = fs.readFileSync(path.join(ROOT, 'desktop', 'src', 'preload', 'preload.js'), 'utf8');
const exposed = [...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
const usedApi = new Set([...js.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]));

const proto = require('../shared/protocol.js');
const serverSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'src', 'main', 'server.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'src', 'main', 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ok  ', n, e === undefined ? '' : `= ${JSON.stringify(e)}`); } else { fail++; console.log('  FAIL', n, e === undefined ? '' : `= ${JSON.stringify(e)}`); } };
const section = (t) => console.log(`\n[${t}]`);

section('1. index.html 的 id 引用完整性');
const missing = [...jsIds].filter((id) => !htmlIds.has(id));
ok('app.js 引用的 id 全部存在于 HTML', missing.length === 0, missing);

section('2. 聊天相关 id 已定义');
['chatBadge', 'chatList', 'chatListEmpty', 'chatOnlineList', 'chatHead', 'chatPeerName',
  'chatPeerMeta', 'chatEmpty', 'chatTimeline', 'chatDropMask', 'chatComposer',
  'chatInput', 'btnChatSend', 'btnChatAttach', 'btnNewChat', 'btnChatClear']
  .forEach((id) => ok(`#${id}`, htmlIds.has(id)));

section('3. 聊天导航项存在');
ok('导航 data-tab="chat"', /data-tab="chat"/.test(html));
ok('聊天 tab 区块 #tab-chat', htmlIds.has('tab-chat'));

section('4. preload 暴露的 API 都被 app.js 用到的已实现');
const missingApi = [...usedApi].filter((k) => !exposed.includes(k));
ok('app.js 调用的 api.* 均在 preload 中暴露', missingApi.length === 0, missingApi);

section('5. IPC 通道配对（preload invoke ↔ main handle）');
const ipcUsed = [...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
const ipcHandled = new Set([...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
const ipcMissing = [...new Set(ipcUsed)].filter((c) => !ipcHandled.has(c));
ok('所有 invoke 通道都有对应 handler', ipcMissing.length === 0, ipcMissing);

section('6. 聊天协议消息类型已接入 server.js');
ok('处理 CHAT_SEND', serverSrc.includes('P.MSG.CHAT_SEND'));
ok('处理 CHAT_ACK', serverSrc.includes('P.MSG.CHAT_ACK'));
ok('处理 CHAT_READ', serverSrc.includes('P.MSG.CHAT_READ'));
ok('send_offer 带 origin/chatId', serverSrc.includes('origin: opts.origin'));
ok('offer:auto 事件已转发', serverSrc.includes("'offer:auto'"));

section('7. main.js 聊天事件转发');
['chat:message', 'chat:delivered', 'chat:read'].forEach((ev) =>
  ok(`转发 ${ev}`, mainSrc.includes(`'${ev}'`)));

section('8. 协议新增导出');
ok('MSG.CHAT_SEND', proto.MSG.CHAT_SEND === 'chat_send');
ok('makeChatId', typeof proto.makeChatId === 'function');
ok('makeMsgId', typeof proto.makeMsgId === 'function');
ok('CHAT_TEXT_MAX', proto.CHAT_TEXT_MAX === 4000, proto.CHAT_TEXT_MAX);

section('9. mjs 同步（手机端也拿到新导出）');
const mjs = fs.readFileSync(path.join(ROOT, 'shared', 'protocol.mjs'), 'utf8');
ok('mjs 有 CHAT_SEND', mjs.includes("CHAT_SEND: 'chat_send'"));
ok('mjs 有 makeChatId', mjs.includes('function makeChatId'));
ok('mjs 有 makeMsgId', mjs.includes('function makeMsgId'));

section('10. CSS 关键类已定义');
const css = fs.readFileSync(path.join(ROOT, 'desktop', 'src', 'renderer', 'style.css'), 'utf8');
['.chat-shell', '.chat-side', '.chat-timeline', '.msg', '.bubble', '.file-card',
  '.chat-composer', '.chat-dropmask', '.nav-badge', '.chat-item-unread']
  .forEach((sel) => ok(sel, css.includes(sel + ' ') || css.includes(sel + '{') || css.includes(sel + ',')));

console.log('\n──────────────────────────────');
console.log(`  通过 ${pass} · 失败 ${fail}`);
console.log('──────────────────────────────\n');
process.exit(fail ? 1 : 0);
