/**
 * 传输服务端（Windows 电脑端，Node net 模块）
 * - 监听 TCP，接受手机端连接
 * - 处理握手 / 配对 / 收发文件
 * - 发出 EventEmitter 事件供 Electron 主进程转发给渲染层
 *
 * 事件：
 *   listening, pair:request, device:connected, device:disconnected,
 *   offer:incoming, transfer:progress, transfer:complete, transfer:error,
 *   transfer:cancelled, session:error
 */

'use strict';

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fsp = require('fs').promises;
const EventEmitter = require('events');
const P = require('../../../shared/protocol.js');
const { FileSender, FileReceiver, buildSendList } = require('./transfer.js');

class Session extends EventEmitter {
  constructor(sock, opts) {
    super();
    this.sock = sock;
    this.server = opts.server;
    this.peerDevice = null;       // 对端 device 对象
    this.paired = false;
    this.authMode = 'none';
    this.pendingOffer = null;     // 待用户确认的 send_offer
    this.receivers = new Map();   // fileId -> FileReceiver
    this.senders = new Map();     // transferId -> FileSender
    this.closed = false;
    this.lastPong = Date.now();
    this.createdAt = Date.now();

    this.decoder = new P.NdjsonDecoder((msg, isBin) => {
      if (isBin) this._onBinary(msg);
      else this._onMessage(msg);
    });

    sock.on('data', (d) => {
      try { this.decoder.push(d); } catch (e) { this.emit('session:error', e); }
    });
    sock.on('error', (e) => { this.emit('session:error', e); });
    sock.on('close', () => this._close());
    sock.setNoDelay(true);
    if (typeof sock.setKeepAlive === 'function') sock.setKeepAlive(true, 15000);
  }

  get id() { return this._id || (this._id = `${this.sock.remoteAddress}:${this.sock.remotePort}`); }

  send(obj) {
    if (this.closed) return;
    try { this.sock.write(P.encodeMessage(obj)); } catch (e) { this.emit('session:error', e); }
  }

  sendRaw(buf) {
    if (this.closed) return;
    try { this.sock.write(buf); } catch (e) { this.emit('session:error', e); }
  }

