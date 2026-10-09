/**
 * 设备发现：UDP 组播 + 网段扫描 (Windows 电脑端 / Node)
 * 协议见 docs/PROTOCOL.md §2
 */

'use strict';

const dgram = require('dgram');
const os = require('os');
const EventEmitter = require('events');
const P = require('../../../shared/protocol.js');

/** 取本机局域网 IPv4 地址列表（排除回环 / 虚拟网卡） */
function listLocalIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // 过滤常见虚拟网卡
      if (/^(vEthernet|VMware|VirtualBox|Loopback|utun|docker|Hyper-V)/i.test(name)) continue;
      out.push({ iface: name, address: a.address, netmask: a.netmask, cidr: a.cidr });
    }
  }
  // 优先 192.168.x / 10.x / 172.16-31.x 这类典型内网段
  out.sort((a, b) => rank(a.address) - rank(b.address));
  return out;
}

function rank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return 2;
  return 3;
}

/** 由 IP + 掩码计算网段起止（用于生成扫描列表） */
function subnetRange(ip, netmask) {
  const toInt = (s) => s.split('.').reduce((acc, o) => (acc << 8) + (+o), 0) >>> 0;
  const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  const ipN = toInt(ip), maskN = toInt(netmask);
  const net = (ipN & maskN) >>> 0;
  const bcast = (net | (~maskN >>> 0)) >>> 0;
  return { start: toIp(net + 1), end: toIp(bcast - 1) };
}

/** 展开 192.168.1.1-254 这类表达式为 IP 列表 */
function expandRange(expr) {
  const s = String(expr || '').trim();
  // 形式一：a.b.c.d-e
  let m = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*-\s*(\d{1,3})$/);
  if (m) {
    const base = m[1].split('.').slice(0, 3).join('.');
    const from = +m[1].split('.')[3];
    const to = +m[2];
    return rangeList(base, from, to);
  }
  // 形式二：a.b.c.d-e.f.g.h（闭区间，含两端）
  m = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*-\s*(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m) {
    const toInt = (x) => x.split('.').reduce((acc, o) => (acc << 8) + (+o), 0) >>> 0;
    const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    const a = toInt(m[1]), b = toInt(m[2]);
    if (b < a || b - a > 4096) return [];
    const out = [];
    for (let i = a; i <= b; i++) out.push(toIp(i));
    return out;
  }
  return [];
}

/** 生成 base.from ~ base.to 的地址列表（闭区间，1..254） */
function rangeList(base, from, to) {
  const out = [];
  const lo = Math.max(1, Math.min(from, to));
  const hi = Math.min(254, Math.max(from, to));
  for (let i = lo; i <= hi; i++) out.push(`${base}.${i}`);
  return out;
}

/**
 * Discovery 服务
 * 事件：device:up / device:down / device:update / scan:progress / error
 */
class Discovery extends EventEmitter {
  constructor(opts) {
    super();
    this.self = opts.self;                    // { deviceId, name, type, os, port, fingerprint }
    this.port = opts.port || P.PORT;
    this.devices = new Map();                 // deviceId -> device(含 ip/lastSeen)
    this._sock = null;
    this._timer = null;
    this._scanning = false;
    this._scanAbort = false;
  }

  start() {
    if (this._sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this._sock = sock;

    sock.on('error', (e) => this.emit('error', e));

    sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));

    sock.on('listening', () => {
      try {
        sock.setBroadcast(true);
        sock.setMulticastTTL(P.MULTICAST_TTL);
        // 多网卡时逐个加入组播组
        for (const { address } of listLocalIPv4()) {
          try { sock.addMembership(P.MULTICAST_ADDR, address); } catch (_) {}
        }
        this.emit('started', { port: sock.address().port });
      } catch (e) {
        this.emit('error', e);
      }
    });

