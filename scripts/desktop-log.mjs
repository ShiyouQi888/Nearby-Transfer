// 订阅 Electron 渲染进程的 console 输出并持续打印，用于观察一次交互的实时日志。
const PORT = process.env.DESKTOP_CDP_PORT || 9481;
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }));
  ws.send(JSON.stringify({ id: ++id, method: 'Log.enable' }));
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    console.log('[console.' + m.params.type + ']', m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  } else if (m.method === 'Log.entryAdded') {
    console.log('[log.' + m.params.entry.level + ']', m.params.entry.text);
  } else if (m.method === 'Runtime.exceptionThrown') {
    console.log('[EXCEPTION]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
});
setTimeout(() => process.exit(0), Number(process.env.WATCH_MS || 25000));