  _close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.senders.values()) s.cancel();
    for (const r of this.receivers.values()) r.cancel(true).catch(() => {});
    this.emit('disconnected', { sessionId: this.id, device: this.peerDevice });
  }

  close(reason) {
    if (reason) this.send(P.makeMessage(P.MSG.BYE, { reason }, this.server.self.deviceId));
    try { this.sock.end(); } catch (_) {}
    setTimeout(() => { try { this.sock.destroy(); } catch (_) {} }, 300);
  }

  // ── 消息分发 ────────────────────────────────────────────────

  _onMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case P.MSG.HELLO: return this._onHello(msg);
      case P.MSG.PAIR_REQUEST: return this._onPairRequest(msg);
      case P.MSG.SEND_OFFER: return this._onSendOffer(msg);
      case P.MSG.SEND_ACCEPT: return this._onSendAccept(msg);
      case P.MSG.SEND_REJECT: return this._onSendReject(msg);
      case P.MSG.CHUNK_ACK: return this._onChunkAck(msg);
      case P.MSG.PROGRESS: return this._onPeerProgress(msg);
      case P.MSG.COMPLETE: return this._onPeerComplete(msg);
      case P.MSG.CANCEL: return this._onCancel(msg);
      case P.MSG.PING: return this.send(P.makeMessage(P.MSG.PONG, {}, this.server.self.deviceId));
      case P.MSG.PONG: this.lastPong = Date.now(); return;
      case P.MSG.BYE: return this.close();
      default: return;
    }
  }

  _onHello(msg) {
    this.peerDevice = msg.device || null;
    const auth = msg.auth || {};

    // 1) 已配对：校验长期令牌
    if (auth.mode === 'paired' && auth.token) {
      const v = P.verifyToken(this.server.deviceSecret, auth.token);
      if (v.ok && (!this.peerDevice || v.deviceId === this.peerDevice.deviceId)) {
        this.paired = true;
        this.authMode = 'paired';
        this.server.trust(auth.deviceId || v.deviceId, this.peerDevice);
        this.send(P.makeMessage(P.MSG.HELLO_ACK, {
          accepted: true,
          reason: P.HELLO_REASON.PAIRED,
          server: this.server.selfDevice(),
        }, this.server.self.deviceId));
        this.emit('device:connected', { sessionId: this.id, device: this.peerDevice, authMode: 'paired' });
        return;
      }
      this.send(P.makeMessage(P.MSG.HELLO_ACK, {
        accepted: false, reason: P.HELLO_REASON.BAD_TOKEN, server: this.server.selfDevice(),
      }, this.server.self.deviceId));
      this.close('bad_token');
      return;
    }

    // 2) 请求配对：校验 6 位匹配码或二维码临时令牌
    if (auth.mode === 'pair') {
      const okCode = auth.pairCode && this.server.verifyPairCode(auth.pairCode);
      const okToken = auth.token && this.server.verifyQrToken(auth.token);
      if (okCode || okToken) {
        this.paired = true;
        this.authMode = 'pair';
        const token = P.signToken(this.server.deviceSecret, this.peerDevice ? this.peerDevice.deviceId : 'unknown', Date.now(), 0);
        const record = this.server.trust(this.peerDevice ? this.peerDevice.deviceId : 'unknown', this.peerDevice);
        this.send(P.makeMessage(P.MSG.HELLO_ACK, {
          accepted: true,
          reason: P.HELLO_REASON.PAIRED,
          server: this.server.selfDevice(),
          token,                       // 下发长期令牌，手机端保存
          expiresAt: 0,
        }, this.server.self.deviceId));
        this.emit('device:connected', { sessionId: this.id, device: this.peerDevice, authMode: 'pair', record });
        return;
      }
      this.send(P.makeMessage(P.MSG.HELLO_ACK, {
        accepted: false, reason: P.HELLO_REASON.NEED_PAIR, server: this.server.selfDevice(),
      }, this.server.self.deviceId));
      this.emit('pair:failed', { sessionId: this.id, device: this.peerDevice, reason: 'bad_code' });
      this.close('need_pair');
      return;
    }

    // 3) 匿名连接：一律拒绝（协议要求未配对设备拒绝连接）
    this.send(P.makeMessage(P.MSG.HELLO_ACK, {
      accepted: false, reason: P.HELLO_REASON.NEED_PAIR, server: this.server.selfDevice(),
    }, this.server.self.deviceId));
    this.close('not_paired');
  }

  _onPairRequest(msg) {
    // 已握手成功又发 pair_request：补发令牌
    if (!this.paired) {
      this.send(P.makeMessage(P.MSG.PAIR_RESULT, { ok: false, reason: 'not_authenticated' }, this.server.self.deviceId));
      return;
    }
    const token = P.signToken(this.server.deviceSecret, msg.deviceId || 'unknown', Date.now(), 0);
    this.send(P.makeMessage(P.MSG.PAIR_RESULT, { ok: true, token, expiresAt: 0 }, this.server.self.deviceId));
  }

  _requirePaired() {
    if (!this.paired) {
      this.send(P.makeMessage(P.MSG.ERROR, { code: P.ERR.NOT_PAIRED, message: '设备未配对' }, this.server.self.deviceId));
      return false;
    }
    return true;
  }

  // ── 接收文件（手机 → 电脑） ──────────────────────────────────

  async _onSendOffer(msg) {
    if (!this._requirePaired()) return;
    const files = Array.isArray(msg.files) ? msg.files : [];
    if (!files.length) return;

    const offer = {
      sessionId: this.id,
      transferId: msg.transferId,
      device: this.peerDevice,
      files,
      totalBytes: msg.totalBytes || files.reduce((a, f) => a + (f.size || 0), 0),
      saveDir: this.server.saveDir,
    };
    this.pendingOffer = offer;
    // 交给 UI，等用户确认（协议 §6.2：接收方必须由用户确认）
    this.emit('offer:incoming', offer);
  }

  /** 由 UI 调用：用户点「接受」 */
  async acceptOffer(transferId, { resume = true } = {}) {
    const offer = this.pendingOffer;
    if (!offer || offer.transferId !== transferId) return { ok: false, reason: 'no_such_offer' };
    this.pendingOffer = null;

    const transfer = this.server.createTransfer({
      transferId: offer.transferId,
      direction: 'receive',
      device: this.peerDevice,
      files: offer.files,
      totalBytes: offer.totalBytes,
    });
    transfer.status = 'active';

    const resumeList = [];
    for (const f of offer.files) {
      if (f.isDir) {
        // 目录标记：直接建目录
        const dir = path.join(this.server.saveDir, P.sanitizeRelPath(f.relPath, f.name));
        await fsp.mkdir(dir, { recursive: true }).catch(() => {});
        transfer.files.find((x) => x.fileId === f.fileId).status = 'done';
        continue;
      }
      const rec = new FileReceiver({ meta: f, saveDir: this.server.saveDir, transferId: offer.transferId });
      await rec.open();
      if (resume && rec.receivedBytes > 0 && rec.receivedBytes < f.size) {
        rec.resumeToken = 'rs_' + Math.random().toString(16).slice(2, 8);
        resumeList.push({ fileId: f.fileId, receivedBytes: rec.receivedBytes, resumeToken: rec.resumeToken });
      } else if (rec.receivedBytes >= f.size && f.size > 0) {
        // 已经收完过：直接完成
        await rec.finish();
      }
      this.receivers.set(f.fileId, rec);
      this._wireReceiver(rec, transfer, f);
    }

    this.send(P.makeMessage(P.MSG.SEND_ACCEPT, {
      transferId: offer.transferId,
      acceptedBy: this.server.self.name,
      resume: resumeList,
      saveTo: this.server.saveDir,
    }, this.server.self.deviceId));

    this.server.emit('transfer:start', { transferId: offer.transferId, direction: 'receive', transfer });
    return { ok: true, resume: resumeList };
  }

  /** 由 UI 调用：用户点「拒绝」 */
  rejectOffer(transferId, reason = 'user_denied') {
    const offer = this.pendingOffer;
    if (!offer || offer.transferId !== transferId) return { ok: false };
    this.pendingOffer = null;
    this.send(P.makeMessage(P.MSG.SEND_REJECT, { transferId, reason }, this.server.self.deviceId));
    this.emit('offer:rejected', { transferId, reason });
    return { ok: true };
  }

  _wireReceiver(rec, transfer, f) {
    const item = transfer.files.find((x) => x.fileId === f.fileId);
    rec.on('progress', (p) => {
      item.transferredBytes = p.transferredBytes;
      item.speed = p.speed;
      item.etaMs = p.etaMs;
      transfer.transferredBytes = transfer.files.reduce((a, x) => a + (x.transferredBytes || 0), 0);
      transfer.speed = p.speed;
      this.server.emit('transfer:progress', {
        transferId: transfer.transferId,
        fileId: f.fileId,
        transferredBytes: p.transferredBytes,
        totalBytes: p.totalBytes,
        speed: p.speed,
        etaMs: p.etaMs,
        overall: transfer.transferredBytes,
        overallTotal: transfer.totalBytes,
      });
    });
    rec.on('error', (e) => {
      this.send(P.makeMessage(P.MSG.ERROR, { transferId: transfer.transferId, fileId: f.fileId, code: P.ERR.WRITE_FAILED, message: String(e.message || e) }, this.server.self.deviceId));
      this.server.emit('transfer:error', { transferId: transfer.transferId, fileId: f.fileId, message: String(e.message || e) });
    });
  }

  /** 二进制分片到达 */
  _onBinary(frame) {
    const rec = this.receivers.get(frame.fileId);
    if (!rec) return;   // 未确认的 offer 或未知文件：丢弃
    // writeChunk 内部串行化，这里直接把后续处理挂在同一条链上，
    // 避免「收满最后一片」与「收尾 rename」并发执行
    const task = rec.writeChunk(frame).then(async ({ needAck }) => {
      if (needAck) {
        this.send(P.makeMessage(P.MSG.CHUNK_ACK, {
          transferId: rec.transferId,
          fileId: frame.fileId,
          ackedSeq: rec.ackedSeq,
          receivedBytes: rec.receivedBytes,
        }, this.server.self.deviceId));
      }
      if (rec.receivedBytes >= rec.meta.size && !rec.finished && !rec._finishPromise) {
        const r = await rec.finish();
        const transfer = this.server.getTransfer(rec.transferId);
        if (transfer) {
          const item = transfer.files.find((x) => x.fileId === frame.fileId);
          if (item) { item.status = r.ok ? 'done' : 'failed'; item.path = r.path; }
          transfer.doneBytes = transfer.files.filter((x) => x.status === 'done').reduce((a, x) => a + x.size, 0);
        }
        this.send(P.makeMessage(P.MSG.COMPLETE, {
          transferId: rec.transferId, fileId: frame.fileId, path: r.path, size: r.size || rec.receivedBytes,
        }, this.server.self.deviceId));
        this.server.emit('transfer:file-complete', {
          transferId: rec.transferId, fileId: frame.fileId, path: r.path, ok: r.ok, reason: r.reason,
        });
        this._maybeFinishReceive(transfer);
      }
    }).catch((e) => {
      this.server.emit('transfer:error', { transferId: rec.transferId, fileId: frame.fileId, message: String(e.message || e) });
    });
    // 保持链路引用，便于取消时等待
    rec._tail = task;
  }

  _maybeFinishReceive(transfer) {
    if (!transfer) return;
    const all = transfer.files.every((f) => f.status === 'done' || f.status === 'failed' || f.isDir);
    if (!all) return;
    const anyFailed = transfer.files.some((f) => f.status === 'failed');
    transfer.status = anyFailed ? 'failed' : 'done';
    transfer.finishedAt = Date.now();
    transfer.durationMs = transfer.finishedAt - transfer.startedAt;
    this.server.emit('transfer:complete', { transferId: transfer.transferId, direction: 'receive', transfer });
  }

  // ── 发送文件（电脑 → 手机） ──────────────────────────────────

  /**
   * 主动向手机端发送
   * @param {string[]} absPaths
   */
  async startSend(absPaths, opts = {}) {
    if (!this._requirePaired()) return { ok: false, reason: 'not_paired' };
    const list = await buildSendList(absPaths, { ...opts, checksum: opts.checksum || (this.peerDevice && this.peerDevice.type === 'mobile') });
    if (!list.length) return { ok: false, reason: 'empty' };
    this._sendOpts = { maxBytesPerSec: opts.maxBytesPerSec || 0 };

    const transferId = 't_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
    const files = list.map((x) => x.meta);
    const totalBytes = files.reduce((a, f) => a + f.size, 0);

    const transfer = this.server.createTransfer({
      transferId, direction: 'send', device: this.peerDevice, files, totalBytes, localPaths: list,
    });
    this._inflightSend = { transfer, list };
    transfer.status = 'offered';

    this.send(P.makeMessage(P.MSG.SEND_OFFER, {
      transferId, files, totalBytes,
    }, this.server.self.deviceId));

    this.server.emit('transfer:offered', { transferId, transfer });
    // 等待对方 send_accept / send_reject（超时 60s 自动失败）
    const timer = setTimeout(() => {
      if (transfer.status === 'offered') {
        transfer.status = 'failed';
        transfer.error = 'timeout';
        this.server.emit('transfer:complete', { transferId, direction: 'send', transfer });
      }
    }, 60000);
    this._offerTimer = timer;
    return { ok: true, transferId, files: files.length, totalBytes };
  }

  async _onSendAccept(msg) {
    const inflight = this._inflightSend;
    if (!inflight || inflight.transfer.transferId !== msg.transferId) return;
    if (this._offerTimer) { clearTimeout(this._offerTimer); this._offerTimer = null; }

    const { transfer, list } = inflight;
    transfer.status = 'active';
    transfer.saveTo = msg.saveTo || '';
    transfer.acceptedBy = msg.acceptedBy || '';

    const resumeMap = new Map((msg.resume || []).map((r) => [r.fileId, r]));
    this.server.emit('transfer:start', { transferId: transfer.transferId, direction: 'send', transfer });

    // 串行发送每个文件（协议 §6.1：逐个文件串行）
    (async () => {
      for (const entry of list) {
        const { meta, filePath } = entry;
        const item = transfer.files.find((x) => x.fileId === meta.fileId);
        const r = resumeMap.get(meta.fileId);

        if (meta.isDir) { item.status = 'done'; continue; }

        // 断点续传：起始分片号
        let startSeq = 0;
        if (r && r.receivedBytes > 0 && r.receivedBytes < meta.size) {
          startSeq = Math.floor(r.receivedBytes / (meta.chunkSize || P.DEFAULT_CHUNK_SIZE));
        }
        item.resumedFrom = startSeq;

        // 等待该文件被 ack 或完成
        const sender = new FileSender({
          filePath, meta, startSeq,
          maxBytesPerSec: this._sendOpts && this._sendOpts.maxBytesPerSec,
          write: (buf) => new Promise((resolve, reject) => {
            const ok = this.sock.write(buf, (err) => (err ? reject(err) : resolve()));
            if (!ok) this.sock.once('drain', resolve);
          }),
        });

        this.senders.set(meta.fileId, sender);
        sender.on('progress', (p) => {
          item.transferredBytes = p.transferredBytes;
          item.speed = p.speed;
          item.etaMs = p.etaMs;
          transfer.transferredBytes = transfer.files.reduce((a, x) => a + (x.transferredBytes || 0), 0);
          transfer.speed = p.speed;
          this.server.emit('transfer:progress', {
            transferId: transfer.transferId, fileId: meta.fileId,
            transferredBytes: p.transferredBytes, totalBytes: p.totalBytes,
            speed: p.speed, etaMs: p.etaMs,
            overall: transfer.transferredBytes, overallTotal: transfer.totalBytes,
          });
        });

        const res = await sender.run();
        this.senders.delete(meta.fileId);

        if (res.ok) {
          item.status = 'done';
          item.transferredBytes = meta.size;
          // 发 complete，等对方回 complete 为最终确认
          this.send(P.makeMessage(P.MSG.COMPLETE, {
            transferId: transfer.transferId, fileId: meta.fileId, path: meta.relPath, size: meta.size,
          }, this.server.self.deviceId));
        } else {
          item.status = 'failed';
          break;   // 中断后续文件
        }
      }

      const anyFailed = transfer.files.some((x) => x.status === 'failed' || x.status === 'pending');
      transfer.status = anyFailed ? 'failed' : 'done';
      transfer.finishedAt = Date.now();
      transfer.durationMs = transfer.finishedAt - transfer.startedAt;
      this.server.emit('transfer:complete', { transferId: transfer.transferId, direction: 'send', transfer });
    })().catch((e) => {
      transfer.status = 'failed';
      transfer.error = String(e.message || e);
      this.server.emit('transfer:error', { transferId: transfer.transferId, message: String(e.message || e) });
      this.server.emit('transfer:complete', { transferId: transfer.transferId, direction: 'send', transfer });
    });
  }

  _onSendReject(msg) {
    const inflight = this._inflightSend;
    if (!inflight) return;
    if (this._offerTimer) { clearTimeout(this._offerTimer); this._offerTimer = null; }
    inflight.transfer.status = 'rejected';
    inflight.transfer.error = msg.reason || 'rejected';
    this.server.emit('transfer:complete', { transferId: msg.transferId, direction: 'send', transfer: inflight.transfer });
  }

  _onChunkAck(msg) {
    // 记录对端确认位置（用于断线后精准续传）
    const t = this.server.getTransfer(msg.transferId);
    if (!t) return;
    const item = t.files.find((x) => x.fileId === msg.fileId);
    if (item) { item.ackedSeq = msg.ackedSeq; item.peerReceivedBytes = msg.receivedBytes; }
  }

  _onPeerProgress(msg) {
    const t = this.server.getTransfer(msg.transferId);
    if (!t) return;
    this.server.emit('transfer:peer-progress', msg);
  }

  _onPeerComplete(msg) {
    const t = this.server.getTransfer(msg.transferId);
    if (t) t.peerCompletedAt = Date.now();
  }

  _onCancel(msg) {
    const t = this.server.getTransfer(msg.transferId);
    if (t) { t.status = 'cancelled'; t.error = msg.reason || 'cancelled'; }
    for (const s of this.senders.values()) s.cancel();
    for (const r of this.receivers.values()) r.cancel(msg.keepPartial !== false).catch(() => {});
    this.server.emit('transfer:cancelled', { transferId: msg.transferId, by: msg.by, transfer: t });
  }

  /** UI 调用：取消发送中/接收中的传输 */
  cancelTransfer(transferId, opts = {}) {
    const t = this.server.getTransfer(transferId);
    if (!t) return { ok: false };
    for (const s of this.senders.values()) s.cancel();
    for (const r of this.receivers.values()) r.cancel(opts.keepPartial !== false).catch(() => {});
    this.send(P.makeMessage(P.MSG.CANCEL, {
      transferId, by: 'receiver', reason: opts.reason || 'user_cancelled', keepPartial: opts.keepPartial !== false,
    }, this.server.self.deviceId));
    if (t) { t.status = 'cancelled'; t.error = opts.reason || 'user_cancelled'; }
    this.server.emit('transfer:cancelled', { transferId, by: 'local', transfer: t });
    return { ok: true };
  }
}

