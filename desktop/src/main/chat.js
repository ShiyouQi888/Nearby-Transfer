/**
 * 聊天会话存储（桌面端）
 *
 * 为什么单独一个文件：
 *   现有 server.js 里的 transfer 记录是「一次性」的（createTransfer → archive），
 *   而聊天需要的是「持久化的会话 + 消息时间线 + 未读/已读位点」这套完全不同的模型。
 *   把它隔离出来，既不动传输层，也便于独立测试。
 *
 * 存储布局（%APPDATA%/ltp/ 下）：
 *   chats.json              → 会话索引（每个对端一条摘要）
 *   chats/<peerId>.json     → 该会话的完整消息时间线
 *
 * 设计要点：
 *   1) 排序以「数组追加顺序」为准，ts 仅用于展示 —— 两端时钟可能有偏差。
 *   2) 去重一律按 msgId —— 重连重放会重复投递。
 *   3) 所有读写都包 try/catch，文件损坏时降级为空并备份原文件，
 *      绝不让聊天数据问题拖垮整个应用启动。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../../../shared/protocol.js');

/** 单个会话最多保留的消息条数（超出从最旧裁剪） */
const MESSAGES_PER_CHAT = P.CHAT_HISTORY_LIMIT || 2000;

/** 消息发送状态（本地视图，不参与协议传输） */
const DELIVERY = Object.freeze({
  PENDING: 'pending',       // 本地已入列，尚未发出（对端离线）
  SENT: 'sent',             // 已写入 socket
  DELIVERED: 'delivered',   // 对端回 chat_ack
  READ: 'read',             // 对端回 chat_read
  FAILED: 'failed',
});

class ChatStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir       数据目录（一般传 CONFIG_DIR）
   * @param {function} [opts.onChange] 变更回调（用于推送 UI）
   */
  constructor(opts = {}) {
    this.dir = opts.dir;
    this.messagesDir = path.join(this.dir, 'chats');
    this.indexFile = path.join(this.dir, 'chats.json');
    this.onChange = opts.onChange || (() => {});

    /** peerId -> 会话摘要 { peerId, peer, lastMessage, unread, updatedAt, autoAccept } */
    this.chats = new Map();
    /** peerId -> message[] （内存缓存，懒加载） */
    this._messages = new Map();

    this._load();
  }

  // ── 持久化 ────────────────────────────────────────────────

  _load() {
    try {
      fs.mkdirSync(this.messagesDir, { recursive: true });
    } catch (_) { /* 目录建不了后面写也会失败，交由各自 try 兜底 */ }

    try {
      if (fs.existsSync(this.indexFile)) {
        const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        (raw.chats || []).forEach((c) => {
          if (c && c.peerId) this.chats.set(c.peerId, c);
        });
      }
    } catch (e) {
      // 索引损坏：备份后从零开始，避免启动直接崩
      this._backup(this.indexFile);
      this.chats = new Map();
    }
  }

  _backup(file) {
    try {
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (_) {}
  }

  _saveIndex() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const out = { chats: [...this.chats.values()] };
      fs.writeFileSync(this.indexFile, JSON.stringify(out, null, 2), 'utf8');
    } catch (e) {
      console.error('[chat] 保存会话索引失败', e);
    }
  }

  _messagesFile(peerId) {
    return path.join(this.messagesDir, `${String(peerId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  _loadMessages(peerId) {
    if (this._messages.has(peerId)) return this._messages.get(peerId);
    const file = this._messagesFile(peerId);
    let list = [];
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        list = Array.isArray(raw.messages) ? raw.messages : [];
      }
    } catch (_) {
      this._backup(file);
      list = [];
    }
    if (list.length > MESSAGES_PER_CHAT) list = list.slice(-MESSAGES_PER_CHAT);
    this._messages.set(peerId, list);
    return list;
  }

  _saveMessages(peerId) {
    const list = this._messages.get(peerId);
    if (!list) return;
    try {
      fs.mkdirSync(this.messagesDir, { recursive: true });
      fs.writeFileSync(this._messagesFile(peerId), JSON.stringify({ messages: list }, null, 2), 'utf8');
    } catch (e) {
      console.error('[chat] 保存消息失败', e);
    }
  }

  // ── 会话 ──────────────────────────────────────────────────

  /** 取或建一个会话 */
  openChat(peer) {
    const peerId = (peer && peer.deviceId) || 'unknown';
    let chat = this.chats.get(peerId);
    if (!chat) {
      chat = {
        peerId,
        chatId: P.makeChatId(peerId),
        peer: {
          deviceId: peerId,
          name: (peer && peer.name) || peerId,
          type: (peer && peer.type) || 'desktop',
        },
        lastMessage: null,
        unread: 0,
        autoAccept: false,      // 用户是否已「接受该会话」（决定文件是否静默接收）
        createdAt: Date.now(),
        updatedAt: Date.now(),
        readUpTo: 0,            // 本地已读位点（消息 ts 或序号）
        readUpToId: '',         // 更可靠的已读位点：最后一条已读 msgId
      };
      this.chats.set(peerId, chat);
      // 注意：这里不能重置 _messages 缓存 —— append() 会先写入消息再调 openChat()，
      // 若在此清空缓存，刚追加的那条消息就会从内存视图里消失（只在磁盘上）。
      if (!this._messages.has(peerId)) this._messages.set(peerId, []);
      this._saveIndex();
      this.onChange({ kind: 'chat:new', chat });
    } else if (peer) {
      let changed = false;
      if (peer.name && peer.name !== chat.peer.name) { chat.peer.name = peer.name; changed = true; }
      if (peer.type && peer.type !== chat.peer.type) { chat.peer.type = peer.type; changed = true; }
      if (changed) this._saveIndex();
    }
    return chat;
  }

  /** 会话列表（按最后活跃倒序） */
  summary() {
    return [...this.chats.values()]
      .map((c) => ({
        ...c,
        messageCount: this._loadMessages(c.peerId).length,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(peerId) {
    return this.chats.get(peerId) || null;
  }

  /** 用户点了「接受会话」——此后该会话的文件静默接收 */
  acceptSession(peerId) {
    const chat = this.chats.get(peerId);
    if (!chat) return null;
    chat.autoAccept = true;
    chat.updatedAt = Date.now();
    this._saveIndex();
    this.onChange({ kind: 'chat:accepted', chat });
    return chat;
  }

  /** 是否对该会话启用静默接收（同时受大小/数量阈值约束） */
  canAutoAccept(peerId, { files = [], totalBytes = 0 } = {}) {
    const chat = this.chats.get(peerId);
    if (!chat || !chat.autoAccept) return false;
    if (files.length > (P.CHAT_SILENT_MAX_FILES || 20)) return false;
    if (totalBytes > (P.CHAT_SILENT_MAX_BYTES || 0)) return false;
    return true;
  }

  clear(peerId) {
    const chat = this.chats.get(peerId);
    if (!chat) return { ok: false };
    this._messages.set(peerId, []);
    this._saveMessages(peerId);
    chat.lastMessage = null;
    chat.unread = 0;
    chat.updatedAt = Date.now();
    this._saveIndex();
    this.onChange({ kind: 'chat:cleared', chat });
    return { ok: true };
  }

  deleteChat(peerId) {
    if (!this.chats.has(peerId)) return { ok: false };
    this.chats.delete(peerId);
    this._messages.delete(peerId);
    this._saveIndex();
    try { fs.unlinkSync(this._messagesFile(peerId)); } catch (_) {}
    this.onChange({ kind: 'chat:deleted', peerId });
    return { ok: true };
  }

  // ── 消息 ──────────────────────────────────────────────────

  /**
   * 追加一条消息。
   * @param {string} peerId
   * @param {object} message  { msgId, dir:'in'|'out', kind, text, ts, status, attachment }
   * @returns {{ message: object, duplicate: boolean }}
   */
  append(peerId, message) {
    const list = this._loadMessages(peerId);
    // 去重：重连重放会重复投递同一条消息
    if (message.msgId) {
      const existed = list.find((m) => m.msgId === message.msgId);
      if (existed) return { message: existed, duplicate: true };
    }
    const rec = {
      msgId: message.msgId || P.makeMsgId('local'),
      dir: message.dir === 'in' ? 'in' : 'out',
      kind: message.kind || 'text',
      text: message.text || '',
      ts: message.ts || Date.now(),
      status: message.status || (message.dir === 'in' ? 'received' : DELIVERY.SENT),
      attachment: message.attachment || null,
    };
    // 附件进度类字段必须一并保留，否则「重启后已完成/已传一半的文件」
    // 会因为字段丢失而回退成「未开始」的外观（气泡进度条归零）。
    if (message.progress != null) rec.progress = message.progress;
    if (message.done != null) rec.done = !!message.done;
    if (message.transferId) rec.transferId = message.transferId;
    if (message.silent != null) rec.silent = !!message.silent;
    list.push(rec);
    if (list.length > MESSAGES_PER_CHAT) list.splice(0, list.length - MESSAGES_PER_CHAT);
    this._saveMessages(peerId);

    const chat = this.openChat({ deviceId: peerId, name: message.peerName, type: message.peerType });
    chat.lastMessage = {
      msgId: rec.msgId,
      kind: rec.kind,
      text: rec.kind === 'text' ? rec.text.slice(0, 80) : '',
      fileName: rec.attachment && rec.attachment.files && rec.attachment.files[0]
        ? rec.attachment.files[0].name : '',
      dir: rec.dir,
      ts: rec.ts,
    };
    chat.updatedAt = rec.ts;
    if (rec.dir === 'in' && !message.silent) chat.unread = (chat.unread || 0) + 1;
    this._saveIndex();

    this.onChange({ kind: 'message:new', peerId, chat, message: rec });
    return { message: rec, duplicate: false };
  }

  /** 分页取历史（before 为空表示取最新一页） */
  list(peerId, { before = null, limit = 200 } = {}) {
    const list = this._loadMessages(peerId);
    let end = list.length;
    if (before) {
      const idx = list.findIndex((m) => m.msgId === before);
      if (idx >= 0) end = idx;
    }
    const start = Math.max(0, end - limit);
    return { messages: list.slice(start, end), hasMore: start > 0 };
  }

  /** 按 msgId 更新状态（送达 / 已读 / 失败 / 附件进度） */
  updateStatus(peerId, msgId, patch) {
    const list = this._loadMessages(peerId);
    const m = list.find((x) => x.msgId === msgId);
    if (!m) return null;
    Object.assign(m, patch);
    this._saveMessages(peerId);
    this.onChange({ kind: 'message:update', peerId, message: m });
    return m;
  }

  /** 对端已读：把本地所有 out 消息标为 read */
  markPeerRead(peerId, upToTs = 0) {
    const list = this._loadMessages(peerId);
    let changed = false;
    list.forEach((m) => {
      if (m.dir === 'out' && m.status !== DELIVERY.READ && m.ts <= upToTs) {
        m.status = DELIVERY.READ;
        changed = true;
      }
    });
    if (changed) {
      this._saveMessages(peerId);
      this.onChange({ kind: 'message:update', peerId });
    }
    return { ok: changed };
  }

  /** 本地已读：把该会话 in 消息全部标为已读并清零未读 */
  markLocalRead(peerId) {
    const chat = this.chats.get(peerId);
    if (!chat) return { ok: false };
    const list = this._loadMessages(peerId);
    const lastIn = [...list].reverse().find((m) => m.dir === 'in');
    chat.unread = 0;
    if (lastIn) { chat.readUpTo = lastIn.ts; chat.readUpToId = lastIn.msgId; }
    chat.updatedAt = Date.now();
    this._saveIndex();
    this.onChange({ kind: 'chat:read', chat });
    return { ok: true, upToTs: chat.readUpTo };
  }

  /** 待重发的出站消息（对端离线时留下的 pending） */
  pendingOut(peerId) {
    return this._loadMessages(peerId).filter((m) => m.dir === 'out' && m.status === DELIVERY.PENDING);
  }

  /** 全部会话的总未读数（用于红点） */
  totalUnread() {
    return [...this.chats.values()].reduce((a, c) => a + (c.unread || 0), 0);
  }
}

module.exports = { ChatStore, DELIVERY, MESSAGES_PER_CHAT };
