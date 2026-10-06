/**
 * ⚠️ 自动生成文件，请勿手工编辑。
 * 源文件：shared/protocol.js
 * 生成命令：node scripts/gen-protocol-mjs.js
 * 用途：供手机端（浏览器 ESM / Vite）导入，与电脑端共用同一份协议实现。
 */

/**
 * LTP/1 —— 局域网互传协议 共享层
 * 电脑端与手机端共用此文件，任何修改必须两端同步。
 * 协议文档见 docs/PROTOCOL.md
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// 同构层：让本文件在 Node 与浏览器（手机端 WebView）中都能运行。
//  - Node：使用原生 Buffer / crypto
//  - 浏览器：仅在缺失时注入一个「够用」的 Buffer 垫片（utf8 / base64 /
//    base64url / hex / ascii 编解码 + 常用读写方法），供二维码与帧解析使用。
//    浏览器端不参与令牌签发，crypto 相关函数在无 require 的环境下会给出明确报错。
// ─────────────────────────────────────────────────────────────

const IS_NODE = false; // [生成] 浏览器版本固定为非 Node

// 注意：本地变量不能直接叫 Buffer，否则会遮蔽全局 Buffer 并触发 TDZ 错误。
// 统一通过 globalThis.Buffer 取用（浏览器缺失时再注入垫片）。
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = makeBufferShim();
}
const Buf = globalThis.Buffer;

function makeBufferShim() {
  const enc = (s) => new TextEncoder().encode(String(s));
  const dec = (b) => new TextDecoder('utf-8').decode(b);

  const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function bytesToBase64(u8) {
    let out = '';
    for (let i = 0; i < u8.length; i += 3) {
      const b0 = u8[i], b1 = u8[i + 1], b2 = u8[i + 2];
      out += B64_CHARS[b0 >> 2];
      out += B64_CHARS[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
      out += i + 1 < u8.length ? B64_CHARS[((b1 & 15) << 2) | ((b2 || 0) >> 6)] : '=';
      out += i + 2 < u8.length ? B64_CHARS[b2 & 63] : '=';
    }
    return out;
  }
  function base64ToBytes(str) {
    const s = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
    const clean = s.replace(/=+$/, '');
    const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
    let bits = 0, val = 0, p = 0;
    for (let i = 0; i < clean.length; i++) {
      val = (val << 6) | B64_CHARS.indexOf(clean[i]);
      bits += 6;
      if (bits >= 8) { bits -= 8; out[p++] = (val >> bits) & 0xff; }
    }
    return out.subarray(0, p);
  }
  const b64urlEncode = (u8) => bytesToBase64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64urlDecode = (s) => base64ToBytes(String(s).replace(/-/g, '+').replace(/_/g, '/'));

  class Shim {
    constructor(u8) {
      this._u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
      this.length = this._u8.length;
      this.buffer = this._u8.buffer;
      this.byteOffset = this._u8.byteOffset;
      this.byteLength = this._u8.byteLength;
    }
    static from(v, encoding) {
      if (v instanceof Shim) return v;
      if (typeof v === 'string') {
        if (encoding === 'base64') return new Shim(base64ToBytes(v));
        if (encoding === 'base64url') return new Shim(b64urlDecode(v));
        if (encoding === 'hex') {
          const out = new Uint8Array(Math.floor(v.length / 2));
          for (let i = 0; i < out.length; i++) out[i] = parseInt(v.substr(i * 2, 2), 16);
          return new Shim(out);
        }
        return new Shim(enc(v)); // utf8 / ascii（ASCII 与 UTF-8 对常见字符一致）
      }
      if (v instanceof Uint8Array) return new Shim(v);
      if (v instanceof ArrayBuffer) return new Shim(new Uint8Array(v));
      if (Array.isArray(v)) return new Shim(new Uint8Array(v));
      return new Shim(new Uint8Array(0));
    }
    static alloc(n) { return new Shim(new Uint8Array(n)); }
    static concat(list) {
      const total = list.reduce((a, b) => a + b.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const b of list) { out.set(b instanceof Shim ? b._u8 : b, off); off += b.length; }
      return new Shim(out);
    }
    static isBuffer(o) { return o instanceof Shim; }
    toString(encoding) {
      if (encoding === 'base64') return bytesToBase64(this._u8);
      if (encoding === 'base64url') return b64urlEncode(this._u8);
      if (encoding === 'hex') return [...this._u8].map((x) => x.toString(16).padStart(2, '0')).join('');
      return dec(this._u8);
    }
    subarray(a, b) { return new Shim(this._u8.subarray(a, b)); }
    slice(a, b) { return new Shim(this._u8.slice(a, b)); }
    copy(target, tStart, sStart, sEnd) { target._u8.set(this._u8.subarray(sStart, sEnd), tStart); return (sEnd - sStart); }
    indexOf(byte, from) { return this._u8.indexOf(byte, from); }
    equals(other) { return this.length === other.length && this._u8.every((v, i) => v === other._u8[i]); }
    writeUInt16BE(v, o) { this._u8[o] = (v >>> 8) & 0xff; this._u8[o + 1] = v & 0xff; }
    writeUInt32BE(v, o) { this._u8[o] = (v >>> 24) & 0xff; this._u8[o + 1] = (v >>> 16) & 0xff; this._u8[o + 2] = (v >>> 8) & 0xff; this._u8[o + 3] = v & 0xff; }
    readUInt16BE(o) { return (this._u8[o] << 8) | this._u8[o + 1]; }
    readUInt32BE(o) { return ((this._u8[o] << 24) | (this._u8[o + 1] << 16) | (this._u8[o + 2] << 8) | this._u8[o + 3]) >>> 0; }
    get(i) { return this._u8[i]; }
    set(arr, o) { this._u8.set(arr instanceof Shim ? arr._u8 : arr, o); }
  }
  // 兼容 instanceof Buffer / Buffer.isBuffer 的写法
  Shim.poolSize = 8192;
  return Shim;
}

const PROTOCOL_VERSION = 1;
const PROTOCOL_ID = 'LTP/1';

/** 统一端口：TCP 服务 + UDP 发现 */
const PORT = 53317;

