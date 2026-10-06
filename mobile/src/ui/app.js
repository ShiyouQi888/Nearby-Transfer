/**
 * 手机端 UI 主逻辑
 *
 * 职责：
 *  - 连接电脑（扫码 / 6 位匹配码 / 手动 IP / 网段扫描 / 已信任设备）
 *  - 发送文件（图片 / 视频 / 文档 / 任意文件，支持多选批量）
 *  - 接收文件（收到 offer 弹确认框，实时进度、速度、剩余时间）
 *  - 展示最近接收记录
 *
 * 所有网络与协议细节都封装在 ../core/client.js，落盘在 ../core/storage.js，
 * 本文件只做「状态 → DOM」的渲染与用户事件绑定。
 */

import * as P from '@shared/protocol.mjs';
import { MobileClient } from '../core/client.js';
import { installLanBridge } from '../core/lan-bridge.js';
import { getCameraPermission, requestCameraPermission } from '../core/permissions.js';
import { icon, fileIcon } from './icons.js';
import {
  loadDevice, saveDevice, loadTrusted, saveTrusted,
  storageFactory, openLocalFile, buildMeta,
} from '../core/storage.js';

// ─────────────────────────────────────────────────────────────
// 全局状态
// ─────────────────────────────────────────────────────────────

const state = {
  device: loadDevice(),
  trusted: loadTrusted(),
  client: null,               // MobileClient
  channel: null,              // 'native' | 'websocket'
  server: null,               // 对端电脑信息
  picks: [],                  // 待发送：{ file, meta, reader }
  transfers: new Map(),       // transferId → { id, dir, name, totalBytes, files:Map, startedAt, status, speed, eta }
  scanAbort: null,
};