    sock.bind(this.port, () => {});
    // 定时宣告
    this._timer = setInterval(() => {
      this.announce();
      this._sweep();
    }, P.ANNOUNCE_INTERVAL_MS);
    this.announce();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._sock) {
      try { this._send(this._bye()); } catch (_) {}
      try { this._sock.close(); } catch (_) {}
      this._sock = null;
    }
    this._scanAbort = true;
  }

  /** 构造 device 对象（协议 §2.1） */
  _selfDevice(ip) {
    return {
      deviceId: this.self.deviceId,
      name: this.self.name,
      type: this.self.type || 'desktop',
      os: this.self.os || `${os.type()} ${os.release()}`,
      ip: ip || this.primaryIP(),
      port: this.port,
      protocol: P.PROTOCOL_ID,
      pairingRequired: this.self.pairingRequired !== false,
      fingerprint: this.self.fingerprint || '',
      avatarData: this.self.avatarData || '',
    };
  }

  primaryIP() {
    const list = listLocalIPv4();
    return list.length ? list[0].address : '127.0.0.1';
  }

  _announceMsg() {
    return P.encodeMessage(P.makeMessage(P.MSG.ANNOUNCE, { device: this._selfDevice() }, this.self.deviceId));
  }

  _bye() {
    return P.encodeMessage(P.makeMessage(P.MSG.BYE, {}, this.self.deviceId));
  }

  /** 组播 + 广播宣告（广播作为组播被禁用的兜底） */
  announce() {
    if (!this._sock) return;
    const msg = this._announceMsg();
    this._send(msg);
  }

  _send(msg) {
    if (!this._sock) return;
    try { this._sock.send(msg, 0, msg.length, this.port, P.MULTICAST_ADDR); } catch (_) {}
    try { this._sock.send(msg, 0, msg.length, this.port, '255.255.255.255'); } catch (_) {}
  }

  _onMessage(buf, rinfo) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch (_) { return; }
    if (!msg || msg.v !== P.PROTOCOL_VERSION) return;
    if (msg.deviceId === this.self.deviceId) return;   // 忽略自己

    switch (msg.type) {
      case P.MSG.ANNOUNCE:
        if (msg.device) this._upsert(msg.device, rinfo.address);
        break;
      case P.MSG.PROBE:
        // 被探测到：立即单播回一份 announce
        if (msg.wantReply !== false && this._sock) {
          const reply = this._announceMsg();
          try { this._sock.send(reply, 0, reply.length, rinfo.port, rinfo.address); } catch (_) {}
        }
        break;
      case P.MSG.BYE:
        if (msg.deviceId && this.devices.delete(msg.deviceId)) {
          this.emit('device:down', { deviceId: msg.deviceId });
        }
        break;
    }
  }

  _upsert(dev, ip) {
    const existing = this.devices.get(dev.deviceId);
    const merged = {
      ...dev,
      ip: dev.ip || ip,
      lastSeen: Date.now(),
      self: false,
    };
    this.devices.set(dev.deviceId, merged);
    if (!existing) this.emit('device:up', merged);
    else this.emit('device:update', merged);
  }

  /** 清理超时设备 */
  _sweep() {
    const now = Date.now();
    for (const [id, d] of this.devices) {
      if (now - d.lastSeen > P.DEVICE_TIMEOUT_MS) {
        this.devices.delete(id);
        this.emit('device:down', { deviceId: id });
      }
    }
  }

  list() {
    return [...this.devices.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** 手动扫描指定网段（并发探测） */
  async scan(rangeExpr, opts = {}) {
    if (this._scanning) return { cancelled: true };
    const concurrency = opts.concurrency || 24;
    const timeoutMs = opts.timeoutMs || 800;

    let ips = [];
    if (rangeExpr) {
      ips = expandRange(rangeExpr);
      if (!ips.length) throw new Error(`无法解析网段表达式：${rangeExpr}`);
    } else {
      // 按网卡真实掩码计算网段；大于 4096 个地址时依赖广播/组播发现，
      // 避免把企业级大网段展开成数万次单播探测。
      const interfaces = listLocalIPv4();
      for (const { address, netmask } of interfaces) {
        if (!netmask) continue;
        const range = subnetRange(address, netmask);
        const toInt = (s) => s.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0);
        const start = toInt(range.start), end = toInt(range.end);
        if (end >= start && end - start < 4096) {
          const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
          for (let ip = start; ip <= end; ip++) ips.push(toIp(ip));
        }
      }
      ips = [...new Set(ips)];
      if (!ips.length && !interfaces.length) ips = rangeList('192.168.1', 1, 254);
    }

    this._scanning = true;
    this._scanAbort = false;

    const self = this.self.deviceId;
    const before = new Set(this.devices.keys());
    const scanStartedAt = Date.now();
    const probe = P.encodeMessage(P.makeMessage(P.MSG.PROBE, { wantReply: true }, self));
    const sock = this._sock;

    // 先广播/组播一次，兼容手机开启了广播发现但未响应逐 IP 单播的网络；
    // 后续仍保留逐地址探测，覆盖 AP 隔离或广播被禁用的环境。
    try { sock.setBroadcast(true); sock.send(probe, 0, probe.length, this.port, '255.255.255.255'); } catch (_) {}
    try { sock.send(probe, 0, probe.length, this.port, P.MULTICAST_ADDR); } catch (_) {}
    for (const { address, netmask } of listLocalIPv4()) {
      if (!netmask) continue;
      try {
        const { end } = subnetRange(address, netmask);
        const broadcast = (Number(end.split('.')[0]) * 0x1000000 + Number(end.split('.')[1]) * 0x10000 + Number(end.split('.')[2]) * 0x100 + Number(end.split('.')[3]) + 1) >>> 0;
        const directed = [broadcast >>> 24, (broadcast >>> 16) & 255, (broadcast >>> 8) & 255, broadcast & 255].join('.');
        sock.send(probe, 0, probe.length, this.port, directed);
      } catch (_) {}
    }

    let done = 0;
    const total = ips.length;

    const worker = async () => {
      while (ips.length && !this._scanAbort) {
        const ip = ips.shift();
        if (!sock) break;
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; clearTimeout(t); resolve(); } };
          const t = setTimeout(finish, timeoutMs);
          try {
            sock.send(probe, 0, probe.length, this.port, ip, () => {});
          } catch (_) { finish(); }
          // UDP 无回执，靠 timeout 推进；announce 回包由 _onMessage 异步处理
          setTimeout(() => { done++; this.emit('scan:progress', { done, total }); finish(); }, 30);
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

    // 给最后的回包一点时间落表
    await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 900)));

    this._scanning = false;
    const found = this.list().filter((d) => !before.has(d.deviceId) || d.lastSeen >= scanStartedAt - 100);
    this.emit('scan:done', { total, found: found.length });
    return { total, scanned: done, found, cancelled: this._scanAbort };
  }

  cancelScan() { this._scanAbort = true; }
}

module.exports = { Discovery, listLocalIPv4, subnetRange, expandRange, rangeList };
