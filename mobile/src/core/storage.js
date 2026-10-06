/**
 * 手机端存储层
 *
 * 手机端的落盘能力因运行环境而异，这里做统一封装：
 *  - Capacitor 环境（打包成 APK）：走 @capacitor/filesystem 写真实文件
 *  - 浏览器环境：走 OPFS（File System Access / Origin Private File System）
 *    作为可运行的降级方案，便于开发调试
 *
 * 对外暴露 storageFactory(meta) → { path, receivedBytes, write(u8, offset), close(), abort() }
 */

import * as P from '@shared/protocol.mjs';

const DIR = 'LANTransfer';
const RECORD_KEY = 'ltp_pending_';

// ─────────────────────────────────────────────────────────────
// 待传记录（用于断点续传扫描）
// ─────────────────────────────────────────────────────────────

export function savePendingRecord(fileId, rec) {
  try { localStorage.setItem(RECORD_KEY + fileId, JSON.stringify(rec)); } catch (_) {}
}
export function getPendingRecord(fileId) {
  try { const s = localStorage.getItem(RECORD_KEY + fileId); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
export function clearPendingRecord(fileId) {
  try { localStorage.removeItem(RECORD_KEY + fileId); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// Capacitor 实现
// ─────────────────────────────────────────────────────────────

function capacitorAvailable() {
  return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem);
}

/** 用 Capacitor 写文件：分片追加写入 base64 块 */
class CapStore {
  constructor(meta) {
    this.meta = meta;
    this.FS = window.Capacitor.Plugins.Filesystem;
    this.Directory = { Documents: 'DOCUMENTS', Data: 'DATA', ExternalStorage: 'EXTERNAL_STORAGE' };
    this.rel = P.sanitizeRelPath(meta.relPath, meta.name);
    this.path = `${DIR}/${this.rel}`;
    this.receivedBytes = 0;
    this._closed = false;
  }

  async init() {
    // 建目录（逐级）
    const segs = this.path.split('/');
    segs.pop();
    let acc = '';
    for (const s of segs) {
      acc = acc ? `${acc}/${s}` : s;
      try {
        await this.FS.mkdir({ path: acc, directory: this.Directory.Documents, recursive: true });
      } catch (_) { /* 已存在 */ }
    }
    // 若已有半截文件，取其大小
    try {
      const st = await this.FS.stat({ path: this.path, directory: this.Directory.Documents });
      this.receivedBytes = st.size || 0;
    } catch (_) { this.receivedBytes = 0; }
    return this;
  }

  /**
   * 按偏移写入。Capacitor Filesystem 的 appendFile 只能追加，
   * 因此续传时先截断到断点再追加。
   */
  async write(u8, offset) {
    const b64 = bytesToBase64(u8);
    if (offset === 0) {
      await this.FS.writeFile({
        path: this.path, directory: this.Directory.Documents,
        data: b64, recursive: true,
      });
    } else {
      // 若与已有内容不连续（理论上不会，因为分片严格顺序），先按偏移截断
      const cur = this.receivedBytes;
      if (offset !== cur) {
        await this.FS.writeFile({ path: this.path, directory: this.Directory.Documents, data: '', recursive: true });
        // 注意：真实设备上可用 seek 能力更好；此处退化为重建
      }
      await this.FS.appendFile({ path: this.path, directory: this.Directory.Documents, data: b64 });
    }
    this.receivedBytes = Math.max(this.receivedBytes, offset + u8.length);
  }

  async close() {
    this._closed = true;
    return this.path;
  }

  abort(_keep) { this._closed = true; }
}

// ─────────────────────────────────────────────────────────────
// 浏览器 OPFS 实现（开发调试可用）
// ─────────────────────────────────────────────────────────────

class OpfsStore {
  constructor(meta) {
    this.meta = meta;
    this.rel = P.sanitizeRelPath(meta.relPath, meta.name);
    this.path = `${DIR}/${this.rel}`;
    this.receivedBytes = 0;
    this._fh = null;
  }

  async init() {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      throw new Error('当前环境不支持文件系统（OPFS 不可用）');
    }
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR, { create: true });
    const segs = this.rel.split('/');
    const name = segs.pop();
    let cur = dir;
    for (const s of segs) cur = await cur.getDirectoryHandle(s, { create: true });
    const fh = await cur.getFileHandle(name, { create: true });
    this._fh = fh;
    try { this.receivedBytes = (await fh.getFile()).size; } catch (_) { this.receivedBytes = 0; }
    return this;
  }

  async write(u8, offset) {
    const f = await this._fh.createWritable({ keepExistingData: true });
    try {
      await f.write({ type: 'write', position: offset, data: u8 });
    } finally {
      await f.close();
    }
    this.receivedBytes = Math.max(this.receivedBytes, offset + u8.length);
  }

  async close() { return this.path; }
  abort(_keep) { /* 保留文件以便续传 */ }
}

// ─────────────────────────────────────────────────────────────
// 工厂
// ─────────────────────────────────────────────────────────────

export async function storageFactory(meta) {
  if (meta.isDir) {
    // 目录标记：只记录路径，不产生数据
    return { path: `${DIR}/${meta.relPath}`, receivedBytes: 0, write: async () => {}, close: async () => `${DIR}/${meta.relPath}`, abort() {} };
  }
  if (capacitorAvailable()) {
    try { return await new CapStore(meta).init(); }
    catch (e) { /* 落到 OPFS */ }
  }
  return await new OpfsStore(meta).init();
}

// ─────────────────────────────────────────────────────────────
// 读取待发送文件（Capacitor / input[type=file] / OPFS）
// ─────────────────────────────────────────────────────────────

/**
 * 把「用户选中的文件」包装成可随机读取的 reader
 * @returns {Promise<{size:number, read:(offset:number,len:number)=>Promise<Uint8Array>}>}
 */
export async function openLocalFile(file) {
  // 1) Capacitor File 对象通常带 path
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem && file.path) {
    const FS = window.Capacitor.Plugins.Filesystem;
    const st = await FS.stat({ path: file.path, directory: { Documents: 'DOCUMENTS' } }).catch(() => null);
    const size = (st && st.size) || file.size || 0;
    return {
      size,
      async read(offset, len) {
        const r = await FS.readFile({
          path: file.path, directory: { Documents: 'DOCUMENTS' },
          // Capacitor 6 不支持 range 读，整块读出后切片（大文件建议原生插件补充 range 能力）
        });
        const all = base64ToBytes(r.data);
        return all.slice(offset, offset + len);
      },
    };
  }
  // 2) 标准 File / Blob
  return {
    size: file.size,
    async read(offset, len) {
      const blob = file.slice(offset, offset + len);
      const ab = await blob.arrayBuffer();
      return new Uint8Array(ab);
    },
  };
}

