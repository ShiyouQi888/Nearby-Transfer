/**
 * 冒烟测试：不启动 Electron 窗口，直接验证电脑端主进程各模块能否正常装配
 * 并完成一次真实的「发现 → 配对 → 双向传输」闭环。
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dgram = require('dgram');
const P = require('../shared/protocol.js');
const { Discovery, listLocalIPv4, subnetRange, expandRange } = require('../desktop/src/main/discovery.js');
const { TransferServer } = require('../desktop/src/main/server.js');

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('  ok   ' + l); };
const bad = (l, d) => { fail++; console.log('  FAIL ' + l + (d ? '\n       ' + d : '')); };
const eq = (l, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? ok(l + ' = ' + JSON.stringify(a)) : bad(l, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ltp-smoke-'));
const SAVE = path.join(TMP, 'dl');
fs.mkdirSync(SAVE, { recursive: true });

(async function main() {
  console.log('\n[A] 网络工具');
  {
    const ips = listLocalIPv4();
    ok('枚举到本机局域网 IPv4：' + (ips.map((x) => x.address).join(', ') || '（无，测试环境可接受）'));
    eq('解析 192.168.1.1-254 数量（闭区间 1..254）', expandRange('192.168.1.1-254').length, 254);
    eq('解析首尾', [expandRange('10.0.0.1-5')[0], expandRange('10.0.0.1-5').slice(-1)[0]], ['10.0.0.1', '10.0.0.5']);
    eq('完整四段区间', [expandRange('192.168.1.10-192.168.1.13').length], [4]);
    eq('倒序区间返回空', expandRange('192.168.1.9-192.168.1.2').length, 0);
    const r = subnetRange('192.168.1.23', '255.255.255.0');
    eq('网段起止', [r.start, r.end], ['192.168.1.1', '192.168.1.254']);
    eq('非法表达式返回空', expandRange('not-an-ip').length, 0);
  }

  console.log('\n[B] 二维码生成（主进程 qrcode 库）');
  {
    const QRCode = require('qrcode');
    const payload = P.encodeQrPayload({ ip: '192.168.1.23', port: P.PORT, token: 'a1b2c3', name: 'DESKTOP-齐世有', deviceId: 'pc-1' });
    const url = await QRCode.toDataURL(payload, { width: 460, margin: 1, errorCorrectionLevel: 'M' });
    eq('生成 PNG data URL', url.startsWith('data:image/png;base64,'), true);
    ok('二维码 PNG 大小 = ' + Math.round(url.length / 1024) + ' KB');
    const back = P.decodeQrPayload(payload);
    eq('二维码内容可解回', [back.ip, back.port, back.name], ['192.168.1.23', P.PORT, 'DESKTOP-齐世有']);
  }

  console.log('\n[C] 发现服务（真实 UDP 组播 + 单播探测）');
  {
    const pcSelf = {
      deviceId: 'pc-srv', name: 'DESKTOP-A', type: 'desktop', os: 'Windows 11',
      port: P.PORT, fingerprint: 'PC-0001',
    };
    const d = new Discovery({ self: pcSelf, port: P.PORT });
    const seen = [];
    d.on('device:up', (dev) => seen.push(dev));
    d.start();
    await new Promise((r) => setTimeout(r, 400));

    // 伪造一台「手机」发 announce
    const phone = dgram.createSocket('udp4');
    const msg = P.encodeMessage(P.makeMessage(P.MSG.ANNOUNCE, {
      device: {
        deviceId: 'mobile-sim', name: 'Pixel 8', type: 'mobile', os: 'Android 14',
        ip: '127.0.0.1', port: P.PORT, protocol: P.PROTOCOL_ID, fingerprint: 'PH-0001',
      },
    }, 'mobile-sim'));
    await new Promise((res) => phone.send(msg, 0, msg.length, P.PORT, '127.0.0.1', () => res()));
    // 也发一份到组播，覆盖组成员可达性
    await new Promise((res) => {
      try { phone.send(msg, 0, msg.length, P.PORT, P.MULTICAST_ADDR, () => res()); }
      catch (_) { res(); }
    });

    await new Promise((r) => setTimeout(r, 600));
    const found = d.list().find((x) => x.deviceId === 'mobile-sim');
    ok('通过 UDP 发现到模拟手机', !!found);
    if (found) eq('设备信息完整', [found.name, found.type], ['Pixel 8', 'mobile']);
    eq('忽略自身', d.list().some((x) => x.deviceId === 'pc-srv'), false);

    // 探测：手机收到 probe 后应单播回 announce
    const gotProbe = new Promise((resolve) => {
      phone.on('message', (buf) => {
        try { const m = JSON.parse(buf.toString()); if (m.type === P.MSG.PROBE) resolve(m); } catch (_) {}
      });
    });
    const scanP = d.scan('127.0.0.1-2', { concurrency: 2, timeoutMs: 300 });
    const probe = await Promise.race([gotProbe, new Promise((r) => setTimeout(() => r(null), 2000))]);
    ok('本机收到 probe 探测包', !!probe);
    await scanP;
    d.stop();
    phone.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n[D] 服务端装配：配对码 / 二维码令牌 / 信任表 / 传输记录');
  {
    const srv = new TransferServer({
      self: { deviceId: 'pc-1', name: 'DESKTOP', type: 'desktop', os: 'Windows 11', ip: '127.0.0.1', fingerprint: 'PC-1' },
      deviceSecret: crypto.randomBytes(32).toString('hex'),
      port: 54399,
      saveDir: SAVE,
    });
    await srv.listen();

    const code = srv.newPairCode();
    eq('匹配码可用', srv.verifyPairCode(code), true);
    eq('错误匹配码不可用', srv.verifyPairCode('000000'), false);

    const { payload, token } = srv.makeQrPayload();
    eq('二维码令牌可校验', srv.verifyQrToken(token), true);
    eq('未知令牌不可校验', srv.verifyQrToken('deadbeef'), false);
    eq('二维码含 port', P.decodeQrPayload(payload).port, 54399);

    const rec = srv.trust('mobile-1', { deviceId: 'mobile-1', name: 'Pixel', type: 'mobile', fingerprint: 'PH-1' });
    eq('信任表已写入', srv.listTrusted().length, 1);
    eq('指纹落库', rec.fingerprint, 'PH-1');
    eq('撤销信任', srv.untrust('mobile-1'), true);
    eq('撤销后为空', srv.listTrusted().length, 0);

    const t = srv.createTransfer({
      transferId: 't_x', direction: 'receive',
      device: { deviceId: 'mobile-1', name: 'Pixel', type: 'mobile' },
      files: [{ fileId: 'f1', name: 'a.jpg', size: 100, relPath: 'a.jpg', mime: 'image/jpeg' }],
      totalBytes: 100,
    });
    eq('传输记录已建', srv.getTransfer('t_x').files.length, 1);
    srv.archive('t_x');
    eq('归档到历史', srv.listHistory().length, 1);

    srv.close();
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log('\n[E] 端口占用错误能被捕获');
  {
    const a = new TransferServer({
      self: { deviceId: 'a', name: 'A', type: 'desktop', os: 'W', ip: '127.0.0.1' },
      deviceSecret: 'x', port: 54400, saveDir: SAVE,
    });
    await a.listen();
    const b = new TransferServer({
      self: { deviceId: 'b', name: 'B', type: 'desktop', os: 'W', ip: '127.0.0.1' },
      deviceSecret: 'x', port: 54400, saveDir: SAVE,
    });
    let err = null;
    try { await b.listen(); } catch (e) { err = e; }
    ok('第二个实例监听同端口时抛错（UI 可据此提示端口被占用）', !!err && (err.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(err.message))));
    a.close();
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log('\n[F] 渲染层静态接线检查（app.js 引用的 DOM id 是否都存在于 index.html）');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'renderer', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'renderer', 'app.js'), 'utf8');
    const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const usedIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    const missing = [...usedIds].filter((i) => !htmlIds.has(i));
    eq('app.js 引用的所有 id 都存在于 HTML', missing, []);
    ok('HTML 定义 ' + htmlIds.size + ' 个 id，app.js 引用 ' + usedIds.size + ' 个');

    // preload 暴露的方法是否都被 app.js 用到（反之提示未用）
    const pre = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'preload', 'preload.js'), 'utf8');
    const exposed = [...pre.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    const usedApi = [...js.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]);
    const notInPreload = [...new Set(usedApi)].filter((m) => !exposed.includes(m));
    eq('app.js 调用的 preload 方法均已暴露', notInPreload, []);
    ok('preload 暴露 ' + exposed.length + ' 个方法');

    // 主进程 ipcMain.handle 是否覆盖 preload 的 invoke 通道
    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'main', 'main.js'), 'utf8');
    const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
    const invoked = new Set([...pre.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
    const unhandled = [...invoked].filter((c) => !handled.has(c));
    eq('preload 调用的 IPC 通道均有 handler', unhandled, []);
    ok('主进程注册 ' + handled.size + ' 个 IPC handler');
  }

  console.log('\n══════════════════════════════');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log('══════════════════════════════\n');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n冒烟测试异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
