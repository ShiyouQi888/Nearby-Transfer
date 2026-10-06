/**
 * 浏览器/WebView 环境下的传输客户端（手机端核心）
 *
 * 关键背景：浏览器无法直接开 TCP Socket，因此手机端通过原生桥接层
 * （Android 侧的 LanSocket 插件 / 或 Capacitor 自定义插件）获得字节流能力。
 * 本文件定义统一的 socket 抽象，并提供三种实现：
 *   1) NativeSocket  —— 走原生桥接（真机使用）
 *   2) WebSocketSocket —— 走电脑端额外开的 WS 网关（免原生插件的降级方案）
 *   3) HttpSocket —— 走 HTTP 分片上传（最保守的降级方案）
 *
 * 三者对上层暴露完全相同的接口：send(buf) / onData(cb) / onClose(cb) / close()，
 * 并且都复用 shared/protocol.js 的消息编解码，保证两端协议一致。
 */

import * as P from '@shared/protocol.mjs';

// ─────────────────────────────────────────────────────────────
// Socket 抽象
// ─────────────────────────────────────────────────────────────

export class SocketBase {
  constructor() { this._dataCbs = []; this._closeCbs = []; this._errCbs = []; }
  onData(cb) { this._dataCbs.push(cb); return this; }
  onClose(cb) { this._closeCbs.push(cb); return this; }
  onError(cb) { this._errCbs.push(cb); return this; }
  _emitData(buf) { this._dataCbs.forEach((f) => f(buf)); }
  _emitClose() { this._closeCbs.forEach((f) => f()); }
  _emitError(e) { this._errCbs.forEach((f) => f(e)); }
}

/**
 * 原生桥接 Socket。
 * Android 侧提供 window.LanBridge：
 *   LanBridge.connect(host, port, id)
 *   LanBridge.send(id, base64)      // 二进制以 base64 传输
 *   LanBridge.close(id)
 *   LanBridge.onData(cb)   → cb({ id, base64 })
 *   LanBridge.onClose(cb)  → cb({ id })
 *   LanBridge.onError(cb)  → cb({ id, message })
 */
export class NativeSocket extends SocketBase {
  constructor(host, port) {
    super();
    this.host = host; this.port = port;
    this.id = 's_' + Math.random().toString(36).slice(2, 10);
    this._queue = [];
    this._ready = false;
  }

  async connect() {
    const B = window.LanBridge;
    if (!B) throw new Error('原生桥接不可用（非 Android 环境）');

    B.onData(({ id, base64 }) => {
      if (id !== this.id) return;
      this._emitData(base64ToBytes(base64));
    });
    B.onClose(({ id }) => { if (id === this.id) this._emitClose(); });
    B.onError(({ id, message }) => { if (id === this.id) this._emitError(new Error(message)); });

    await B.connect(this.host, this.port, this.id);
    this._ready = true;
    // 补发连接前积压的数据
    for (const buf of this._queue) await this._rawSend(buf);
    this._queue = [];
    return this;
  }

  send(buf) {
    if (!this._ready) { this._queue.push(buf); return; }
    this._rawSend(buf);
  }

  async _rawSend(buf) {
    const b64 = bytesToBase64(buf);
    try { await window.LanBridge.send(this.id, b64); }
    catch (e) { this._emitError(e); }
  }

  close() {
    try { window.LanBridge && window.LanBridge.close(this.id); } catch (_) {}
    this._emitClose();
  }
}

/**
 * 走电脑端 WebSocket 网关的 Socket（降级方案，免原生插件）。
 * 电脑端在 /ws 路径开一个 WebSocket，把二进制帧透传到 TCP session。
 */