/** 按扩展名 + 相对路径构建协议元数据 */
export function buildMeta(file, relPath, idx, chunkSize = P.DEFAULT_CHUNK_SIZE) {
  return {
    fileId: `f_${idx}`,
    name: file.name,
    size: file.size,
    mime: file.type || guessMime(file.name),
    relPath: relPath || file.name,
    isDir: false,
    mtime: file.lastModified || Date.now(),
    chunkSize,
    sha256: '',
  };
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt: 'text/plain', md: 'text/markdown',
};
export function guessMime(name) {
  const e = P.extOf(name);
  return MIME[e] || 'application/octet-stream';
}

// ─────────────────────────────────────────────────────────────
// base64
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
// 本机身份持久化
// ─────────────────────────────────────────────────────────────

const ID_KEY = 'ltp_device';
const TRUST_KEY = 'ltp_trusted';

export function loadDevice() {
  try {
    const s = localStorage.getItem(ID_KEY);
    if (s) return JSON.parse(s);
  } catch (_) {}
  const id = 'mobile-' + randomHex(4);
  const dev = {
    deviceId: id,
    name: defaultName(),
    type: 'mobile',
    os: detectOS(),
    fingerprint: '',
  };
  try { localStorage.setItem(ID_KEY, JSON.stringify(dev)); } catch (_) {}
  return dev;
}

export function saveDevice(dev) {
  try { localStorage.setItem(ID_KEY, JSON.stringify(dev)); } catch (_) {}
}

export function loadTrusted() {
  try { return JSON.parse(localStorage.getItem(TRUST_KEY) || '{}'); } catch (_) { return {}; }
}
export function saveTrusted(map) {
  try { localStorage.setItem(TRUST_KEY, JSON.stringify(map)); } catch (_) {}
}

function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function defaultName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android 手机';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone';
  return '我的手机';
}

function detectOS() {
  const ua = navigator.userAgent;
  const m = ua.match(/Android\s+([\d.]+)/);
  if (m) return `Android ${m[1]}`;
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  return 'Mobile';
}