// ─────────────────────────────────────────────────────────────
// DOM 快捷方法
// ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function toast(msg, kind = 'info', ms = 2600) {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  // CSS 使用 .ok / .err 两个修饰类
  el.className = `toast ${kind === 'ok' ? 'ok' : kind === 'error' ? 'err' : ''}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** 切换「连接引导 / 主界面」 */
function showScreen(which) {
  $('screen-connect').classList.toggle('active', which === 'connect');
  $('screen-main').classList.toggle('active', which === 'main');
}

/** 填充 [data-icon] 占位符（静态 HTML 与动态片段通用） */
function fillIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    const size = el.classList.contains('tile-ic') ? 22
      : el.classList.contains('btn-ico') ? 17
      : el.classList.contains('st-ic') ? 16
      : el.classList.contains('ct-ic') ? 16
      : 20;
    el.innerHTML = icon(name, size, 1.7);
  });
}

// ─────────────────────────────────────────────────────────────
// 设备名渲染
// ─────────────────────────────────────────────────────────────

function renderSelf() {
  $('selfName').textContent = state.device.name || '我的手机';
  $('setName').value = state.device.name || '';
  $('setDeviceId').textContent = state.device.deviceId;
  $('setChannel').textContent =
    state.channel === 'native' ? '原生 Socket（直连 TCP）'
    : state.channel === 'websocket' ? 'WebSocket 网关'
    : '未连接';
}

function renderConnectionBadge(connected) {
  const badge = $('connectionBadge');
  if (!badge) return;
  badge.classList.toggle('is-connected', connected);
  badge.innerHTML = `<i></i>${connected ? '已连接' : '未连接'}`;
}

async function renderCameraPermission() {
  const dot = $('cameraPermissionDot');
  const text = $('cameraPermissionText');
  if (!dot || !text) return;
  const permission = await getCameraPermission();
  dot.dataset.state = permission;
  text.textContent = {
    granted: '已允许，扫码时可以直接打开摄像头。',
    denied: '已拒绝，请在系统设置中允许摄像头权限。',
    unsupported: '当前环境不支持摄像头，请使用 6 位匹配码。',
    prompt: '尚未申请，只有点击扫码时才会请求。',
  }[permission] || '权限状态未知。';
}

// ─────────────────────────────────────────────────────────────
// 连接流程
// ─────────────────────────────────────────────────────────────

/** 用给定地址 + 认证方式连接 */
async function connectTo(host, port, auth, { pairing = false } = {}) {
  if (state.client) disconnect();

  const client = new MobileClient({ device: state.device });
  state.client = client;
  state.server = null;

  // 事件绑定（在 connect 之前绑，避免丢失首次事件）
  client.addEventListener('hello', (ev) => renderPeer(ev.detail.server));
  client.addEventListener('offer', (ev) => onIncomingOffer(ev.detail));
  client.addEventListener('progress', (ev) => onProgress(ev.detail));
  client.addEventListener('file_done', (ev) => onFileDone(ev.detail));
  client.addEventListener('send_start', (ev) => onSendStart(ev.detail));
  client.addEventListener('send_done', (ev) => onSendDone(ev.detail));
  client.addEventListener('cancel', () => toast('对方取消了传输', 'warn'));
  client.addEventListener('closed', () => onClosed());
  client.addEventListener('error', (ev) => toast(ev.detail.message || '发生错误', 'error'));

  const btn = pairing ? $('btnUseCode') : null;
  if (btn) btn.disabled = true;

  try {
    const res = await client.connect(host, port, auth);
    state.channel = client.channel;
    state.server = res.server || null;

    // 记录/更新信任设备
    if (state.server) {
      state.trusted[state.server.deviceId] = {
        deviceId: state.server.deviceId,
        name: state.server.name,
        ip: host,
        port,
        lastSeen: Date.now(),
      };
      saveTrusted(state.trusted);
      renderTrusted();
    }

    renderPeer(state.server);
    renderSelf();
    state.picks = [];
    renderPicks();
    showScreen('main');
    renderConnectionBadge(true);
    toast(`已连接到 ${state.server ? state.server.name : host}`, 'ok');
    return true;
  } catch (e) {
    toast(e.message || '连接失败', 'error', 4200);
    try { client.close(); } catch (_) {}
    state.client = null;
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function disconnect() {
  if (state.client) {
    try { state.client.close(); } catch (_) {}
  }
  state.client = null;
  state.channel = null;
  state.server = null;
  state.transfers.clear();
  $('activeWrap').innerHTML = '';
  showScreen('connect');
  renderConnectionBadge(false);
  renderSelf();
  refreshTrustedCard();
}

function onClosed() {
  toast('与电脑的连接已断开', 'warn');
  state.client = null;
  state.channel = null;
  state.server = null;
  showScreen('connect');
  renderConnectionBadge(false);
  renderSelf();
}

// ─────────────────────────────────────────────────────────────
// 对端信息
// ─────────────────────────────────────────────────────────────

function renderPeer(server) {
  if (!server) return;
  $('peerName').textContent = server.name || '电脑';
  $('peerMeta').textContent = `${server.os || 'Windows'} · ${server.type || 'desktop'}`;
  $('peerDot').classList.remove('off');
}

// ─────────────────────────────────────────────────────────────
// 已信任设备
// ─────────────────────────────────────────────────────────────

function renderTrusted() {
  const list = $('trustedList');
  const items = Object.values(state.trusted);
  list.innerHTML = '';
  if (!items.length) { refreshTrustedCard(); return; }

  items
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .forEach((t) => {
      const li = document.createElement('li');
      li.className = 'found';
      li.innerHTML = `
        <span class="found-icon">${icon('desktop', 19, 1.7)}</span>
        <div class="found-main">
          <div class="found-name">${escapeHtml(t.name || '电脑')}</div>
          <div class="found-meta">${escapeHtml(t.ip)}:${t.port}</div>
        </div>
        <span class="found-go">连接</span>`;
      li.addEventListener('click', () => {
        connectTo(t.ip, t.port, t.token ? { mode: 'token', token: t.token } : { mode: 'none' });
      });
      list.appendChild(li);
    });
  refreshTrustedCard();
}

function refreshTrustedCard() {
  const has = Object.keys(state.trusted).length > 0;
  $('trustedCard').hidden = !has;
}

// ─────────────────────────────────────────────────────────────
// 扫码
// ─────────────────────────────────────────────────────────────

let qrStream = null;
let qrDetector = null;
let qrTimer = null;

async function startScanQr() {
  const mask = $('scanQrMask');
  const video = $('qrVideo');
  mask.hidden = false;

  try {
    // 只在用户主动点击扫码后申请，避免首次启动就弹权限框。
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    video.srcObject = qrStream;
    await video.play();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied ? '摄像头权限未开启，请在系统设置中允许后重试' : '无法打开摄像头：' + (e.message || e), 'error', 4200);
    renderCameraPermission();
    closeScanQr();
    return;
  }

  // 优先使用原生 BarcodeDetector
  if ('BarcodeDetector' in window) {
    try {
      qrDetector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (_) { qrDetector = null; }
  }

  if (qrDetector) {
    qrTimer = setInterval(async () => {
      try {
        const codes = await qrDetector.detect(video);
        if (codes && codes.length) handleQrText(codes[0].rawValue);
      } catch (_) {}
    }, 350);
  } else {
    $('scanQrTip').textContent = '当前环境不支持自动识别，请在电脑上手动输入匹配码';
    // 无 BarcodeDetector：改为提示 + 允许手动输入
    setTimeout(() => {
      if (!qrDetector) toast('此设备不支持扫码识别，请改用 6 位匹配码', 'warn', 4000);
    }, 1200);
  }
}

function closeScanQr() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  if (qrStream) { qrStream.getTracks().forEach((t) => t.stop()); qrStream = null; }
  $('qrVideo').srcObject = null;
  $('scanQrMask').hidden = true;
}

async function handleQrText(text) {
  closeScanQr();
  const payload = safeDecodeQr(text);
  if (!payload) { toast('二维码内容无法识别', 'error'); return; }
  toast(`正在连接 ${payload.name || payload.ip}…`, 'info');
  await connectTo(payload.ip, payload.port, {
    mode: payload.token ? 'qr_token' : 'none',
    token: payload.token,
  });
}

/** 兼容 shared decodeQrPayload，并做一次 fallback 解析 */
function safeDecodeQr(text) {
  try {
    const obj = P.decodeQrPayload(text);
    if (obj) return obj;
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────
// 6 位匹配码
// ─────────────────────────────────────────────────────────────

async function useCode() {
  const code = ($('codeInput').value || '').replace(/\D/g, '');
  if (code.length !== 6) { toast('请输入 6 位匹配码', 'warn'); return; }
  const ip = ($('ipInput').value || '').trim();
  if (!ip) {
    toast('请同时填写电脑 IP（匹配码需知道连哪台电脑）', 'warn', 3600);
    $('ipInput').focus();
    return;
  }
  const port = Number($('portInput').value) || P.PORT;
  await connectTo(ip, port, { mode: 'pair_code', code });
}

// ─────────────────────────────────────────────────────────────
// 手动连接
// ─────────────────────────────────────────────────────────────

async function manualConnect() {
  const ip = ($('ipInput').value || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { toast('请输入正确的 IP 地址', 'warn'); return; }
  const port = Number($('portInput').value) || P.PORT;
  await connectTo(ip, port, { mode: 'none' });
}

// ─────────────────────────────────────────────────────────────
// 网段扫描（通过电脑端 HTTP /probe 探测）
// ─────────────────────────────────────────────────────────────

function expandRange(expr) {
  // 192.168.1.1-254 / 192.168.1.0/24 / 192.168.1.23
  const s = String(expr || '').trim();
  if (!s) return [];

  // CIDR
  const cidr = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidr) {
    const base = cidr[1].split('.').map(Number);
    const bits = Number(cidr[2]);
    if (bits < 24 || bits > 32) return [];
    const hostBits = 32 - bits;
    const size = 2 ** hostBits;
    const start = (((base[0] << 24) >>> 0) + (base[1] << 16) + (base[2] << 8) + base[3]) >>> 0;
    const net = start & (~((size - 1) >>> 0) >>> 0);
    const out = [];
    for (let i = 1; i < size - 1 && out.length < 512; i++) out.push(intToIp((net + i) >>> 0));
    return out;
  }

  // 尾段范围 a-b
  const m = s.match(/^(\d{1,3}(?:\.\d{1,3}){2})\.(\d{1,3})\s*-\s*(\d{1,3})$/);
  if (m) {
    const pre = m[1];
    let a = Number(m[2]), b = Number(m[3]);
    if (a > b) [a, b] = [b, a];
    const out = [];
    for (let i = a; i <= b && i <= 254 && out.length < 512; i++) out.push(`${pre}.${i}`);
    return out;
  }

  // 单 IP
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return [s];
  return [];
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

async function probeHost(ip, port, timeoutMs = 900) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // 电脑端 HTTP 服务监听在 TCP 端口 + 1
    const res = await fetch(`http://${ip}:${port + 1}/probe`, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.ok && data.device) return { ip, port, ...data.device, _json: data };
    return null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function scanNetwork() {
  let expr = ($('rangeInput').value || '').trim();
  if (!expr) {
    // 用当前输入 IP 的 /24 兜底
    const ip = ($('ipInput').value || '').trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) expr = ip.replace(/\.\d+$/, '.1-254');
    else expr = '192.168.1.1-254';
    $('rangeInput').value = expr;
  }
  const hosts = expandRange(expr);
  if (!hosts.length) { toast('网段格式不正确，示例：192.168.1.1-254', 'warn'); return; }

  const port = Number($('portInput').value) || P.PORT;
  const bar = $('scanBar'), fill = $('scanFill'), text = $('scanText');
  bar.hidden = false;
  text.textContent = `扫描中… 0/${hosts.length}`;

  let done = 0;
  let found = 0;
  let cancelled = false;
  state.scanAbort = () => { cancelled = true; };

  const list = $('foundList');
  list.innerHTML = '';

  const CONC = 24;
  let idx = 0;
  async function worker() {
    while (idx < hosts.length && !cancelled) {
      const ip = hosts[idx++];
      const dev = await probeHost(ip, port);
      done++;
      fill.style.width = `${Math.round((done / hosts.length) * 100)}%`;
      text.textContent = `扫描中… ${done}/${hosts.length}${found ? `，发现 ${found}` : ''}`;
      if (dev) { found++; appendFound(list, dev); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  state.scanAbort = null;
  bar.hidden = true;
  $('scanHint').textContent = found
    ? `发现 ${found} 台电脑端，点击即可配对连接。`
    : '未发现电脑端。请确认电脑已开启「邻传」且在同一 Wi-Fi。';
  toast(found ? `发现 ${found} 台设备` : '未发现设备', found ? 'ok' : 'warn');
}

function appendFound(list, dev) {
  const li = document.createElement('li');
  li.className = 'found';
  li.innerHTML = `
    <span class="found-icon">${icon('desktop', 19, 1.7)}</span>
    <div class="found-main">
      <div class="found-name">${escapeHtml(dev.name || '电脑')}</div>
      <div class="found-meta">${escapeHtml(dev.ip)}:${dev.port} · ${escapeHtml(dev.os || 'Windows')}</div>
    </div>
    <span class="found-go">${icon('chevronRight', 16, 2)}</span>`;
  li.addEventListener('click', () => {
    // 已信任 → 带 token 直连；否则走配对
    const t = state.trusted[dev.deviceId];
    connectTo(dev.ip, dev.port, t && t.token
      ? { mode: 'token', token: t.token }
      : { mode: 'none' });
  });
  list.appendChild(li);
}

// ─────────────────────────────────────────────────────────────
// 选择待发送文件
// ─────────────────────────────────────────────────────────────

const PICK_ACCEPT = {
  image: 'image/*',
  video: 'video/*',
  doc: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv',
  any: '*/*',
};

function pickFiles(kind) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = PICK_ACCEPT[kind] || '*/*';
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    addPicks(files, kind);
  });
  input.click();
}