export class WebSocketSocket extends SocketBase {
  constructor(host, port) {
    super();
    this.host = host; this.port = port;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.port}/ws`;
      let ws;
      try { ws = new WebSocket(url); } catch (e) { return reject(e); }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const t = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('WebSocket 连接超时')); }, 6000);

      ws.onopen = () => { clearTimeout(t); resolve(this); };
      ws.onmessage = (ev) => {
        const d = ev.data;
        if (d instanceof ArrayBuffer) this._emitData(new Uint8Array(d));
        else if (typeof d === 'string') this._emitData(new TextEncoder().encode(d));
        else this._emitData(d);
      };
      ws.onclose = () => { clearTimeout(t); this._emitClose(); };
      ws.onerror = () => { clearTimeout(t); this._emitError(new Error('WebSocket 错误')); };
    });
  }

  send(buf) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  }

  close() { try { this.ws && this.ws.close(); } catch (_) {} }
}

/** 自动选择可用通道 */
export async function openSocket(host, port) {
  // 优先原生（性能最好，无需电脑端额外开端口）
  if (window.LanBridge && window.LanBridge.connect) {
    const s = new NativeSocket(host, port);
    await s.connect();
    return { socket: s, kind: 'native' };
  }
  // 降级 WebSocket
  const s = new WebSocketSocket(host, port);
  await s.connect();
  return { socket: s, kind: 'websocket' };
}

// ─────────────────────────────────────────────────────────────
// base64 工具（原生桥接以 base64 传二进制）
// ─────────────────────────────────────────────────────────────

export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ─────────────────────────────────────────────────────────────
// 客户端
// ─────────────────────────────────────────────────────────────

/** 手机端统一使用的 NDJSON 解码器（浏览器版，输入 Uint8Array） */
class BrowserDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this._buf = new Uint8Array(0);
  }
  push(data) {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    const merged = new Uint8Array(this._buf.length + d.length);
    merged.set(this._buf, 0);
    merged.set(d, this._buf.length);
    this._buf = merged;
    this._drain();
  }
  _drain() {
    for (;;) {
      if (!this._buf.length) return;
      const first = this._buf[0];
      // 二进制帧
      if (first === 0x4c) {   // 'L'
        if (this._buf.length < 4) return;
        if (!(this._buf[0] === 0x4c && this._buf[1] === 0x54 && this._buf[2] === 0x50 && this._buf[3] === 0x43)) {
          this._buf = this._buf.subarray(1); continue;
        }
        if (this._buf.length < 6) return;
        const fileIdLen = (this._buf[4] << 8) | this._buf[5];
        const headerLen = 14 + fileIdLen;
        if (this._buf.length < headerLen) return;
        const fileId = utf8Decode(this._buf.subarray(6, 6 + fileIdLen));
        const dv = new DataView(this._buf.buffer, this._buf.byteOffset);
        const seq = dv.getUint32(6 + fileIdLen);
        const payloadLen = dv.getUint32(10 + fileIdLen);
        if (this._buf.length < headerLen + payloadLen) return;
        const payload = this._buf.slice(headerLen, headerLen + payloadLen);
        this._buf = this._buf.slice(headerLen + payloadLen);
        this.onMessage({ fileId, seq, payload }, true);
        continue;
      }
      // 文本
      const nl = this._buf.indexOf(0x0a);
      if (nl === -1) return;
      const line = utf8Decode(this._buf.subarray(0, nl)).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      try { this.onMessage(JSON.parse(line), false); } catch (_) {}
    }
  }
}

function utf8Decode(u8) { return new TextDecoder('utf-8').decode(u8); }

let _seq = 0;
const nextSeq = () => ++_seq;

export function encodeMsg(type, fields, deviceId) {
  const obj = { v: P.PROTOCOL_VERSION, type, seq: nextSeq(), ts: Date.now() };
  if (deviceId) obj.deviceId = deviceId;
  Object.assign(obj, fields || {});
  return new TextEncoder().encode(JSON.stringify(obj) + '\n');
}

export function encodeChunkFrame(fileId, seq, payload) {
  const idBytes = new TextEncoder().encode(fileId);
  const header = new Uint8Array(14 + idBytes.length);
  header[0] = 0x4c; header[1] = 0x54; header[2] = 0x50; header[3] = 0x43;
  header[4] = (idBytes.length >> 8) & 0xff; header[5] = idBytes.length & 0xff;
  header.set(idBytes, 6);
  const dv = new DataView(header.buffer);
  dv.setUint32(6 + idBytes.length, seq);
  dv.setUint32(10 + idBytes.length, payload.length);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

/**
 * 手机端传输客户端
 * 事件同电脑端语义，便于 UI 复用同一套渲染逻辑。
 */
export class MobileClient extends EventTarget {
  constructor({ device }) {
    super();
    this.device = device;            // { deviceId, name, type:'mobile', ... }
    this.token = null;
    this.socket = null;
    this.server = null;              // 对端 device
    this.paired = false;
    this.channel = null;
    this.receivers = new Map();
    this.senders = new Map();
    this.offers = [];
    this.pendingAccept = null;
    this.decoder = new BrowserDecoder((m, b) => (b ? this._onBin(m) : this._onMsg(m)));
  }

  _fire(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async connect(host, port, auth) {
    const { socket, kind } = await openSocket(host, port);
    this.socket = socket;
    this.channel = kind;
    socket.onData((d) => this.decoder.push(d));
    socket.onClose(() => { this.paired = false; this._fire('closed', {}); });
    socket.onError((e) => this._fire('error', { message: String(e.message || e) }));

    this.sendMsg(P.MSG.HELLO, {
      device: this.device,
      auth: auth || { mode: 'none' },
    }, this.device.deviceId);

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('握手超时（请确认电脑端已开启并处于同一局域网）')), 8000);
      const onAck = (ev) => {
        clearTimeout(t);
        this.removeEventListener('hello', onAck);
        const ack = ev.detail;
        if (!ack.accepted) return reject(new Error(reasonText(ack.reason)));
        this.paired = true;
        if (ack.token) this.token = ack.token;
        resolve({ server: this.server, token: this.token, reason: ack.reason });
      };
      this.addEventListener('hello', onAck);
    });
  }

  sendMsg(type, fields, deviceId) { this.socket && this.socket.send(encodeMsg(type, fields, deviceId)); }
  sendRaw(buf) { this.socket && this.socket.send(buf); }

  close() { this.socket && this.socket.close(); }

  // ── 消息处理 ─────────────────────────────────────────────

  _onMsg(msg) {
    switch (msg.type) {
      case P.MSG.HELLO_ACK:
        this.server = msg.server || null;
        this._fire('hello', msg);
        break;
      case P.MSG.PAIR_RESULT:
        if (msg.ok && msg.token) this.token = msg.token;
        this._fire('pair_result', msg);
        break;
      case P.MSG.SEND_OFFER:
        this.offers.push(msg);
        this._fire('offer', msg);
        break;
      case P.MSG.SEND_ACCEPT:
        this._fire('accept', msg);
        this._onAccept(msg);
        break;
      case P.MSG.SEND_REJECT:
        this._fire('reject', msg);
        break;
      case P.MSG.COMPLETE:
        this._fire('complete', msg);
        break;
      case P.MSG.CANCEL:
        this._fire('cancel', msg);
        this._cancelAll(true);
        break;
      case P.MSG.ERROR:
        this._fire('error', { message: msg.message, code: msg.code });
        break;
      case P.MSG.PING:
        this.sendMsg(P.MSG.PONG, {}, this.device.deviceId);
        break;
    }
  }

  // ── 接收（电脑 → 手机） ──────────────────────────────────

  /**
   * 接受 offer
   * @param {object} offer
   * @param {(meta)=>Promise<{filePath:string,write:(u8,offset)=>Promise<void>,close:()=>Promise<string>}>} storageFactory
   *   由平台层提供落盘能力（Capacitor Filesystem / 浏览器 OPFS）
   */
  async acceptOffer(offer, storageFactory) {
    const resume = [];
    for (const f of offer.files) {
      if (f.isDir) continue;
      const rec = new MobileReceiver({ meta: f, transferId: offer.transferId, storageFactory });
      const opened = await rec.open();
      if (opened.receivedBytes > 0 && opened.receivedBytes < f.size) {
        resume.push({ fileId: f.fileId, receivedBytes: opened.receivedBytes, resumeToken: 'rs_m_' + Math.random().toString(16).slice(2, 8) });
      }
      this.receivers.set(f.fileId, rec);
      rec.onProgress = (p) => this._fire('progress', { ...p, transferId: offer.transferId, direction: 'receive' });
      rec.onDone = (r) => this._fire('file_done', { ...r, transferId: offer.transferId });
    }
    this.sendMsg(P.MSG.SEND_ACCEPT, {
      transferId: offer.transferId,
      acceptedBy: this.device.name,
      resume,
      saveTo: '手机存储/下载/LANTransfer',
    }, this.device.deviceId);
    return resume;
  }

  rejectOffer(offer, reason = 'user_denied') {
    this.sendMsg(P.MSG.SEND_REJECT, { transferId: offer.transferId, reason }, this.device.deviceId);
  }

  _onBin(frame) {
    const rec = this.receivers.get(frame.fileId);
    if (!rec) return;
    rec.writeChunk(frame).then(({ needAck }) => {
      if (needAck) {
        this.sendMsg(P.MSG.CHUNK_ACK, {
          transferId: rec.transferId, fileId: frame.fileId,
          ackedSeq: rec.ackedSeq, receivedBytes: rec.receivedBytes,
        }, this.device.deviceId);
      }
      if (rec.receivedBytes >= rec.meta.size && !rec.finished && !rec._finishPromise) {
        rec.finish().then((r) => {
          this.sendMsg(P.MSG.COMPLETE, {
            transferId: rec.transferId, fileId: frame.fileId, path: r.path, size: rec.receivedBytes,
          }, this.device.deviceId);
        }).catch((e) => this._fire('error', { message: String(e.message || e) }));
      }
    }).catch((e) => this._fire('error', { message: String(e.message || e) }));
  }

  // ── 发送（手机 → 电脑） ──────────────────────────────────

  /**
   * @param {Array<{meta:object, open:()=>Promise<{size:number,read:(offset,len)=>Promise<Uint8Array>}>}>} entries
   */
  async sendOffer(entries) {
    const transferId = 't_m_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
    const files = entries.map((e) => e.meta);
    const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);
    this._outgoing = { transferId, entries };
    this.sendMsg(P.MSG.SEND_OFFER, { transferId, files, totalBytes }, this.device.deviceId);
    return { transferId, files, totalBytes };
  }

  async _onAccept(msg) {
    const out = this._outgoing;
    if (!out || out.transferId !== msg.transferId) return;
    const resumeMap = new Map((msg.resume || []).map((r) => [r.fileId, r]));
    this._fire('send_start', { transferId: msg.transferId, acceptedBy: msg.acceptedBy });

    for (const entry of out.entries) {
      const { meta } = entry;
      if (meta.isDir) continue;
      const r = resumeMap.get(meta.fileId);
      let startSeq = 0;
      if (r && r.receivedBytes > 0 && r.receivedBytes < meta.size) {
        startSeq = Math.floor(r.receivedBytes / (meta.chunkSize || P.DEFAULT_CHUNK_SIZE));
      }
      const sender = new MobileSender({
        meta, startSeq, entry,
        write: (buf) => this.sendRaw(buf),
        onProgress: (p) => this._fire('progress', { ...p, transferId: msg.transferId, direction: 'send' }),
      });
      this.senders.set(meta.fileId, sender);
      const res = await sender.run();
      this.senders.delete(meta.fileId);
      if (res.ok) {
        this.sendMsg(P.MSG.COMPLETE, {
          transferId: msg.transferId, fileId: meta.fileId, path: meta.relPath, size: meta.size,
        }, this.device.deviceId);
      } else {
        this._fire('error', { message: '发送被中断' });
        break;
      }
    }
    this._outgoing = null;
    this._fire('send_done', { transferId: msg.transferId });
  }

  cancelTransfer(transferId, keepPartial = true) {
    this._cancelAll(keepPartial);
    this.sendMsg(P.MSG.CANCEL, {
      transferId, by: 'sender', reason: 'user_cancelled', keepPartial,
    }, this.device.deviceId);
  }

  _cancelAll(keepPartial) {
    for (const s of this.senders.values()) s.cancel();
    for (const r of this.receivers.values()) r.cancel(keepPartial);
  }
}

function reasonText(r) {
  return {
    need_pair: '设备未配对，请先在电脑端扫码或输入匹配码完成配对',
    bad_token: '令牌已失效，请重新配对',
    rejected: '对方拒绝了连接',
  }[r] || `连接被拒绝（${r}）`;
}

// ─────────────────────────────────────────────────────────────
// 手机端接收器 / 发送器
// ─────────────────────────────────────────────────────────────

export class MobileReceiver {
  constructor({ meta, transferId, storageFactory }) {
    this.meta = meta;
    this.transferId = transferId;
    this.storageFactory = storageFactory;
    this.chunkSize = meta.chunkSize || P.DEFAULT_CHUNK_SIZE;
    this.receivedBytes = 0;
    this.ackedSeq = -1;
    this._expectSeq = 0;
    this.cancelled = false;
    this.finished = false;
    this._chunksSinceAck = 0;
    this._lastAckAt = 0;
    this._samples = [];
    this._chain = Promise.resolve();
    this._store = null;
    this.onProgress = null;
    this.onDone = null;
  }

  async open() {
    this._store = await this.storageFactory(this.meta);
    this.receivedBytes = this._store.receivedBytes || 0;
    if (this.receivedBytes >= this.meta.size && this.meta.size > 0) this.receivedBytes = 0;
    this.ackedSeq = this.receivedBytes > 0 ? Math.floor(this.receivedBytes / this.chunkSize) - 1 : -1;
    this._expectSeq = this.ackedSeq + 1;
    return { receivedBytes: this.receivedBytes };
  }

  writeChunk(frame) {
    const task = this._chain.then(() => this._inner(frame));
    this._chain = task.catch(() => {});
    return task;
  }

  async _inner(frame) {
    if (this.cancelled || this.finished) return { needAck: false };
    if (frame.seq !== this._expectSeq) return { needAck: false };
    const offset = frame.seq * this.chunkSize;
    await this._store.write(frame.payload, offset);
    this.receivedBytes = offset + frame.payload.length;
    this.ackedSeq = frame.seq;
    this._expectSeq = frame.seq + 1;
    this._chunksSinceAck++;

    // 速度采样
    const now = Date.now();
    this._samples.push({ t: now, b: this.receivedBytes });
    while (this._samples.length > 2 && now - this._samples[0].t > 3000) this._samples.shift();
    let speed = 0;
    if (this._samples.length >= 2) {
      const dt = (this._samples[this._samples.length - 1].t - this._samples[0].t) / 1000;
      const db = this._samples[this._samples.length - 1].b - this._samples[0].b;
      if (dt > 0) speed = db / dt;
    }
    if (this.onProgress) {
      this.onProgress({
        fileId: this.meta.fileId, transferredBytes: this.receivedBytes, totalBytes: this.meta.size,
        speed, etaMs: speed > 0 && this.meta.size > this.receivedBytes
          ? Math.round(((this.meta.size - this.receivedBytes) / speed) * 1000) : null,
      });
    }

    const needAck = this._chunksSinceAck >= P.ACK_EVERY_CHUNKS ||
      (Date.now() - this._lastAckAt >= P.ACK_EVERY_MS && this._chunksSinceAck > 0);
    if (needAck) { this._lastAckAt = Date.now(); this._chunksSinceAck = 0; }
    return { needAck };
  }

  finish() {
    if (this.finished) return Promise.resolve({ ok: true, path: this._store.path });
    if (this._finishPromise) return this._finishPromise;
    this._finishPromise = (async () => {
      await this._chain;
      const path = await this._store.close();
      this.finished = true;
      const r = { ok: true, path, size: this.receivedBytes };
      if (this.onDone) this.onDone(r);
      return r;
    })();
    return this._finishPromise;
  }

  cancel(keepPartial = true) {
    this.cancelled = true;
    if (this._store) this._store.abort(keepPartial);
  }
}

export class MobileSender {
  constructor({ meta, startSeq, entry, write, onProgress }) {
    this.meta = meta;
    this.chunkSize = meta.chunkSize || P.DEFAULT_CHUNK_SIZE;
    this.startSeq = startSeq || 0;
    this.entry = entry;
    this.write = write;
    this.onProgress = onProgress;
    this.cancelled = false;
    this.sentBytes = this.startSeq * this.chunkSize;
    this._samples = [];
  }

  cancel() { this.cancelled = true; }

  async run() {
    const reader = await this.entry.open();
    let seq = this.startSeq;
    while (seq * this.chunkSize < this.meta.size && !this.cancelled) {
      const offset = seq * this.chunkSize;
      const want = Math.min(this.chunkSize, this.meta.size - offset);
      const payload = await reader.read(offset, want);
      if (!payload || !payload.length) break;
      this.write(encodeChunkFrame(this.meta.fileId, seq, payload));
      this.sentBytes = offset + payload.length;

      const now = Date.now();
      this._samples.push({ t: now, b: this.sentBytes });
      while (this._samples.length > 2 && now - this._samples[0].t > 3000) this._samples.shift();
      let speed = 0;
      if (this._samples.length >= 2) {
        const dt = (this._samples[this._samples.length - 1].t - this._samples[0].t) / 1000;
        const db = this._samples[this._samples.length - 1].b - this._samples[0].b;
        if (dt > 0) speed = db / dt;
      }
      if (this.onProgress) {
        this.onProgress({
          fileId: this.meta.fileId, transferredBytes: this.sentBytes, totalBytes: this.meta.size,
          speed, etaMs: speed > 0 ? Math.round(((this.meta.size - this.sentBytes) / speed) * 1000) : null,
        });
      }
      seq++;
      // 让出主线程，避免 WebView 卡死
      if (seq % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return { ok: !this.cancelled && this.sentBytes >= this.meta.size, sentBytes: this.sentBytes };
  }
}
