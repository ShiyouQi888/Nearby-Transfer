/**
 * ChatStore 独立测试（不依赖 Electron）
 * 用法：node scripts/test-chat-store.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatStore, DELIVERY } = require('../desktop/src/main/chat.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok ', name, extra === undefined ? '' : `= ${JSON.stringify(extra)}`); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : `= ${JSON.stringify(extra)}`); }
}
function section(t) { console.log(`\n[${t}]`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ltp-chat-'));

(async () => {
  section('1. 会话创建与持久化');
  const store = new ChatStore({ dir: tmp });
  const chat = store.openChat({ deviceId: 'pc-a1b2c3', name: '办公室电脑', type: 'desktop' });
  ok('chatId 派生正确', chat.chatId === 'c_pc-a1b2c3', chat.chatId);
  ok('索引文件已写入', fs.existsSync(path.join(tmp, 'chats.json')));
  ok('会话消息目录已建', fs.existsSync(path.join(tmp, 'chats')));

  section('2. 追加消息与去重');
  const a = store.append('pc-a1b2c3', { msgId: 'm_1', dir: 'out', kind: 'text', text: '你好', ts: 1000 });
  ok('首条非重复', a.duplicate === false);
  ok('状态默认 sent', a.message.status === DELIVERY.SENT, a.message.status);
  const dup = store.append('pc-a1b2c3', { msgId: 'm_1', dir: 'out', kind: 'text', text: '你好', ts: 1000 });
  ok('同 msgId 判重', dup.duplicate === true);
  ok('去重后仍只有 1 条', store.list('pc-a1b2c3').messages.length === 1);

  section('3. 入站消息与未读');
  store.append('pc-a1b2c3', { msgId: 'm_2', dir: 'in', kind: 'text', text: '在的', ts: 2000 });
  store.append('pc-a1b2c3', { msgId: 'm_3', dir: 'in', kind: 'text', text: '照片发我', ts: 3000 });
  ok('未读数 = 2', store.get('pc-a1b2c3').unread === 2, store.get('pc-a1b2c3').unread);
  ok('汇总未读 = 2', store.totalUnread() === 2);

  section('4. 本地已读清零');
  const r = store.markLocalRead('pc-a1b2c3');
  ok('已读返回 ok', r.ok === true);
  ok('已读位点 = 3000', r.upToTs === 3000, r.upToTs);
  ok('未读清零', store.get('pc-a1b2c3').unread === 0);

  section('5. 对端已读回执');
  const mr = store.markPeerRead('pc-a1b2c3', 5000);
  ok('有变更', mr.ok === true);
  ok('出站消息变 read', store.list('pc-a1b2c3').messages.find((m) => m.msgId === 'm_1').status === DELIVERY.READ);

  section('6. 分页');
  for (let i = 100; i < 120; i++) {
    store.append('pc-a1b2c3', { msgId: `m_p${i}`, dir: 'in', kind: 'text', text: `第${i}条`, ts: i, silent: true });
  }
  const page1 = store.list('pc-a1b2c3', { limit: 5 });
  ok('limit=5 返回 5 条', page1.messages.length === 5, page1.messages.length);
  ok('hasMore = true', page1.hasMore === true);
  const page2 = store.list('pc-a1b2c3', { before: page1.messages[0].msgId, limit: 5 });
  ok('翻页无重叠', page2.messages[page2.messages.length - 1].msgId !== page1.messages[0].msgId);

  section('7. 文件消息 / 静默接收授权');
  ok('初始不可自动接收', store.canAutoAccept('pc-a1b2c3', { files: [{}] }) === false);
  store.acceptSession('pc-a1b2c3');
  ok('接受后小文件可自动', store.canAutoAccept('pc-a1b2c3', { files: [{}], totalBytes: 1024 }) === true);
  ok('超量仍需确认', store.canAutoAccept('pc-a1b2c3', { files: new Array(30).fill({}), totalBytes: 0 }) === false);
  ok('超大仍需确认', store.canAutoAccept('pc-a1b2c3', { files: [{}], totalBytes: 600 * 1024 * 1024 }) === false);
  store.append('pc-a1b2c3', {
    msgId: 'm_file1', dir: 'out', kind: 'file', ts: 9000,
    attachment: { transferId: 't_1', files: [{ fileId: 'f_1', name: 'IMG.jpg', size: 1024 }], totalBytes: 1024 },
  });
  const fm = store.list('pc-a1b2c3').messages.find((m) => m.msgId === 'm_file1');
  ok('文件消息 kind', fm.kind === 'file');
  ok('附件保留', fm.attachment.files[0].name === 'IMG.jpg');
  ok('摘要带文件名', store.get('pc-a1b2c3').lastMessage.fileName === 'IMG.jpg');

  section('7b. 附件进度 / 完成态字段不丢失（回归）');
  {
    store.append('pc-a1b2c3', {
      msgId: 'm_file2', dir: 'out', kind: 'file', ts: 9100,
      progress: 0.62, done: false, transferId: 't_2', silent: false,
      attachment: { totalBytes: 2048, files: [{ fileId: 'f_2', name: 'BIG.zip', size: 2048 }] },
    });
    const f2 = store.list('pc-a1b2c3').messages.find((m) => m.msgId === 'm_file2');
    ok('append 保留 progress', f2.progress === 0.62, f2.progress);
    ok('append 保留 done', f2.done === false, f2.done);
    ok('append 保留 transferId', f2.transferId === 't_2', f2.transferId);
    // 重启后仍在（这一条正是之前的回归点：字段被 append 白名单丢掉）
    const s2 = new ChatStore({ dir: tmp });
    const f2b = s2.list('pc-a1b2c3').messages.find((m) => m.msgId === 'm_file2');
    ok('重载后 progress 仍在', f2b && f2b.progress === 0.62, f2b && f2b.progress);
    ok('重载后 transferId 仍在', f2b && f2b.transferId === 't_2', f2b && f2b.transferId);
    s2.updateStatus('pc-a1b2c3', 'm_file2', { done: true, progress: 1 });
    const s3 = new ChatStore({ dir: tmp });
    ok('完成后 done 落盘', s3.list('pc-a1b2c3').messages.find((m) => m.msgId === 'm_file2').done === true);
  }

  section('8. 重启后数据仍在（持久化）');
  const store2 = new ChatStore({ dir: tmp });
  ok('会话恢复', !!store2.get('pc-a1b2c3'));
  ok('消息恢复', store2.list('pc-a1b2c3', { limit: 1000 }).messages.length === store.list('pc-a1b2c3', { limit: 1000 }).messages.length);
  // 注意：§7b 又追加了 m_file2(BIG.zip)，所以最新摘要应指向它
  ok('lastMessage 恢复', store2.get('pc-a1b2c3').lastMessage.fileName === 'BIG.zip');

  section('9. 损坏文件容错');
  fs.writeFileSync(path.join(tmp, 'chats.json'), '{ this is not json', 'utf8');
  let crashed = false;
  try { new ChatStore({ dir: tmp }); } catch (_) { crashed = true; }
  ok('损坏不抛异常', crashed === false);

  section('10. 清空与删除');
  const store3 = new ChatStore({ dir: tmp });
  store3.openChat({ deviceId: 'x-1', name: 'X' });
  store3.append('x-1', { msgId: 'mx1', dir: 'in', kind: 'text', text: 'hi', silent: true });
  ok('清空后消息为 0', store3.clear('x-1').ok && store3.list('x-1').messages.length === 0);
  ok('删除会话成功', store3.deleteChat('x-1').ok === true && !store3.get('x-1'));

  console.log('\n──────────────────────────────');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log('──────────────────────────────\n');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
