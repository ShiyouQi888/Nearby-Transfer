const P = require('../shared/protocol.js');

let pass = 0, fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ok  ' + label + ' = ' + a); }
  else { fail++; console.log('  FAIL ' + label + '\n       got      ' + a + '\n       expected ' + e); }
}

console.log('\n[1] NDJSON 拆包 —— 文本消息跨 chunk、多条粘连');
{
  const got = [];
  const dec = new P.NdjsonDecoder((m, isBin) => got.push([m, isBin]));
  const m1 = P.encodeMessage(P.makeMessage('hello', { a: 1 }, 'pc-1'));
  const m2 = P.encodeMessage(P.makeMessage('ping', {}, 'pc-1'));
  const m3 = P.encodeMessage(P.makeMessage('send_offer', { transferId: 't_1' }, 'pc-1'));
  const stream = Buffer.concat([m1, m2, m3]);
  for (let i = 0; i < stream.length; i += 3) dec.push(stream.subarray(i, Math.min(i + 3, stream.length)));
  eq('消息条数', got.length, 3);
  eq('类型序列', got.map((g) => g[0].type), ['hello', 'ping', 'send_offer']);
  eq('均为文本', got.every((g) => !g[1]), true);
}

console.log('\n[2] 二进制帧拼装 —— 帧头 + payload 跨 chunk 到达');
{
  const CHUNK = 256;
  const got = [];
  const dec = new P.NdjsonDecoder((m, isBin) => got.push([m, isBin]));

  // 3 个分片：前两片满 256B，最后一片 100B
  const payloads = [Buffer.alloc(CHUNK, 0x41), Buffer.alloc(CHUNK, 0x42), Buffer.alloc(100, 0x43)];
  const frames = payloads.map((p, i) => P.encodeChunkFrame('f_1', i, p));
  const stream = Buffer.concat(frames);

  // 以 37 字节这种刁钻的粒度切碎喂入
  for (let i = 0; i < stream.length; i += 37) dec.push(stream.subarray(i, Math.min(i + 37, stream.length)));

  eq('完整片数', got.length, 3);
  eq('分片序号', got.map((g) => g[0].seq), [0, 1, 2]);
  eq('fileId', got.map((g) => g[0].fileId), ['f_1', 'f_1', 'f_1']);
  eq('各片长度(末片可不足)', got.map((g) => g[0].payload.length), [256, 256, 100]);
  eq('片0内容正确', got[0][0].payload.equals(payloads[0]), true);
  eq('片2内容正确', got[2][0].payload.equals(payloads[2]), true);
}

console.log('\n[3] 文本与二进制混流共存');
{
  const CHUNK = 8;
  const got = [];
  const dec = new P.NdjsonDecoder((m, b) => got.push(b ? 'BIN:' + m.payload.toString() : 'TXT:' + m.type));
  const stream = Buffer.concat([
    P.encodeMessage(P.makeMessage('send_accept', {}, 'pc-1')),
    P.encodeChunkFrame('f_9', 0, Buffer.from('ABCDEFGH')),
    P.encodeMessage(P.makeMessage('complete', {}, 'pc-1')),
  ]);
  dec.push(stream);
  eq('混流序列', got, ['TXT:send_accept', 'BIN:ABCDEFGH', 'TXT:complete']);
}

console.log('\n[4] 令牌签发与校验');
{
  const secret = 'devsecret';
  const tok = P.signToken(secret, 'mobile-9f8e', Date.now(), 0);
  eq('有效令牌', P.verifyToken(secret, tok), { ok: true, deviceId: 'mobile-9f8e' });
  eq('错误密钥', P.verifyToken('other', tok), { ok: false });
  eq('篡改令牌', P.verifyToken(secret, tok.slice(0, -3) + 'xxx'), { ok: false });
  const expired = P.signToken(secret, 'm1', Date.now() - 10000, 1000);
  eq('过期令牌', P.verifyToken(secret, expired), { ok: false, reason: 'expired' });
}

console.log('\n[5] 二维码载荷往返（含中文设备名）');
{
  const qr = P.encodeQrPayload({ ip: '192.168.1.23', port: 53317, token: 'a1b2c3', name: 'DESKTOP-齐世有', deviceId: 'pc-x' });
  const d = P.decodeQrPayload(qr);
  eq('前缀', qr.startsWith('LTP1:'), true);
  eq('长度适合二维码', qr.length < 400, true);
  eq('ip', d.ip, '192.168.1.23');
  eq('port', d.port, 53317);
  eq('中文名', d.name, 'DESKTOP-齐世有');
  eq('非法输入返回 null', P.decodeQrPayload('https://example.com'), null);
}

console.log('\n[6] 路径安全与文件归类');
{
  eq('阻断 ../ 穿越', P.sanitizeRelPath('../../etc/pa:ss?.txt', 'x.txt'), 'etc/pa_ss_.txt');
  eq('反斜杠归一', P.sanitizeRelPath('DCIM\\Camera\\a.jpg', 'a.jpg'), 'DCIM/Camera/a.jpg');
  eq('空路径回落', P.sanitizeRelPath('', 'a.jpg'), 'a.jpg');
  eq('归类', ['a.jpg', 'b.mp4', 'c.pdf', 'd.zip', 'e.apk', 'f.unk'].map(P.groupOf),
    ['image', 'video', 'doc', 'archive', 'apk', 'other']);
}

console.log('\n[7] 格式化与匹配码');
{
  eq('字节', P.formatBytes(4823912), '4.60 MB');
  eq('速度', P.formatSpeed(12582912), '12.0 MB/s');
  eq('剩余时间', P.formatEta(217000), '3 分 37 秒');
  const codes = new Set();
  for (let i = 0; i < 500; i++) codes.add(P.makePairCode());
  eq('6位数字且首位非0', [...codes].every((c) => /^[1-9]\d{5}$/.test(c)), true);
  eq('随机性良好', codes.size > 490, true);
  eq('设备指纹格式', /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(P.makeFingerprint('s3cret')), true);
}

console.log('\n[8] 速度计');
{
  const m = new P.SpeedMeter();
  m.update(0);
  const t0 = Date.now();
  // 模拟 1 秒内传了 1MB
  m._samples = [{ t: t0, bytes: 0 }, { t: t0 + 1000, bytes: 1048576 }];
  m._last = 1048576;
  eq('速度≈1MB/s', Math.round(m.speed), 1048576);
  eq('ETA 剩余 1MB', m.eta(2097152), 1000);
  eq('已完成返回 null', m.eta(1048576), null);
}

console.log('\n──────────────────────────────');
console.log(`  通过 ${pass} · 失败 ${fail}`);
console.log('──────────────────────────────\n');
process.exit(fail ? 1 : 0);
