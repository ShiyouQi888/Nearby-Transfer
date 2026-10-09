// 通过 CDP 在 Electron 渲染进程里执行一段表达式并打印结果。
// 用法：node scripts/desktop-eval.mjs "<js 表达式>"
const PORT = process.env.DESKTOP_CDP_PORT || 9481;
const expr = process.argv[2] || '1';
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url && t.url.includes('index.html'));
if (!page) { console.error('找不到渲染进程页面'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method, params }));
  setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout')); } }, 15000);
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return;
  pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Runtime.enable');
const r = await send('Runtime.evaluate', {
  expression: `(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return 'ERR:' + e.message; } })()`,
  awaitPromise: true, returnByValue: true,
});
console.log(r.result?.value ?? JSON.stringify(r));
ws.close();
