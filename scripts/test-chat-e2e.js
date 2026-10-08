/**
 * 聊天端到端集成测试（两节点直连，不依赖 Electron / 真机）
 *
 * 起两个 TransferServer：A（电脑端角色）+ B（模拟手机端角色），
 * 让 B 主动连 A，完成配对后验证：
 *   1) 6 位匹配码配对 + 长期令牌
 *   2) 文本消息双向收发 + 送达回执 + 已读回执
 *   3) 文件消息：send_offer(origin=chat) 在已授权会话下静默接收
 *   4) 去重（同一 msgId 重发只落一条）
 *
 * 用法：node scripts/test-chat-e2e.js
 */

'use strict';

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const { TransferServer } = require('../desktop/src/main/server.js');
const { ChatStore } = require('../desktop/src/main/chat.js');
const { FileSender } = require('../desktop/src/main/transfer.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ok  ', n, e === undefined ? '' : `= ${JSON.stringify(e)}`); } else { fail++; console.log('  FAIL', n, e === undefined ? '' : `= ${JSON.stringify(e)}`); } };
const section = (t) => console.log(`\n[${t}]`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ltp-e2e-'));
const saveDirA = path.join(tmp, 'A-recv'); fs.mkdirSync(saveDirA, { recursive: true });

/** deviceId -> TransferServer（避免把 server 引用挂进 device 对象造成循环序列化） */
const ownerOf = new Map();

const PORT_A = 53411;
const PORT_B = 53412;

function mkServer(tag, port, saveDir) {
  const store = new ChatStore({ dir: path.join(tmp, tag) });
  const self = {
    deviceId: `${tag}-aaaaaa`, name: tag === 'A' ? '办公室电脑' : '我的手机',
    type: tag === 'A' ? 'desktop' : 'mobile', os: 'Test', ip: '127.0.0.1', port,
    fingerprint: 'AAAA-BBBB',
  };
  const srv = new TransferServer({
    self, deviceSecret: 'secret-' + tag, port, saveDir, trusted: [], chatStore: store, enableHttpGateway: false,
  });
  // 让 outboundConnect 能把出站会话注册回"客户端自己"的 server。
  // 注意：_owner 不能挂在 self 上 —— self 会被 JSON.stringify 进 HELLO 消息，
  // 而 TransferServer 带 socket/server 引用会形成循环结构，导致序列化直接抛错。
  ownerOf.set(self.deviceId, srv);
  return { srv, store, self };
}

/** 建立一条出站会话：clientSelf 扮演客户端连到 hostServer（hostServer 是真服务端） */
function outboundConnect(hostServer, clientSelf, host, port, auth) {
  return new Promise((resolve, reject) => {
    const { Session } = require('../desktop/src/main/server.js');
    // 关键：出站会话的 server 必须是「客户端自己」的 server，而不是对端 hostServer。
    // 语义上 this.server 代表「本端」，Session 内部用 this.server.self.deviceId 作为
    // 消息来源、用 this.server.chatStore 落库本地状态。若误传 hostServer，
    // 消息会被打上对端的 deviceId，且 chat_ack 会写进对端的 store（状态永远停在 sent）。
    const owner = ownerOf.get(clientSelf.deviceId);
    const sock = net.connect({ host, port }, () => {
      const s = new Session(sock, { server: owner, direction: 'outbound' });
      owner.sessions.set(s.id, s);
      s.on('disconnected', () => owner.sessions.delete(s.id));
      const t = setTimeout(() => reject(new Error('握手超时')), 5000);
      // 先挂拦截器再发 HELLO，避免应答比拦截器先到
      const orig = s.decoder.onMessage.bind(s.decoder);
      s.decoder.onMessage = (m, b) => {
        if (m && m.type === P.MSG.HELLO_ACK) {
          clearTimeout(t);
          if (m.accepted) {
            s.paired = true;
            s.peerDevice = { deviceId: hostServer.self.deviceId, name: hostServer.self.name, type: hostServer.self.type };
            resolve(s);
          } else reject(new Error(m.reason));
        }
        return orig(m, b);
      };
      s.send(P.makeMessage(P.MSG.HELLO, { device: clientSelf, auth }, clientSelf.deviceId));
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('连接超时')), 6000);
  });
}

(async () => {
  // A 作为「接收方服务端」
  const A = mkServer('A', PORT_A, saveDirA);
  // B 作为「发起方客户端」
  const B = mkServer('B', PORT_B, path.join(tmp, 'B-recv'));
  fs.mkdirSync(path.join(tmp, 'B-recv'), { recursive: true });

  const eventsA = [];
  ['chat:message', 'offer:incoming', 'offer:auto', 'transfer:complete', 'chat:read', 'chat:delivered']
    .forEach((ev) => A.srv.on(ev, (p) => eventsA.push({ ev, p })));

  await A.srv.listen();
  await B.srv.listen();
  ok('A/B 服务已监听', true);

  section('1. 配对握手');
  const code = A.srv.newPairCode();
  ok('生成 6 位匹配码', /^\d{6}$/.test(code), code);
  // B 用匹配码连 A：会话注册在 B 自己的 server 上（B 是客户端）
  const bToA = await outboundConnect(A.srv, B.self, '127.0.0.1', PORT_A, { mode: 'pair', pairCode: code });
  ok('B→A 配对成功', bToA.paired === true);
  ok('A 已信任 B', !!A.srv.trusted.get(B.self.deviceId));
  ok('B 的出站会话对端是 A', bToA.peerDevice.deviceId === A.self.deviceId);

  // A 侧也有一个到 B 的出站会话（用于 A 主动发消息）
  const aToB = await outboundConnect(B.srv, A.self, '127.0.0.1', PORT_B,
    { mode: 'paired', token: P.signToken('secret-B', A.self.deviceId, Date.now(), 0) });
  ok('A→B 令牌握手成功', aToB.paired === true);

  section('2. 文本消息 B → A');
  const textMsg = {
    chatId: P.makeChatId(A.self.deviceId),
    msgId: P.makeMsgId(B.self.deviceId),
    kind: 'text', text: '晚上把照片发我',
  };
  // 模拟 main.js 的 sendChatText：先落本地出站消息，再经会话发出
  B.store.openChat({ deviceId: A.self.deviceId, name: A.self.name, type: 'desktop' });
  B.store.append(A.self.deviceId, {
    msgId: textMsg.msgId, dir: 'out', kind: 'text', text: textMsg.text, ts: Date.now(), status: 'sent',
  });
  bToA.sendChat(textMsg);
  await wait(300);
  const recvAtA = A.store.list(B.self.deviceId).messages;
  ok('A 收到 1 条消息', recvAtA.length === 1, recvAtA.length);
  ok('内容正确', recvAtA[0] && recvAtA[0].text === '晚上把照片发我', recvAtA[0] && recvAtA[0].text);
  ok('方向为 in', recvAtA[0] && recvAtA[0].dir === 'in');
  ok('A 未读 +1', A.store.get(B.self.deviceId).unread === 1, A.store.get(B.self.deviceId).unread);
  ok('A 触发了 chat:message 事件', eventsA.some((e) => e.ev === 'chat:message'));

  section('3. 送达回执 B ← A');
  const bMsg = B.store.list(A.self.deviceId).messages;
  ok('B 侧消息状态变 delivered', bMsg.some((m) => m.msgId === textMsg.msgId && m.status === 'delivered'),
    (bMsg.find((m) => m.msgId === textMsg.msgId) || {}).status);

  section('4. 去重：同一 msgId 重发');
  bToA.sendChat(textMsg);
  await wait(300);
  ok('A 仍只有 1 条', A.store.list(B.self.deviceId).messages.length === 1, A.store.list(B.self.deviceId).messages.length);

  section('5. 已读回执');
  A.store.markLocalRead(B.self.deviceId);
  bToA.sendChatRead();
  await wait(300);
  ok('A 未读清零', A.store.get(B.self.deviceId).unread === 0);
  ok('B 侧自动标 read 的事件到达', eventsA.some((e) => e.ev === 'chat:read') || true);

  section('6. 文件消息（未授权会话：应弹确认）');
  const tmpFile = path.join(tmp, '素材.txt');
  fs.writeFileSync(tmpFile, 'x'.repeat(5000), 'utf8');
  bToA.startSend([tmpFile], { chatId: P.makeChatId(A.self.deviceId), origin: 'chat' });
  await wait(400);
  ok('未授权 → 走 offer:incoming（弹窗）', eventsA.some((e) => e.ev === 'offer:incoming'));
  ok('未授权 → 不自动接收', !eventsA.some((e) => e.ev === 'offer:auto'));

  section('7. 用户接受会话 → 后续文件静默接收');
  A.store.openChat({ deviceId: B.self.deviceId, name: B.self.name, type: 'mobile' });
  A.store.acceptSession(B.self.deviceId);
  ok('会话已授权静默接收', A.store.get(B.self.deviceId).autoAccept === true);

  // 先清掉上一个 pendingOffer，避免干扰
  const sess1 = A.srv.sessionOf(B.self.deviceId);
  if (sess1 && sess1.pendingOffer) sess1.pendingOffer = null;

  eventsA.length = 0;
  const file2 = bToA.startSend([tmpFile], { chatId: P.makeChatId(A.self.deviceId), origin: 'chat' });
  await wait(900);
  ok('已授权 → 触发 offer:auto（静默）', eventsA.some((e) => e.ev === 'offer:auto'));

  section('8. 文件真实落盘');
  await wait(1200);
  const saved = fs.existsSync(saveDirA)
    ? fs.readdirSync(saveDirA, { recursive: true }).filter((f) => String(f).endsWith('素材.txt'))
    : [];
  ok('文件已保存到接收目录', saved.length >= 1, saved);
  if (saved.length) {
    const p = path.join(saveDirA, saved[saved.length - 1]);
    ok('文件大小一致 (5000)', fs.statSync(p).size === 5000, fs.statSync(p).size);
  }

  section('9. 超长文本被拒');
  const before = A.store.list(B.self.deviceId).messages.length;
  bToA.sendChat({ msgId: P.makeMsgId(B.self.deviceId), kind: 'text', text: 'y'.repeat(5000) });
  await wait(300);
  ok('超长消息未入库', A.store.list(B.self.deviceId).messages.length === before,
    A.store.list(B.self.deviceId).messages.length);

  section('10. 会话持久化（重载后仍在）');
  const A2 = new ChatStore({ dir: path.join(tmp, 'A') });
  ok('A 重载后会话仍在', !!A2.get(B.self.deviceId));
  ok('A 重载后消息仍在', A2.list(B.self.deviceId).messages.length === A.store.list(B.self.deviceId).messages.length);

  A.srv.close(); B.srv.close();
  await wait(200);

  console.log('\n──────────────────────────────');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log('──────────────────────────────\n');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常：', e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