async function addPicks(files, kind) {
  for (const file of files) {
    const idx = state.picks.length + 1;
    const relPath = file.webkitRelativePath || file.name;
    const meta = buildMeta(file, relPath, idx);
    let reader = null;
    try { reader = await openLocalFile(file); }
    catch (e) { toast(`无法读取 ${file.name}`, 'error'); continue; }
    state.picks.push({ file, meta, reader, kind });
  }
  renderPicks();
}

function renderPicks() {
  const wrap = $('pickPreview');
  const btn = $('btnSend');
  wrap.innerHTML = '';
  if (!state.picks.length) {
    btn.disabled = true;
    btn.textContent = '选择要发送的内容';
    return;
  }
  const total = state.picks.reduce((a, p) => a + (p.meta.size || 0), 0);
  state.picks.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pick-row';
    row.innerHTML = `
      <span class="pr-ico">${fileIcon(p.meta.name, 26)}</span>
      <span class="pr-name" title="${escapeHtml(p.meta.name)}">${escapeHtml(p.meta.name)}</span>
      <span class="pr-size">${P.formatBytes(p.meta.size)}</span>
      <button class="pr-x" title="移除">${icon('close', 14, 2)}</button>`;
    row.querySelector('.pr-x').addEventListener('click', () => {
      state.picks.splice(i, 1);
      renderPicks();
    });
    wrap.appendChild(row);
  });
  btn.disabled = false;
  btn.textContent = `发送 ${state.picks.length} 个文件（${P.formatBytes(total)}）`;
}

