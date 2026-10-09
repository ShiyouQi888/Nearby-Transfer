// 临时探针：查清 window.api.newPairCode() 的真实返回结构，以及 preload 暴露了哪些接口。
const PORT = process.env.DESKTOP_CDP_PORT || 9481;

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url && t.url.includes('index.html'));
  if (!page) { console.error('找不到渲染进程页面'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
    setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); reject(new Error('timeout ' + method)); } }, 15000);
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  await send('Runtime.enable');

  const evalExpr = async (label, expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const res = r.result || {};
    console.log(`\n### ${label}\n` + (res.exceptionDetails
      ? 'EXCEPTION: ' + JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails)
      : JSON.stringify(res.value, null, 2)));
    return res.value;
  };

  await evalExpr('api keys', `Object.keys(window.api || {}).join(',')`);
  await evalExpr('typeof newPairCode', `typeof (window.api && window.api.newPairCode)`);
  await evalExpr('raw result', `(async () => { const r = await window.api.newPairCode(); return JSON.stringify({ keys: r && Object.keys(r), json: JSON.stringify(r) }); })()`);

  ws.close();
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