/**
 * 辅助 HTTP 端口（TCP 端口 + 1）。
 * 用途：
 *   1) 手机端（浏览器 / WebView 无法开原始 TCP）通过 HTTP 探测设备
 *   2) WebSocket 降级通道：ws://<ip>:53318/ws
 *   3) HTTP 分片上传降级通道
 * 电脑端两个端口同时监听，协议消息格式完全一致。
 */
const HTTP_PORT = PORT + 1;

/** 组播地址与 TTL（TTL=1 限制在同网段，不跨路由器） */
const MULTICAST_ADDR = '239.255.42.99';
const MULTICAST_TTL = 1;

/** 默认分片大小 256KB */
const DEFAULT_CHUNK_SIZE = 256 * 1024;

/** 二进制帧 magic */
const FRAME_MAGIC = Buf.from('LTPC', 'ascii');

/** 发现心跳间隔 / 离线判定 */
const ANNOUNCE_INTERVAL_MS = 3000;
const DEVICE_TIMEOUT_MS = 15000;

/** 每多少片回一次 ack */
const ACK_EVERY_CHUNKS = 16;
const ACK_EVERY_MS = 200;

/** 进度上报间隔 */
const PROGRESS_INTERVAL_MS = 300;

/** 二维码前缀 */
const QR_PREFIX = 'LTP1:';

/** 6 位匹配码有效期 */
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
/** 二维码临时令牌有效期 */
const QR_TOKEN_TTL_MS = 5 * 60 * 1000;

const MSG = Object.freeze({
  ANNOUNCE: 'announce',
  PROBE: 'probe',
  BYE: 'bye',
  HELLO: 'hello',
  HELLO_ACK: 'hello_ack',
  PAIR_REQUEST: 'pair_request',
  PAIR_RESULT: 'pair_result',
  TRUST_LIST: 'trust_list',
  SEND_OFFER: 'send_offer',
  SEND_ACCEPT: 'send_accept',
  SEND_REJECT: 'send_reject',
  CHUNK_ACK: 'chunk_ack',
  PROGRESS: 'progress',
  COMPLETE: 'complete',
  CANCEL: 'cancel',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
});

const HELLO_REASON = Object.freeze({
  PAIRED: 'paired',
  NEED_PAIR: 'need_pair',
  REJECTED: 'rejected',
  BAD_TOKEN: 'bad_token',
});

const ERR = Object.freeze({
  DISK_FULL: 'DISK_FULL',
  WRITE_FAILED: 'WRITE_FAILED',
  BAD_MESSAGE: 'BAD_MESSAGE',
  UNKNOWN_FILE: 'UNKNOWN_FILE',
  OFFSET_MISMATCH: 'OFFSET_MISMATCH',
  NOT_PAIRED: 'NOT_PAIRED',
});