// ─────────────────────────────────────────────────────────────

class TransferServer extends EventEmitter {
  constructor(opts) {
    super();
    this.self = opts.self;                     // { deviceId, name, type, os, fingerprint }
    this.deviceSecret = opts.deviceSecret;     // 用于签发/校验令牌
    this.port = opts.port || P.PORT;
    this.httpPort = opts.httpPort || (this.port + 1);
    this.saveDir = opts.saveDir;
    this.sessions = new Map();
    this.trusted = new Map(opts.trusted || []);   // deviceId -> record
    this.transfers = new Map();                    // transferId -> transfer 记录
    this.history = [];                             // 传输历史（内存 + 持久化由上层负责）
    this._server = null;
    this._http = null;
    this._wss = null;
    this._pairCodes = new Map();                   // code -> { expiresAt }
    this._qrTokens = new Map();                    // token -> { expiresAt }
    /** WebRTC/WS 网关：手机端浏览器场景的降级通道 */
    this.enableHttpGateway = opts.enableHttpGateway !== false;
  }

  selfDevice() {
    return {
      deviceId: this.self.deviceId,
      name: this.self.name,
      type: this.self.type || 'desktop',
      os: this.self.os,
      ip: this.self.ip,
      port: this.port,
      protocol: P.PROTOCOL_ID,
      pairingRequired: true,
      fingerprint: this.self.fingerprint || '',
    };
  }