function pickIcon(kind) {
  return { image: 'image', video: 'video', doc: 'doc', any: 'clip' }[kind] || 'clip';
}

// ─────────────────────────────────────────────────────────────
// 发送
// ─────────────────────────────────────────────────────────────

async function sendPicks() {
  if (!state.client) { toast('尚未连接电脑', 'warn'); return; }
  if (!state.picks.length) return;

  const entries = state.picks.map((p, i) => ({
    meta: { ...p.meta, fileId: `f_${i + 1}` },
    open: () => p.reader,
  }));

  try {
    const { transferId, files, totalBytes } = await state.client.sendOffer(entries);
    createTransferCard({
      id: transferId,
      dir: 'send',
      name: files.length === 1 ? files[0].name : `${files.length} 个文件`,
      totalBytes,
      fileCount: files.length,
      startedAt: Date.now(),
      status: 'waiting',
    });
    state.picks = [];
    renderPicks();
  } catch (e) {
    toast('发送失败：' + (e.message || e), 'error');
  }
}

function onSendStart(detail) {
  const t = state.transfers.get(detail.transferId);
  if (t) { t.status = 'active'; t.acceptedBy = detail.acceptedBy; renderTransfers(); }
  toast(`${detail.acceptedBy || '电脑'} 已接受，开始传输`, 'ok');
}

