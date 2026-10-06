/**
 * 传输引擎（两端共用逻辑，基于 fs.promises）
 * - FileSender：按协议把文件切成帧发出去，支持断点续传 / 取消 / 进度
 * - FileReceiver：落盘 .part 文件，支持续传 / 校验 / 原子改名
 *
 * 与具体传输通道解耦：调用方传入 write(buf) 与 close()，便于 Node TCP 与
 * 移动端（RN / Capacitor 等）各自适配。
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const P = require('../../../shared/protocol.js');

const PART_SUFFIX = '.lpart';

// ─────────────────────────────────────────────────────────────
// 发送端
// ─────────────────────────────────────────────────────────────

class FileSender extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.filePath 源文件绝对路径
   * @param {object} o.meta     send_offer 里的文件元数据（fileId/name/size/chunkSize/relPath）
   * @param {number} o.startSeq 起始分片号（断点续传）
   * @param {(buf:Buffer)=>Promise<void>|void} o.write 写通道
   */
  constructor(o) {
    super();
    this.filePath = o.filePath;
    this.meta = o.meta;
    this.chunkSize = o.meta.chunkSize || P.DEFAULT_CHUNK_SIZE;
    this.startSeq = o.startSeq || 0;
    this.write = o.write;
    this.maxBytesPerSec = o.maxBytesPerSec || 0;   // 0 = 不限速
    this.cancelled = false;
    this.sentBytes = this.startSeq * this.chunkSize;
    if (this.sentBytes > this.meta.size) this.sentBytes = this.meta.size;
    this._meter = new P.SpeedMeter();
    this._paused = false;
    this._resumeWaiters = [];
  }

  get totalBytes() { return this.meta.size; }

  cancel() {
    this.cancelled = true;
    this._releasePaused();
  }

  /** 暂停（用于限速/暂停按钮） */
  pause() { this._paused = true; }
  resume() { this._paused = false; this._releasePaused(); }
  _releasePaused() {
    const w = this._resumeWaiters.splice(0);
    w.forEach((fn) => fn());
  }

  async _waitIfPaused() {
    while (this._paused && !this.cancelled) {
      await new Promise((r) => this._resumeWaiters.push(r));
    }
  }

  /**
   * 执行发送，直到文件发完或取消
   * @param {object} [opts]
   * @param {number} [opts.maxBytesPerSec] 限速（字节/秒），0 或省略表示不限速
   */
  async run(opts = {}) {
    const { size } = this.meta;
    const fh = await fsp.open(this.filePath, 'r');
    const fileId = this.meta.fileId;
    const buf = Buffer.allocUnsafe(this.chunkSize);
    let seq = this.startSeq;
    const maxBps = opts.maxBytesPerSec || this.maxBytesPerSec || 0;
    const t0 = Date.now();
    let bytesSinceThrottle = 0;

    try {
      while (seq * this.chunkSize < size && !this.cancelled) {
        await this._waitIfPaused();
        if (this.cancelled) break;

        const offset = seq * this.chunkSize;
        const want = Math.min(this.chunkSize, size - offset);
        const { bytesRead } = await fh.read(buf, 0, want, offset);
        if (bytesRead <= 0) break;

        const payload = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
        const frame = P.encodeChunkFrame(fileId, seq, payload);
        await this.write(frame);

        this.sentBytes = offset + bytesRead;
        this._meter.update(this.sentBytes);
        this.emit('progress', {
          fileId,
          seq,
          transferredBytes: this.sentBytes,
          totalBytes: size,
          speed: this._meter.speed,
          etaMs: this._meter.eta(size),
        });

        // 限速：按累计耗时补齐应有的等待时间
        if (maxBps > 0) {
          bytesSinceThrottle += bytesRead;
          const shouldElapse = (bytesSinceThrottle / maxBps) * 1000;
          const elapsed = Date.now() - t0;
          const wait = shouldElapse - elapsed;
          if (wait > 1) await new Promise((r) => setTimeout(r, Math.min(wait, 1000)));
        }

        seq++;
      }
      const ok = !this.cancelled && this.sentBytes >= size;
      this.emit('done', { fileId, sentBytes: this.sentBytes, totalBytes: size, ok, nextSeq: seq });
      return { ok, sentBytes: this.sentBytes, nextSeq: seq };
    } finally {
      await fh.close().catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 接收端
// ─────────────────────────────────────────────────────────────

class FileReceiver extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.meta    send_offer 中的文件元数据
   * @param {string} o.saveDir 保存目录
   * @param {string} [o.transferId] 所属传输会话 ID（ack / complete 回包需要）
   * @param {string} [o.resumeToken]
   * @param {number} [o.receivedBytes] 断点已收字节
   */
  constructor(o) {
    super();
    this.meta = o.meta;
    this.transferId = o.transferId || null;
    this.saveDir = o.saveDir;
    this.chunkSize = o.meta.chunkSize || P.DEFAULT_CHUNK_SIZE;
    this.resumeToken = o.resumeToken || null;
    this.receivedBytes = o.receivedBytes || 0;
    this.ackedSeq = this.receivedBytes > 0
      ? Math.floor(this.receivedBytes / this.chunkSize) - 1
      : -1;
    this.cancelled = false;
    this.finished = false;
    this._fh = null;
    this._meter = new P.SpeedMeter();
    this._lastAckAt = 0;
    this._chunksSinceAck = 0;

    /**
     * 串行化写入队列。
     * 解码器回调是同步的、而落盘是异步的：若不做串行化，
     * 第 n 片还在 await 写盘时第 n+1 片就已到达，_expectSeq 尚未推进，
     * 会被误判为「乱序」。这里把每片压入链式 Promise，保证严格顺序。
     */
    this._chain = Promise.resolve();
    /** 累计 ack 状态，由队列内的任务填写 */
    this._pendingAcks = 0;

    /** 最终落盘路径（含重名去冲突） */
    this.finalPath = null;
    /** 临时文件路径 */
    this.partPath = null;
    /** 期望的下一个分片序号 */
    this._expectSeq = this.ackedSeq + 1;
  }

  /** 计算安全的落盘路径：清洗路径 + 防重名 + 不越出 saveDir */
  async resolveTargets() {
    const rel = P.sanitizeRelPath(this.meta.relPath, this.meta.name);
    const safeRel = rel.split('/').join(path.sep);
    let target = path.resolve(this.saveDir, safeRel);
    const rootResolved = path.resolve(this.saveDir);
    if (!target.startsWith(rootResolved + path.sep) && target !== rootResolved) {
      target = path.join(rootResolved, P.sanitizeRelPath(null, this.meta.name).split('/').pop());
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    this.partPath = target + PART_SUFFIX;
    this.finalPath = await uniquePath(target);
    return { finalPath: this.finalPath, partPath: this.partPath };
  }

  async open() {
    await this.resolveTargets();

    // 已收字节以磁盘上 .part 的实际大小为准（比协议上报更可靠）。
    // 只要有 .part 就尝试续传，不强制要求 resumeToken——
    // 断线重连、应用重启等场景下 token 可能已丢失，但半截文件仍在。
    let existing = 0;
    try { existing = (await fsp.stat(this.partPath)).size; } catch (_) { existing = 0; }
    // 半截文件比目标还大 → 视为脏数据，重头来
    if (existing > this.meta.size) existing = 0;

    if (existing > 0 && existing < this.meta.size) {
      this.receivedBytes = existing;
      this.ackedSeq = Math.floor(existing / this.chunkSize) - 1;
      // 落在半片中间时，回退到该片开头，让发送方从整片边界重传
      this._expectSeq = this.ackedSeq + 1;
      this._resumeBytes = this.receivedBytes;
      this._fh = await fsp.open(this.partPath, 'r+');
      this.emit('resumed', { receivedBytes: this.receivedBytes, ackedSeq: this.ackedSeq });
    } else if (existing >= this.meta.size && this.meta.size > 0) {
      // 上次其实已经收完，只是没来得及改名
      this.receivedBytes = existing;
      this.ackedSeq = Math.floor(existing / this.chunkSize);   // 无待传分片
      this._expectSeq = this.ackedSeq + 1;
      this._resumeBytes = existing;
      this._fh = await fsp.open(this.partPath, 'r+');
    } else {
      this.receivedBytes = 0;
      this.ackedSeq = -1;
      this._expectSeq = 0;
      this._resumeBytes = 0;
      this._fh = await fsp.open(this.partPath, 'w');
    }
    return { receivedBytes: this.receivedBytes, expectSeq: this._expectSeq };
  }

  /**
   * 写入一个分片帧（由解码器交付）。内部串行化，调用方可直接并发调用。
   * @param {{fileId:string, seq:number, payload:Buffer}} frame
   * @returns {Promise<{ needAck:boolean }>}
   */
  writeChunk(frame) {
    // 把任务挂到链尾，保证严格按到达顺序落盘
    const task = this._chain.then(() => this._writeChunkInner(frame));
    // 吞掉异常以免中断整条链（错误通过 error 事件上报）
    this._chain = task.catch(() => {});
    return task;
  }

  async _writeChunkInner(frame) {
    if (this.cancelled || this.finished || this._finishPromise) return { needAck: false };
    const { seq, payload } = frame;

    if (seq !== this._expectSeq) {
      // 重复片：直接忽略（可能是重传）；跳号则报错
      if (seq < this._expectSeq) return { needAck: false };
      this.emit('error', new Error(`分片乱序：期望 ${this._expectSeq}，收到 ${seq}`));
      return { needAck: false };
    }
    if (!this._fh) {
      this.emit('error', new Error('接收器未打开（open() 未调用或已关闭）'));
      return { needAck: false };
    }

    const offset = seq * this.chunkSize;
    await this._fh.write(payload, 0, payload.length, offset);
    this.receivedBytes = offset + payload.length;
    this.ackedSeq = seq;
    this._expectSeq = seq + 1;
    this._meter.update(this.receivedBytes);
    this._chunksSinceAck++;

    this.emit('progress', {
      fileId: this.meta.fileId,
      transferredBytes: this.receivedBytes,
      totalBytes: this.meta.size,
      speed: this._meter.speed,
      etaMs: this._meter.eta(this.meta.size),
    });

    const now = Date.now();
    const needAck = this._chunksSinceAck >= P.ACK_EVERY_CHUNKS ||
      (now - this._lastAckAt >= P.ACK_EVERY_MS && this._chunksSinceAck > 0);
    if (needAck) {
      this._lastAckAt = now;
      this._chunksSinceAck = 0;
    }
    return { needAck };
  }

  /** 等待队列中所有写入落盘（收尾/统计前调用） */
  drain() { return this._chain; }

  /**
   * 收尾：等待队列清空 + flush + 校验 + 原子改名。
   *
   * 注意 `finished` 的语义 = 「已彻底完成（含 rename）」。
   * 中途用 `_finishing` 做幂等锁，避免并发收尾；
   * 外部轮询 `finished` 时不会看到「已标记完成但文件还没落盘」的中间态。
   */
  async finish() {
    if (this.finished) return { ok: true, path: this.finalPath, size: this.receivedBytes };
    if (this._finishPromise) return this._finishPromise;      // 幂等：复用同一次收尾
    this._finishPromise = this._doFinish();
    return this._finishPromise;
  }

  async _doFinish() {
    await this._chain;                       // 先让在途分片全部落盘
    this._closed = true;
    await this._fh.sync().catch(() => {});
    await this._fh.close().catch(() => {});
    this._fh = null;

    if (this.receivedBytes < this.meta.size) {
      this.finished = true;
      this.result = { ok: false, path: this.partPath, reason: 'incomplete', receivedBytes: this.receivedBytes };
      return this.result;
    }

    // 可选整文件校验
    let sha256 = '';
    if (this.meta.sha256) {
      sha256 = await sha256File(this.partPath);
      if (sha256 !== this.meta.sha256) {
        this.finished = true;
        this.result = { ok: false, path: this.partPath, reason: 'checksum_mismatch', sha256 };
        return this.result;
      }
    }

    await fsp.rename(this.partPath, this.finalPath);
    const st = await fsp.stat(this.finalPath);
    this.finished = true;                    // 只有在文件真正就位后才置位
    this.result = { ok: true, path: this.finalPath, size: st.size, sha256 };
    this.emit('finished', { path: this.finalPath, size: st.size });
    return this.result;
  }

  /** 取消：保留或删除 .part */
  async cancel(keepPartial = true) {
    this.cancelled = true;
    await this._chain.catch(() => {});
    if (this._fh) {
      await this._fh.close().catch(() => {});
      this._fh = null;
    }
    if (!keepPartial && this.partPath) {
      await fsp.unlink(this.partPath).catch(() => {});
    }
    this.emit('cancelled', { keepPartial, receivedBytes: this.receivedBytes });
  }
}

/** 若目标已存在，追加 (1)(2)… 生成唯一路径 */
async function uniquePath(target) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let candidate = target;
  let i = 1;
  for (;;) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${base} (${i})${ext}`);
      i++;
      if (i > 9999) return path.join(dir, `${base} (${Date.now()})${ext}`);
    } catch (_) {
      return candidate;
    }
  }
}

/** 流式计算文件 sha256 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
// 发送清单构建：把「文件/文件夹」展开成协议 files[] 数组
// ─────────────────────────────────────────────────────────────

/**
 * @param {string[]} absPaths 绝对路径列表（文件或目录）
 * @returns {Promise<Array>} 每项含 { filePath, meta }
 */
async function buildSendList(absPaths, opts = {}) {
  const chunkSize = opts.chunkSize || P.DEFAULT_CHUNK_SIZE;
  const out = [];
  let idx = 0;

  async function walk(p, prefix) {
    const st = await fsp.stat(p);
    if (st.isDirectory()) {
      const name = path.basename(p);
      const rel = prefix ? `${prefix}/${name}` : name;
      // 发送目录本身作为标记项（接收端据此建目录）
      const entries = await fsp.readdir(p);
      if (entries.length === 0) {
        out.push({
          filePath: null,
          meta: {
            fileId: `f_${++idx}`,
            name,
            size: 0,
            mime: 'inode/directory',
            relPath: rel,
            isDir: true,
            mtime: st.mtimeMs,
            chunkSize,
            sha256: '',
          },
        });
      }
      for (const e of entries.sort()) {
        await walk(path.join(p, e), rel);
      }
      return;
    }
    if (!st.isFile()) return;

    const rel = prefix ? `${prefix}/${path.basename(p)}` : path.basename(p);
    out.push({
      filePath: p,
      meta: {
        fileId: `f_${++idx}`,
        name: path.basename(p),
        size: st.size,
        mime: guessMime(p),
        relPath: rel,
        isDir: false,
        mtime: st.mtimeMs,
        chunkSize,
        sha256: '',          // 需要整文件校验时可在 opts.checksum 打开
      },
    });
  }

  for (const p of absPaths) {
    try { await walk(p, ''); } catch (e) { /* 跳过不可访问项 */ }
  }
  return out;
}

const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  apk: 'application/vnd.android.package-archive',
};

function guessMime(file) {
  return MIME_MAP[P.extOf(file)] || 'application/octet-stream';
}

module.exports = { FileSender, FileReceiver, buildSendList, uniquePath, sha256File, guessMime, PART_SUFFIX };
