'use strict';

const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const { listLocalIPv4 } = require('./discovery.js');

const DISCOVERY_PORT = 53300;

function broadcasts() {
  const values = new Set(['255.255.255.255']);
  for (const item of listLocalIPv4()) {
    const ip = item.address.split('.').map(Number), mask = item.netmask.split('.').map(Number);
    const address = ip.map((n, i) => (n & mask[i]) | (~mask[i] & 255)).join('.');
    if (address !== '255.255.255.255') values.add(address);
  }
  return [...values];
}

function tcpRedeem(host, port, groupId, code, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) || 53318 });
    let data = '', done = false;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'redeem', ...(groupId ? { groupId } : {}), code })}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8'); const end = data.indexOf('\n'); if (end < 0) return;
      try { const message = JSON.parse(data.slice(0, end)); const invite = message.type === 'invite' ? message.invite : null; if (invite?.token) { invite.host = host; invite.port = Number(port) || invite.port; finish(invite); } else finish(null); }
      catch (_) { finish(null); }
    });
    socket.on('error', () => finish(null)); socket.on('close', () => finish(null));
  });
}

function directHosts() {
  const hosts = new Set();
  const toInt = (value) => value.split('.').reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
  const toIp = (value) => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
  for (const item of listLocalIPv4()) {
    const ip = toInt(item.address), mask = toInt(item.netmask);
    const network = (ip & mask) >>> 0, broadcast = (network | (~mask >>> 0)) >>> 0;
    const size = broadcast - network - 1;
    // Keep the fallback bounded. Typical home/LAN networks are /24; a very
    // large subnet should continue using UDP discovery rather than probing it.
    if (size < 1 || size > 1024) continue;
    for (let address = network + 1; address < broadcast; address++) hosts.add(toIp(address));
  }
  return [...hosts];
}

async function redeemDirectHosts(code, options = {}) {
  const candidates = [...(options.directHosts || directHosts())];
  const ports = [Number(options.groupPort) || 53318];
  // The Android emulator is behind NAT and cannot be reached from the host
  // through its 10.0.2.x address. The local dev launcher may expose the phone
  // service through adb forward without changing the production protocol.
  const bridgePort = Number(process.env.LTP_GROUP_BRIDGE_PORT) || 0;
  if (process.env.LTP_DEV === '1' && bridgePort) {
    if (!candidates.includes('127.0.0.1')) candidates.push('127.0.0.1');
    if (!ports.includes(bridgePort)) ports.push(bridgePort);
  }
  const targets = candidates.flatMap((host) => ports.map((port) => ({ host, port })));
  const concurrency = Math.max(1, Number(options.directConcurrency) || 64);
  const timeoutMs = Math.max(100, Number(options.directTimeoutMs) || 350);
  for (let offset = 0; offset < targets.length; offset += concurrency) {
    const batch = targets.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map((target) => tcpRedeem(target.host, target.port, '', code, timeoutMs)));
    const invite = results.find(Boolean);
    if (invite) return invite;
  }
  return null;
}

async function resolveGroupCode(rawCode, options = {}) {
  const code = String(rawCode || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位群聊口令');
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => {});
  const nonce = crypto.randomBytes(8).toString('hex');
  const hosts = new Map();
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '0.0.0.0', () => { socket.removeListener('error', reject); socket.setBroadcast(true); resolve(); });
    });
    socket.on('message', (buffer, rinfo) => {
      try {
        const packet = JSON.parse(buffer.toString('utf8'));
        if (packet.v !== 1 || packet.type !== 'group-hosts' || packet.nonce !== nonce || !Array.isArray(packet.groups)) return;
        for (const group of packet.groups) if (group.groupId) hosts.set(`${rinfo.address}/${group.groupId}`, { host: rinfo.address, ...group });
      } catch (_) { /* ignore unrelated LAN datagrams */ }
    });
    const request = Buffer.from(JSON.stringify({ v: 1, type: 'group-discover', nonce }));
    for (const address of options.broadcastAddresses || broadcasts()) socket.send(request, options.discoveryPort || DISCOVERY_PORT, address);
    await new Promise((resolve) => setTimeout(resolve, options.timeoutMs || 1100));
  } finally { socket.close(); }
  const results = await Promise.all([...hosts.values()].map((group) => tcpRedeem(group.host, group.port, group.groupId, code)));
  let invite = results.find(Boolean);
  // UDP broadcast replies are unavailable on some Wi-Fi APs and from Android
  // emulators. Probe the local subnet over the same TCP redeem protocol as a
  // bounded fallback so a valid phone-hosted group remains discoverable.
  if (!invite) invite = await redeemDirectHosts(code, options);
  if (!invite) throw new Error('口令无效或已过期，请确认双方在同一局域网并向群主索取新口令');
  return invite;
}

module.exports = { resolveGroupCode, broadcasts, GROUP_DISCOVERY_PORT: DISCOVERY_PORT };