// ─────────────────────────────────────────────────────────────
// 消息构造
// ─────────────────────────────────────────────────────────────

let _seq = 0;
function nextSeq() {
  _seq = (_seq + 1) % 0x7fffffff;
  return _seq;
}

/**
 * 构造一条协议消息（不含二进制帧）
 * @param {string} type  MSG.* 之一
 * @param {object} [fields] 附加字段
 * @param {string} [deviceId]
 */
function makeMessage(type, fields, deviceId) {
  const base = {
    v: PROTOCOL_VERSION,
    type,
    seq: nextSeq(),
    ts: Date.now(),
  };
  if (deviceId) base.deviceId = deviceId;
  return Object.assign(base, fields || {});
}

/** 编码为 NDJSON 行（含换行符） */
function encodeMessage(obj) {
  return Buf.from(JSON.stringify(obj) + '\n', 'utf8');
}

// ─────────────────────────────────────────────────────────────
// NDJSON 拆包器：TCP 是流，可能一次收到半条 / 多条消息
// ─────────────────────────────────────────────────────────────

class NdjsonDecoder {
  /**
   * @param {(msg:object, isBinary:boolean)=>void} onMessage
   * @param {object} [opts]
   * @param {number} [opts.highWaterMark] 单帧 payload 上限（默认 64MB），
   *   防止畸形长度字段导致一次性分配巨量内存。
   */
  constructor(onMessage, opts) {
    this.onMessage = onMessage;
    this.highWaterMark = (opts && opts.highWaterMark) || 64 * 1024 * 1024;
    /**
     * 统一字节缓冲区。TCP 是字节流，文本消息与二进制帧共用一条流，
     * 因此必须用「同一个 Buffer 队列」缓存未消费完的数据。
     */
    this._buf = Buf.alloc(0);
  }

  /** 喂入原始 TCP 数据，可能同时触发多条文本消息 / 二进制帧 */
  push(data) {
    if (!data || data.length === 0) return;
    this._buf = this._buf.length ? Buf.concat([this._buf, data]) : Buf.from(data);
    this._drain();
  }

  _drain() {
    for (;;) {
      if (this._buf.length === 0) return;
      const first = this._buf[0];

      // ── 二进制帧：前 4 字节为 magic "LTPC"（首字节 0x4C 'L'）
      if (first === 0x4c) {
        if (this._buf.length < 4) return;             // 不足以判定 magic
        if (!this._buf.subarray(0, 4).equals(FRAME_MAGIC)) {
          this._buf = this._buf.subarray(1);          // 脏数据，丢弃 1 字节重试
          continue;
        }
        // 需要先读到 fileIdLen 才能算出帧头长度
        if (this._buf.length < 6) return;
        const fileIdLen = this._buf.readUInt16BE(4);
        const headerLen = 14 + fileIdLen;
        if (this._buf.length < headerLen) return;     // 帧头未收全

        const fileId = this._buf.subarray(6, 6 + fileIdLen).toString('utf8');
        const seq = this._buf.readUInt32BE(6 + fileIdLen);
        const payloadLen = this._buf.readUInt32BE(10 + fileIdLen);
        if (payloadLen > this.highWaterMark) {
          // 长度异常：判定为流损坏，丢弃 magic 继续找下一帧
          this._buf = this._buf.subarray(4);
          continue;
        }
        if (this._buf.length < headerLen + payloadLen) return;  // 整帧未收全

        // 注意：必须 copy，因为 _buf 会被重新赋值，subarray 是视图
        const payload = Buf.from(this._buf.subarray(headerLen, headerLen + payloadLen));
        this._buf = this._buf.subarray(headerLen + payloadLen);
        this.onMessage({ fileId, seq, payload }, true);
        continue;
      }

      // ── 文本消息（NDJSON）：找换行符
      const nl = this._buf.indexOf(0x0a);
      if (nl === -1) return;                          // 半条消息，等更多数据

      const line = this._buf.subarray(0, nl).toString('utf8');
      this._buf = this._buf.subarray(nl + 1);
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    const s = line.trim();
    if (!s) return;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      return; // 忽略坏行，不中断连接
    }
    this.onMessage(obj, false);
  }
}

/**
 * 编码一个二进制分片帧。
 *
 * 帧格式（大端）：
 *   magic   4B   "LTPC"
 *   fileIdLen 2B
 *   fileId    变长 UTF-8
 *   seq       4B   分片序号，从 0 开始
 *   payloadLen 4B  本片实际字节数（末片不足 chunkSize 时 != chunkSize）
 *   payload   变长
 * payloadLen 是必需的：TCP 流中帧与帧首尾相接，没有长度字段就无法切分。
 *
 * @param {string} fileId
 * @param {number} seq 分片序号（从 0 开始）
 * @param {Buffer} payload
 */
