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
import { ChatStore, DELIVERY } from '../core/chat-store.js';
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
  pane: 'files',              // 当前主面板：'files' | 'chat'
};

/** 聊天存储（全局单例，跨连接保留历史） */
const chatStore = new ChatStore();
/** transferId → { peerId, msgId }，用于把传输进度映射回聊天里的文件气泡 */
const chatTransferIndex = new Map();

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
  // 聊天
  client.addEventListener('chat', (ev) => onChatMessage(ev.detail));
  client.addEventListener('chat_ack', (ev) => onChatAck(ev.detail));
  client.addEventListener('chat_read', (ev) => onChatRead(ev.detail));

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

    // 建立/恢复与该电脑的聊天会话，并回到用户上次停留的面板
    const chat = ensureChat();
    if (chat) { CHAT.activeId = chat.peerId; CHAT.messages = chatStore.list(chat.peerId).messages; }
    renderChatBadge();
    setPane(state.pane === 'chat' ? 'chat' : 'files');

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
  markChatTransferDone(detail.transferId, true);
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
  const trust = $('offerTrust') ? $('offerTrust').checked : true;
  $('offerMask').hidden = true;
  pendingOffer = null;

  // 用户勾了「信任该会话」→ 以后该会话的文件静默接收（与电脑端语义一致）
  if (trust) {
    const chat = ensureChat();
    if (chat) chatStore.acceptSession(chat.peerId);
  }

  createTransferCard({
    id: offer.transferId,
    dir: 'receive',
    name: offer.files.length === 1 ? offer.files[0].name : `${offer.files.length} 个文件`,
    totalBytes: offer.totalBytes || 0,
    fileCount: offer.files.length,
    startedAt: Date.now(),
    status: 'active',
  });

  // 若这条 offer 属于聊天里的文件消息，把气泡补上并挂进度
  if (offer.origin === 'chat' || offer.chatId) {
    const peerId = chatPeerId();
    const lastFileMsg = [...chatStore.list(peerId).messages].reverse()
      .find((m) => m.dir === 'in' && m.kind === 'file' && !m.attachment?.transferId);
    if (lastFileMsg) {
      chatStore.updateStatus(peerId, lastFileMsg.msgId, {
        transferId: offer.transferId,
        status: 'received',
      });
      chatTransferIndex.set(offer.transferId, { peerId, msgId: lastFileMsg.msgId });
    }
  }

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
// 聊天（Chat over LTP/1）
//
// 设计要点（详见 docs/CHAT.md）：
//   · 文本消息 = 一条 chat_send NDJSON，不经传输层；
//   · 文件消息 = chat_send（先让气泡出现）+ send_offer（字节走既有分片通道）；
//   · 去重按 msgId；排序按到达顺序，ts 仅用于展示；
//   · 未配对设备无法进入聊天（会话本身就是配对后的 TCP 通道）。
// ─────────────────────────────────────────────────────────────

const CHAT = {
  activeId: '',        // 当前会话的 peerId（手机上恒为电脑的 deviceId）
  messages: [],        // 当前会话的消息缓存
  sending: false,
};

function chatPeerId() {
  return (state.server && state.server.deviceId) || 'unknown';
}

/** 会话需要存在才能收发（首次进入时惰性创建） */
function ensureChat() {
  if (!state.server) return null;
  return chatStore.openChat({
    deviceId: state.server.deviceId,
    name: state.server.name,
    type: state.server.type || 'desktop',
  });
}

