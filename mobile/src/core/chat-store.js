/**
 * 聊天会话存储（手机端）
 *
 * 与电脑端 desktop/src/main/chat.js 保持同一套数据语义，只是落到 localStorage：
 *   ltp_chat_index                → 会话索引 [{ peerId, peer, lastMessage, unread, autoAccept, ... }]
 *   ltp_chat_msgs_<peerId>        → 该会话的消息时间线 [message]
 *
 * 为什么两端各写一份而不共享：
 *   电脑端要落磁盘文件、手机端只能用 WebView 的 localStorage；
 *   但「消息模型」(msgId 去重 / 到达顺序排序 / unread / delivery / autoAccept) 必须一致，
 *   否则同一段对话在两端语义会分叉。此处刻意与 desktop 版逐字段对齐。
 *
 * 设计要点（与 docs/CHAT.md 一致）：
 *   1) 排序以「数组追加顺序」为准，ts 仅用于展示 —— 两端时钟可能有偏差。
 *   2) 去重一律按 msgId。
 *   3) 手机端消息量有限，直接整表 JSON 存 localStorage 即可；
 *      超限从最旧裁剪，避免 5MB 配额被打爆。
 */

const INDEX_KEY = 'ltp_chat_index';
const MSG_PREFIX = 'ltp_chat_msgs_';

/** 单个会话最多保留的消息条数 */
export const MESSAGES_PER_CHAT = 500;

/** 消息发送状态（本地视图，不参与协议传输） */
export const DELIVERY = Object.freeze({
  PENDING: 'pending',       // 本地已入列，尚未发出（对端离线）
  SENT: 'sent',             // 已写入 socket
  DELIVERED: 'delivered',   // 对端回 chat_ack
  READ: 'read',             // 对端回 chat_read
  FAILED: 'failed',
});

function safeParse(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (_) { return fallback; }
}

function sanitizeId(s) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_');
}

export class ChatStore {
  /** @param {object} [opts] @param {function} [opts.onChange] 变更回调 */
  constructor(opts = {}) {
    this.onChange = opts.onChange || (() => {});
    /** peerId -> 会话摘要 */
    this.chats = new Map();
    /** peerId -> message[] （内存缓存） */
    this._messages = new Map();
    this._loadIndex();
  }

  // ── 持久化 ────────────────────────────────────────────────

  _loadIndex() {
    const raw = safeParse(localStorage.getItem(INDEX_KEY), { chats: [] });
    (raw.chats || []).forEach((c) => {
      if (c && c.peerId) this.chats.set(c.peerId, c);
    });
  }

  _saveIndex() {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify({ chats: [...this.chats.values()] }));
    } catch (e) {
      console.warn('[chat] 保存会话索引失败', e);
    }
  }

  _msgKey(peerId) { return MSG_PREFIX + sanitizeId(peerId); }

  _loadMessages(peerId) {
    if (this._messages.has(peerId)) return this._messages.get(peerId);
    let list = safeParse(localStorage.getItem(this._msgKey(peerId)), null);
    if (!Array.isArray(list)) list = [];
    if (list.length > MESSAGES_PER_CHAT) list = list.slice(-MESSAGES_PER_CHAT);
    this._messages.set(peerId, list);
    return list;
  }

  _saveMessages(peerId) {
    const list = this._messages.get(peerId);
    if (!list) return;
    try {
      localStorage.setItem(this._msgKey(peerId), JSON.stringify(list));
    } catch (e) {
      // 配额打满：砍掉一半最旧的再试一次
      try {
        const trimmed = list.slice(-Math.floor(MESSAGES_PER_CHAT / 2));
        localStorage.setItem(this._msgKey(peerId), JSON.stringify(trimmed));
      } catch (_) { console.warn('[chat] 保存消息失败', e); }
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
        chatId: 'c_' + sanitizeId(peerId),
        peer: {
          deviceId: peerId,
          name: (peer && peer.name) || peerId,
          type: (peer && peer.type) || 'desktop',
        },
        lastMessage: null,
        unread: 0,
        autoAccept: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        readUpTo: 0,
        readUpToId: '',
      };
      this.chats.set(peerId, chat);
      // 不能重置 _messages：append() 会先写消息再调 openChat()
      if (!this._messages.has(peerId)) this._messages.set(peerId, []);
      this._saveIndex();
      this.onChange({ kind: 'chat:new', chat });
    } else if (peer && peer.name && peer.name !== chat.peer.name) {
      chat.peer.name = peer.name;
      this._saveIndex();
    }
    return chat;
  }

  /** 会话列表（按最后活跃倒序） */
  summary() {
    return [...this.chats.values()]
      .map((c) => ({ ...c, messageCount: this._loadMessages(c.peerId).length }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(peerId) { return this.chats.get(peerId) || null; }

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

  /** 是否对该会话启用静默接收（同时受大小/数量阈值约束，由调用方传入） */
  canAutoAccept(peerId, { files = [], totalBytes = 0, maxFiles = 20, maxBytes = 500 * 1024 * 1024 } = {}) {
    const chat = this.chats.get(peerId);
    if (!chat || !chat.autoAccept) return false;
    if (files.length > maxFiles) return false;
    if (totalBytes > maxBytes) return false;
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
    try { localStorage.removeItem(this._msgKey(peerId)); } catch (_) {}
    this.onChange({ kind: 'chat:deleted', peerId });
    return { ok: true };
  }

  // ── 消息 ──────────────────────────────────────────────────

  /**
   * 追加一条消息（按 msgId 去重）
   * @returns {{ message: object, duplicate: boolean }}
   */
  append(peerId, message) {
    const list = this._loadMessages(peerId);
    if (message.msgId) {
      const existed = list.find((m) => m.msgId === message.msgId);
      if (existed) return { message: existed, duplicate: true };
    }
    const rec = {
      msgId: message.msgId || ('m_local_' + Date.now()),
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

    const chat = this.openChat({ deviceId: peerId, name: message.peerName });
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

  /** 按 msgId 更新字段（送达 / 已读 / 附件元数据） */
  updateStatus(peerId, msgId, patch) {
    const list = this._loadMessages(peerId);
    const m = list.find((x) => x.msgId === msgId);
    if (!m) return null;
    Object.assign(m, patch);
    this._saveMessages(peerId);
    this.onChange({ kind: 'message:update', peerId, message: m });
    return m;
  }

  /** 对端已读：把本地 out 消息标为 read */
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

  /** 本地已读：清零未读并记录位点 */
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

  /** 待重发的出站消息 */
  pendingOut(peerId) {
    return this._loadMessages(peerId).filter((m) => m.dir === 'out' && m.status === DELIVERY.PENDING);
  }

  /** 全部会话的总未读数（用于红点） */
  totalUnread() {
    return [...this.chats.values()].reduce((a, c) => a + (c.unread || 0), 0);
  }
}