function encodeChunkFrame(fileId, seq, payload) {
  const idBuf = Buf.from(fileId, 'utf8');
  const header = Buf.alloc(14 + idBuf.length);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt16BE(idBuf.length, 4);
  idBuf.copy(header, 6);
  header.writeUInt32BE(seq, 6 + idBuf.length);
  header.writeUInt32BE(payload.length, 10 + idBuf.length);
  return Buf.concat([header, payload]);
}

// ─────────────────────────────────────────────────────────────
// 设备 / 令牌 / 匹配码
// ─────────────────────────────────────────────────────────────

// Node 环境使用原生 crypto；浏览器环境不参与令牌签发，
// 这里在缺失时给出一个「调用即报错」的占位对象，避免整个模块导入失败。
// 用间接 require 规避打包器对 node 内置模块的静态解析。
let crypto;
if (IS_NODE) {
  const req = typeof require === 'function' ? require : (typeof module !== 'undefined' && module.require ? module.require.bind(module) : null);
  crypto = req ? req('crypto') : null;
}
if (!crypto) {
  const unsupported = () => { throw new Error('当前环境不支持加密操作（仅电脑端参与令牌签发）'); };
  crypto = {
    randomBytes: unsupported,
    randomInt: unsupported,
    createHash: unsupported,
    createHmac: unsupported,
    timingSafeEqual: unsupported,
  };
}

/** 生成设备 ID，如 pc-a1b2c3d4 / mobile-9f8e7d6c */
function makeDeviceId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

/** 生成 6 位数字匹配码（首位非 0） */
function makePairCode() {
  const n = crypto.randomInt(100000, 1000000);
  return String(n);
}

/** 生成二维码临时令牌（短小，便于二维码容量） */
function makeQrToken() {
  return crypto.randomBytes(6).toString('hex'); // 12 位十六进制
}

/** 设备指纹：由设备码派生的短标识，用于配对校验展示 */
function makeFingerprint(deviceSecret) {
  const h = crypto.createHash('sha256').update(deviceSecret).digest('hex').toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}

/** 签发长期令牌：HMAC(secret, deviceId + issuedAt) 截断 */
function signToken(deviceSecret, deviceId, issuedAt = Date.now(), ttlMs = 0) {
  const payload = `${deviceId}.${issuedAt}.${ttlMs}`;
  const sig = crypto.createHmac('sha256', deviceSecret).update(payload).digest('base64url');
  const raw = `${payload}.${sig}`;
  return Buf.from(raw, 'utf8').toString('base64url');
}

/** 校验长期令牌，返回 { ok, deviceId } */
function verifyToken(deviceSecret, token) {
  try {
    const raw = Buf.from(token, 'base64url').toString('utf8');
    const parts = raw.split('.');
    if (parts.length !== 4) return { ok: false };
    const [deviceId, issuedAtStr, ttlStr, sig] = parts;
    const issuedAt = Number(issuedAtStr);
    const ttlMs = Number(ttlStr);
    const expect = crypto
      .createHmac('sha256', deviceSecret)
      .update(`${deviceId}.${issuedAt}.${ttlMs}`)
      .digest('base64url');
    if (sig.length !== expect.length) return { ok: false };
    if (!crypto.timingSafeEqual(Buf.from(sig), Buf.from(expect))) return { ok: false };
    if (ttlMs > 0 && Date.now() > issuedAt + ttlMs) return { ok: false, reason: 'expired' };
    return { ok: true, deviceId };
  } catch (e) {
    return { ok: false };
  }
}