  listen() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => {
        const s = new Session(sock, { server: this });
        this.sessions.set(s.id, s);
        s.on('disconnected', (info) => { this.sessions.delete(s.id); this.emit('device:disconnected', info); });
        s.on('session:error', (e) => this.emit('session:error', { sessionId: s.id, message: String(e.message || e) }));
        ['device:connected', 'pair:failed', 'offer:incoming', 'offer:rejected'].forEach((ev) =>
          s.on(ev, (p) => this.emit(ev, p)));
        this.emit('session:new', { sessionId: s.id, remote: s.sock.remoteAddress });
      });
      srv.on('error', reject);
      srv.listen(this.port, '0.0.0.0', () => {
        this._server = srv;
        this.emit('listening', { port: this.port });
        // 主通道就绪后再拉辅助 HTTP 网关（失败不影响主通道）
        if (this.enableHttpGateway) {
          this.listenHttp().then((r) => this.emit('http:ready', r));
        }
        resolve({ port: this.port });
      });
    });
  }

  close() {
    for (const s of this.sessions.values()) s.close();
    if (this._server) { try { this._server.close(); } catch (_) {} this._server = null; }
    if (this._wss) { try { this._wss.close(); } catch (_) {} this._wss = null; }
    if (this._http) { try { this._http.close(); } catch (_) {} this._http = null; }
  }

  // ─────────────────────────────────────────────────────────────
  // HTTP / WebSocket 网关
  //
  // 为什么要它：手机端若以「浏览器 / 普通 WebView」形态运行，无法发起原始
  // TCP 连接，也无法做 UDP 组播。为此电脑端额外开一个轻量 HTTP 服务：
  //   GET  /probe            → 返回本机设备信息（供手机端扫描网段时探测）
  //   WS   /ws               → 把二进制帧透传进同一条 TCP 会话管线
  //   GET  /ping             → 健康检查
  // 所有业务消息仍复用 LTP/1 的编解码，两端逻辑不分叉。
  // ─────────────────────────────────────────────────────────────
  listenHttp() {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this._onHttp(req, res));
      srv.on('error', (e) => {
        // 端口冲突不致命：TCP 主通道仍可用
        this.emit('http:error', { message: String(e.message || e), code: e.code });
        resolve({ port: this.httpPort, degraded: true });
      });
      srv.listen(this.httpPort, '0.0.0.0', () => {
        this._http = srv;
        this._setupWebSocket(srv);
        this.emit('http:listening', { port: this.httpPort });
        resolve({ port: this.httpPort });
      });
    });
  }

  _onHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (url.pathname === '/ping') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, name: this.self.name, protocol: P.PROTOCOL_ID }));
    }

    // 手机端扫描网段时打这个端点，判断该 IP 是否为「局域网互传」电脑端
    if (url.pathname === '/probe') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        device: this.selfDevice(),
        pairingRequired: true,
        // 提示手机端：可用 ws 通道（同端口）
        wsPath: '/ws',
      }));
    }

    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  }

  /**
   * 极简 WebSocket 服务端（避免引入 ws 依赖，手写握手 + 帧解析）。
   * 仅需支持二进制帧与文本帧的收发，够用即可。
   */
  _setupWebSocket(srv) {
    srv.on('upgrade', (req, sock) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws') { sock.destroy(); return; }
      const key = req.headers['sec-websocket-key'];
      if (!key) { sock.destroy(); return; }

      const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      sock.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      this.emit('http:ws-open', { remote: sock.remoteAddress });

      // 用同一条会话管线：把 WS 收到的数据喂给解码器，把出站数据封成 WS 帧
      const session = new WsSession(sock, { server: this });
      this.sessions.set(session.id, session);
      session.on('disconnected', (info) => {
        this.sessions.delete(session.id);
        this.emit('device:disconnected', info);
      });
      session.on('session:error', (e) =>
        this.emit('session:error', { sessionId: session.id, message: String(e.message || e) }));
      ['device:connected', 'pair:failed', 'offer:incoming', 'offer:rejected']
        .forEach((ev) => session.on(ev, (p) => this.emit(ev, p)));
    });
  }

  // ── 配对码 / 二维码令牌 ─────────────────────────────────────

  /** 生成并注册 6 位匹配码（5 分钟有效） */
  newPairCode() {
    this._gcPairing();
    let code;
    do { code = P.makePairCode(); } while (this._pairCodes.has(code));
    this._pairCodes.set(code, { expiresAt: Date.now() + P.PAIR_CODE_TTL_MS });
    return code;
  }

  verifyPairCode(code) {
    this._gcPairing();
    const rec = this._pairCodes.get(String(code));
    if (!rec) return false;
    if (Date.now() > rec.expiresAt) { this._pairCodes.delete(String(code)); return false; }
    return true;
  }

  /** 一次性二维码令牌 */
  newQrToken() {
    this._gcPairing();
    const token = P.makeQrToken();
    this._qrTokens.set(token, { expiresAt: Date.now() + P.QR_TOKEN_TTL_MS });
    return token;
  }

  verifyQrToken(token) {
    this._gcPairing();
    const rec = this._qrTokens.get(String(token));
    if (!rec) return false;
    if (Date.now() > rec.expiresAt) { this._qrTokens.delete(String(token)); return false; }
    return true;
  }

  _gcPairing() {
    const now = Date.now();
    for (const [k, v] of this._pairCodes) if (now > v.expiresAt) this._pairCodes.delete(k);
    for (const [k, v] of this._qrTokens) if (now > v.expiresAt) this._qrTokens.delete(k);
  }

  /** 二维码内容（协议 §5） */
  makeQrPayload() {
    const token = this.newQrToken();
    return {
      token,
      payload: P.encodeQrPayload({
        ip: this.self.ip,
        port: this.port,
        token,
        name: this.self.name,
        deviceId: this.self.deviceId,
      }),
    };
  }

  // ── 信任设备 ────────────────────────────────────────────────

  trust(deviceId, device) {
    if (!deviceId) return null;
    const rec = {
      deviceId,
      name: (device && device.name) || (this.trusted.get(deviceId) || {}).name || deviceId,
      type: (device && device.type) || 'mobile',
      fingerprint: (device && device.fingerprint) || '',
      trustedAt: (this.trusted.get(deviceId) || {}).trustedAt || Date.now(),
      lastSeenAt: Date.now(),
    };
    this.trusted.set(deviceId, rec);
    this.emit('trust:changed', { trusted: [...this.trusted.values()] });
    return rec;
  }

  untrust(deviceId) {
    const ok = this.trusted.delete(deviceId);
    if (ok) this.emit('trust:changed', { trusted: [...this.trusted.values()] });
    return ok;
  }

  listTrusted() { return [...this.trusted.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt); }

  // ── 传输记录 ────────────────────────────────────────────────

  createTransfer({ transferId, direction, device, files, totalBytes, localPaths }) {
    const t = {
      transferId,
      direction,                    // 'send' | 'receive'
      device: device ? { deviceId: device.deviceId, name: device.name, type: device.type } : null,
      files: files.map((f) => ({
        fileId: f.fileId,
        name: f.name,
        size: f.size,
        relPath: f.relPath,
        mime: f.mime,
        isDir: !!f.isDir,
        status: 'pending',
        transferredBytes: 0,
        speed: 0,
        etaMs: null,
        path: null,
      })),
      totalBytes,
      transferredBytes: 0,
      speed: 0,
      status: 'pending',
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      error: null,
      localPaths: localPaths || null,
      saveTo: null,
    };
    this.transfers.set(transferId, t);
    return t;
  }

  getTransfer(id) { return this.transfers.get(id); }

  /** 归档到历史 */
  archive(transferId) {
    const t = this.transfers.get(transferId);
    if (!t) return null;
    if (!this.history.find((h) => h.transferId === transferId)) this.history.unshift(t);
    if (this.history.length > 500) this.history.length = 500;
    return t;
  }

  listHistory() { return this.history; }

  listTransfers() { return [...this.transfers.values()]; }

  /** 找当前已连接的会话 */
  sessionOf(deviceId) {
    for (const s of this.sessions.values()) {
      if (s.paired && s.peerDevice && s.peerDevice.deviceId === deviceId) return s;
    }
    return null;
  }

  /**
   * 取「当前活跃」会话。
   * 优先返回有待确认 offer 的会话（接收确认必须回给正确的对端），
   * 其次返回最近一次活动的已配对会话。
   */
  activeSession() {
    let fallback = null;
    for (const s of this.sessions.values()) {
      if (!s.paired) continue;
      if (s.pendingOffer) return s;                     // 有等待确认的 offer，优先
      if (!fallback || s.createdAt > fallback.createdAt) fallback = s;
    }
    return fallback;
  }

  /** 按 sessionId 精确取会话 */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /** 取某个 transferId 所属的会话 */
  sessionOfTransfer(transferId) {
    for (const s of this.sessions.values()) {
      if (s.pendingOffer && s.pendingOffer.transferId === transferId) return s;
      if (s.receivers.size && [...s.receivers.values()].some((r) => r.transferId === transferId)) return s;
      if (s._inflightSend && s._inflightSend.transfer.transferId === transferId) return s;
    }
    return null;
  }

  allSessions() {
    return [...this.sessions.values()].filter((s) => s.paired).map((s) => ({
      sessionId: s.id,
      device: s.peerDevice,
      authMode: s.authMode,
      remote: s.sock.remoteAddress,
    }));
  }
}

