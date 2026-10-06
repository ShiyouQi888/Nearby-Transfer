/**
 * WebSocket 网关端到端测试
 * 验证：手机端以浏览器/WebView 形态（只能用 WS，不能开原始 TCP）时，
 * 通过 ws://<ip>:53318/ws 也能完整走通 配对 → 传输 → 校验。
 */

'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const P = require('../shared/protocol.js');
const { TransferServer } = require('../desktop/src/main/server.js');
const { FileReceiver, FileSender, buildSendList } = require('../desktop/src/main/transfer.js');

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('  ok   ' + l); };
const bad = (l, d) => { fail++; console.log('  FAIL ' + l + (d ? '\n       ' + d : '')); };
const eq = (l, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? ok(l + ' = ' + JSON.stringify(a)) : bad(l, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ltp-ws-'));
const SAVE = path.join(TMP, 'dl');
fs.mkdirSync(SAVE, { recursive: true });

// ── 最小 WebSocket 客户端（无第三方依赖） ────────────────────

class WsClient {
  constructor(host, port, pathname = '/ws') {
    this.host = host; this.port = port; this.pathname = pathname;
    this._handlers = { data: [], close: [], error: [] };
  }

  on(ev, cb) { this._handlers[ev].push(cb); return this; }
  _emit(ev, arg) { this._handlers[ev].forEach((f) => f(arg)); }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: this.host, port: this.port, path: this.pathname,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, sock, head) => {
        this.sock = sock;
        this._buf = Buffer.alloc(0);
        sock.on('data', (d) => {
          this._buf = Buffer.concat([this._buf, d]);
          this._drain();
        });
        sock.on('close', () => this._emit('close'));
        sock.on('error', (e) => this._emit('error', e));
        if (head && head.length) { this._buf = Buffer.concat([this._buf, head]); this._drain(); }
        resolve(this);
      });
      req.on('error', reject);
      req.end();
    });
  }

  _drain() {
    for (;;) {
      const f = this._decode();
      if (!f) break;
      if (f.opcode === 0x2 || f.opcode === 0x1 || f.opcode === 0x0) this._emit('data', f.payload);
      else if (f.opcode === 0x8) { this._emit('close'); return; }
    }
  }

  _decode() {
    const b = this._buf;
    if (b.length < 2) return null;
    const opcode = b[0] & 0x0f;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = b.readUInt32BE(6); off = 10; }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    this._buf = b.subarray(off + len);
    return { opcode, payload };
  }

  send(buf) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | data.length; }
    else if (data.length < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(data.length, 6); }
    header[0] = 0x80 | 0x2;   // FIN + binary
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  close() { try { this.sock.destroy(); } catch (_) {} }
}