function chatTime(ts) {
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function chatDayLabel(ts) {
  const d = new Date(ts || Date.now());
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return '今天';
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 出站消息状态 → 展示文案 */
function statusText(st) {
  return {
    pending: '未送达',
    sent: '已发送',
    delivered: '已送达',
    read: '已读',
    sending: '发送中',
    failed: '发送失败',
  }[st] || '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 用于把 msgId 塞进 querySelector 的属性选择器里 */
function cssEscape(s) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(s));
  return String(s).replace(/["\\]/g, '\\$&');
}

/** 单条消息 → DOM 字符串 */
function messageHtml(m) {
  const out = m.dir === 'out';
  const avatar = out
    ? `<span class="msg-avatar">${icon('mobile', 17, 1.8)}</span>`
    : `<span class="msg-avatar" style="color:var(--ds-brand-bright)">${icon('desktop', 17, 1.8)}</span>`;

  let inner;
  if (m.kind === 'file') {
    inner = fileCardHtml(m);
  } else {
    inner = `<div class="bubble">${escapeHtml(m.text)}</div>`;
  }

  const st = out ? statusText(m.status) : '';
  const stCls = m.status === 'read' ? ' is-read' : m.status === 'failed' ? ' is-failed' : '';
  const meta = `
    <div class="msg-meta">
      <span>${chatTime(m.ts)}</span>
      ${st ? `<span class="st${stCls}">${st}</span>` : ''}
      ${m.status === 'failed' ? `<button class="msg-retry" data-retry="${escapeHtml(m.msgId)}">重发</button>` : ''}
    </div>`;

  return `<div class="msg ${out ? 'out' : 'in'}" data-msgid="${escapeHtml(m.msgId)}">${avatar}<div class="msg-body">${inner}${meta}</div></div>`;
}

/** 文件消息气泡：图标 + 名称 + 大小 + 进度条 */
function fileCardHtml(m) {
  const att = m.attachment || {};
  const f = (att.files && att.files[0]) || {};
  const name = f.name || (att.name || '文件');
  const size = f.size != null ? f.size : att.size;
  const t = m.done ? 1 : (m.progress || 0);
  const pct = Math.round(t * 100);
  const doneCls = m.done ? ' is-done' : '';
  const barHidden = (m.dir === 'in' && !m.done && !m.progress) ? ' hidden' : '';
  return `
    <div class="file-card">
      <div class="file-card-head">
        <span class="file-card-ico">${fileIcon(name, 34)}</span>
        <span class="file-card-main">
          <span class="file-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="file-card-size">${size != null ? P.formatBytes(size) : ''}${m.done ? ' · 已完成' : ''}</span>
        </span>
      </div>
      <div class="file-card-bar${doneCls}"${barHidden}><i style="width:${pct}%"></i></div>
    </div>`;
}

/** 重建整个时间线（仅在切换会话/初次加载时调用） */
function renderTimeline() {
  const wrap = $('chatTimeline');
  const empty = $('chatEmpty');
  if (!wrap) return;
  wrap.innerHTML = '';
  const list = CHAT.messages;
  if (!list.length) { empty.hidden = false; return; }
  empty.hidden = true;
  list.forEach((m) => { wrap.insertAdjacentHTML('beforeend', messageHtml(m)); });
  scrollChatToEnd();
}

function scrollChatToEnd() {
  const wrap = $('chatTimeline');
  if (!wrap) return;
  const scroller = wrap.parentElement;   // .pane 才是滚动容器
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

/** 增量追加单条（避免整表重建导致滚动跳位） */
function appendMessageEl(m) {
  const wrap = $('chatTimeline');
  if (!wrap) return;
  $('chatEmpty').hidden = true;
  wrap.insertAdjacentHTML('beforeend', messageHtml(m));
  scrollChatToEnd();
}

/** 就地更新单条（状态 / 进度变化） */
function updateMessageEl(m) {
  const wrap = $('chatTimeline');
  if (!wrap) return;
  const el = wrap.querySelector(`[data-msgid="${cssEscape(m.msgId)}"]`);
  if (!el) return;
  const html = messageHtml(m);
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const next = tmp.firstElementChild;
  if (next) el.replaceWith(next);
  else el.remove();
}

/** 把消息 upsert 进缓存 + DOM */
function upsertChatMessage(peerId, message) {
  if (peerId !== CHAT.activeId) { renderChatBadge(); return; }
  const i = CHAT.messages.findIndex((x) => x.msgId === message.msgId);
  if (i >= 0) {
    CHAT.messages[i] = { ...CHAT.messages[i], ...message };
    updateMessageEl(CHAT.messages[i]);
  } else {
    CHAT.messages.push(message);
    appendMessageEl(message);
  }
  renderChatBadge();
}

function renderChatBadge() {
  const total = chatStore.totalUnread();
  const badge = $('chatUnreadBadge');
  if (badge) {
    badge.hidden = total === 0;
    badge.textContent = total > 99 ? '99+' : String(total);
  }
}

/** 进入聊天面板：加载历史、清未读、上报已读 */
function openChatPane({ notifyPeer = true } = {}) {
  const chat = ensureChat();
  if (!chat) return;
  CHAT.activeId = chat.peerId;
  CHAT.messages = chatStore.list(chat.peerId).messages;
  renderTimeline();
  chatStore.markLocalRead(chat.peerId);
  renderChatBadge();
  if (notifyPeer && state.client && state.client.paired) {
    state.client.sendChatRead(chat.readUpTo || Date.now());
  }
}

// ── 发送 ────────────────────────────────────────────────────

function autoGrowInput() {
  const ta = $('chatInput');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  $('btnChatSend').disabled = !ta.value.trim();
}

function sendChatText() {
  const ta = $('chatInput');
  const text = (ta.value || '').trim();
  if (!text || !state.client) return;
  if (!state.client.paired) { toast('尚未连接到电脑', 'warn'); return; }

  const chat = ensureChat();
  if (!chat) return;
  const online = !!state.client.socket;
  const msgId = P.makeMsgId(state.device.deviceId);

  // 先落本地出站消息（乐观渲染），再交给协议层发送
  const { message } = chatStore.append(chat.peerId, {
    msgId, dir: 'out', kind: 'text', text, ts: Date.now(),
    status: online ? DELIVERY.SENT : DELIVERY.PENDING,
  });
  upsertChatMessage(chat.peerId, message);

  const r = state.client.sendChat({ kind: 'text', text, msgId });
  if (!r.ok) {
    chatStore.updateStatus(chat.peerId, msgId, { status: DELIVERY.FAILED });
    toast(r.reason === 'too_long' ? `单条消息最多 ${P.CHAT_TEXT_MAX} 字` : '发送失败', 'error');
  }
  ta.value = '';
  autoGrowInput();
}

/** 把选中的文件作为「聊天里的文件消息」发送 */
async function sendChatFiles(files) {
  if (!state.client || !state.client.paired) { toast('尚未连接到电脑', 'warn'); return; }
  if (!files || !files.length) return;
  const chat = ensureChat();
  if (!chat) return;

  // 逐个建 meta + reader
  const entries = [];
  const metas = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const meta = { ...buildMeta(file, file.webkitRelativePath || file.name, entries.length + 1) };
    let reader = null;
    try { reader = await openLocalFile(file); }
    catch (e) { toast(`无法读取 ${file.name}`, 'error'); continue; }
    entries.push({ meta, open: () => reader });
    metas.push(meta);
  }
  if (!entries.length) return;

  const totalBytes = metas.reduce((a, m) => a + (m.size || 0), 0);
  const msgId = P.makeMsgId(state.device.deviceId);

  // 1) 先落一条文件消息气泡（进度 0），让用户立刻看到
  const { message } = chatStore.append(chat.peerId, {
    msgId, dir: 'out', kind: 'file', text: '',
    ts: Date.now(), status: DELIVERY.SENT,
    attachment: {
      files: metas.map((m) => ({ fileId: m.fileId, name: m.name, size: m.size, mime: m.mime, relPath: m.relPath })),
      totalBytes,
    },
  });
  upsertChatMessage(chat.peerId, message);

  // 2) 发 chat_send（告诉对端「这是一条聊天里的文件消息」）
  state.client.sendChat({
    kind: 'file', msgId,
    attachment: { files: message.attachment.files, totalBytes },
  });

  // 3) 再发 send_offer，字节走既有分片通道；带 chatId + origin 让电脑端知道这是聊天附件
  try {
    const { transferId } = await state.client.sendOffer(entries, { chatId: chat.chatId, origin: 'chat' });
    chatTransferIndex.set(transferId, { peerId: chat.peerId, msgId });
    // 把 transferId 回填进附件，便于后续把进度映射回气泡
    chatStore.updateStatus(chat.peerId, msgId, { transferId });
    const t = createTransferCard({
      id: transferId, dir: 'send',
      name: metas.length === 1 ? metas[0].name : `${metas.length} 个文件`,
      totalBytes, fileCount: metas.length, startedAt: Date.now(), status: 'waiting',
    });
    t.chatPeerId = chat.peerId; t.chatMsgId = msgId;
  } catch (e) {
    chatStore.updateStatus(chat.peerId, msgId, { status: DELIVERY.FAILED });
    toast('发送失败：' + (e.message || e), 'error');
  }
}

/** 弹出文件选择器，选中后作为聊天文件消息发送 */
function pickChatFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '*/*';
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    if (files.length) sendChatFiles(files);
  });
  input.click();
}

