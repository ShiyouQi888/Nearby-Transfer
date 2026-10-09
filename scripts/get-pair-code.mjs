// 通过 CDP 连到 Electron 渲染进程，生成一个 6 位配对码并打印。
// 用途：本地端到端调试——手机端/模拟器需要这个码才能完成首次配对。
const PORT = process.env.DESKTOP_CDP_PORT || 9481;

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url && t.url.includes('index.html'))
    || targets.find((t) => t.type === 'page');
  if (!page) { console.error('找不到渲染进程页面'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
    setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); reject(new Error('timeout ' + method)); } }, 10000);
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  await send('Runtime.enable');
  // 注意：preload 通过 contextBridge 暴露的全局名是 window.ltp（不是 window.api）。
  const result = await send('Runtime.evaluate', {
    expression: `(async () => {
      const bridge = window.ltp || window.api;
      if (!bridge || typeof bridge.newPairCode !== 'function') {
        return 'NO_BRIDGE:' + Object.keys(window).filter(k => /ltp|api/i.test(k)).join(',');
      }
      const r = await bridge.newPairCode();
      // 兼容两种返回：直接给码字符串，或给 { code, ttlMs } 对象。
      if (typeof r === 'string') return r;
      if (r && r.code) return String(r.code);
      return 'SHAPE:' + JSON.stringify(r);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('PAIR_CODE=' + (result.result && result.result.value));
  ws.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
