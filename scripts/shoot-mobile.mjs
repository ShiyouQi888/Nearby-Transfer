/**
 * 移动端截图（开发用）：用 CDP 精确设置移动视口，截取连接页 / 主界面 / 聊天面板。
 *
 * 用法：node scripts/shoot-mobile.mjs [url]
 *
 * 实现说明：
 *   早期版本手写 WebSocket 帧编解码，在新版 Chrome 上握手偶尔不返回，导致脚本挂死。
 *   Node 22 内置了全局 WebSocket，直接用它连 CDP 更稳。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_ = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = Number(process.env.CDP_PORT || 9334);
const OUT = path.join(__dirname, '..', '_shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

fs.mkdirSync(OUT, { recursive: true });

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待 CDP 就绪 */
async function waitForCdp(timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await httpJson('/json/version');
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (_) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('CDP 未就绪（超时）');
    await sleep(300);
  }
}

/** 打开一个 page target 并连上它 */
async function openPageTarget() {
  // 用 /json/new 显式建一个标签页，避免被扩展的 background_page 干扰
  const created = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      },
    );
    req.on('error', reject);
    req.end();
  });
  return created;
}

const profileDir = path.join(OUT, '_cdp_prof_m');
try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;
try {
  await waitForCdp();
  const target = await openPageTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const cmd = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  const shoot = async (name) => {
    const r = await cmd('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      console.log('[shot]', name);
    } else {
      console.error('[shot] 失败', name, JSON.stringify(r).slice(0, 200));
    }
  };
  const evalJs = async (expression) => {
    const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      console.error('[eval] 异常：', JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    }
    return r;
  };

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cmd('Page.navigate', { url: URL_ });
  await sleep(2200);

  // 1) 连接页
  await shoot('mobile-connect.png');

  // 2) 主界面（伪造已连接状态，仅为截图展示）
  await evalJs(`(() => {
    document.getElementById('screen-connect').classList.remove('active');
    document.getElementById('screen-main').classList.add('active');
    document.getElementById('peerName').textContent = 'DESKTOP-IEUIHUM';
    document.getElementById('peerMeta').textContent = '192.168.100.131:53317 · 已配对';
    document.getElementById('peerDot').classList.remove('off');
  })()`);
  await sleep(400);
  await shoot('mobile-main.png');

  // 3) 聊天面板：注入示例消息，验证气泡 / 文件卡片 / 状态位 / 未读红点
  await evalJs(`(() => {
    document.querySelector('.seg-btn[data-pane="chat"]').click();
    if (window.__ltpSeedChat) window.__ltpSeedChat();
  })()`);
  await sleep(700);
  await shoot('mobile-chat.png');

  // 3b) 注入后立刻断言渲染结果（在清空之前，否则会读到空表）
  const probe = await evalJs(`(() => {
    const tl = document.getElementById('chatTimeline');
    const badge = document.getElementById('chatUnreadBadge');
    return JSON.stringify({
      timelineNodes: tl ? tl.children.length : -1,
      fileCards: document.querySelectorAll('.file-card').length,
      progressBars: document.querySelectorAll('.file-card-bar i').length,
      outBubbles: document.querySelectorAll('.msg.out').length,
      inBubbles: document.querySelectorAll('.msg.in').length,
      hasArrow: !!(tl && tl.querySelector('.bubble')),
      unreadBadge: badge ? badge.textContent : '',
      unreadHidden: badge ? badge.hidden : null,
      panesOn: [...document.querySelectorAll('.pane.is-on')].map((p) => p.dataset.pane),
    });
  })()`);
  console.log('[probe 注入后]', probe.result && probe.result.result && probe.result.result.value);

  // 4) 空会话态
  await evalJs(`(() => { if (window.__ltpClearChat) window.__ltpClearChat(); })()`);
  await sleep(400);
  await shoot('mobile-chat-empty.png');

  const probe2 = await evalJs(`(() => {
    const empty = document.getElementById('chatEmpty');
    return JSON.stringify({
      timelineNodes: document.getElementById('chatTimeline').children.length,
      emptyVisible: empty ? !empty.hidden && getComputedStyle(empty).display !== 'none' : null,
    });
  })()`);
  console.log('[probe 清空后]', probe2.result && probe2.result.result && probe2.result.result.value);
} catch (e) {
  console.error('截图失败：', e.message);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch (_) {}
}
process.exit(exitCode);