// ── 接收 ────────────────────────────────────────────────────

/** 收到对端的聊天消息 */
function onChatMessage(msg) {
  const peerId = chatPeerId();
  const { message, duplicate } = chatStore.append(peerId, {
    msgId: msg.msgId,
    dir: 'in',
    kind: msg.kind || 'text',
    text: msg.text || '',
    ts: msg.ts || Date.now(),
    status: 'received',
    attachment: msg.attachment || null,
  });

  // 无论是否重复投递，都要回执（对方可能只是没收到 ack 而重发）
  if (state.client) state.client.sendChatAck(message.msgId, message.ts);
  if (duplicate) return;

  if (peerId === CHAT.activeId && state.pane === 'chat') {
    upsertChatMessage(peerId, message);
    chatStore.markLocalRead(peerId);
    if (state.client) state.client.sendChatRead(Date.now());
  } else {
    renderChatBadge();
    toast('收到一条新消息', 'info');
  }
}

function onChatAck(msg) {
  const peerId = chatPeerId();
  const updated = chatStore.updateStatus(peerId, msg.msgId, { status: DELIVERY.DELIVERED });
  if (updated && peerId === CHAT.activeId) upsertChatMessage(peerId, updated);
}

function onChatRead(msg) {
  const peerId = chatPeerId();
  chatStore.markPeerRead(peerId, msg.upToTs || 0);
  // 整批状态都变了，这里直接重建时间线最省事（已读回执不频繁）
  if (peerId === CHAT.activeId) {
    CHAT.messages = chatStore.list(peerId).messages;
    renderTimeline();
  }
}

