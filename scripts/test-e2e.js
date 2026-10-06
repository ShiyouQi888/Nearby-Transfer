/**
 * 端到端集成测试：真实 TCP 连接，完整跑通
 *   配对 → send_offer → send_accept → 分片 → complete → 落盘校验
 *   以及 断点续传 / 中途取消 / 未配对拒绝
 */

'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const P = require('../shared/protocol.js');
const { TransferServer } = require('../desktop/src/main/server.js');
const { FileReceiver, FileSender, buildSendList } = require('../desktop/src/main/transfer.js');

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('  ok   ' + l); };
const bad = (l, d) => { fail++; console.log('  FAIL ' + l + (d ? '\n       ' + d : '')); };
const eq = (l, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? ok(l + ' = ' + JSON.stringify(a)) : bad(l, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ltp-test-'));
const SAVE_DIR = path.join(TMP, 'received');
fs.mkdirSync(SAVE_DIR, { recursive: true });

/** 模拟手机端：一条 TCP 客户端 */
class MockPhone {
  constructor({ deviceId, name, port }) {
    this.device = {
      deviceId, name, type: 'mobile', os: 'Android 14', ip: '127.0.0.1',
      port, protocol: 'LTP/1', pairingRequired: false, fingerprint: 'PH-0001',
    };
    this.port = port;
    this.serverDevice = null;
    this.token = null;
    this.helloAck = null;
    this.offers = [];
    this.receivers = new Map();
    this.incoming = new Map();
    this.events = [];
    this.decoder = new P.NdjsonDecoder((m, isBin) => (isBin ? this._onBin(m) : this._onMsg(m)));
    /** 测试可控项 */
    this.autoAccept = true;
    this.rejectNext = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, '127.0.0.1', () => resolve());
      this.sock.on('error', reject);
      this.sock.on('data', (d) => this.decoder.push(d));
    });
  }

  send(o) { this.sock.write(P.encodeMessage(o)); }
  sendRaw(b) { this.sock.write(b); }

  hello(auth) {
    this.send(P.makeMessage(P.MSG.HELLO, { device: this.device, auth }, this.device.deviceId));
  }

  _onMsg(msg) {
    this.events.push(msg.type);
    switch (msg.type) {
      case P.MSG.HELLO_ACK:
        this.helloAck = msg;
        this.serverDevice = msg.server;
        if (msg.token) this.token = msg.token;
        break;
      case P.MSG.SEND_OFFER:
        this.offers.push(msg);
        if (this.rejectNext) {
          this.rejectNext = false;
          this.send(P.makeMessage(P.MSG.SEND_REJECT, { transferId: msg.transferId, reason: 'user_denied' }, this.device.deviceId));
        } else if (this.autoAccept) {
          this.acceptOffer(msg);
        }
        break;
      case P.MSG.SEND_ACCEPT:
        this.lastAccept = msg;
        this.onAccept && this.onAccept(msg);
        break;
      case P.MSG.SEND_REJECT:
        this.lastReject = msg;
        this.onReject && this.onReject(msg);
        break;
      case P.MSG.COMPLETE:
        this.onComplete && this.onComplete(msg);
        break;
      case P.MSG.CANCEL:
        this.onCancelMsg && this.onCancelMsg(msg);
        break;
    }
  }

  async acceptOffer(offer, opts = {}) {
    const resume = [];
    for (const f of offer.files) {
      if (f.isDir) continue;
      const rec = new FileReceiver({ meta: f, saveDir: SAVE_DIR, transferId: offer.transferId });
      await rec.open();
      if (rec.receivedBytes > 0 && rec.receivedBytes < f.size) {
        resume.push({ fileId: f.fileId, receivedBytes: rec.receivedBytes, resumeToken: 'rs_test' });
      }
      this.receivers.set(f.fileId, rec);
      rec.on('progress', () => {});
    }
    this.send(P.makeMessage(P.MSG.SEND_ACCEPT, {
      transferId: offer.transferId, acceptedBy: this.device.name, resume, saveTo: SAVE_DIR,
    }, this.device.deviceId));
    return resume;
  }

  _onBin(frame) {
    const rec = this.receivers.get(frame.fileId);
    if (!rec) return;
    rec.writeChunk(frame).then(async ({ needAck }) => {
      if (needAck) {
        this.send(P.makeMessage(P.MSG.CHUNK_ACK, {
          transferId: rec.transferId, fileId: frame.fileId, ackedSeq: rec.ackedSeq, receivedBytes: rec.receivedBytes,
        }, this.device.deviceId));
      }
      if (rec.receivedBytes >= rec.meta.size && !rec.finished && !rec._finishPromise) {
        const r = await rec.finish();
        this.send(P.makeMessage(P.MSG.COMPLETE, { transferId: rec.transferId, fileId: frame.fileId, path: r.path, size: r.size || rec.receivedBytes }, this.device.deviceId));
        this.onFileDone && this.onFileDone(frame.fileId, r);
      }
    }).catch((e) => console.error('phone recv err', e.message));
  }

  /** 手机主动发文件给电脑 */
  async sendFiles(paths) {
    const list = await buildSendList(paths, { chunkSize: 64 * 1024 });
    const transferId = 't_phone_' + Math.random().toString(36).slice(2, 8);
    const files = list.map((x) => x.meta);
    const totalBytes = files.reduce((a, f) => a + f.size, 0);
    this.send(P.makeMessage(P.MSG.SEND_OFFER, { transferId, files, totalBytes }, this.device.deviceId));

    // 等电脑端 accept
    const accept = await waitFor(() => this.lastAccept, 3000);
    if (!accept) throw new Error('未收到 send_accept');

    const resumeMap = new Map((accept.resume || []).map((r) => [r.fileId, r]));
    for (const { meta, filePath } of list) {
      if (meta.isDir) continue;
      const r = resumeMap.get(meta.fileId);
      let startSeq = 0;
      if (r && r.receivedBytes > 0 && r.receivedBytes < meta.size) startSeq = Math.floor(r.receivedBytes / meta.chunkSize);
      const sender = new FileSender({
        filePath, meta, startSeq,
        write: (buf) => new Promise((res, rej) => this.sock.write(buf, (e) => (e ? rej(e) : res()))),
      });
      await sender.run();
      this.send(P.makeMessage(P.MSG.COMPLETE, { transferId, fileId: meta.fileId, path: meta.relPath, size: meta.size }, this.device.deviceId));
    }
    return { transferId, files };
  }

  destroy() { try { this.sock.destroy(); } catch (_) {} }
}

