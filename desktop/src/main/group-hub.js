'use strict';

const net = require('net');
const dgram = require('dgram');
const EventEmitter = require('events');
const crypto = require('crypto');

const PORT = 53318;
const DISCOVERY_PORT = 53300;
const MAX_LINE = 16 * 1024;
const AVATAR_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{1,22000}$/;

class GroupHub extends EventEmitter {
  constructor({ store, deviceId, name, port = PORT, discoveryPort = DISCOVERY_PORT }) {
    super(); this.store = store; this.deviceId = deviceId; this.name = name; this.port = port;
    this.discoveryPort = discoveryPort; this.server = null; this.clients = new Set(); this.discovery = null; this.redeemAttempts = new Map();
  }

  async listen() {
    if (this.server) return Promise.resolve();
    this.server = net.createServer((socket) => this._accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => { this.server.removeListener('error', reject); this.port = this.server.address().port; resolve(); });
    });
    this.discovery = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.discovery.on('message', (buf, rinfo) => this._discover(buf, rinfo));
    this.discovery.on('error', (error) => this.emit('error', error));
    await new Promise((resolve, reject) => {
      this.discovery.once('error', reject);
      this.discovery.bind(this.discoveryPort, '0.0.0.0', () => { this.discovery.removeListener('error', reject); try { this.discovery.setBroadcast(true); this.discoveryPort = this.discovery.address().port; } catch (_) {} resolve(); });
    });
  }

  close() {
    for (const client of this.clients) { try { client.socket.destroy(); } catch (_) {} }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
    if (this.discovery) { try { this.discovery.close(); } catch (_) {} this.discovery = null; }
  }

  invite(groupId) {
    const group = this.store.get(groupId); if (!group || group.ownerId !== this.deviceId) return null;
    const ip = this._primaryIp();
    return { scheme: 'nearby-group-v1', groupId: group.id, name: group.name, ownerId: this.deviceId, ownerName: this.name, host: ip, port: this.port, token: group.token };
  }

  sendLocal(groupId, text) {
    const g = this.store.get(groupId); const value = String(text || '').trim();
    if (!g || g.dissolved || g.ownerId !== this.deviceId || !value || value.length > 4000) return null;
    const message = this.store.append(groupId, { msgId: crypto.randomUUID(), senderId: this.deviceId, senderName: this.name, text: value });
    if (message) this._broadcast(groupId, { type: 'message', groupId, message });
    return message;
  }

  sendFileMessage(groupId, message) {
    const group = this.store.get(groupId);
    if (!group || group.dissolved || !message || message.groupId !== group.id) return false;
    this._broadcast(group.id, message);
    return true;
  }

  removeMember(groupId, targetId) {
    const group = this.store.get(groupId); if (!group || group.ownerId !== this.deviceId || targetId === this.deviceId) return false;
    this.store.banMember(groupId, targetId);
    const members = group.members.filter((m) => m.deviceId !== targetId);
    for (const c of [...this.clients]) if (c.groupId === groupId && c.deviceId === targetId) { this._send(c, { type: 'removed', groupId }); c.socket.end(); }
    this._broadcast(groupId, { type: 'members', groupId, members }); return true;
  }

  dissolve(groupId) {
    const group = this.store.get(groupId); if (!group || group.ownerId !== this.deviceId) return false;
    this._broadcast(groupId, { type: 'dissolved', groupId }); this.store.remove(groupId);
    for (const c of [...this.clients]) if (c.groupId === groupId) c.socket.end(); return true;
  }

  _primaryIp() {
    const os = require('os');
    for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && !/^169\.254\./.test(entry.address)) return entry.address;
    }
    return '127.0.0.1';
  }

  _discover(buf, rinfo) {
    let request; try { request = JSON.parse(buf.toString('utf8')); } catch (_) { return; }
    if (request.type !== 'group-discover' || request.v !== 1 || typeof request.nonce !== 'string') return;
    const groups = this.store.list().filter((g) => g.ownerId === this.deviceId && g.inviteCode && g.inviteExpiresAt > Date.now())
      .map((g) => ({ groupId: g.id, name: g.name, ownerName: g.ownerName, port: this.port }));
    const payload = Buffer.from(JSON.stringify({ v: 1, type: 'group-hosts', nonce: request.nonce, groups }));
    try { this.discovery.send(payload, rinfo.port, rinfo.address); } catch (_) {}
  }

  _redeem(client, msg) {
    const now = Date.now(), ip = String(client.socket.remoteAddress || '');
    const prior = this.redeemAttempts.get(ip) || { count: 0, since: now };
    if (now - prior.since > 60000) { prior.count = 0; prior.since = now; }
    prior.count++; this.redeemAttempts.set(ip, prior);
    if (prior.count > 12) { this._send(client, { type: 'error', reason: 'rate_limited' }); return client.socket.end(); }
    const groupId = String(msg.groupId || '');
    const group = groupId
      ? this.store.get(groupId)
      : this.store.list().find((item) => item.ownerId === this.deviceId && item.inviteCode && item.inviteExpiresAt >= now && String(msg.code || '') === item.inviteCode);
    if (!group || group.ownerId !== this.deviceId || group.inviteExpiresAt < now || String(msg.code || '') !== group.inviteCode) {
      this._send(client, { type: 'error', reason: 'invalid_code' }); return client.socket.end();
    }
    this._send(client, { type: 'invite', invite: this.invite(group.id) });
    client.socket.end();
  }

  _accept(socket) {
    socket.setNoDelay(true); const client = { socket, buffer: '', groupId: '', deviceId: '', name: '' };
    // Group sockets are long-lived idle connections; disconnecting them on read-idle
    // would silently take a chat offline after two minutes.
    this.clients.add(client);
    socket.on('data', (data) => {
      client.buffer += data.toString('utf8');
      if (client.buffer.length > MAX_LINE) return socket.destroy();
      let nl;
      while ((nl = client.buffer.indexOf('\n')) >= 0) {
        const line = client.buffer.slice(0, nl); client.buffer = client.buffer.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch (_) { return socket.destroy(); }
        this._message(client, msg);
      }
    });
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
  }

  _send(client, value) { if (!client.socket.destroyed) client.socket.write(`${JSON.stringify(value)}\n`); }

  _message(client, msg) {
    if (!client.groupId) {
      if (msg.type === 'redeem') return this._redeem(client, msg);
      if (msg.type !== 'join' || !msg.groupId || !msg.token || !msg.deviceId) return client.socket.destroy();
      const group = this.store.get(msg.groupId);
      if (!group || group.dissolved || group.token !== msg.token || (group.bannedIds || []).includes(String(msg.deviceId))) { this._send(client, { type: 'error', reason: 'invite_invalid' }); return client.socket.destroy(); }
      client.groupId = group.id; client.deviceId = String(msg.deviceId).slice(0, 128); client.name = String(msg.name || client.deviceId).slice(0, 64);
      const avatarData = AVATAR_RE.test(String(msg.avatarData || '')) ? String(msg.avatarData) : '';
      const members = [...group.members.filter((m) => m.deviceId !== client.deviceId), { deviceId: client.deviceId, name: client.name, type: String(msg.deviceType || (/^mobile[-_]/i.test(client.deviceId) ? 'mobile' : 'desktop')), avatarData, joinedAt: Date.now() }];
      this.store.setMembers(group.id, members);
      this._send(client, { type: 'joined', group: this._publicGroup(group) });
      this._broadcast(group.id, { type: 'members', groupId: group.id, members: group.members });
      return;
    }
    const group = this.store.get(client.groupId); if (!group || group.dissolved) return client.socket.destroy();
    if (msg.groupId !== group.id) return;
    if (msg.type === 'message') {
      const text = String(msg.text || '').trim(); if (!text || text.length > 4000) return;
      const rec = this.store.append(group.id, { msgId: String(msg.msgId || crypto.randomUUID()), senderId: client.deviceId, senderName: client.name, text }, { unread: true });
      if (rec) this._broadcast(group.id, { type: 'message', groupId: group.id, message: rec });
    } else if (msg.type === 'file_start' || msg.type === 'file_chunk' || msg.type === 'file_end') {
      const value = { ...msg, groupId: group.id, senderId: client.deviceId, senderName: client.name };
      if (msg.type === 'file_start') {
        value.name = String(msg.name || '文件').slice(0, 255);
        value.size = Math.max(0, Number(msg.size) || 0);
        value.mime = String(msg.mime || 'application/octet-stream').slice(0, 160);
      }
      if (msg.type === 'file_chunk' && typeof msg.data !== 'string') return;
      this._broadcast(group.id, value);
      this.emit('file', value);
    } else if (msg.type === 'leave') {
      const members = group.members.filter((m) => m.deviceId !== client.deviceId);
      this.store.setMembers(group.id, members); this._broadcast(group.id, { type: 'members', groupId: group.id, members }); client.socket.end();
    }
  }

  _publicGroup(g) { const { token, inviteCode, inviteExpiresAt, ...rest } = g; return rest; }
  _broadcast(groupId, value) { for (const c of this.clients) if (c.groupId === groupId) this._send(c, value); this.emit('event', value); }
}

module.exports = { GroupHub, GROUP_PORT: PORT, GROUP_DISCOVERY_PORT: DISCOVERY_PORT };