function onSendDone(detail) {
  const t = state.transfers.get(detail.transferId);
  if (t) { t.status = 'done'; t.endedAt = Date.now(); renderTransfers(); }
  toast('发送完成', 'ok');
}

// ─────────────────────────────────────────────────────────────
// 接收
// ─────────────────────────────────────────────────────────────

let pendingOffer = null;

function onIncomingOffer(offer) {
  pendingOffer = offer;
  const from = offer.from || (state.server && state.server.name) || '电脑';
  $('offerFrom').textContent = `来自 ${from}`;
  const ul = $('offerFiles');
  ul.innerHTML = '';
  (offer.files || []).slice(0, 30).forEach((f) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="of-ico">${f.isDir
        ? `<span class="fi fi-dir" style="--fi-size:26px">${icon('folderOpen', 15, 1.7)}</span>`
        : fileIcon(f.name, 26)}</span>
      <span class="of-name">${escapeHtml(f.relPath || f.name)}</span>
      <span class="of-size">${f.isDir ? '文件夹' : P.formatBytes(f.size)}</span>`;
    ul.appendChild(li);
  });
  if ((offer.files || []).length > 30) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `… 还有 ${offer.files.length - 30} 个文件`;
    ul.appendChild(li);
  }
  $('offerSum').innerHTML = `共 <b>${offer.files ? offer.files.length : 0}</b> 项 · ${P.formatBytes(offer.totalBytes || 0)}`;
  $('offerMask').hidden = false;
}

async function acceptOffer() {
  if (!pendingOffer || !state.client) return;
  const offer = pendingOffer;
  $('offerMask').hidden = true;
  pendingOffer = null;

  createTransferCard({
    id: offer.transferId,
    dir: 'receive',
    name: offer.files.length === 1 ? offer.files[0].name : `${offer.files.length} 个文件`,
    totalBytes: offer.totalBytes || 0,
    fileCount: offer.files.length,
    startedAt: Date.now(),
    status: 'active',
  });

  try {
    await state.client.acceptOffer(offer, storageFactory);
    toast('已接受，开始接收', 'ok');
  } catch (e) {
    toast('接收失败：' + (e.message || e), 'error');
  }
}

function rejectOffer() {
  if (!pendingOffer || !state.client) return;
  state.client.rejectOffer(pendingOffer, 'user_denied');
  $('offerMask').hidden = true;
  pendingOffer = null;
  toast('已拒绝接收', 'info');
}

// ─────────────────────────────────────────────────────────────
// 传输进度渲染
// ─────────────────────────────────────────────────────────────

function createTransferCard(info) {
  const t = {
    ...info,
    files: new Map(),
    speed: 0,
    etaMs: null,
    transferred: 0,
  };
  state.transfers.set(info.id, t);
  renderTransfers();
  return t;
}

function onProgress(p) {
  const t = state.transfers.get(p.transferId);
  if (!t) return;
  const prev = t.files.get(p.fileId);
  const prevBytes = prev ? prev.bytes : 0;
  t.files.set(p.fileId, { bytes: p.transferredBytes, total: p.totalBytes });
  t.transferred = (t.transferred || 0) + Math.max(0, p.transferredBytes - prevBytes);
  t.speed = p.speed || t.speed;
  t.etaMs = p.etaMs;
  t.status = 'active';
  renderTransfers();
}

function onFileDone(d) {
  const t = state.transfers.get(d.transferId);
  if (t) {
    const rec = t.files.get(d.fileId);
    if (rec) rec.done = true;
    t.status = 'done';
    renderTransfers();
    // 记入"最近接收"列表
    if (t.dir === 'receive') pushRecvItem(d.path || d.fileId, d.size, t.startedAt);
  }
}

const recvItems = [];
function pushRecvItem(path, size, at) {
  recvItems.unshift({ path, size, at });
  if (recvItems.length > 40) recvItems.pop();
  renderRecv();
}

function renderRecv() {
  const ul = $('recvList');
  const empty = $('recvEmpty');
  ul.innerHTML = '';
  if (!recvItems.length) { empty.hidden = false; return; }
  empty.hidden = true;
  recvItems.forEach((r) => {
    const li = document.createElement('li');
    li.className = 'recv';
    const name = String(r.path || '').split('/').pop();
    li.innerHTML = `
      <span class="recv-ico">${fileIcon(name, 28)}</span>
      <div class="recv-main">
        <div class="recv-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="recv-meta">${P.formatBytes(r.size)} · ${timeText(r.at)}</div>
      </div>`;
    ul.appendChild(li);
  });
}

function renderTransfers() {
  const wrap = $('activeWrap');
  wrap.innerHTML = '';
  const list = Array.from(state.transfers.values()).sort((a, b) => b.startedAt - a.startedAt);
  if (!list.length) return;

  list.forEach((t) => {
    const fset = Array.from(t.files.values());
    const gotBytes = fset.reduce((a, f) => a + (f.bytes || 0), 0);
    const pct = t.totalBytes > 0 ? Math.min(100, Math.round((gotBytes / t.totalBytes) * 100)) : 0;
    const done = t.status === 'done';
    const el = document.createElement('div');
    el.className = 'xfer';
    el.innerHTML = `
      <div class="xfer-head">
        <div class="xfer-title">
          <span class="xfer-dir ${t.dir === 'send' ? 'send' : 'recv'}">${icon(t.dir === 'send' ? 'arrowUp' : 'arrowDown', 15, 2)}</span>
          <div>
            <div class="xfer-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
            <div class="xfer-sub">${t.fileCount || 1} 个文件 · ${t.dir === 'send' ? '发送到电脑' : '接收自电脑'}</div>
          </div>
        </div>
        <span class="xfer-pct">${done ? '完成' : pct + '%'}</span>
      </div>
      <div class="bar"><div class="bar-fill ${done ? 'done' : ''}" style="width:${pct}%"></div></div>
      <div class="xfer-stats">
        <span><b>${P.formatBytes(gotBytes)}</b> / ${P.formatBytes(t.totalBytes)}</span>
        <span>${t.status === 'active' ? P.formatSpeed(t.speed) : done ? '已完成' : '等待对方确认'}</span>
        <span>${t.status === 'active' && t.etaMs != null ? '剩余 ' + P.formatEta(t.etaMs) : ''}</span>
      </div>
      ${done ? '' : '<button class="xfer-cancel">取消</button>'}`;
    const btn = el.querySelector('.xfer-cancel');
    if (btn) {
      btn.addEventListener('click', () => {
        if (state.client) state.client.cancelTransfer(t.id, true);
        t.status = 'done';
        renderTransfers();
        toast('已取消传输', 'info');
      });
    }
    wrap.appendChild(el);
  });
}

function timeText(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ─────────────────────────────────────────────────────────────
// 设置面板
// ─────────────────────────────────────────────────────────────

function openSheet() { $('sheetMask').hidden = false; }
function closeSheet() { $('sheetMask').hidden = true; }

function saveName() {
  const name = ($('setName').value || '').trim() || '我的手机';
  state.device.name = name;
  saveDevice(state.device);
  renderSelf();
  closeSheet();
  toast('名称已保存', 'ok');
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────
// 事件绑定
// ─────────────────────────────────────────────────────────────

function bind() {
  $('btnSettings').addEventListener('click', openSheet);
  $('btnCloseSheet').addEventListener('click', closeSheet);
  $('btnSaveName').addEventListener('click', saveName);
  $('btnCheckCamera').addEventListener('click', async () => {
    const permission = await getCameraPermission();
    if (permission === 'prompt') {
      try {
        await requestCameraPermission();
        toast('摄像头权限已开启', 'ok');
      } catch (e) {
        toast('未能开启摄像头权限，请在系统设置中检查', 'error', 3600);
      }
    } else if (permission === 'denied') {
      toast('请在系统设置中允许邻传使用摄像头', 'warn', 3600);
    } else if (permission === 'unsupported') {
      toast('当前环境不支持摄像头，请使用 6 位匹配码', 'warn', 3600);
    } else {
      toast('摄像头权限已允许', 'ok');
    }
    renderCameraPermission();
  });
  $('sheetMask').addEventListener('click', (e) => { if (e.target === $('sheetMask')) closeSheet(); });

  $('btnScanQr').addEventListener('click', startScanQr);
  $('btnCloseScan').addEventListener('click', closeScanQr);

  $('btnUseCode').addEventListener('click', useCode);
  $('btnManual').addEventListener('click', manualConnect);
  $('btnScanNet').addEventListener('click', scanNetwork);

  $('codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });

  document.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => pickFiles(btn.dataset.pick));
  });

  $('btnSend').addEventListener('click', sendPicks);
  $('btnDisconnect').addEventListener('click', () => {
    if (state.client) state.client.close();
    disconnect();
    toast('已断开连接', 'info');
  });

  $('btnAccept').addEventListener('click', acceptOffer);
  $('btnReject').addEventListener('click', rejectOffer);

  window.addEventListener('beforeunload', () => {
    if (state.client) { try { state.client.close(); } catch (_) {} }
  });
}

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

function boot() {
  // 填充静态 HTML 中的图标占位符
  fillIcons();
  // 注册原生 Socket 桥接（浏览器环境自动忽略，降级到 WebSocket 网关）
  installLanBridge();
  bind();
  renderSelf();
  renderTrusted();
  renderPicks();
  renderRecv();
  refreshTrustedCard();
  showScreen('connect');
  renderConnectionBadge(false);
  renderCameraPermission();
}

boot();