/** 生成不含公钥体系的「信任表」记录项 */
function makeTrustRecord(device) {
  return {
    deviceId: device.deviceId,
    name: device.name,
    type: device.type,
    fingerprint: device.fingerprint,
    trustedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────
// 二维码编解码
// ─────────────────────────────────────────────────────────────

function encodeQrPayload({ ip, port, token, name, deviceId }) {
  const json = JSON.stringify({ ip, port, token, name, deviceId, protocol: PROTOCOL_ID });
  return QR_PREFIX + Buf.from(json, 'utf8').toString('base64url');
}

function decodeQrPayload(text) {
  const s = String(text || '').trim();
  if (!s.startsWith(QR_PREFIX)) return null;
  try {
    const json = Buf.from(s.slice(QR_PREFIX.length), 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    if (!obj.ip || !obj.port) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

/** 人类可读字节 */
function formatBytes(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

/** 人类可读速度 */
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

/** 人类可读剩余时间 */
function formatEta(ms) {
  if (ms === null || ms === undefined || !isFinite(ms) || ms < 0) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return `${m} 分 ${sec} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分`;
}

/** 防路径穿越：清洗相对路径 */
function sanitizeRelPath(relPath, fileName) {
  const raw = String(relPath || fileName || 'file');
  const segs = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    // Windows 非法字符
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_'));
  return segs.length ? segs.join('/') : 'file';
}

/** 取文件扩展名（小写，不含点） */
function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
}

/** 按扩展名归类，用于发送端分组统计 */
const EXT_GROUPS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tiff', 'svg', 'avif'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf', 'odt'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
  apk: ['apk', 'aab', 'ipa'],
};

function groupOf(name) {
  const e = extOf(name);
  for (const [g, list] of Object.entries(EXT_GROUPS)) {
    if (list.includes(e)) return g;
  }
  return 'other';
}

// ─────────────────────────────────────────────────────────────
// 传输进度统计器
// ─────────────────────────────────────────────────────────────

class SpeedMeter {
  constructor() {
    this.reset();
  }
  reset() {
    this._samples = [];   // { t, bytes }
    this._last = 0;
  }
  /** @param {number} bytes 累计已传字节 */
  update(bytes) {
    const now = Date.now();
    this._samples.push({ t: now, bytes });
    // 保留最近 3 秒
    while (this._samples.length > 2 && now - this._samples[0].t > 3000) this._samples.shift();
    this._last = bytes;
  }
  get speed() {
    const s = this._samples;
    if (s.length < 2) return 0;
    const dt = (s[s.length - 1].t - s[0].t) / 1000;
    const db = s[s.length - 1].bytes - s[0].bytes;
    if (dt <= 0) return 0;
    return Math.max(0, db / dt);
  }
  eta(total) {
    const sp = this.speed;
    if (!sp || total <= this._last) return null;
    return Math.round(((total - this._last) / sp) * 1000);
  }
}

export {
  PROTOCOL_VERSION,
  PROTOCOL_ID,
  PORT,
  HTTP_PORT,
  MULTICAST_ADDR,
  MULTICAST_TTL,
  DEFAULT_CHUNK_SIZE,
  FRAME_MAGIC,
  ANNOUNCE_INTERVAL_MS,
  DEVICE_TIMEOUT_MS,
  ACK_EVERY_CHUNKS,
  ACK_EVERY_MS,
  PROGRESS_INTERVAL_MS,
  QR_PREFIX,
  PAIR_CODE_TTL_MS,
  QR_TOKEN_TTL_MS,
  MSG,
  HELLO_REASON,
  ERR,
  makeMessage,
  encodeMessage,
  NdjsonDecoder,
  encodeChunkFrame,
  makeDeviceId,
  makePairCode,
  makeQrToken,
  makeFingerprint,
  signToken,
  verifyToken,
  makeTrustRecord,
  encodeQrPayload,
  decodeQrPayload,
  formatBytes,
  formatSpeed,
  formatEta,
  sanitizeRelPath,
  extOf,
  groupOf,
  EXT_GROUPS,
  SpeedMeter,
};

export default {
  PROTOCOL_VERSION,
  PROTOCOL_ID,
  PORT,
  HTTP_PORT,
  MULTICAST_ADDR,
  MULTICAST_TTL,
  DEFAULT_CHUNK_SIZE,
  FRAME_MAGIC,
  ANNOUNCE_INTERVAL_MS,
  DEVICE_TIMEOUT_MS,
  ACK_EVERY_CHUNKS,
  ACK_EVERY_MS,
  PROGRESS_INTERVAL_MS,
  QR_PREFIX,
  PAIR_CODE_TTL_MS,
  QR_TOKEN_TTL_MS,
  MSG,
  HELLO_REASON,
  ERR,
  makeMessage,
  encodeMessage,
  NdjsonDecoder,
  encodeChunkFrame,
  makeDeviceId,
  makePairCode,
  makeQrToken,
  makeFingerprint,
  signToken,
  verifyToken,
  makeTrustRecord,
  encodeQrPayload,
  decodeQrPayload,
  formatBytes,
  formatSpeed,
  formatEta,
  sanitizeRelPath,
  extOf,
  groupOf,
  EXT_GROUPS,
  SpeedMeter,
};