/** 把传输进度映射回聊天里的文件气泡 */
function updateChatProgressFromTransfer(p) {
  const link = chatTransferIndex.get(p.transferId);
  if (!link) return;
  const list = chatStore.list(link.peerId).messages;
  const m = list.find((x) => x.msgId === link.msgId);
  if (!m) return;
  const total = (m.attachment && m.attachment.totalBytes) || 0;
  const progress = total > 0 ? Math.min(1, (p.transferredBytes || 0) / total) : 0;
  chatStore.updateStatus(link.peerId, link.msgId, { progress });
  if (link.peerId === CHAT.activeId) {
    const cached = CHAT.messages.find((x) => x.msgId === link.msgId);
    if (cached) { cached.progress = progress; updateMessageEl(cached); }
  }
}

/** 传输结束 → 把聊天文件气泡标为完成 */
function markChatTransferDone(transferId, ok = true) {
  const link = chatTransferIndex.get(transferId);
  if (!link) return;
  chatTransferIndex.delete(transferId);
  const patch = ok ? { done: true, progress: 1 } : { status: DELIVERY.FAILED };
  const m = chatStore.updateStatus(link.peerId, link.msgId, patch);
  if (m && link.peerId === CHAT.activeId) upsertChatMessage(link.peerId, m);
}

// ── 面板切换 ────────────────────────────────────────────────

function setPane(pane) {
  state.pane = pane;
  $('screen-main').classList.toggle('chat-open', pane === 'chat');
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.pane === pane));
  document.querySelectorAll('#pane-files, #pane-chat').forEach((el) => {
    el.classList.toggle('is-on', el.dataset.pane === pane);
  });
  if (pane === 'chat') openChatPane();
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
  // 同步更新聊天里文件气泡的进度
  updateChatProgressFromTransfer(p);
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
  markChatTransferDone(d.transferId, true);
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

