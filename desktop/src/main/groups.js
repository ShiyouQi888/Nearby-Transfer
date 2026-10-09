'use strict';

const fs = require('fs');
const path = require('path');

/** Persistent group conversations; transport is handled by GroupHub. */
class GroupStore {
  constructor(dir, onChange = () => {}) {
    this.file = path.join(dir, 'groups.json');
    this.onChange = onChange;
    this.groups = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      let migrated = false;
      for (const g of raw.groups || []) {
        if (!g) continue;
        const id = g.id && g.id !== 'undefined' ? String(g.id) : String(g.groupId || '');
        if (!id) continue;
        if (g.id !== id || g.groupId) { g.id = id; delete g.groupId; migrated = true; }
        this.groups.set(id, g);
      }
      if (migrated) this._save();
    } catch (_) { /* first run or corrupt index: leave a usable empty store */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ groups: [...this.groups.values()] }, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) { console.error('[groups] persist failed', error); }
  }

  list() { return [...this.groups.values()].filter((g) => !g.dissolved).sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id) { return this.groups.get(String(id || '')) || null; }

  create(group) {
    const now = Date.now();
    const value = {
      id: String(group.id), name: String(group.name || '').trim().slice(0, 48),
      ownerId: String(group.ownerId), ownerName: String(group.ownerName || ''),
      host: String(group.host || ''), port: Number(group.port) || 53318,
      token: String(group.token || ''), inviteCode: String(group.inviteCode || ''), inviteExpiresAt: Number(group.inviteExpiresAt) || now + 10 * 60 * 1000,
      members: [{ deviceId: String(group.ownerId), name: String(group.ownerName || ''), type: 'desktop', avatarData: String(group.ownerAvatarData || ''), joinedAt: now }],
      bannedIds: [], messages: [], createdAt: now, updatedAt: now, dissolved: false,
    };
    if (!value.name || !value.token) return null;
    this.groups.set(value.id, value); this._save(); this.onChange({ kind: 'group:created', group: value }); return value;
  }

  join(group) {
    const id = String(group?.id || group?.groupId || '');
    if (!id || id === 'undefined' || !group?.token) return null;
    const existing = this.groups.get(id);
    if (existing) return existing;
    const now = Date.now();
    const value = { ...group, id, name: String(group.name || '').slice(0, 48), members: group.members || [], messages: group.messages || [], createdAt: group.createdAt || now, updatedAt: now, dissolved: false };
    delete value.groupId;
    this.groups.set(value.id, value); this._save(); this.onChange({ kind: 'group:joined', group: value }); return value;
  }

  setMembers(id, members) {
    const g = this.get(id); if (!g || g.dissolved) return null;
    g.members = (members || []).filter((m) => m && m.deviceId).slice(0, 64);
    g.updatedAt = Date.now(); this._save(); this.onChange({ kind: 'group:members', group: g }); return g;
  }

  setUnread(id, count) {
    const g = this.get(id); if (!g || g.dissolved) return null;
    g.unread = Math.max(0, Math.min(999, Number(count) || 0)); g.updatedAt = Date.now(); this._save(); return g;
  }

  updateInvite(id, code, expiresAt = Date.now() + 10 * 60 * 1000) {
    const g = this.get(id); if (!g || g.dissolved) return null;
    g.inviteCode = String(code || ''); g.inviteExpiresAt = Number(expiresAt) || Date.now() + 10 * 60 * 1000;
    g.updatedAt = Date.now(); this._save(); this.onChange({ kind: 'group:invite', group: g }); return g;
  }

  banMember(id, deviceId) {
    const g = this.get(id); if (!g) return null;
    g.bannedIds = Array.from(new Set([...(g.bannedIds || []), String(deviceId || '')].filter(Boolean)));
    g.members = (g.members || []).filter((m) => m.deviceId !== deviceId);
    g.updatedAt = Date.now(); this._save(); this.onChange({ kind: 'group:members', group: g }); return g;
  }

  append(id, message, options = {}) {
    const g = this.get(id); if (!g || g.dissolved) return null;
    const msgId = String(message.msgId || '');
    if (msgId && g.messages.some((m) => m.msgId === msgId)) return null;
    const rec = { ...message, msgId, senderId: String(message.senderId || ''), senderName: String(message.senderName || ''), text: String(message.text || '').slice(0, 4000), ts: Number(message.ts) || Date.now() };
    g.messages.push(rec); if (g.messages.length > 2000) g.messages.splice(0, g.messages.length - 2000);
    if (options.unread) g.unread = Math.min(999, (Number(g.unread) || 0) + 1);
    g.lastMessage = rec; g.updatedAt = rec.ts; this._save(); this.onChange({ kind: 'group:message', group: g, message: rec }); return rec;
  }

  remove(id) { const g = this.get(id); if (!g) return false; g.dissolved = true; g.updatedAt = Date.now(); this._save(); this.onChange({ kind: 'group:dissolved', group: g }); return true; }
}

module.exports = { GroupStore };