function waitFor(fn, timeout = 5000, tick = 20) {
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

/** 走 WS 的模拟手机 */
class WsPhone {
  constructor(port, deviceId = 'mobile-ws') {
    this.device = {
      deviceId, name: 'Chrome 手机', type: 'mobile', os: 'Android 14',
      ip: '127.0.0.1', port, protocol: P.PROTOCOL_ID, fingerprint: 'WS-0001',
    };
    this.port = port;
    this.events = [];
    this.offers = [];
    this.receivers = new Map();
    this.helloAck = null;
    this.token = null;
    this.autoAccept = true;
    this._textBuf = Buffer.alloc(0);
  }

  async connect() {
    this.ws = new WsClient('127.0.0.1', this.port + 1);
    this.ws.on('data', (d) => this._onData(d));
    await this.ws.connect();
    return this;
  }

  _onData(d) {
    // 复用协议层的流拆包器
    if (!this.dec) this.dec = new P.NdjsonDecoder((m, isBin) => (isBin ? this._onBin(m) : this._onMsg(m)));
    this.dec.push(d);
  }

  send(o) { this.ws.send(P.encodeMessage(o)); }
  sendRaw(b) { this.ws.send(b); }

  hello(auth) { this.send(P.makeMessage(P.MSG.HELLO, { device: this.device, auth }, this.device.deviceId)); }

  _onMsg(msg) {
    this.events.push(msg.type);
    if (msg.type === P.MSG.HELLO_ACK) { this.helloAck = msg; if (msg.token) this.token = msg.token; }
    if (msg.type === P.MSG.SEND_OFFER) {
      this.offers.push(msg);
      if (this.autoAccept) this.acceptOffer(msg);
    }
    if (msg.type === P.MSG.SEND_ACCEPT) { this.lastAccept = msg; this.onAccept && this.onAccept(msg); }
    if (msg.type === P.MSG.COMPLETE) { this.onComplete && this.onComplete(msg); }
    if (msg.type === P.MSG.CANCEL) { this.onCancelMsg && this.onCancelMsg(msg); }
  }

  async acceptOffer(offer) {
    const resume = [];
    for (const f of offer.files) {
      if (f.isDir) continue;
      const rec = new FileReceiver({ meta: f, saveDir: SAVE, transferId: offer.transferId });
      await rec.open();
      if (rec.receivedBytes > 0 && rec.receivedBytes < f.size) {
        resume.push({ fileId: f.fileId, receivedBytes: rec.receivedBytes, resumeToken: 'rs_ws' });
      }
      this.receivers.set(f.fileId, rec);
    }
    this.send(P.makeMessage(P.MSG.SEND_ACCEPT, {
      transferId: offer.transferId, acceptedBy: this.device.name, resume, saveTo: SAVE,
    }, this.device.deviceId));
  }

  _onBin(frame) {
    const rec = this.receivers.get(frame.fileId);
    if (!rec) return;
    rec.writeChunk(frame).then(({ needAck }) => {
      if (needAck) {
        this.send(P.makeMessage(P.MSG.CHUNK_ACK, {
          transferId: rec.transferId, fileId: frame.fileId, ackedSeq: rec.ackedSeq, receivedBytes: rec.receivedBytes,
        }, this.device.deviceId));
      }
      if (rec.receivedBytes >= rec.meta.size && !rec.finished && !rec._finishPromise) {
        rec.finish().then((r) => {
          this.send(P.makeMessage(P.MSG.COMPLETE, { transferId: rec.transferId, fileId: frame.fileId, path: r.path, size: rec.receivedBytes }, this.device.deviceId));
          this.onFileDone && this.onFileDone(frame.fileId, r);
        });
      }
    }).catch(() => {});
  }

  /** 手机 → 电脑（走 WS） */
  async sendFiles(paths) {
    const list = await buildSendList(paths, { chunkSize: 128 * 1024 });
    const transferId = 't_ws_' + Math.random().toString(36).slice(2, 8);
    const files = list.map((x) => x.meta);
    this.send(P.makeMessage(P.MSG.SEND_OFFER, { transferId, files, totalBytes: files.reduce((a, f) => a + f.size, 0) }, this.device.deviceId));
    const acc = await waitFor(() => this.lastAccept, 4000);
    if (!acc || acc.transferId !== transferId) throw new Error('未收到 send_accept');
    const resumeMap = new Map((acc.resume || []).map((r) => [r.fileId, r]));
    for (const { meta, filePath } of list) {
      if (meta.isDir) continue;
      const r = resumeMap.get(meta.fileId);
      let startSeq = 0;
      if (r && r.receivedBytes > 0 && r.receivedBytes < meta.size) startSeq = Math.floor(r.receivedBytes / meta.chunkSize);
      const sender = new FileSender({
        filePath, meta, startSeq,
        write: (buf) => this.sendRaw(buf),
      });
      await sender.run();
      this.send(P.makeMessage(P.MSG.COMPLETE, { transferId, fileId: meta.fileId, path: meta.relPath, size: meta.size }, this.device.deviceId));
    }
    return { transferId, files };
  }

  destroy() { try { this.ws.close(); } catch (_) {} }
}

// ══════════════════════════════════════════════════════════════

(async function main() {
  const PORT = 54500;
  const server = new TransferServer({
    self: { deviceId: 'pc-ws', name: 'DESKTOP-WS', type: 'desktop', os: 'Windows 11', ip: '127.0.0.1', fingerprint: 'PC-WS' },
    deviceSecret: crypto.randomBytes(32).toString('hex'),
    port: PORT,
    saveDir: SAVE,
  });
  await server.listen();
  await new Promise((r) => setTimeout(r, 300));

  console.log('\n[1] HTTP 探测端点 /probe（手机端扫描网段用）');
  {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT + 1, path: '/probe', timeout: 3000 }, (res) => {
        let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s) }));
      }).on('error', reject);
    });
    eq('HTTP 200', r.status, 200);
    eq('返回设备名', r.body.device.name, 'DESKTOP-WS');
    eq('声明协议', r.body.device.protocol, 'LTP/1');
    eq('提示 ws 路径', r.body.wsPath, '/ws');
  }

  console.log('\n[2] /ping 健康检查');
  {
    const r = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: PORT + 1, path: '/ping', timeout: 3000 }, (res) => {
        let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(JSON.parse(s)));
      }).on('error', () => resolve(null));
    });
    eq('ping ok', r && r.ok, true);
  }

  console.log('\n[3] WebSocket 握手 + 匿名连接被拒（与 TCP 通道同样的安全策略）');
  {
    const phone = new WsPhone(PORT);
    await phone.connect();
    ok('WS 升级成功（客户端拿到 101）');
    phone.hello({ mode: 'none' });
    const ack = await waitFor(() => phone.helloAck, 3000);
    eq('WS 通道同样拒绝未配对设备', ack && ack.accepted, false);
    eq('原因一致', ack && ack.reason, 'need_pair');
    phone.destroy();
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n[4] WebSocket 通道完整配对 + 电脑→手机 传大文件');
  let wsToken = null;
  {
    const code = server.newPairCode();
    const phone = new WsPhone(PORT);
    await phone.connect();
    phone.hello({ mode: 'pair', pairCode: code, deviceId: 'mobile-ws' });
    const ack = await waitFor(() => phone.helloAck, 3000);
    eq('WS 通道配对成功', ack && ack.accepted, true);
    eq('下发长期令牌', typeof ack.token === 'string' && ack.token.length > 20, true);
    wsToken = ack.token;

    const f = mkFile('ws-big.bin', 6 * 1024 * 1024 + 7777);
    const session = server.activeSession();
    ok('电脑端会话已建立（走 WS 桥接）', !!session);
    const r = await session.startSend([f.path], { chunkSize: 256 * 1024 });
    eq('已发起发送', r.ok, true);

    const got = await waitFor(() => {
      const rec = [...phone.receivers.values()][0];
      return rec && rec.finished ? rec : null;
    }, 20000);
    ok('WS 通道收到文件', !!got && got.finished);
    eq('大小一致', fs.statSync(got.finalPath).size, f.size);
    eq('sha256 一致（二进制帧经 WS 封解包无损）', sha256(got.finalPath), f.sha);
    phone.destroy();
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n[5] WebSocket 通道 手机→电脑 批量文件');
  {
    const dir = path.join(TMP, 'wsalbum');
    fs.mkdirSync(dir, { recursive: true });
    const a = mkFile('p1.jpg', 400 * 1024, dir);
    const b = mkFile('p2.mp4', 1200 * 1024, dir);

    const phone = new WsPhone(PORT);
    await phone.connect();
    phone.hello({ mode: 'paired', token: wsToken, deviceId: 'mobile-ws' });
    await waitFor(() => phone.helloAck, 3000);

    const offers = [];
    server.on('offer:incoming', (o) => offers.push(o));
    // 注意：不能 await sendFiles（它在内部等 accept），必须先起流程再等 offer
    const sending = phone.sendFiles([dir]).catch((e) => { throw e; });
    const offer = await waitFor(() => offers[0], 4000);
    ok('电脑端收到 send_offer', !!offer);
    eq('文件名与路径', offer.files.map((x) => x.relPath).sort(), ['wsalbum/p1.jpg', 'wsalbum/p2.mp4']);

    await server.sessionOfTransfer(offer.transferId).acceptOffer(offer.transferId);
    await sending;
    const t = await waitFor(() => {
      const x = server.getTransfer(offer.transferId);
      return x && x.status === 'done' ? x : null;
    }, 12000);
    eq('电脑端接收完成', !!t, true);
    eq('p1 校验', sha256(path.join(SAVE, 'wsalbum/p1.jpg')), a.sha);
    eq('p2 校验', sha256(path.join(SAVE, 'wsalbum/p2.mp4')), b.sha);
    phone.destroy();
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n[6] WebSocket 通道 断点续传（WS 桥接下同样生效）');
  {
    const f = mkFile('wsresume.bin', 4 * 1024 * 1024);
    const CHUNK = 128 * 1024;
    const R_DIR = path.join(TMP, 'ws-resume');
    fs.mkdirSync(R_DIR, { recursive: true });

    const phone1 = new WsPhone(PORT);
    phone1.autoAccept = false;
    await phone1.connect();
    phone1.hello({ mode: 'paired', token: wsToken, deviceId: 'mobile-ws' });
    await waitFor(() => phone1.helloAck, 3000);

    const session1 = server.activeSession();
    await session1.startSend([f.path], { chunkSize: CHUNK });
    const offer1 = await waitFor(() => phone1.offers[0], 4000);
    ok('手机端收到 offer', !!offer1);
    const rec1 = new FileReceiver({ meta: offer1.files[0], saveDir: R_DIR, transferId: offer1.transferId });
    await rec1.open();
    phone1.receivers.set(offer1.files[0].fileId, rec1);
    phone1.send(P.makeMessage(P.MSG.SEND_ACCEPT, { transferId: offer1.transferId, acceptedBy: 'x', resume: [], saveTo: R_DIR }, phone1.device.deviceId));

    const partial = await new Promise((resolve) => {
      let cut = false;
      const iv = setInterval(() => {
        if (!cut && rec1.receivedBytes >= CHUNK * 10) { cut = true; clearInterval(iv); const s = rec1.receivedBytes; phone1.destroy(); resolve(s); }
      }, 1);
      setTimeout(() => { if (!cut) { cut = true; clearInterval(iv); const s = rec1.receivedBytes; phone1.destroy(); resolve(s); } }, 8000);
    });
    ok('第一轮收到 ' + P.formatBytes(partial));
    await new Promise((r) => setTimeout(r, 400));
    const onDisk = fs.statSync(rec1.partPath).size;
    await rec1.cancel(true);

    const phone2 = new WsPhone(PORT);
    phone2.autoAccept = false;
    await phone2.connect();
    phone2.hello({ mode: 'paired', token: wsToken, deviceId: 'mobile-ws' });
    await waitFor(() => phone2.helloAck, 3000);

    const session2 = server.activeSession();
    await session2.startSend([f.path], { chunkSize: CHUNK });
    const offer2 = await waitFor(() => phone2.offers[0], 4000);
    const rec2 = new FileReceiver({ meta: offer2.files[0], saveDir: R_DIR, transferId: offer2.transferId });
    const opened = await rec2.open();
    phone2.receivers.set(offer2.files[0].fileId, rec2);

    eq('WS 通道续传起点 > 0', opened.receivedBytes > 0, true);
    eq('续传起点等于磁盘残片大小', opened.receivedBytes, onDisk);
    phone2.send(P.makeMessage(P.MSG.SEND_ACCEPT, {
      transferId: offer2.transferId, acceptedBy: 'x',
      resume: [{ fileId: offer2.files[0].fileId, receivedBytes: opened.receivedBytes, resumeToken: 'x' }],
      saveTo: R_DIR,
    }, phone2.device.deviceId));

    const done = await waitFor(() => (rec2.finished ? rec2 : null), 20000);
    ok('WS 通道续传完成', !!done);
    eq('续传后 sha256 一致', sha256(rec2.finalPath), f.sha);
    phone2.destroy();
  }

  server.close();
  await new Promise((r) => setTimeout(r, 300));

  console.log('\n══════════════════════════════');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log('══════════════════════════════\n');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nWS 测试异常终止：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