// escapeHtml / cssEscape 定义在聊天区块（文件上部），此处不再重复定义。

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

  // 传输 / 聊天 面板切换
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setPane(btn.dataset.pane));
  });

  // 聊天输入
  const chatInput = $('chatInput');
  chatInput.addEventListener('input', autoGrowInput);
  chatInput.addEventListener('keydown', (e) => {
    // 桌面浏览器里 Enter 发送、Shift+Enter 换行；手机软键盘走「发送」键
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatText(); }
  });
  $('btnChatSend').addEventListener('click', sendChatText);
  $('btnChatAttach').addEventListener('click', pickChatFiles);

  // 时间线里的「重发」
  $('chatTimeline').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-retry]');
    if (!btn) return;
    const msgId = btn.dataset.retry;
    const m = CHAT.messages.find((x) => x.msgId === msgId);
    if (!m || !state.client) return;
    if (m.kind === 'text') {
      const r = state.client.sendChat({ kind: 'text', text: m.text, msgId });
      if (r.ok) {
        chatStore.updateStatus(CHAT.activeId, msgId, { status: DELIVERY.SENT });
        toast('已重新发送', 'ok');
      }
    } else {
      toast('请重新选择文件发送', 'warn');
    }
  });

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
  // 聊天：初始面板 + 未读红点
  setPane('files');
  renderChatBadge();
  autoGrowInput();

  // 开发调试钩子：仅用于截图/联调时注入假数据，生产构建下也不会被执行
  // （除非显式调用 window.__ltpSeedChat()，不影响正常使用）
  window.__ltpSeedChat = seedChatForDebug;
  window.__ltpClearChat = () => {
    if (CHAT.activeId) chatStore.clear(CHAT.activeId);
    CHAT.messages = [];
    renderTimeline();
    renderChatBadge();
  };
}

/** 注入示例消息，便于截图检查气泡/文件卡片/状态位样式 */
function seedChatForDebug() {
  const peerId = CHAT.activeId || chatPeerId();
  if (!peerId || peerId === 'unknown') {
    // 未连接时也能看样式：临时造一个会话
    chatStore.openChat({ deviceId: 'desktop-debug', name: 'DESKTOP-IEUIHUM', type: 'desktop' });
    CHAT.activeId = 'desktop-debug';
  }
  const pid = CHAT.activeId;
  const now = Date.now();
  const items = [
    { msgId: 'd1', dir: 'in', kind: 'text', text: '在吗？我把今晚的照片整理好了', ts: now - 300000, status: 'received' },
    { msgId: 'd2', dir: 'out', kind: 'text', text: '在的，直接发过来吧', ts: now - 260000, status: 'read' },
    { msgId: 'd3', dir: 'in', kind: 'text', text: '好，照片有点多，我打包一下', ts: now - 210000, status: 'received' },
    { msgId: 'd4', dir: 'out', kind: 'text', text: '没事，局域网传得快', ts: now - 190000, status: 'delivered' },
    {
      msgId: 'd5', dir: 'out', kind: 'file', text: '', ts: now - 120000, status: 'sent', progress: 0.62, done: false,
      attachment: { totalBytes: 48 * 1024 * 1024, files: [{ fileId: 'f1', name: '周末露营-原图.zip', size: 48 * 1024 * 1024, mime: 'application/zip' }] },
    },
    {
      msgId: 'd6', dir: 'in', kind: 'file', text: '', ts: now - 60000, status: 'received', done: true,
      attachment: { totalBytes: 128 * 1024 * 1024, files: [{ fileId: 'f2', name: '2026-05-全家福.mp4', size: 128 * 1024 * 1024, mime: 'video/mp4' }] },
    },
    { msgId: 'd7', dir: 'in', kind: 'text', text: '收到没？', ts: now - 20000, status: 'received' },
  ];
  items.forEach((m) => chatStore.append(pid, m));
  CHAT.messages = chatStore.list(pid).messages;
  renderTimeline();
  renderChatBadge();
}

boot();