// ─────────────────────────────────────────────────────────────
// WebSocket 会话：复用 Session 的全部协议逻辑，只替换字节通道
//
// Session 通过 this.sock.write(buf) 写出、绑定 'data'/'close' 事件；
// 这里用一个「假 socket」把这两件事桥接到 WebSocket 帧上即可，
// 协议处理代码一行都不用改。
// ─────────────────────────────────────────────────────────────

class WsSession extends Session {
  constructor(sock, opts) {
    const bridge = makeWsSocketBridge(sock);
    super(bridge, opts);
    this._ws = sock;
    bridge.once('close', () => { /* 已由 Session 处理 */ });
  }
}

/**
 * 把原始 TCP socket 包装成 WebSocket 帧通道：
 * 对上层表现为标准 net.Socket（write / on('data') / destroy / setNoDelay …）
 */
function makeWsSocketBridge(wsSock) {
  const EventEmitter = require('events');
  const bridge = new EventEmitter();
  bridge.remoteAddress = wsSock.remoteAddress;
  bridge.remotePort = wsSock.remotePort;

  bridge.setNoDelay = () => {};
  bridge.setKeepAlive = () => {};
  bridge.once = bridge.once.bind(bridge);

  // 上层 write(buf) → 封成 WS 二进制帧
  bridge.write = (buf, cb) => {
    try {
      wsSock.write(encodeWsFrame(buf, 0x2));   // 0x2 = binary
      if (typeof cb === 'function') cb();
      return true;
    } catch (e) {
      bridge.emit('error', e);
      if (typeof cb === 'function') cb(e);
      return false;
    }
  };

  bridge.end = () => { try { wsSock.write(encodeWsFrame(Buffer.alloc(0), 0x8)); } catch (_) {} };
  bridge.destroy = () => { try { wsSock.destroy(); } catch (_) {} };

  // WS 帧 → 还原为字节流喂给上层
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = decodeWsFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.consumed);
      if (frame.opcode === 0x8) {                              // close
        try { wsSock.end(); } catch (_) {}
        bridge.emit('close');
        return;
      }
      if (frame.opcode === 0x9) {                              // ping → pong
        try { wsSock.write(encodeWsFrame(frame.payload, 0xa)); } catch (_) {}
        continue;
      }
      if (frame.opcode === 0x1) {                              // text → 当作 UTF-8 字节
        bridge.emit('data', Buffer.from(frame.payload));
        continue;
      }
      if (frame.opcode === 0x2 || frame.opcode === 0x0) {      // binary / continuation
        bridge.emit('data', Buffer.from(frame.payload));
        continue;
      }
    }
  };

  wsSock.on('data', onData);
  wsSock.on('close', () => bridge.emit('close'));
  wsSock.on('error', (e) => bridge.emit('error', e));

  return bridge;
}

/** 编码一个 WebSocket 帧（服务端 → 客户端，不加掩码） */
function encodeWsFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f);      // FIN + opcode
  return Buffer.concat([header, data]);
}

/** 从缓冲区头部尝试解析一个客户端帧（带掩码），返回 {opcode, payload, consumed} */
function decodeWsFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2), lo = buf.readUInt32BE(6);
    if (hi !== 0) return null;             // 超过 4GB，本项目用不到
    len = lo; off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode, payload, consumed: off + len };
}

module.exports = { TransferServer, Session, WsSession };
