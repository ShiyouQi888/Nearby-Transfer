/**
 * 手机端多断点横向溢出审计（CDP）
 *
 * 用无头 Chrome 的 Emulation.setDeviceMetricsOverride 精确指定视口宽度，
 * 比较 documentElement.scrollWidth > clientWidth，并列出右边界超出的元素。
 * 坐标/尺寸均通过 Runtime.evaluate 从真实渲染结果取得。
 *
 * 用法：node scripts/overflow-audit-mobile.js <url>
 */

'use strict';

const http = require('http');
const { spawn } = require('child_process');

const URL_ = process.argv[2] || 'http://127.0.0.1:5399/';
const PORT = 9333;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WIDTHS = [320, 360, 390, 414];

function cdpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function wsConnect(wsUrl) {
  // 极简 WebSocket 客户端（避免 ws 依赖）
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = Buffer.from(String(Math.random())).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => {
      const net = require('net');
      let buf = Buffer.alloc(0);
      const listeners = [];
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0] & 0x80) !== 0;
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f; let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 0x1 || op === 0x2) {
            if (fin) listeners.forEach((f) => f(payload.toString('utf8')));
          }
        }
      });
      const send = (str) => {
        const data = Buffer.from(str, 'utf8');
        const mask = Buffer.alloc(4);
        for (let i = 0; i < 4; i++) mask[i] = (Math.random() * 256) | 0;
        let header;
        if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
        else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
        const masked = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
        socket.write(Buffer.concat([header, mask, masked]));
      };
      resolve({ send, on: (f) => listeners.push(f), socket });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + require('path').join(__dirname, '..', '_shots', '_cdp_prof'),
    'about:blank',
  ], { stdio: 'ignore' });

  await new Promise((r) => setTimeout(r, 2500));

  try {
    const tabs = await cdpGet('/json');
    const page = tabs.find((t) => t.type === 'page');
    const ws = await wsConnect(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.on((msg) => {
      const m = JSON.parse(msg);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const cmd = (method, params = {}) => new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

    await cmd('Page.enable');
    await cmd('Runtime.enable');

    let anyFail = false;
    for (const w of WIDTHS) {
      await cmd('Emulation.setDeviceMetricsOverride', {
        width: w, height: 844, deviceScaleFactor: 2, mobile: true,
      });
      await cmd('Page.navigate', { url: URL_ });
      await new Promise((r) => setTimeout(r, 1500));

      const expr = `(() => {
        const de = document.documentElement;
        const vw = de.clientWidth;
        const overflow = de.scrollWidth - vw;
        const bad = [];
        document.querySelectorAll('body *').forEach(el => {
          if (el.closest('.table-scroll, .scanqr-mask')) return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          if (r.right > vw + 1) {
            bad.push({ tag: el.tagName.toLowerCase(), cls: (el.className||'').toString().slice(0,40), right: Math.round(r.right), vw });
          }
        });
        return JSON.stringify({ vw, overflow, bad: bad.slice(0, 8) });
      })()`;
      const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true });
      const data = JSON.parse(r.result.result.value);
      const pass = data.overflow <= 1 && data.bad.length === 0;
      if (!pass) anyFail = true;
      console.log(`  ${pass ? '[PASS]' : '[FAIL]'} 视口 ${w}px · 溢出 ${data.overflow}px · 超界元素 ${data.bad.length}`);
      data.bad.forEach((b) => console.log(`         ↳ <${b.tag} class="${b.cls}"> right=${b.right} > vw=${b.vw}`));
    }
    console.log(anyFail ? '\n存在横向溢出，需修复。' : '\n所有断点均无横向溢出。');
    process.exit(anyFail ? 1 : 0);
  } catch (e) {
    console.error('审计异常：', e.message);
    process.exit(2);
  } finally {
    chrome.kill();
  }
})();
