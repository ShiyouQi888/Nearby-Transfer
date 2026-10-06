/**
 * 移动端截图（开发用）：用 CDP 精确设置移动视口，截取连接页与主界面。
 * 用法：node scripts/shoot-mobile.mjs <url>
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_ = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9334;
const OUT = path.join(__dirname, '..', '_shots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function cdpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = Buffer.from(Math.random().toString()).toString('base64').slice(0, 16);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (res, socket) => {
      const listeners = [];
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
          listeners.forEach((f) => f(payload.toString()));
        }
      });
      const send = (str) => {
        const data = Buffer.from(str);
        const mask = Buffer.from([1, 2, 3, 4]);
        let header;
        if (data.length < 126) { header = Buffer.alloc(6); header[0] = 0x81; header[1] = 0x80 | data.length; }
        else { header = Buffer.alloc(8); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
        const masked = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
        socket.write(Buffer.concat([header, mask, masked]));
      };
      resolve({ send, on: (f) => listeners.push(f) });
    });
    req.on('error', reject);
    req.end();
  });
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + path.join(OUT, '_cdp_prof_m'),
  'about:blank',
], { stdio: 'ignore' });

await new Promise((r) => setTimeout(r, 2600));

try {
  const tabs = await cdpGet('/json');
  const page = tabs.find((t) => t.type === 'page');
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on((msg) => { const m = JSON.parse(msg); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cmd = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cmd('Page.navigate', { url: URL_ });
  await new Promise((r) => setTimeout(r, 1800));

  // 连接页
  let shot = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'mobile-connect.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('[shot] mobile-connect.png');

  // 切到主界面（伪造已连接状态，仅为截图展示）
  await cmd('Runtime.evaluate', { expression: `(() => {
    document.getElementById('screen-connect').classList.remove('active');
    document.getElementById('screen-main').classList.add('active');
    document.getElementById('peerName').textContent = 'DESKTOP-IEUIHUM';
    document.getElementById('peerMeta').textContent = '192.168.100.131:53317 · 已配对';
    // 造几条待发送 + 接收记录，便于查看样式
    const pv = document.getElementById('pickPreview');
    pv.innerHTML = window.__mkRow ? '' : '';
  })()` });
  await new Promise((r) => setTimeout(r, 400));
  shot = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'mobile-main.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('[shot] mobile-main.png');
} catch (e) {
  console.error('截图失败：', e.message);
} finally {
  chrome.kill();
}
process.exit(0);
