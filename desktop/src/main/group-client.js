'use strict';

const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');

class GroupClient extends EventEmitter {
  constructor({ invite, deviceId, name, avatarData = '' }) {
    super(); this.invite = invite; this.deviceId = deviceId; this.name = name; this.avatarData = avatarData;
    this.socket = null; this.buffer = ''; this.joined = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = this.socket = net.createConnection({ host: this.invite.host, port: Number(this.invite.port) || 53318 });
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('群聊连接超时')); }, 8000);
      socket.once('connect', () => this._send({ type: 'join', groupId: this.invite.groupId, token: this.invite.token, deviceId: this.deviceId, name: this.name, avatarData: this.avatarData }));
      socket.on('data', (data) => {
        this.buffer += data.toString('utf8');
        if (this.buffer.length > 16 * 1024) return socket.destroy();
        let nl; while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl); this.buffer = this.buffer.slice(nl + 1);
          let message; try { message = JSON.parse(line); } catch (_) { continue; }
          if (message.type === 'joined') { this.joined = true; clearTimeout(timeout); this.emit('joined', message.group); resolve(message.group); }
          else if (message.type === 'error') { clearTimeout(timeout); reject(new Error(message.reason || '群聊加入失败')); }
          else this.emit('message', message);
        }
      });
      socket.on('error', (error) => { clearTimeout(timeout); if (!this.joined) reject(error); else this.emit('connectionError', error); });
      socket.on('close', () => { this.joined = false; this.emit('close'); });
    });
  }

  _send(value) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
    try { this.socket.write(`${JSON.stringify(value)}\n`); return true; } catch (_) { return false; }
  }
  sendText(text) {
    const value = String(text || '').trim();
    if (!this.joined || !value || value.length > 4000) return false;
    return this._send({ type: 'message', groupId: this.invite.groupId, text: value });
  }
  async sendFile(filePath, meta) {
    if (!this.joined || !filePath || !meta?.transferId || !meta.fileId) return false;
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return false;
    const start = { type: 'file_start', groupId: this.invite.groupId, transferId: meta.transferId, fileId: meta.fileId, name: meta.name, size: stat.size, mime: meta.mime || 'application/octet-stream', senderId: this.deviceId, senderName: this.name };
    if (!this._send(start)) return false;
    const input = fs.createReadStream(filePath, { highWaterMark: 6144 }); let seq = 0;
    for await (const chunk of input) {
      if (!this._send({ type: 'file_chunk', groupId: this.invite.groupId, transferId: meta.transferId, fileId: meta.fileId, seq: seq++, data: chunk.toString('base64'), senderId: this.deviceId, senderName: this.name })) return false;
    }
    return this._send({ type: 'file_end', groupId: this.invite.groupId, transferId: meta.transferId, fileId: meta.fileId, senderId: this.deviceId, senderName: this.name });
  }
  removeMember(deviceId) { this._send({ type: 'remove', groupId: this.invite.groupId, targetId: deviceId }); }
  dissolve() { this._send({ type: 'dissolve', groupId: this.invite.groupId }); }
  leave() { this._send({ type: 'leave', groupId: this.invite.groupId }); }
  close() { clearTimeout(this.retryTimer); this.retryTimer = null; if (this.socket) this.socket.destroy(); }
}

module.exports = { GroupClient };
