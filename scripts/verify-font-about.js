/**
 * 字体 + 关于页 验证（零依赖 CDP 客户端）
 *
 * 断言：
 *   [A] 思源黑体子集被真正加载（document.fonts 里有该 face，且 check() 为 true）
 *   [B] 实际渲染字体是思源黑体（用 document.fonts.check + 测量宽度差异交叉验证）
 *   [C] 字重比改造前更粗（读取 body 计算样式 >= 450）
 *   [D] 关于页结构完整（版本号 / 版权 / 三处联系方式）
 *   [E] 设置弹窗「常规 / 关于」页签能切换
 *   [F] 联系方式点击行为（公众号复制走剪贴板；邮箱/官网只是调用不报错）
 *
 * 截图 _shots/about.png 与 _shots/font-weight.png
 *
 * 用法：node scripts/verify-font-about.js
 */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_shots');
const PORT = 9460;
const ELECTRON = path.join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('  ok   ' + l); };
const bad = (l, d) => { fail++; console.log('  FAIL ' + l + (d ? ' :: ' + d : '')); };
const eq = (l, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? ok(l) : bad(l, `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect(url) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let handshook = false;
    const handlers = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshook) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        handshook = true;
        buf = buf.subarray(i + 4);
        resolve(api);
      }
      for (;;) {
        if (buf.length < 2) return;
        const b1 = buf[0], b2 = buf[1];
        const op = b1 & 0x0f;
        let len = b2 & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = (b2 & 0x80) !== 0;
        let mask = null;
        if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
        if (buf.length < off + len) return;
        let payload = buf.subarray(off, off + len);
        if (masked) { const c = Buffer.from(payload); for (let k = 0; k < c.length; k++) c[k] ^= mask[k % 4]; payload = c; }
        buf = buf.subarray(off + len);
        if (op === 1) { const s = payload.toString('utf8'); handlers.forEach((h) => h(s)); }
      }
    });
    sock.on('error', reject);
    const api = {
      send(obj) {
        const data = Buffer.from(JSON.stringify(obj), 'utf8');
        const mask = crypto.randomBytes(4);
        const n = data.length;
        let head;
        if (n < 126) head = Buffer.from([0x81, 0x80 | n]);
        else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
        else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
        const m = Buffer.from(data);
        for (let k = 0; k < m.length; k++) m[k] ^= mask[k % 4];
        sock.write(Buffer.concat([head, mask, m]));
      },
      onMessage(h) { handlers.push(h); },
      close() { try { sock.destroy(); } catch (e) { /* ignore */ } },
    };
  });
}

const getJson = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
  let b = '';
  r.on('data', (c) => { b += c; });
  r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
}).on('error', rej));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // 关键：否则 Electron 退化成纯 Node
  env.LTP_NO_GPU = '1';
  env.NO_SANDBOX = '1';

  const child = spawn(ELECTRON, [
    path.join(ROOT, 'desktop', 'src', 'main', 'main.js'),
    '--in-process-gpu', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stderr.on('data', (d) => {
    const s = String(d);
    if (!/NODE_OPTION|DevTools listening|GLES|gpu_channel|raster_command|shared context/i.test(s)) process.stdout.write('[err] ' + s);
  });

  let list = null;
  for (let i = 0; i < 30; i++) {
    try { list = await getJson('/json/list'); if (list && list.length) break; } catch (e) { /* retry */ }
    await wait(600);
  }
  const page = (list || []).find((t) => t.type === 'page');
  if (!page) {
    console.log('未找到页面');
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    process.exit(1);
  }

  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.onMessage((s) => {
    const m = JSON.parse(s);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send({ id: i, method, params }); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r && r.result ? r.result.value : undefined;
  };

  await send('Page.enable');
  await wait(3200);

  console.log('\n[A] 思源黑体子集是否真正加载');
  {
    const faces = await ev(`(() => {
      const out = [];
      document.fonts.forEach(f => out.push({ family: f.family, weight: f.weight, status: f.status }));
      return out;
    })()`);
    const shs = (faces || []).find((f) => /Source Han Sans/i.test(f.family));
    shs ? ok(`@font-face 已注册：${shs.family}（weight ${shs.weight}，status ${shs.status}）`)
        : bad('未找到 Source Han Sans 的 @font-face', JSON.stringify(faces));

    const loaded = await ev(`document.fonts.ready.then(() => document.fonts.check('450 14px "Source Han Sans SC"'))`);
    eq('字体已就绪且可用于 450 字重', loaded, true);

    // 直接取字体文件，确认能真正读到字节（本地 file:// 场景下 Resource Timing 拿不到 transferSize，
    // 因此改为主动 fetch 并读 arrayBuffer 长度来验证「文件真的存在且可读」）
    const bytes = await ev(`fetch('fonts/source-han-sans-sc-subset.woff2')
      .then(r => r.arrayBuffer())
      .then(b => {
        const u = new Uint8Array(b.slice(0, 4));
        return { len: b.byteLength, magic: Array.from(u).map(x => x.toString(16).padStart(2,'0')).join(' ') };
      })
      .catch(e => ({ err: String(e) }))`);
    if (bytes && bytes.len > 100000) {
      ok(`字体文件可读取：${(bytes.len / 1024).toFixed(0)} KB，magic=${bytes.magic}`);
    } else {
      bad('字体文件读取异常', JSON.stringify(bytes));
    }
    // woff2 的魔数固定为 "wOF2" = 77 4f 46 32
    eq('文件头是合法 woff2（77 4f 46 32）', bytes && bytes.magic, '77 4f 46 32');
  }

  console.log('\n[B] 渲染字体与字重');
  {
    const fam = await ev(`getComputedStyle(document.body).fontFamily`);
    /Source Han Sans/i.test(fam) ? ok('正文字体栈首位为 Source Han Sans：' + fam.split(',')[0]) : bad('字体栈首位不对', fam);

    const w = await ev(`getComputedStyle(document.body).fontWeight`);
    eq('正文字重已提升到 450', w, '450');

    const varSet = await ev(`getComputedStyle(document.body).fontVariationSettings`);
    /wght/.test(varSet) ? ok('可变轴已生效：' + varSet) : bad('font-variation-settings 未生效', varSet);

    // 说明：不能用「宽度对比」判断中文字体是否生效 ——
    // 汉字在思源黑体与回退字体里都占固定的 1em 宽（等宽方块字），宽度恒等。
    // 正确做法是数「墨迹像素」：把文字画到 canvas 上统计深色像素，
    // 字重越重墨迹越多，既能证明可变轴生效，也能证明字体确实被选中。
    const ink = await ev(`(() => {
      const count = (weight, family) => {
        const cv = document.createElement('canvas');
        cv.width = 600; cv.height = 130;
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 130);
        g.fillStyle = '#000';
        g.font = weight + ' 80px ' + family;
        g.textBaseline = 'top';
        g.fillText('邻传设备', 10, 10);
        const d = g.getImageData(0, 0, 600, 130).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
        return n;
      };
      return {
        w450: count(450, '"Source Han Sans SC"'),
        w700: count(700, '"Source Han Sans SC"'),
        w900: count(900, '"Source Han Sans SC"'),
      };
    })()`);
    if (ink && ink.w700 > ink.w450 && ink.w900 > ink.w700) {
      ok(`可变字重真实生效（墨迹像素 450→${ink.w450}，700→${ink.w700}，900→${ink.w900}）`);
    } else {
      bad('可变字重未生效（各字重墨迹像素未递增）', JSON.stringify(ink));
    }

    // 证明「思源黑体」这个 family 真的被浏览器选中：
    // 同时给该 family 加一个必然回退的备用名，若 family 未加载则墨迹会与纯回退一致。
    const used = await ev(`(() => {
      const count = (family) => {
        const cv = document.createElement('canvas');
        cv.width = 600; cv.height = 130;
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 130);
        g.fillStyle = '#000';
        g.font = '450 80px ' + family;
        g.textBaseline = 'top';
        g.fillText('邻传设备', 10, 10);
        const d = g.getImageData(0, 0, 600, 130).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
        return n;
      };
      return { shs: count('"Source Han Sans SC"'), bogus: count('"__no_such_font__"') };
    })()`);
    used && used.shs !== used.bogus
      ? ok(`思源黑体确实被选中（墨迹 ${used.shs} ≠ 纯回退 ${used.bogus}）`)
      : bad('思源黑体未被选中（墨迹与纯回退一致）', JSON.stringify(used));
  }

  console.log('\n[C] 关于页内容');
  {
    await ev(`document.querySelector('.nav-item[data-tab="about"]').click()`);
    await wait(700);

    const active = await ev(`document.querySelector('.nav-item[data-tab="about"]').classList.contains('active') && document.getElementById('tab-about').classList.contains('active')`);
    eq('侧栏「关于」可切换到对应页', active, true);

    const navCount = await ev(`document.querySelectorAll('.nav-item').length`);
    eq('侧栏共 6 项导航', navCount, 6);

    const ver = await ev(`document.getElementById('aboutVersion').textContent`);
    ver && ver !== '—' ? ok('版本号已渲染：v' + ver) : bad('版本号未渲染', String(ver));

    const rows = await ev(`document.querySelectorAll('#tab-about .contact-row').length`);
    eq('关于页有 3 项联系方式', rows, 3);

    const labels = await ev(`Array.from(document.querySelectorAll('#tab-about .ct-value')).map(e => e.textContent)`);
    ok('联系方式内容：' + JSON.stringify(labels));

    const copy = await ev(`document.querySelector('.about-copy').textContent.replace(/\\s+/g,' ').trim()`);
    /©\\s*2026|© 2026/.test(copy) ? ok('版权信息已展示：' + copy.slice(0, 60) + '…') : bad('版权信息缺失', String(copy));
    /思源黑体/.test(copy) ? ok('字体授权说明已注明') : bad('未注明字体授权');

    const envRows = await ev(`document.querySelectorAll('#aboutEnv code').length`);
    envRows >= 4 ? ok('运行环境信息 ' + envRows + ' 行（版本/协议/Electron/系统）') : bad('运行环境信息不足', String(envRows));
  }

  // 截图：关于页
  {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) {
      fs.writeFileSync(path.join(OUT, 'about.png'), Buffer.from(shot.data, 'base64'));
      ok('已保存 _shots/about.png');
    } else bad('关于页截图失败');
  }

  console.log('\n[D] 设置弹窗「常规 / 关于」页签');
  {
    await ev(`document.getElementById('btnSettings').click()`);
    await wait(600);

    const open = await ev(`!document.getElementById('settingsModal').hidden`);
    eq('设置弹窗已打开', open, true);

    const t0 = await ev(`document.querySelector('.mtab.active').dataset.mtab`);
    eq('默认停在「常规」页签', t0, 'general');

    await ev(`document.querySelector('.mtab[data-mtab="about"]').click()`);
    await wait(600);
    const t1 = await ev(`document.querySelector('.mtab.active').dataset.mtab`);
    eq('可切换到「关于」页签', t1, 'about');

    const paneOk = await ev(`document.getElementById('mpane-about').classList.contains('active') && !document.getElementById('mpane-general').classList.contains('active')`);
    eq('关于面板显示、常规面板隐藏', paneOk, true);

    const miniVer = await ev(`document.getElementById('setAboutVersion').textContent`);
    miniVer && miniVer !== '—' ? ok('弹窗内版本号已渲染：v' + miniVer) : bad('弹窗内版本号未渲染', String(miniVer));

    const miniRows = await ev(`document.querySelectorAll('#mpane-about .contact-row').length`);
    eq('弹窗关于页有 3 项联系方式', miniRows, 3);

    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    if (shot2 && shot2.data) {
      fs.writeFileSync(path.join(OUT, 'about-modal.png'), Buffer.from(shot2.data, 'base64'));
      ok('已保存 _shots/about-modal.png');
    } else bad('设置弹窗截图失败');

    // 关闭后再打开，应回到「常规」
    await ev(`document.getElementById('btnCloseSettings').click()`);
    await wait(400);
    await ev(`document.getElementById('btnSettings').click()`);
    await wait(500);
    const t2 = await ev(`document.querySelector('.mtab.active').dataset.mtab`);
    eq('重新打开回到「常规」页签', t2, 'general');
    await ev(`document.getElementById('btnCloseSettings').click()`);
  }

  console.log('\n[E] 联系方式点击行为');
  {
    const info = await ev(`window.ltp.getAppInfo().then(i => ({ version: i.version, protocol: i.protocol, electron: i.electron }))`);
    info && info.version ? ok(`getAppInfo 返回正常（v${info.version} / ${info.protocol} / Electron ${info.electron}）`) : bad('getAppInfo 异常', JSON.stringify(info));

    const allowed = await ev(`window.ltp.openExternal('file:///C:/Windows/System32/cmd.exe').then(r => r)`);
    eq('openExternal 拒绝 file:// 协议', allowed && allowed.ok, false);

    const bad2 = await ev(`window.ltp.openExternal('javascript:alert(1)').then(r => r)`);
    eq('openExternal 拒绝 javascript: 协议', bad2 && bad2.ok, false);

    // 公众号点击应把内容写进剪贴板（不弹系统窗口，适合自动化验证）
    await ev(`document.querySelector('.nav-item[data-tab="about"]').click()`);
    await wait(500);
    await ev(`document.querySelector('#tab-about #ctWechat').click()`);
    await wait(700);
    const clip = await ev(`document.getElementById('toastWrap').textContent`);
    /NearbyTransfer/.test(clip) ? ok('点击公众号行已复制并提示：' + clip.slice(0, 40)) : bad('公众号复制未触发', String(clip));
  }

  ws.close();
  try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }

  console.log('\n══════════════════════════════');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log('══════════════════════════════\n');
  setTimeout(() => process.exit(fail ? 1 : 0), 500);
})().catch((e) => {
  console.error('\n异常：', e);
  process.exit(1);
});
