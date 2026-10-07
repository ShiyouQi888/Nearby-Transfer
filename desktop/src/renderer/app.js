/**
 * 渲染层逻辑（Windows 电脑端）
 * 所有系统能力通过 window.ltp（preload 暴露）调用
 */

'use strict';

const $ = (id) => document.getElementById(id);
const api = window.ltp;

// ── 状态 ─────────────────────────────────────────────

const S = {
  self: null,
  devices: [],          // 发现到的设备
  trusted: [],
  history: [],
  sessions: [],
  transfers: new Map(), // transferId -> { ...记录, sessionId }
  received: [],
  picks: [],            // 待发送的本地路径
  pickSelection: [],    // 待发送清单的勾选状态
  quickTargetId: '',
  pendingOffer: null,
  scanTimer: null,
  qrPayload: null,
  codeExpire: 0,
  codeTimer: null,
};

const fmt = {
  bytes: (n) => {
    if (n == null || isNaN(n)) return '-';
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
  },
  speed: (b) => (!b || b <= 0 ? '--' : `${fmt.bytes(b)}/s`),
  eta: (ms) => {
    if (ms == null || !isFinite(ms) || ms < 0) return '--';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
  },
  time: (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  dur: (ms) => {
    if (!ms && ms !== 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} 秒`;
    return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  },
  size: (n) => `${fmt.bytes(n)}`,
  // 文件图标：统一 SVG 语义图标（替代 emoji）
  icon: (name, size) => window.Icons.fileIcon(name, { size: size || 24 }),
  // 通用图标
  svg: (name, opts) => window.Icons.icon(name, opts),
  baseName: (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p,
};

function fileVisual(name, filePath, size = 30) {
  const icon = fmt.icon(name, size);
  if (!filePath) return icon;
  return `<span class="file-visual" data-thumb-path="${esc(filePath)}">${icon}</span>`;
}

async function hydrateThumbnails(root) {
  const nodes = (root || document).querySelectorAll('[data-thumb-path]');
  await Promise.all([...nodes].map(async (el) => {
    const r = await api.getImagePreview(el.dataset.thumbPath);
    if (!r || !r.ok || !r.dataUrl) return;
    el.classList.add('has-thumb');
    el.innerHTML = `<img src="${r.dataUrl}" alt="" draggable="false" />`;
  }));
}

// ── 图标占位符自动填充 ────────────────────────────────
// HTML 中写 <span data-icon="xxx"></span>，此处统一注入 SVG，
// 避免在标记里散落大量内联 SVG，也保证图标随主题变色。
function fillIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    // 尺寸按 class 语义取值
    const size = el.classList.contains('h2-ic') ? 15
      : el.classList.contains('bi') ? 16
      : el.classList.contains('ni') ? 17
      : el.classList.contains('tb-ic') ? 15
      : el.classList.contains('ac-go') ? 16
      : el.classList.contains('ep-icon') ? 30
      : el.classList.contains('ts-ic') ? 18
      : el.classList.contains('th-ic') ? 16
      : el.classList.contains('fn-ic') ? 15
      : el.classList.contains('wc-ic') ? 15
      : el.classList.contains('ct-ic') ? 16
      : el.classList.contains('ct-act') ? 14
      : el.classList.contains('logo') ? 22
      : 20;
    el.innerHTML = window.Icons.icon(name, { size, sw: 1.7 });
  });
}

// ── 场景插画填充（hero / 侧栏） ───────────────────────
function fillIllusts(root) {
  (root || document).querySelectorAll('[data-illust]').forEach((el) => {
    const name = el.getAttribute('data-illust');
    const svg = window.Icons.illust(name);
    if (svg) el.innerHTML = svg;
  });
}

// ── Toast ────────────────────────────────────────────

function toast(msg, kind) {
  msg = window.LTP_I18N ? window.LTP_I18N.t(msg) : msg;
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(() => el.remove(), 2600);
}

function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const isEnglish = window.LTP_I18N && window.LTP_I18N.getLanguage() === 'en-US';
      const notification = new Notification(window.LTP_I18N ? window.LTP_I18N.t(title) : title, { body: window.LTP_I18N ? window.LTP_I18N.t(body) : body, silent: false, icon: 'logo.png', dir: 'auto', lang: isEnglish ? 'en' : 'zh-CN' });
      notification.onclick = () => { api.winFocus(); window.focus(); };
    }
    else if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  } catch (_) {}
}

// ── 导航 ─────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + tab));
    if (tab === 'devices') refreshQr();
    if (tab === 'trusted') renderTrusted();
    if (tab === 'history') renderHistory();
    if (tab === 'received') renderReceived();
    if (tab === 'about') renderAbout();
  });
});

// ── 渲染：自身信息 ───────────────────────────────────

function subnetForInterface(address, netmask) {
  if (!address || !netmask) return null;
  const toInt = (ip) => ip.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
  const toIp = (value) => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
  const ipNumber = toInt(address), maskNumber = toInt(netmask), network = (ipNumber & maskNumber) >>> 0;
  const broadcast = (network | (~maskNumber >>> 0)) >>> 0;
  const start = network + 1, end = broadcast - 1;
  const prefix = netmask.split('.').reduce((sum, octet) => sum + Number(octet).toString(2).replace(/0/g, '').length, 0);
  return { network: toIp(network), prefix, start, end, range: end >= start && end - start < 4096 ? `${toIp(start)}-${toIp(end)}` : null };
}

async function loadSelf() {
  const self = await api.getSelf();
  S.self = self;
  $('selfLine').textContent = `${self.name} · ${self.lanIPs.map((x) => x.address).join(' / ') || self.ip} · 端口 ${self.port}`;
  $('statusPill').innerHTML = `${window.Icons.icon('wifi', { size: 15, sw: 1.7 })}运行中`;
  $('statusPill').classList.remove('bad');

  // 当前网络：默认取第一个局域网地址所在网段
  const firstInterface = self.lanIPs && self.lanIPs[0];
  const first = (firstInterface && firstInterface.address) || self.ip || '';
  const firstSubnet = firstInterface && subnetForInterface(firstInterface.address, firstInterface.netmask);
  $('netAddr').textContent = firstSubnet ? `${firstSubnet.network}/${firstSubnet.prefix}` : (first || '—');
  if ($('localIp')) $('localIp').textContent = (self.lanIPs || []).map((x) => x.address).join(' / ') || self.ip || '—';

  // 下拉：列出所有局域网网段（自动探测用）
  const sel = $('netSel');
  const cur = sel.value;
  sel.innerHTML = '<option value="">自动</option>'
    + (self.lanIPs || []).map((x) => {
      const subnet = subnetForInterface(x.address, x.netmask);
      const label = subnet ? `${subnet.network}/${subnet.prefix}` : x.address;
      return `<option value="${esc(`${x.address}|${x.netmask || ''}`)}">${esc(label)}</option>`;
    }).join('');
  if (cur) sel.value = cur;

  $('scanRange').placeholder = `或指定网段 ${(firstSubnet && firstSubnet.range) || '192.168.1.1-254'}`;
}

// ── 渲染：设备列表 ───────────────────────────────────

function renderDevices() {
  const list = $('deviceList');
  const empty = $('deviceEmpty');
  const items = getAvailableDevices();

  if (!items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = items.map((d) => {
    const isMobile = d.type === 'mobile';
    const trusted = S.trusted.some((t) => t.deviceId === d.deviceId);
    const connected = d._connected || S.sessions.some((s) => s.device && s.device.deviceId === d.deviceId);
    const stale = Date.now() - (d.lastSeen || 0) > 8000;
    return `
      <li class="dev" data-id="${esc(d.deviceId)}">
        <div class="dev-icon ${isMobile ? 'mobile' : 'desktop'}">${window.Icons.icon(isMobile ? 'mobile' : 'desktop', { size: 20, sw: 1.6 })}</div>
        <div class="dev-main">
          <div class="dev-name">
            ${esc(d.name || d.deviceId)}
            ${isMobile ? '<span class="tag">手机</span>' : '<span class="tag">电脑</span>'}
            ${connected ? '<span class="tag ok">已连接</span>' : (trusted ? '<span class="tag ok">已信任</span>' : '')}
            ${stale ? '<span class="tag">即将离线</span>' : ''}
          </div>
          <div class="dev-meta">
            <span>${esc(d.ip)}:${d.port || 53317}</span>
            <span>${esc(d.os || '')}</span>
          </div>
        </div>
        <div class="dev-actions">
          <button class="btn small primary" data-act="send"><span class="bi" data-icon="send"></span>发送</button>
        </div>
      </li>`;
  }).join('');
  fillIcons(list);

  list.querySelectorAll('.dev').forEach((li) => {
    li.querySelector('[data-act="send"]').addEventListener('click', () => {
      const id = li.dataset.id;
      const dev = items.find((x) => x.deviceId === id);
      sendToDevice(dev);
    });
  });
  renderQuickTargets();
}

function getAvailableDevices() {
  const liveSessions = (S.sessions || []).filter((s) => s.device && s.device.deviceId).map((s) => ({
    ...s.device,
    ip: s.remote || s.device.ip || '',
    port: s.device.port || 53317,
    _connected: true,
  }));
  return [...S.devices, ...liveSessions]
    .filter((d) => d.deviceId !== (S.self && S.self.deviceId))
    .filter((d, i, all) => all.findIndex((x) => x.deviceId === d.deviceId) === i);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── 发送流程 ─────────────────────────────────────────

$('btnClearPick').addEventListener('click', () => { S.picks = []; S.pickSelection = []; renderPicks(); });
$('btnSelectAllPick').addEventListener('click', () => { S.pickSelection = S.picks.map(() => true); renderPicks(); });
$('btnClearSelectedPick').addEventListener('click', () => { S.pickSelection = S.picks.map(() => false); renderPicks(); });

$('btnPickFolder').addEventListener('click', async () => addDroppedPaths(await api.pickFolder()));

function addDroppedPaths(paths) {
  const fresh = (paths || []).filter((p) => p && !S.picks.some((existing) => typeof existing === 'string' && existing === p));
  if (!fresh.length) return;
  S.picks.push(...fresh); S.pickSelection.push(...fresh.map(() => true)); renderPicks();
  toast(`已添加 ${fresh.length} 项到发送队列`, 'ok');
}

const dropzone = $('sendDropzone');
if (dropzone) {
  ['dragenter', 'dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('is-dragging'); }));
  ['dragleave', 'drop'].forEach((eventName) => dropzone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('is-dragging'); }));
  dropzone.addEventListener('drop', (e) => addDroppedPaths([...e.dataTransfer.files].map((file) => file.path).filter(Boolean)));
  const chooseFromDropzone = async () => addDroppedPaths(await api.pickFiles());
  dropzone.addEventListener('click', chooseFromDropzone);
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseFromDropzone(); } });
}

$('quickTarget').addEventListener('click', (e) => {
  const root = $('quickTarget');
  if (!e.target.closest('.target-picker-trigger')) return;
  const menu = root.querySelector('.target-picker-menu');
  const hasItems = menu.querySelector('[data-target-id]');
  if (!hasItems) return;
  const open = menu.hidden;
  menu.hidden = !open;
  root.setAttribute('aria-expanded', String(open));
});
$('quickTarget').addEventListener('keydown', (e) => {
  const root = $('quickTarget');
  const menu = root.querySelector('.target-picker-menu');
  const options = [...menu.querySelectorAll('[data-target-id]')];
  if (!options.length) return;
  if (e.key === 'Escape') {
    menu.hidden = true;
    root.setAttribute('aria-expanded', 'false');
    root.querySelector('.target-picker-trigger').focus();
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (menu.hidden) {
      menu.hidden = false;
      root.setAttribute('aria-expanded', 'true');
      options[0].focus();
    } else {
      const current = options.indexOf(document.activeElement);
      const next = (current + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next].focus();
    }
  }
});
document.addEventListener('click', (e) => {
  const root = $('quickTarget');
  if (root && !root.contains(e.target)) {
    root.querySelector('.target-picker-menu').hidden = true;
    root.setAttribute('aria-expanded', 'false');
  }
});
$('btnQuickSend').addEventListener('click', async () => {
  const id = S.quickTargetId;
  const dev = getAvailableDevices().find((d) => d.deviceId === id);
  if (!dev) { toast('请先选择在线目标设备', 'err'); return; }
  await sendToDevice(dev);
});

// 粘贴内容：读取剪贴板文本 → 填入文本框（文件类剪贴板由主进程尝试）
$('btnPaste').addEventListener('click', async () => {
  const r = await api.readClipboard();
  if (r && r.files && r.files.length) {
    S.picks.push(...r.files);
    S.pickSelection.push(...r.files.map(() => true));
    renderPicks();
    toast(`已从剪贴板添加 ${r.files.length} 个文件`, 'ok');
    return;
  }
  if (r && r.text) {
    $('textContent').value = r.text;
    $('textContent').focus();
    toast('已将剪贴板内容填入文本框', 'ok');
  } else {
    toast('剪贴板为空或不支持的内容', 'err');
  }
});

// 发送文字：把文本写入临时文件后按普通文件传输
$('btnSendText').addEventListener('click', async () => {
  const text = $('textContent').value.trim();
  if (!text) { toast('请先输入要发送的文字内容', 'err'); return; }
  S.picks.push({ text });
  S.pickSelection.push(true);
  $('textContent').value = '';
  renderPicks();
  toast('已加入待发送清单，请选择目标设备', 'ok');
});

function renderPicks() {
  const el = $('pickList');
  if (!S.picks.length) {
    el.innerHTML = '<span class="muted">尚未选择任何内容</span>';
    renderQuickTargets();
    return;
  }
  while (S.pickSelection.length < S.picks.length) S.pickSelection.push(true);
  const selectedCount = S.pickSelection.filter(Boolean).length;
  el.innerHTML = `<div class="pick-summary">已勾选 ${selectedCount} / ${S.picks.length} 项</div>` + S.picks.map((p, i) => {
    const isText = p && typeof p === 'object' && p.text != null;
    const name = isText ? (p.text.slice(0, 40) + (p.text.length > 40 ? '…' : '')) : fmt.baseName(p);
    const sub = isText ? `文字 · ${p.text.length} 字` : String(p);
    return `
    <div class="pick-item">
      <label class="pick-check" title="选择此项发送"><input type="checkbox" data-pick-check="${i}" ${S.pickSelection[i] !== false ? 'checked' : ''} aria-label="选择 ${esc(name)}"></label>
      <span class="pi-ico">${isText ? window.Icons.icon('edit', { size: 19, sw: 1.7 }) : fileVisual(fmt.baseName(p), p, 30)}</span>
      <span class="pi-name">${esc(name)}</span>
      <span class="pi-size">${esc(sub)}</span>
      <button class="btn ghost small" data-rm="${i}"><span class="bi" data-icon="close"></span>移除</button>
    </div>`;
  }).join('');
  fillIcons(el);
  hydrateThumbnails(el);
  el.querySelectorAll('[data-rm]').forEach((b) => {
    b.addEventListener('click', () => { const i = +b.dataset.rm; S.picks.splice(i, 1); S.pickSelection.splice(i, 1); renderPicks(); });
  });
  el.querySelectorAll('[data-pick-check]').forEach((box) => {
    box.addEventListener('change', () => { S.pickSelection[+box.dataset.pickCheck] = box.checked; renderPicks(); });
  });
  renderQuickTargets();
}

function renderQuickTargets() {
  const select = $('quickTarget');
  const button = $('btnQuickSend');
  if (!select || !button) return;
  const items = getAvailableDevices();
  if (!items.some((d) => d.deviceId === S.quickTargetId)) S.quickTargetId = '';
  const current = items.find((d) => d.deviceId === S.quickTargetId);
  select.querySelector('.target-picker-label').textContent = current
    ? `${current.name || current.deviceId}${current.type === 'mobile' ? ' · 手机' : ' · 电脑'}`
    : (items.length ? '请选择在线设备' : '暂无在线设备，请先扫描');
  const menu = select.querySelector('.target-picker-menu');
  menu.innerHTML = items.map((d) => `<button type="button" class="target-picker-option${d.deviceId === S.quickTargetId ? ' selected' : ''}" data-target-id="${esc(d.deviceId)}" role="option" aria-selected="${d.deviceId === S.quickTargetId}">${window.Icons.icon(d.type === 'mobile' ? 'mobile' : 'desktop', { size: 17, sw: 1.7 })}<span>${esc(d.name || d.deviceId)}</span><small>${d.type === 'mobile' ? '手机' : '电脑'}</small></button>`).join('');
  menu.querySelectorAll('[data-target-id]').forEach((option) => option.addEventListener('click', () => {
    S.quickTargetId = option.dataset.targetId;
    menu.hidden = true;
    select.setAttribute('aria-expanded', 'false');
    renderQuickTargets();
  }));
  button.disabled = !(S.pickSelection.some(Boolean) && S.quickTargetId && items.some((d) => d.deviceId === S.quickTargetId));
}

async function sendToDevice(dev) {
  if (!dev) return;
  const selectedIndices = S.picks.map((_, i) => i).filter((i) => S.pickSelection[i] !== false);
  const selectedPicks = selectedIndices.map((i) => S.picks[i]);
  if (!selectedPicks.length) {
    toast('请先在下方「快速发送」选择文件或文件夹', 'err');
    return;
  }
  const throttle = +$('throttleSel').value || 0;
  const trusted = S.trusted.some((t) => t.deviceId === dev.deviceId);
  toast(trusted ? `正在连接 ${dev.name}…` : `正在与 ${dev.name} 建立配对连接…`);
  const r = await api.sendTo(dev.deviceId, selectedPicks, throttle);
  if (r && r.ok) {
    toast(`已向 ${dev.name} 发起传输（${r.files} 项）`, 'ok');
    const selectedSet = new Set(selectedIndices);
    S.picks = S.picks.filter((_, i) => !selectedSet.has(i));
    S.pickSelection = S.picks.map(() => true);
    renderPicks();
    goto('transfers');
  } else {
    const map = {
      no_server: '服务未启动',
      device_not_found: '设备已离线，请刷新后重试',
      connect_failed: '连接失败，请确认对端已打开应用并已配对',
      not_trusted: '该设备未配对，无法发送',
      empty: '没有可发送的内容',
    };
    toast(map[r && r.reason] || `发送失败：${(r && (r.message || r.reason)) || '未知错误'}`, 'err');
  }
}

function goto(tab) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + tab));
}

// ── 网段扫描 ─────────────────────────────────────────

$('btnScan').addEventListener('click', async () => {
  const selectedInterface = $('netSel').value;
  const typed = $('scanRange').value.trim();
  const [selectedIp, selectedMask] = selectedInterface.split('|');
  const range = typed || (selectedIp && selectedMask ? subnetForInterface(selectedIp, selectedMask).range : null);
  const btn = $('btnScan');
  btn.disabled = true;
  btn.innerHTML = `<span class="bi" data-icon="search"></span>扫描中…`;
  fillIcons(btn);
  $('scanBar').hidden = false;
  $('scanFill').style.width = '0%';
  $('scanText').textContent = '正在并发探测…';
  document.body.classList.add('is-scanning');
  $('radarStage')?.classList.add('is-scanning');
  if ($('radarStatus')) $('radarStatus').textContent = '正在扫描';
  try {
    const r = await api.scan(range);
    if (r && r.error) { toast('扫描失败：' + r.error, 'err'); return; }
    const found = (r.found || []).filter((d) => d.deviceId !== (S.self && S.self.deviceId));
    S.devices = found;
    renderDevices();
    toast(`扫描完成：探测 ${r.scanned} 个地址，发现在线设备 ${found.length} 台`, found.length ? 'ok' : '');
    if (typed) $('scanRange').value = '';
  } catch (e) {
    toast('扫描失败：' + (e.message || e), 'err');
  } finally {
    document.body.classList.remove('is-scanning');
    $('radarStage')?.classList.remove('is-scanning');
    if ($('radarStatus')) $('radarStatus').textContent = '扫描待命';
    btn.disabled = false;
    btn.innerHTML = `<span class="bi" data-icon="search"></span>扫描网络`;
    fillIcons(btn);
    $('scanBar').hidden = true;
  }
});

// ── 配对：二维码 ─────────────────────────────────────

async function refreshQr() {
  const q = await api.makeQr();
  if (!q) { $('qrMeta').textContent = '服务未启动'; return; }
  S.qrPayload = q.payload;
  drawQr(q);
  $('qrMeta').innerHTML = `含 IP、端口与临时令牌<br>有效期 ${Math.round(q.ttlMs / 60000)} 分钟 · 令牌 <code>${esc(q.token)}</code>`;
}

function drawQr(q) {
  const canvas = $('qrCanvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (q.dataUrl) {
    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.onerror = () => fallbackText(ctx, q.payload);
    img.src = q.dataUrl;
    return;
  }
  fallbackText(ctx, q.payload);
}

function fallbackText(ctx, text) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 240, 240);
  ctx.fillStyle = '#111';
  ctx.font = '10px monospace';
  wrapText(ctx, String(text), 8, 18, 224, 12);
  $('qrMeta').textContent = '二维码渲染失败，请在手机端「手动输入」中粘贴上方文本';
}

function wrapText(ctx, text, x, y, maxW, lh) {
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW) { ctx.fillText(line, x, y); line = ch; y += lh; }
    else line += ch;
  }
  ctx.fillText(line, x, y);
}

$('btnRefreshQr').addEventListener('click', async () => { await refreshQr(); toast('已生成新二维码', 'ok'); });

// ── 配对：6 位码 ─────────────────────────────────────

async function newPairCode() {
  const r = await api.newPairCode();
  if (!r) { toast('服务未启动', 'err'); return; }
  $('pairCode').textContent = r.code;
  S.codeExpire = Date.now() + r.ttlMs;
  startCodeTimer();
  toast('已生成新的 6 位匹配码', 'ok');
}

function startCodeTimer() {
  if (S.codeTimer) clearInterval(S.codeTimer);
  const tick = () => {
    const left = S.codeExpire - Date.now();
    if (left <= 0) {
      $('codeTimer').textContent = '该匹配码已过期，请重新生成';
      $('pairCode').textContent = '------';
      clearInterval(S.codeTimer);
      S.codeTimer = null;
      return;
    }
    const s = Math.floor(left / 1000);
    $('codeTimer').textContent = `剩余有效时间 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  S.codeTimer = setInterval(tick, 1000);
}

$('btnNewCode').addEventListener('click', newPairCode);
$('btnCopyCode').addEventListener('click', async () => {
  const code = $('pairCode').textContent.trim();
  if (!/^\d{6}$/.test(code)) { toast('请先生成匹配码', 'err'); return; }
  await api.copyText(code);
  toast('匹配码已复制：' + code, 'ok');
});
$('btnCopyIp').addEventListener('click', async () => {
  const ip = $('localIp').textContent.trim();
  if (!ip || ip === '—') { toast('暂无可复制的本机 IP', 'err'); return; }
  await api.copyText(ip); toast('本机 IP 已复制：' + ip, 'ok');
});

// ── 传输进度渲染 ─────────────────────────────────────

function upsertTransfer(t) {
  S.transfers.set(t.transferId, t);
  renderTransfers();
}

function renderTransfers() {
  const wrap = $('activeTransfers');
  const list = [...S.transfers.values()].filter((t) =>
    ['active', 'offered', 'pending'].includes(t.status));
  $('activeEmpty').hidden = list.length > 0;

  wrap.innerHTML = list.map((t) => {
    const pct = t.totalBytes ? Math.min(100, ((t.transferredBytes || 0) / t.totalBytes) * 100) : 0;
    const isSend = t.direction === 'send';
    const devName = (t.device && t.device.name) || '未知设备';
    const fileLabel = t.files.length === 1
      ? t.files[0].name
      : `${t.files.length} 个项目`;
    return `
      <div class="xfer" data-tid="${esc(t.transferId)}">
        <div class="xfer-head">
          <div class="xfer-title">
            <div class="xfer-dir ${isSend ? 'send' : 'recv'}">${window.Icons.icon(isSend ? 'arrowUp' : 'arrowDown', { size: 15, sw: 2 })}</div>
            <div style="min-width:0">
              <div class="xfer-name">${esc(fileLabel)}</div>
              <div class="xfer-sub">${isSend ? '发送至' : '接收自'} ${esc(devName)} · ${t.files.length} 个文件</div>
            </div>
          </div>
          <button class="btn ghost small danger" data-cancel="${esc(t.transferId)}"><span class="bi" data-icon="close"></span>取消</button>
        </div>
        <div class="bar"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="xfer-stats">
          <span><b>${fmt.bytes(t.transferredBytes || 0)}</b> / ${fmt.bytes(t.totalBytes)}</span>
          <span>${pct.toFixed(1)}%</span>
          <span>${fmt.speed(t.speed)}</span>
          <span>剩余 ${fmt.eta(t.etaMs)}</span>
        </div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('[data-cancel]').forEach((b) => {
    b.addEventListener('click', async () => {
      const tid = b.dataset.cancel;
      const t = S.transfers.get(tid);
      const r = await api.cancelTransfer(t && t.sessionId, tid);
      toast(r && r.ok ? '已取消传输' : '取消失败');
    });
  });
  fillIcons(wrap);
}

// ── 历史渲染 ─────────────────────────────────────────

function renderHistory() {
  const list = $('histList');
  const items = S.history || [];
  $('histEmpty').hidden = items.length > 0;

  list.innerHTML = items.slice(0, 120).map((h) => {
    const isSend = h.direction === 'send';
    const badge = { done: '已完成', failed: '失败', cancelled: '已取消', rejected: '已拒绝' }[h.status] || h.status;
    const first = h.files && h.files[0];
    const label = h.fileCount === 1 && first ? first.name : `${h.fileCount} 个项目`;
    const openable = first && first.path && h.status === 'done' && !isSend;
    return `
      <div class="hist">
        <div class="history-file-visual">${fileVisual(label, first && first.path, 32)}<span class="dir-badge ${isSend ? 'send' : 'recv'}">${window.Icons.icon(isSend ? 'arrowUp' : 'arrowDown', { size: 13, sw: 1.9 })}</span></div>
        <div class="hist-main">
          <div class="hist-name">${esc(label)}</div>
          <div class="hist-meta">
            ${isSend ? '发送至' : '接收自'} ${esc((h.device && h.device.name) || '未知设备')}
            · ${fmt.bytes(h.totalBytes)} · ${fmt.time(h.finishedAt || h.startedAt)}
            ${h.durationMs ? ' · 用时 ' + fmt.dur(h.durationMs) : ''}
            ${h.error && h.status !== 'done' ? ' · ' + esc(h.error) : ''}
          </div>
        </div>
        <span class="badge ${esc(h.status)}">${esc(badge)}</span>
        <div class="hist-actions">
          ${openable ? `<button class="btn ghost small" data-open="${esc(first.path)}"><span class="bi" data-icon="folderOpen"></span>打开</button>
                        <button class="btn ghost small" data-folder="${esc(first.path)}"><span class="bi" data-icon="scan"></span>定位</button>` : ''}
          <button class="btn ghost small danger" data-delete-history="${esc(h.transferId)}"><span class="bi" data-icon="trash"></span>删除</button>
        </div>
      </div>`;
  }).join('');
  fillIcons(list);
  hydrateThumbnails(list);

  list.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => api.openPath(b.dataset.open)));
  list.querySelectorAll('[data-folder]').forEach((b) =>
    b.addEventListener('click', () => api.showInFolder(b.dataset.folder)));
  list.querySelectorAll('[data-delete-history]').forEach((b) => b.addEventListener('click', async () => {
    await api.deleteHistory(b.dataset.deleteHistory);
    S.history = S.history.filter((h) => h.transferId !== b.dataset.deleteHistory);
    renderHistory();
    toast('已删除历史记录', 'ok');
  }));
}

$('btnClearHistory').addEventListener('click', async () => {
  if (!S.history.length) return toast('暂无历史记录');
  await api.clearHistory(); S.history = []; renderHistory(); toast('历史记录已清空', 'ok');
});

$('btnOpenSaveDir').addEventListener('click', async () => {
  const self = S.self || (await api.getSelf());
  api.openPath(self.saveDir);
});

// ── 历史设备 ─────────────────────────────────────────

function renderTrusted() {
  const list = $('trustedList');
  const items = S.trusted || [];
  $('trustedEmpty').hidden = items.length > 0;

  list.innerHTML = items.map((t) => `
    <li class="dev" data-id="${esc(t.deviceId)}">
      <div class="dev-icon ${t.type === 'mobile' ? 'mobile' : 'desktop'}">${window.Icons.icon(t.type === 'mobile' ? 'mobile' : 'desktop', { size: 20, sw: 1.6 })}</div>
      <div class="dev-main">
        <div class="dev-name">${esc(t.name || t.deviceId)}<span class="tag ok">已配对</span></div>
        <div class="dev-meta">
          <span>指纹 ${esc(t.fingerprint || '-')}</span>
          <span>最近连接 ${esc(fmt.time(t.lastSeenAt))}</span>
        </div>
      </div>
      <div class="dev-actions">
        <button class="btn small primary" data-quick-send="${esc(t.deviceId)}"><span class="bi" data-icon="send"></span>快捷发送</button>
        <button class="btn ghost small danger" data-untrust="${esc(t.deviceId)}"><span class="bi" data-icon="trash"></span>删除设备</button>
      </div>
    </li>`).join('');
  fillIcons(list);

  list.querySelectorAll('[data-untrust]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.untrust(b.dataset.untrust);
      toast('已撤销信任，该设备需重新配对', 'ok');
    });
  });
  list.querySelectorAll('[data-quick-send]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.quickSend;
    const dev = S.devices.find((d) => d.deviceId === id) || (S.sessions.find((s) => s.device && s.device.deviceId === id) || {}).device;
    if (!dev) { toast('设备当前不在线，请先扫描或连接', 'err'); return; }
    sendToDevice(dev);
  }));
}

// ── 关于页 ───────────────────────────────────────────

let APP_INFO = null;
let UPDATE_INFO = null;

async function renderAbout() {
  if (!APP_INFO) {
    try { APP_INFO = await api.getAppInfo(); } catch (_) { APP_INFO = {}; }
  }
  const info = APP_INFO || {};

  if ($('aboutVersion')) $('aboutVersion').textContent = info.version || '1.0.0';
  if ($('aboutProtocol')) $('aboutProtocol').textContent = info.protocol || 'LTP/1';

  const rows = [
    ['版本', 'v' + (info.version || '-')],
    ['协议', info.protocol || '-'],
    ['运行环境', `Electron ${info.electron || '-'} · Chromium ${(info.chrome || '-').split('.')[0]}`],
    ['系统', `${info.platform || '-'}（${info.arch || '-'}）`],
  ];
  const env = $('aboutEnv');
  if (env) {
    env.innerHTML = rows
      .map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:14px;padding:5px 0">
        <span style="flex-shrink:0">${esc(k)}</span><code style="text-align:right">${esc(v)}</code></div>`)
      .join('');
  }
}

async function checkForUpdates() {
  const status = $('updateStatus');
  const check = $('btnCheckUpdate');
  const open = $('btnOpenUpdate');
  if (!status || !check || !open) return;
  check.disabled = true; open.hidden = true; status.textContent = '正在检查 GitHub Releases…';
  try {
    const r = await api.checkForUpdates();
    if (!r || !r.ok) throw new Error((r && r.error) || '检查更新失败');
    UPDATE_INFO = r;
    if (r.updateAvailable) {
      status.textContent = `发现新版本 v${r.latestVersion}`;
      open.hidden = false;
      open.onclick = () => api.openExternal(r.desktopUrl || r.releaseUrl);
    } else status.textContent = `当前已是最新版本 v${r.currentVersion}`;
  } catch (e) { status.textContent = `暂时无法检查更新：${e.message || '网络不可用'}`; }
  check.disabled = false;
}

if ($('btnCheckUpdate')) $('btnCheckUpdate').addEventListener('click', checkForUpdates);

/** 联系方式的点击行为：邮箱唤起邮件客户端，官网唤起浏览器；失败则复制到剪贴板。 */
function bindContactRows() {
  document.querySelectorAll('.contact-row:not(.static)').forEach((row) => {
    row.addEventListener('click', async () => {
      const mail = row.dataset.mail;
      const site = row.dataset.site;

      if (mail) {
        const r = await api.openExternal('mailto:' + mail);
        if (r && r.ok) toast('已唤起邮件客户端', 'ok');
        else { await api.copyText(mail); toast('邮箱已复制：' + mail, 'ok'); }
        return;
      }
      if (site) {
        const r = await api.openExternal(site);
        if (r && r.ok) toast('已在浏览器打开官网', 'ok');
        else { await api.copyText(site); toast('网址已复制：' + site, 'ok'); }
      }
    });
  });
}

// ── 接收确认弹窗 ─────────────────────────────────────

function showOffer(offer) {
  S.pendingOffer = offer;
  const devName = (offer.device && offer.device.name) || '未知设备';
  S.received = [{ name: `${offer.files.length} 个待接收文件`, from: devName, size: offer.totalBytes || 0, status: '等待确认', at: Date.now() }, ...(S.received || [])];
  goto('received');
  $('offerFrom').textContent = `来自 ${devName}（${(offer.device && offer.device.type) === 'mobile' ? '手机' : '电脑'}）`;

  $('offerFiles').innerHTML = offer.files.slice(0, 60).map((f) => `
    <div class="offer-file">
      <span class="of-ico">${f.isDir
        ? `<span class="fi fi-dir" style="--fi-size:22px">${window.Icons.icon('folderOpen', { size: 13, sw: 1.7 })}</span>`
        : fmt.icon(f.name, 22)}</span>
      <span class="of-name">${esc(f.relPath || f.name)}</span>
      <span class="of-size">${f.isDir ? '文件夹' : fmt.bytes(f.size)}</span>
    </div>`).join('')
    + (offer.files.length > 60 ? `<div class="muted">…还有 ${offer.files.length - 60} 项</div>` : '');

  $('offerSummary').innerHTML = `共 <b>${offer.files.length}</b> 项 · 合计 <b>${fmt.bytes(offer.totalBytes)}</b><br>
    <span class="muted">将保存到 ${esc(offer.saveDir || '')}</span>`;

  $('offerModal').hidden = false;
  renderReceived();
  const isEnglish = window.LTP_I18N && window.LTP_I18N.getLanguage() === 'en-US';
  notify(isEnglish ? 'Incoming files' : '收到文件', isEnglish ? `${devName} wants to send ${offer.files.length} file(s)` : `${devName} 请求发送 ${offer.files.length} 个文件`);
}

function renderReceived() {
  const list = $('receivedList');
  if (!list) return;
  const items = S.received || [];
  $('receivedEmpty').hidden = items.length > 0;
  list.innerHTML = items.slice(0, 30).map((x) => `
    <div class="hist">
      <div class="received-file-visual">${fileVisual(x.name, x.path, 32)}</div>
      <div class="hist-main"><div class="hist-name">${esc(x.name)}</div><div class="hist-meta">${esc(x.from)} · ${esc(x.status)} · ${fmt.time(x.at)}</div></div>
      <div class="hist-size">${fmt.bytes(x.size || 0)}</div>
    </div>`).join('');
  hydrateThumbnails(list);
}

$('btnOpenReceiveDir').addEventListener('click', async () => {
  const self = S.self || (await api.getSelf());
  api.openPath(self.saveDir);
});

$('btnAcceptOffer').addEventListener('click', async () => {
  const o = S.pendingOffer;
  if (!o) return;
  $('offerModal').hidden = true;
  const r = await api.acceptOffer(o.sessionId, o.transferId);
  S.pendingOffer = null;
  if (r && r.ok) { toast('已开始接收', 'ok'); goto('transfers'); }
  else toast('接收失败：' + ((r && r.reason) || '未知错误'), 'err');
});

$('btnRejectOffer').addEventListener('click', async () => {
  const o = S.pendingOffer;
  if (!o) return;
  $('offerModal').hidden = true;
  await api.rejectOffer(o.sessionId, o.transferId, 'user_denied');
  S.pendingOffer = null;
  renderReceived();
  toast('已拒绝接收');
});

// ── 设置弹窗 ─────────────────────────────────────────

$('btnSettings').addEventListener('click', async () => {
  const self = S.self || (await api.getSelf());
  $('setName').value = self.name;
  $('setSaveDir').value = self.saveDir;
  $('setInfo').innerHTML = `
    设备 ID：<code>${esc(self.deviceId)}</code><br>
    设备指纹：<code>${esc(self.fingerprint || '-')}</code><br>
    监听端口：<code>${self.port}</code> · 协议 <code>${esc(self.protocol)}</code><br>
    局域网地址：<code>${esc(self.lanIPs.map((x) => x.address).join(', ') || self.ip)}</code>`;
  if (!$('firewallStatus').dataset.ready) {
    $('firewallStatus').textContent = '启动时自动配置；如被系统拦截，请点击“自动配置”并允许管理员权限。';
  }
  $('settingsModal').hidden = false;
});

$('btnFixFirewall').addEventListener('click', async () => {
  $('firewallStatus').textContent = '正在请求 Windows 管理员权限…';
  const r = await api.ensureFirewall();
  if (r && r.ok) {
    $('firewallStatus').textContent = '已允许局域网访问端口 53317';
    $('firewallStatus').dataset.ready = '1';
    toast('局域网权限已配置', 'ok');
  } else {
    $('firewallStatus').textContent = '未完成配置，请在 Windows UAC 中允许操作后重试。';
    toast('防火墙权限未配置', 'err');
  }
});

$('btnCloseSettings').addEventListener('click', () => { $('settingsModal').hidden = true; });

$('btnChangeDir').addEventListener('click', async () => {
  const r = await api.chooseSaveDir();
  if (r && r.ok) { $('setSaveDir').value = r.saveDir; toast('保存目录已更新', 'ok'); }
});

$('btnSaveSettings').addEventListener('click', async () => {
  const name = $('setName').value.trim();
  if (name) {
    const r = await api.setDeviceName(name);
    if (r && r.ok) toast('设备名称已更新为 ' + r.name, 'ok');
  }
  await loadSelf();
  $('settingsModal').hidden = true;
});

$('btnRefresh').addEventListener('click', async () => { await loadDevices(); toast('设备列表已刷新'); });

function bindLanguageControl(control) {
  if (!control || control.dataset.bound === '1') return;
  control.dataset.bound = '1';
  control.value = window.LTP_I18N ? window.LTP_I18N.getLanguage() : 'zh-CN';
  control.addEventListener('change', () => window.LTP_I18N && window.LTP_I18N.setLanguage(control.value));
}

// ── 窗口控制（自绘标题栏） ───────────────────────────
// 最大化按钮的图标需随窗口状态在「最大化 / 还原」之间切换。
function setWinMaxIcon(maximized) {
  const btn = $('btnWinMax');
  if (!btn) return;
  btn.title = maximized ? '还原' : '最大化';
  btn.setAttribute('aria-label', btn.title);
  const holder = btn.querySelector('[data-icon]');
  if (holder) {
    holder.setAttribute('data-icon', maximized ? 'winRestore' : 'winMax');
    holder.innerHTML = window.Icons.icon(holder.getAttribute('data-icon'), { size: 15, sw: 1.7 });
  }
}

$('btnWinMin').addEventListener('click', () => api.winMinimize());
$('btnWinMax').addEventListener('click', async () => {
  const r = await api.winToggleMaximize();
  setWinMaxIcon(!!(r && r.maximized));
});
$('btnWinClose').addEventListener('click', () => api.winClose());

// 双击标题栏切换最大化（拖动区内的系统惯例行为）
document.querySelector('.titlebar').addEventListener('dblclick', async (e) => {
  if (e.target.closest('button')) return;   // 点在按钮上不触发
  const r = await api.winToggleMaximize();
  setWinMaxIcon(!!(r && r.maximized));
});

// ── 事件订阅 ─────────────────────────────────────────

function bindEvents() {
  api.onDevices((list) => { S.devices = list || []; renderDevices(); });
  api.onWinState(({ maximized }) => setWinMaxIcon(!!maximized));

  api.onEvent(({ ev, payload }) => {
    if (ev === 'firewall:status') {
      const holder = $('firewallStatus');
      if (holder) {
        holder.textContent = payload && payload.ok
          ? '已允许局域网访问端口 53317'
          : '局域网权限未配置，请在设置中点击“自动配置”。';
        holder.dataset.ready = payload && payload.ok ? '1' : '';
      }
      if (payload && payload.ok && payload.changed) toast('已自动配置局域网权限', 'ok');
      return;
    }
    switch (ev) {
      case 'discovery:scan:progress':
        if (payload && payload.total) {
          const pct = (payload.done / payload.total) * 100;
          $('scanFill').style.width = pct.toFixed(1) + '%';
          $('scanText').textContent = `已探测 ${payload.done} / ${payload.total}`;
        }
        break;

      case 'device:connected':
        toast(`设备已连接：${(payload.device && payload.device.name) || '未知'}`, 'ok');
        refreshSessions();
        break;
      case 'device:disconnected':
        refreshSessions();
        break;

      case 'pair:failed':
        toast(`配对失败：${(payload.device && payload.device.name) || '未知设备'} 匹配码不正确`, 'err');
        break;

      case 'offer:incoming':
        showOffer(payload);
        break;

      case 'transfer:start': {
        const t = payload.transfer;
        if (t) upsertTransfer({ ...t, sessionId: payload.sessionId || t.sessionId });
        break;
      }
      case 'transfer:complete':
      case 'transfer:cancelled': {
        const t = payload.transfer;
        if (t) {
          S.transfers.delete(t.transferId);
          renderTransfers();
          if (ev === 'transfer:complete' && t.status === 'done') {
            toast(`${t.direction === 'send' ? '发送' : '接收'}完成 · ${t.files.length} 个文件 · 用时 ${fmt.dur(t.durationMs)}`, 'ok');
            const isEnglish = window.LTP_I18N && window.LTP_I18N.getLanguage() === 'en-US';
            notify(isEnglish ? 'Transfer complete' : '传输完成', isEnglish ? `${t.direction === 'send' ? 'Sent' : 'Received'} ${t.files.length} file(s)` : `${t.direction === 'send' ? '已发送' : '已接收'} ${t.files.length} 个文件`);
            if (t.direction === 'receive') {
              (t.files || []).forEach((f) => S.received.unshift({ name: f.name || f.relPath || '文件', path: f.path || '', from: (t.device && t.device.name) || '未知设备', size: f.size || 0, status: '已保存', at: Date.now() }));
              renderReceived();
            }
          }
        }
        break;
      }
      case 'transfer:error':
        toast('传输错误：' + (payload.message || ''), 'err');
        break;
      case 'trust:changed':
        S.trusted = payload.trusted || [];
        renderTrusted();
        renderDevices();
        break;
      case 'discovery:device:up':
        if (payload && payload.type === 'mobile') toast(`发现设备：${payload.name}`, 'ok');
        break;
      case 'server:error':
        $('statusPill').textContent = '端口被占用';
        $('statusPill').classList.add('bad');
        toast('服务启动失败：' + (payload.message || ''), 'err');
        break;
    }
  });

  // 进度事件：高频，单独处理
  api.onProgress(({ payload }) => {
    if (!payload) return;
    const t = S.transfers.get(payload.transferId);
    if (!t) return;
    t.transferredBytes = payload.overall != null ? payload.overall : payload.transferredBytes;
    t.speed = payload.speed;
    t.etaMs = payload.etaMs;
    if (Array.isArray(t.files)) {
      const f = t.files.find((x) => x.fileId === payload.fileId);
      if (f) {
        f.transferredBytes = payload.transferredBytes;
        f.status = 'active';
      }
    }
    // 只更新对应 DOM，避免整表重绘
    const el = document.querySelector(`.xfer[data-tid="${cssEsc(payload.transferId)}"]`);
    if (el) {
      const pct = t.totalBytes ? Math.min(100, (t.transferredBytes / t.totalBytes) * 100) : 0;
      const fill = el.querySelector('.bar-fill');
      if (fill) fill.style.width = pct.toFixed(1) + '%';
      const stats = el.querySelectorAll('.xfer-stats span');
      if (stats.length >= 4) {
        stats[0].innerHTML = `<b>${fmt.bytes(t.transferredBytes)}</b> / ${fmt.bytes(t.totalBytes)}`;
        stats[1].textContent = pct.toFixed(1) + '%';
        stats[2].textContent = fmt.speed(t.speed);
        stats[3].textContent = '剩余 ' + fmt.eta(t.etaMs);
      }
    } else {
      renderTransfers();
    }
  });

  api.onHistory((h) => { S.history = h || []; renderHistory(); });
}

function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

async function refreshSessions() {
  S.sessions = await api.getSessions() || [];
  renderDevices();
}

async function loadDevices() {
  S.devices = await api.getDevices() || [];
  renderDevices();
}

function arrangePages() {
  const devices = $('tab-devices');
  const pair = $('pairSection');
  const quick = $('quickSendCard');
  const workspace = $('sendWorkspace');
  if (quick && workspace) workspace.appendChild(quick);
  if (pair && devices) devices.appendChild(pair);
}

// ── 启动 ─────────────────────────────────────────────

(async function boot() {
  arrangePages();
  fillIcons();          // 先注入静态图标
  fillIllusts();        // 注入场景插画（hero / 侧栏）
  bindEvents();
  bindContactRows();    // 关于页的联系方式点击行为
  await loadSelf();
  S.trusted = await api.getTrusted() || [];
  S.sessions = await api.getSessions() || [];
  S.history = await api.getHistory() || [];
  S.transfers.clear();
  // 已在进行的传输也拉回来
  const ongoing = await api.getTransfers() || [];
  ongoing.filter((t) => ['active', 'offered', 'pending'].includes(t.status))
    .forEach((t) => S.transfers.set(t.transferId, t));

  await loadDevices();
  renderTrusted();
  renderHistory();
  renderPicks();
  renderTransfers();
  await newCodeQuiet();
  await refreshQr();
  const language = $('setLanguage');
  bindLanguageControl(language);

  // 初始化最大化按钮状态（窗口可能以最大化启动，或上次退出时是最大化）
  setWinMaxIcon(!!(await api.winIsMaximized()));

  setInterval(refreshSessions, 4000);
})();

async function newCodeQuiet() {
  const r = await api.newPairCode();
  if (!r) return;
  $('pairCode').textContent = r.code;
  S.codeExpire = Date.now() + r.ttlMs;
  startCodeTimer();
}
