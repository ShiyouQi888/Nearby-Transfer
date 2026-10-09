'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const net = require('net');
const { GroupStore } = require('../desktop/src/main/groups.js');
const { GroupHub } = require('../desktop/src/main/group-hub.js');
const { GroupClient } = require('../desktop/src/main/group-client.js');
const { resolveGroupCode } = require('../desktop/src/main/group-invite.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-groups-'));
  const store = new GroupStore(dir);
  const hub = new GroupHub({ store, deviceId: 'pc-host', name: 'Host', port: 0, discoveryPort: 0 });
  try {
    await hub.listen();
    const group = store.create({ id: 'g-test', name: 'Test group', ownerId: 'pc-host', ownerName: 'Host', host: '127.0.0.1', port: hub.port, token: 'invite-secret', inviteCode: '124578', inviteExpiresAt: Date.now() + 600000 });
    const discovery = dgram.createSocket('udp4');
    const discovered = new Promise((resolve, reject) => {
      discovery.once('error', reject); discovery.bind(0, '127.0.0.1', () => {
        const nonce = 'group-test-nonce'; const request = Buffer.from(JSON.stringify({ v: 1, type: 'group-discover', nonce }));
        discovery.send(request, hub.discoveryPort, '127.0.0.1');
      });
      discovery.once('message', (buffer) => resolve(JSON.parse(buffer.toString('utf8'))));
      setTimeout(() => reject(new Error('group discovery timeout')), 1000).unref();
    });
    const hosts = await discovered; discovery.close();
    assert.equal(hosts.groups[0].groupId, group.id);
    const badCode = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: hub.port }); let buffer = '';
      socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'redeem', groupId: group.id, code: '000000' })}\n`));
      socket.on('data', (chunk) => { buffer += chunk.toString(); const newline = buffer.indexOf('\n'); if (newline >= 0) { resolve(JSON.parse(buffer.slice(0, newline))); socket.destroy(); } });
      socket.on('error', reject);
    });
    assert.equal(badCode.reason, 'invalid_code');
    const redeem = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: hub.port }); let buffer = '';
      socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'redeem', groupId: group.id, code: '124578' })}\n`));
      socket.on('data', (chunk) => { buffer += chunk.toString(); const newline = buffer.indexOf('\n'); if (newline >= 0) { resolve(JSON.parse(buffer.slice(0, newline))); socket.destroy(); } });
      socket.on('error', reject);
    });
    assert.equal(redeem.type, 'invite'); assert.equal(redeem.invite.token, 'invite-secret');
    const redeemWithoutGroupId = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: hub.port }); let buffer = '';
      socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'redeem', code: '124578' })}\n`));
      socket.on('data', (chunk) => { buffer += chunk.toString(); const newline = buffer.indexOf('\n'); if (newline >= 0) { resolve(JSON.parse(buffer.slice(0, newline))); socket.destroy(); } });
      socket.on('error', reject);
    });
    assert.equal(redeemWithoutGroupId.type, 'invite'); assert.equal(redeemWithoutGroupId.invite.groupId, group.id);
    const resolvedInvite = await resolveGroupCode('124578', { discoveryPort: hub.discoveryPort, broadcastAddresses: ['127.0.0.1'], timeoutMs: 100 });
    assert.equal(resolvedInvite.groupId, group.id);
    assert.equal(resolvedInvite.token, 'invite-secret');
    const directInvite = await resolveGroupCode('124578', { broadcastAddresses: [], directHosts: ['127.0.0.1'], groupPort: hub.port, directTimeoutMs: 500, timeoutMs: 20 });
    assert.equal(directInvite.groupId, group.id);
    const invite = hub.invite(group.id);
    const joinedStore = new GroupStore(path.join(dir, 'joined'));
    const joined = joinedStore.join({ ...invite, ownerId: 'pc-host' });
    assert.equal(joined.id, group.id);
    assert.equal(joinedStore.get(group.id).id, group.id);
    const client = new GroupClient({ invite, deviceId: 'android-member', name: 'Phone' });
    assert.equal(client.sendText('before joining'), false);
    const received = new Promise((resolve) => client.on('message', (event) => {
      if (event.type === 'message') resolve(event);
    }));
    const hostGroup = await client.connect();
    assert.equal(hostGroup.id, group.id);
    assert.equal(hostGroup.token, undefined); assert.equal(hostGroup.inviteCode, undefined);
    assert(store.get(group.id).members.some((member) => member.deviceId === 'android-member'));
    // A bearer invitation must not let a member impersonate the owner and issue admin actions.
    client.removeMember('android-member'); client.dissolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(store.get(group.id).dissolved, false);
    assert(store.get(group.id).members.some((member) => member.deviceId === 'android-member'));
    assert.equal(client.sendText('hello group'), true);
    const event = await received;
    assert.equal(event.message.text, 'hello group');
    assert.equal(store.get(group.id).messages.length, 1);
    const fromHost = new Promise((resolve) => client.on('message', (message) => {
      if (message.type === 'message' && message.message?.text === 'reply from host') resolve(message);
    }));
    assert(hub.sendLocal(group.id, 'reply from host'));
    assert.equal((await fromHost).message.senderId, 'pc-host');
    assert.equal(joinedStore.get(group.id).messages.length, 0);
    assert(hub.removeMember(group.id, 'android-member'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(!store.get(group.id).members.some((member) => member.deviceId === 'android-member'));
    const banned = new GroupClient({ invite, deviceId: 'android-member', name: 'Phone' });
    await assert.rejects(() => banned.connect());
    client.close(); banned.close();
    assert.equal(client.sendText('after leaving'), false);
    assert(hub.dissolve(group.id));
    assert.equal(store.get(group.id).dissolved, true);
    console.log('Group invite resolution and hub integration passed.');
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
