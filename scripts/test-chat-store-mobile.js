/**
 * 手机端 ChatStore 单元测试（Node 环境，用最小 localStorage 垫片）
 *
 * 用法：node scripts/test-chat-store-mobile.js
 *
 * 手机端 ChatStore 用 ESM + localStorage，这里：
 *   · 用一个简单的内存 localStorage 垫片替代浏览器实现；
 *   · 用 query-string 把 ESM 直接 import 进来。
 * 目的与 desktop 版一致：保证「消息模型的语义」在两端不走样。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ok  ', n, e === undefined ? '' : `= ${JSON.stringify(e)}`); }
  else { fail++; console.log('  FAIL', n, e === undefined ? '' : `= ${JSON.stringify(e)}`); }
};
const section = (t) => console.log(`\n[${t}]`);

// ── localStorage 垫片 ──
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
  clear: () => _store.clear(),
  get length() { return _store.size; },
  key: (i) => [..._store.keys()][i],
};
globalThis.window = globalThis.window || {};

(async () => {
  // chat-store.js 依赖 localStorage 与 protocol（只用常量）
  const mod = await import(pathToFileURL(path.join(ROOT, 'mobile/src/core/chat-store.js')).href);
  const { ChatStore, DELIVERY, MESSAGES_PER_CHAT } = mod;

  const A = 'desktop-abc123';
  const B = 'mobile-xyz789';

  section('1. 会话创建与持久化');
  {
    const s = new ChatStore();
    const c = s.openChat({ deviceId: A, name: '办公室电脑', type: 'desktop' });
    ok('会话已创建', !!c && c.peerId === A);
    ok('chatId 前缀正确', c.chatId === 'c_desktop-abc123', c.chatId);
    ok('默认未读为 0', c.unread === 0);
    ok('默认不静默接收', c.autoAccept === false);
    // 重新加载（同一份 localStorage）
    const s2 = new ChatStore();
    ok('重启后会话仍在', !!s2.get(A));
    ok('重启后展示名保留', s2.get(A).peer.name === '办公室电脑');
  }

  section('2. 追加消息与去重');
  {
    localStorage.clear();
    const s = new ChatStore();
    s.openChat({ deviceId: A, name: '电脑' });
    const r1 = s.append(A, { msgId: 'm1', dir: 'out', kind: 'text', text: '你好', ts: 1000 });
    ok('首次追加不重复', r1.duplicate === false);
    const r2 = s.append(A, { msgId: 'm1', dir: 'out', kind: 'text', text: '你好', ts: 1000 });
    ok('同 msgId 判为重复', r2.duplicate === true);
    ok('重复不增加条数', s.list(A).messages.length === 1);
    ok('append 后能立刻读到（缓存未被清空）', s.list(A).messages.length === 1, s.list(A).messages.length);
  }

  section('3. 进度 / 完成态字段不丢失（回归）');
  {
    localStorage.clear();
    const s = new ChatStore();
    s.openChat({ deviceId: A, name: '电脑' });
    s.append(A, {
      msgId: 'f1', dir: 'out', kind: 'file', ts: 2000,
      progress: 0.62, done: false, transferId: 't_1',
      attachment: { totalBytes: 1000, files: [{ fileId: 'x', name: 'a.zip', size: 1000 }] },
    });
    const m1 = s.list(A).messages[0];
    ok('append 保留 progress', m1.progress === 0.62, m1.progress);
    ok('append 保留 done', m1.done === false, m1.done);
    ok('append 保留 transferId', m1.transferId === 't_1', m1.transferId);
    // 重载后仍在
    const s2 = new ChatStore();
    const m2 = s2.list(A).messages[0];
    ok('重载后 progress 仍在', m2.progress === 0.62, m2.progress);
    ok('重载后 transferId 仍在', m2.transferId === 't_1', m2.transferId);
    // updateStatus 标记完成
    s2.updateStatus(A, 'f1', { done: true, progress: 1 });
    const s3 = new ChatStore();
    ok('完成后 done 落盘', s3.list(A).messages[0].done === true);
  }

  section('4. 入站消息与未读');
  {
    localStorage.clear();
    const s = new ChatStore();
    s.append(A, { msgId: 'i1', dir: 'in', kind: 'text', text: '在吗', ts: 100 });
    s.append(A, { msgId: 'i2', dir: 'in', kind: 'text', text: '在吗2', ts: 200 });
    s.append(A, { msgId: 'o1', dir: 'out', kind: 'text', text: '在', ts: 300 });
    ok('未读 = 2', s.get(A).unread === 2, s.get(A).unread);
    ok('出站不计未读', s.get(A).unread === 2);
    ok('总未读 = 2', s.totalUnread() === 2);
    s.append(A, { msgId: 'i3', dir: 'in', kind: 'text', text: '静默', ts: 400, silent: true });
    ok('silent 入站不计未读', s.get(A).unread === 2, s.get(A).unread);
  }

  section('5. 本地已读清零 + 位点');
  {
    const s = new ChatStore();
    ok('markLocalRead 前有未读', s.get(A).unread === 2);
    const r = s.markLocalRead(A);
    // 位点取「最后一条入站消息」——包含 silent 的那条（i3, ts=400）。
    // 即使不提示未读，只要用户打开了会话，这条也确实被看到了。
    ok('markLocalRead 返回位点', r.ok === true && r.upToTs === 400, r.upToTs);
    ok('未读已清零', s.get(A).unread === 0);
    ok('记录 readUpToId', s.get(A).readUpToId === 'i3', s.get(A).readUpToId);
  }

  section('6. 对端已读回执');
  {
    const s = new ChatStore();
    s.markPeerRead(A, 300);
    const msgs = s.list(A).messages;
    ok('out 消息标为 read', msgs.filter((m) => m.dir === 'out').every((m) => m.status === DELIVERY.READ),
      msgs.filter((m) => m.dir === 'out').map((m) => m.status));
    ok('in 消息不受影响', msgs.filter((m) => m.dir === 'in').every((m) => m.status === 'received'));
  }

  section('7. 分页');
  {
    localStorage.clear();
    const s = new ChatStore();
    for (let i = 0; i < 30; i++) s.append(A, { msgId: `p${i}`, dir: 'out', kind: 'text', text: `第 ${i} 条`, ts: i });
    const page1 = s.list(A, { limit: 10 });
    ok('默认取最新 10 条', page1.messages.length === 10, page1.messages.length);
    ok('最新一条是 p29', page1.messages[9].msgId === 'p29');
    ok('hasMore 为真', page1.hasMore === true);
    const page2 = s.list(A, { before: page1.messages[0].msgId, limit: 10 });
    ok('上一页结束于 p19', page2.messages[9].msgId === 'p19', page2.messages[9].msgId);
  }

  section('8. 静默接收授权（阈值）');
  {
    localStorage.clear();
    const s = new ChatStore();
    s.openChat({ deviceId: A, name: '电脑' });
    ok('未授权时不能静默', s.canAutoAccept(A, { files: [1], totalBytes: 100 }) === false);
    s.acceptSession(A);
    ok('授权后可以静默', s.canAutoAccept(A, { files: [1], totalBytes: 100 }) === true);
    ok('超过文件数阈值 → 拒绝', s.canAutoAccept(A, { files: new Array(21).fill(1), totalBytes: 100 }) === false);
    ok('超过字节阈值 → 拒绝', s.canAutoAccept(A, { files: [1], totalBytes: 501 * 1024 * 1024 }) === false);
    ok('阈值边界内 → 允许', s.canAutoAccept(A, { files: new Array(20).fill(1), totalBytes: 500 * 1024 * 1024 }) === true);
  }

  section('9. 清空与删除');
  {
    localStorage.clear();
    const s = new ChatStore();
    s.append(A, { msgId: 'c1', dir: 'in', kind: 'text', text: 'x', ts: 1 });
    s.append(A, { msgId: 'c2', dir: 'out', kind: 'text', text: 'y', ts: 2 });
    ok('清空前有 2 条', s.list(A).messages.length === 2);
    s.clear(A);
    ok('清空后 0 条', s.list(A).messages.length === 0);
    ok('清空后未读归零', s.get(A).unread === 0);
    s.append(A, { msgId: 'c3', dir: 'in', kind: 'text', text: 'z', ts: 3 });
    s.deleteChat(A);
    ok('删除后会话不存在', s.get(A) === null);
    ok('删除后消息文件已移除', localStorage.getItem('ltp_chat_msgs_' + A) === null);
  }

  section('10. 超限裁剪 + 损坏数据容错');
  {
    localStorage.clear();
    const s = new ChatStore();
    for (let i = 0; i < MESSAGES_PER_CHAT + 50; i++) {
      s.append(A, { msgId: `x${i}`, dir: 'out', kind: 'text', text: 't', ts: i });
    }
    ok(`上限裁剪到 ${MESSAGES_PER_CHAT}`, s.list(A, { limit: 99999 }).messages.length === MESSAGES_PER_CHAT,
      s.list(A, { limit: 99999 }).messages.length);
    ok('保留的是最新的', s.list(A, { limit: 1 }).messages[0].msgId === `x${MESSAGES_PER_CHAT + 49}`);

    // 索引损坏
    localStorage.setItem('ltp_chat_index', '{ 这不是 JSON');
    const s2 = new ChatStore();
    ok('索引损坏时降级为空而非抛错', s2.chats.size === 0);
    // 消息损坏
    localStorage.setItem('ltp_chat_msgs_corrupt', ']]]broken');
    const s3 = new ChatStore();
    ok('消息损坏时返回空数组', s3.list('corrupt').messages.length === 0);
  }

  console.log('\n──────────────────────────────');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log('──────────────────────────────\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常：', e);
  process.exit(1);
});