function waitFor(fn, timeout = 4000, tick = 25) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = fn();
      if (v || Date.now() - t0 > timeout) { clearInterval(iv); resolve(v || null); }
    }, tick);
  });
}

function sha256(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function mkFile(name, size, dir = TMP) {
  const p = path.join(dir, name);
  const buf = crypto.randomBytes(size);
  fs.writeFileSync(p, buf);
  return { path: p, sha: crypto.createHash('sha256').update(buf).digest('hex'), size };
}

// ══════════════════════════════════════════════════════════════

(async function main() {
  const serverSecret = crypto.randomBytes(32).toString('hex');
  const PORT = 54321;

  console.log('\n[1] 未配对设备直接连接 → 应被拒绝（协议 §3.2 / §8）');
  const server = new TransferServer({
    self: { deviceId: 'pc-test-1', name: 'DESKTOP-TEST', type: 'desktop', os: 'Windows 11', ip: '127.0.0.1', fingerprint: 'PC-0001' },
    deviceSecret: serverSecret,
    port: PORT,
    saveDir: SAVE_DIR,
  });
  await server.listen();
  ok('服务端监听 ' + PORT);

  {
    const phone = new MockPhone({ deviceId: 'mobile-aaa', name: 'Pixel 8', port: PORT });
    await phone.connect();
    phone.hello({ mode: 'none' });
    const ack = await waitFor(() => phone.helloAck, 2000);
    eq('匿名连接被拒', ack && ack.accepted, false);
    eq('拒绝原因', ack && ack.reason, 'need_pair');
    phone.destroy();
  }

  console.log('\n[2] 6 位匹配码配对 → 下发长期令牌');
  let phoneToken = null;
  {
    const code = server.newPairCode();
    eq('匹配码为 6 位', /^[1-9]\d{5}$/.test(code), true);
    const phone = new MockPhone({ deviceId: 'mobile-bbb', name: 'Pixel 8', port: PORT });
    await phone.connect();
    phone.hello({ mode: 'pair', pairCode: code, deviceId: 'mobile-bbb' });
    const ack = await waitFor(() => phone.helloAck, 2000);
    eq('配对成功', ack && ack.accepted, true);
    eq('收到长期令牌', typeof ack.token === 'string' && ack.token.length > 20, true);
    eq('服务端已记录信任设备', server.listTrusted().some((t) => t.deviceId === 'mobile-bbb'), true);
    phoneToken = ack.token;
    phone.destroy();
  }
  console.log('\n[3] 错误匹配码 → 拒绝');
  {
    const phone = new MockPhone({ deviceId: 'mobile-ccc', name: 'Evil', port: PORT });
    await phone.connect();
    phone.hello({ mode: 'pair', pairCode: '000000' });
    const ack = await waitFor(() => phone.helloAck, 2000);
    eq('错误码被拒', ack && ack.accepted, false);
    eq('原因', ack.reason, 'need_pair');
    phone.destroy();
  }

  console.log('\n[4] 已信任设备用令牌免配对连接');
  {
    const phone = new MockPhone({ deviceId: 'mobile-bbb', name: 'Pixel 8', port: PORT });
    await phone.connect();
    phone.hello({ mode: 'paired', token: phoneToken, deviceId: 'mobile-bbb' });
    const ack = await waitFor(() => phone.helloAck, 2000);
    eq('令牌连接成功', ack && ack.accepted, true);
    eq('authMode', ack.reason, 'paired');
    phone.destroy();
  }
  console.log('\n[5] 伪造令牌 → 拒绝');
  {
    const bad = P.signToken('wrong-secret', 'mobile-bbb', Date.now(), 0);
    const phone = new MockPhone({ deviceId: 'mobile-bbb', name: 'Pixel 8', port: PORT });
    await phone.connect();
    phone.hello({ mode: 'paired', token: bad, deviceId: 'mobile-bbb' });
    const ack = await waitFor(() => phone.helloAck, 2000);
    eq('伪造令牌被拒', ack && ack.accepted, false);
    eq('原因', ack.reason, 'bad_token');
    phone.destroy();
  }

  console.log('\n[6] 电脑 → 手机 发送大文件（8MB，验证分片 + 校验 + 进度）');
  {
    const f = mkFile('big.bin', 8 * 1024 * 1024 + 12345);   // 非整数片，验证末片
    const phone = new MockPhone({ deviceId: 'mobile-bbb', name: 'Pixel 8', port: PORT });
    await phone.connect();
    phone.hello({ mode: 'paired', token: phoneToken, deviceId: 'mobile-bbb' });
    await waitFor(() => phone.helloAck, 2000);

    const progressEvents = [];
    server.on('transfer:progress', (p) => progressEvents.push(p));

    const session = server.activeSession();
    ok('服务端会话已建立', !!session);

    const r = await session.startSend([f.path], { chunkSize: 256 * 1024 });
    eq('发送已发起', r.ok, true);
    eq('文件数', r.files, 1);

    // 等手机端落盘
    const got = await waitFor(() => {
      const rec = [...phone.receivers.values()][0];
      return rec && rec.finished ? rec : null;
    }, 15000);
    ok('手机端收到文件', !!got && got.finished);
    eq('大小一致', fs.statSync(got.finalPath).size, f.size);
    eq('内容 sha256 一致', sha256(got.finalPath), f.sha);
    ok('有进度事件上报', progressEvents.length > 0);
    const last = progressEvents[progressEvents.length - 1];
    eq('进度到达总量', last.overall, f.size);
    ok('速度有采样: ' + P.formatSpeed(last.speed));

    await waitFor(() => {
      const t = server.listTransfers().find((x) => x.transferId === r.transferId);
      return t && t.status === 'done';
    }, 5000).then((t) => eq('服务端标记完成', !!(t), true));

    phone.destroy();
  }

  console.log('\n[7] 手机 → 电脑 发送批量文件 + 保持目录结构');
  {
    const dir = path.join(TMP, 'album');
    fs.mkdirSync(dir, { recursive: true });
    const a = mkFile('a.jpg', 300 * 1024, dir);
    const b = mkFile('b.png', 900 * 1024, dir);
    const c = mkFile('c.pdf', 1500, dir);

    const phone = new MockPhone({ deviceId: 'mobile-bbb', name: 'Pixel 8', port: PORT });
    await phone.connect();
    phone.hello({ mode: 'paired', token: phoneToken, deviceId: 'mobile-bbb' });
    await waitFor(() => phone.helloAck, 2000);

    const offers = [];
    server.on('offer:incoming', (o) => offers.push(o));

    const sending = phone.sendFiles([dir]);
    const offer = await waitFor(() => offers[0], 3000);
    ok('电脑端收到 send_offer', !!offer);
    eq('含 3 个文件', offer.files.length, 3);
    eq('相对路径保留目录名', offer.files.map((f) => f.relPath).sort(), ['album/a.jpg', 'album/b.png', 'album/c.pdf']);
    eq('显示发送方设备名', offer.device.name, 'Pixel 8');

    const session = server.activeSession();
    await session.acceptOffer(offer.transferId);
    await sending;
    const t = await waitFor(() => {
      const x = server.getTransfer(offer.transferId);
      return x && x.status === 'done' ? x : null;
    }, 10000);
    eq('电脑端接收完成', !!t, true);
    eq('所有文件状态 done', t && t.files.every((f) => f.status === 'done'), true);

    const outDir = path.join(SAVE_DIR, 'album');
    eq('目录结构保留', fs.existsSync(outDir), true);
    eq('a.jpg 校验', sha256(path.join(outDir, 'a.jpg')), a.sha);
    eq('b.png 校验', sha256(path.join(outDir, 'b.png')), b.sha);
    eq('c.pdf 校验', sha256(path.join(outDir, 'c.pdf')), c.sha);
    phone.destroy();
  }

  console.log('\n[8] 断点续传 —— 传到一半断开，重连后从断点继续');
  {
    const f = mkFile('resume.bin', 4 * 1024 * 1024);
    const CHUNK = 128 * 1024;
    const RESUME_DIR = path.join(TMP, 'resume-target');
    fs.mkdirSync(RESUME_DIR, { recursive: true });

    // ── 第一轮：断在约 40%
    const phone1 = new MockPhone({ deviceId: 'mobile-bbb', name: 'Pixel 8', port: PORT });
    // 手机端不自动接受，改为手工落盘到 RESUME_DIR 以便验证续传
    phone1.autoAccept = false;
    await phone1.connect();
    phone1.hello({ mode: 'paired', token: phoneToken, deviceId: 'mobile-bbb' });
    await waitFor(() => phone1.helloAck, 2000);

    const session1 = server.activeSession();
    ok('会话1已建立', !!session1);
    await session1.startSend([f.path], { chunkSize: CHUNK });
    const offer1 = await waitFor(() => phone1.offers[0], 3000);
    ok('手机端收到 send_offer', !!offer1);

    // 手机端手工开接收器（保存到 RESUME_DIR）并回 send_accept
    const rec1 = new FileReceiver({ meta: offer1.files[0], saveDir: RESUME_DIR, transferId: offer1.transferId });
    await rec1.open();
    phone1.receivers.set(offer1.files[0].fileId, rec1);
    phone1.send(P.makeMessage(P.MSG.SEND_ACCEPT, {
      transferId: offer1.transferId, acceptedBy: phone1.device.name, resume: [], saveTo: RESUME_DIR,
    }, phone1.device.deviceId));

    // 环形回环速度极快，用「收到第 12 片就立刻断开」来确保停在半途
    const firstRec = rec1;
    const partial = await new Promise((resolve) => {
      let cut = false;
      const target = CHUNK * 12;
      const iv = setInterval(() => {
        if (!cut && firstRec.receivedBytes >= target) {
          cut = true;
          clearInterval(iv);
          const snap = firstRec.receivedBytes;
          phone1.destroy();          // 立刻断开
          resolve(snap);
        }
      }, 1);
      setTimeout(() => { if (!cut) { cut = true; clearInterval(iv); const snap = firstRec.receivedBytes; phone1.destroy(); resolve(snap); } }, 8000);
    });
    ok('第一轮已收部分数据: ' + P.formatBytes(partial));
    await new Promise((r) => setTimeout(r, 400));

    const sizeOnDisk = fs.statSync(rec1.partPath).size;
    ok('磁盘保留 .part: ' + P.formatBytes(sizeOnDisk));
    eq('.part 小于完整文件', sizeOnDisk < f.size, true);
    await rec1.cancel(true);   // 关闭句柄，保留文件

    // ── 第二轮：重连，同一保存目录 → 自动从 .part 续传
    const phone2 = new MockPhone({ deviceId: 'mobile-bbb', name: 'Pixel 8', port: PORT });
    phone2.autoAccept = false;
    // 让手机端把续传接收器落到 RESUME_DIR（与第一轮同一个 .part）
    await phone2.connect();
    phone2.hello({ mode: 'paired', token: phoneToken, deviceId: 'mobile-bbb' });
    await waitFor(() => phone2.helloAck, 2000);

    const session2 = server.activeSession();
    ok('会话2已建立', !!session2);
    const sendRes2 = await session2.startSend([f.path], { chunkSize: CHUNK });
    const offer2 = await waitFor(() => phone2.offers[0], 3000);
    ok('手机端第二轮收到 send_offer', !!offer2);

    // 手机端 open 同一个目录 → 检测到 .part → 上报续传位点
    const rec2b = new FileReceiver({ meta: offer2.files[0], saveDir: RESUME_DIR, transferId: offer2.transferId });
    const opened2 = await rec2b.open();
    phone2.receivers.set(offer2.files[0].fileId, rec2b);
    const resumeBytes = opened2.receivedBytes;
    ok('续传起点 = ' + P.formatBytes(resumeBytes));
    eq('续传起点接近断点位置', Math.abs(resumeBytes - sizeOnDisk) < CHUNK * 2, true);
    eq('续传起点 > 0（确实没有从头传）', resumeBytes > 0, true);

    phone2.send(P.makeMessage(P.MSG.SEND_ACCEPT, {
      transferId: offer2.transferId, acceptedBy: phone2.device.name,
      resume: [{ fileId: offer2.files[0].fileId, receivedBytes: resumeBytes, resumeToken: 'rs_x' }],
      saveTo: RESUME_DIR,
    }, phone2.device.deviceId));

    const done = await waitFor(() => (rec2b.finished ? rec2b : null), 15000);
    ok('续传后完成', !!done);
    eq('文件大小正确', fs.statSync(rec2b.finalPath).size, f.size);
    eq('内容 sha256 一致', sha256(rec2b.finalPath), f.sha);
    phone2.destroy();
  }

  console.log('\n[9] 中途取消');
  {
    const f = mkFile('cancel.bin', 6 * 1024 * 1024);
    const phone = new MockPhone({ deviceId: 'mobile-bbb', name: 'Pixel 8', port: PORT });
    await phone.connect();
    phone.hello({ mode: 'paired', token: phoneToken, deviceId: 'mobile-bbb' });
    await waitFor(() => phone.helloAck, 2000);

    // 电脑端发起发送 → offer 到达手机端
    const session = server.activeSession();
    ok('会话已建立', !!session);
    // 限速 1MB/s，保证取消发生在传输中途而不是传完之后
    const r = await session.startSend([f.path], { chunkSize: 64 * 1024, maxBytesPerSec: 1024 * 1024 });
    const offered = await waitFor(() => phone.offers[0], 3000);
    ok('手机端收到 send_offer', !!offered);
    await phone.acceptOffer(offered);          // 手机端同意接收

    // 等确实传了一点再取消
    await waitFor(() => {
      const t = server.getTransfer(r.transferId);
      return t && t.transferredBytes > 256 * 1024;
    }, 5000);

    let cancelSeen = false;
    server.on('transfer:cancelled', () => { cancelSeen = true; });
    session.cancelTransfer(r.transferId);
    await waitFor(() => cancelSeen, 3000);
    ok('取消事件已触发', cancelSeen);
    const t = server.getTransfer(r.transferId);
    eq('传输状态 = cancelled', t.status, 'cancelled');
    await new Promise((res) => setTimeout(res, 600));
    const rec = [...phone.receivers.values()][0];
    ok('接收器已建立', !!rec);
    const keep = rec && fs.existsSync(rec.partPath);
    eq('取消后 .part 文件保留供续传', keep, true);
    const sz = keep ? fs.statSync(rec.partPath).size : 0;
    ok('保留的数据量 = ' + P.formatBytes(sz) + '（小于完整 6MB）');
    eq('保留量小于完整文件', sz < f.size, true);
    eq('保留量大于 0', sz > 0, true);
    phone.destroy();
  }

  console.log('\n[10] 接收方拒绝');
  {
    const f = mkFile('reject.bin', 512 * 1024);
    const phone = new MockPhone({ deviceId: 'mobile-bbb', name: 'Pixel 8', port: PORT });
    phone.rejectNext = true;
    await phone.connect();
    phone.hello({ mode: 'paired', token: phoneToken, deviceId: 'mobile-bbb' });
    await waitFor(() => phone.helloAck, 2000);

    const session = server.activeSession();
    const r = await session.startSend([f.path]);
    const t = await waitFor(() => {
      const x = server.getTransfer(r.transferId);
      return x && x.status === 'rejected' ? x : null;
    }, 5000);
    eq('状态 = rejected', t && t.status, 'rejected');
    eq('拒绝原因', t && t.error, 'user_denied');
    phone.destroy();
  }

  console.log('\n[11] 路径穿越防护 —— 恶意 relPath 不得逃出保存目录');
  {
    const meta = { fileId: 'f_evil', name: 'evil.txt', size: 10, relPath: '../../../../../../Windows/evil.txt', chunkSize: 64, isDir: false };
    const rec = new FileReceiver({ meta, saveDir: SAVE_DIR });
    await rec.open();
    const resolvedSave = path.resolve(SAVE_DIR);
    const inside = path.resolve(rec.finalPath).startsWith(resolvedSave + path.sep);
    eq('落盘路径被限制在保存目录内', inside, true);
    await rec.cancel(false);
  }

  console.log('\n[12] 发送清单构建 —— 目录递归 + 扩展名归类');
  {
    const d = path.join(TMP, 'tree');
    fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'x.mp4'), 'v');
    fs.writeFileSync(path.join(d, 'sub', 'y.jpg'), 'i');
    const list = await buildSendList([d]);
    const rels = list.map((x) => x.meta.relPath).sort();
    eq('展开文件相对路径', rels, ['tree/sub/y.jpg', 'tree/x.mp4']);
    eq('mime 推断', list.map((x) => x.meta.mime).sort(), ['image/jpeg', 'video/mp4']);
  }

  server.close();
  await new Promise((r) => setTimeout(r, 200));

  console.log('\n══════════════════════════════');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log('══════════════════════════════\n');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常终止：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
