/**
 * Electron 主进程（Windows 电脑端）
 * 职责：拉起发现服务 + 传输服务，把事件通过 IPC 转发给渲染层，提供文件选择等系统能力。
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage } = require('electron');

/**
 * 无沙箱 / 无 GPU 环境兼容处理。
 * 某些虚拟机、远程桌面或被管控的环境下 GPU 进程会直接崩溃并 FATAL 退出
 * （报错 "GPU process isn't usable. Goodbye."），因此这里在 Electron
 * 初始化窗口前按需追加启动参数。通过环境变量 LTP_NO_GPU=1 启用。
 */
if (process.env.LTP_NO_GPU === '1' || process.env.LTP_SOFTWARE_RENDER === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('no-sandbox');
}
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const P = require('../../../shared/protocol.js');
const { Discovery, listLocalIPv4 } = require('./discovery.js');
const { TransferServer } = require('./server.js');
const { ChatStore } = require('./chat.js');

// Windows 通知使用稳定的应用标识，避免系统显示为 electron.app.*。
if (process.platform === 'win32') app.setAppUserModelId('com.lantransfer.desktop');

const isDev = !!process.env.LTP_DEV;

/**
 * 读取软件自身版本号。
 *
 * 为什么不能只用 app.getVersion()：
 *   开发模式是用 `electron src/main/main.js` 直接启动的，Electron 不会把
 *   desktop/package.json 当作「应用清单」来加载，于是 app.getVersion()
 *   返回的是 **Electron 自己的版本**（如 33.4.11），而不是 1.0.0。
 *   打包后 app.getVersion() 才是对的（读的是 app.asar 内的 package.json）。
 *   这里直接读文件兜底，保证两种模式下显示的都是真实软件版本。
 */
function appVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) return String(pkg.version);
    }
  } catch (_) { /* 读不到就回退 */ }
  try { return app.getVersion(); } catch (_) { return '1.0.3'; }
}

function appResource(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', '..', 'resources', name);
}

function showMainWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function checkGithubRelease() {
  const endpoint = 'https://api.github.com/repos/ShiyouQi888/Nearby-Transfer/releases/latest';
  return new Promise((resolve, reject) => {
    const req = https.get(endpoint, { headers: { 'User-Agent': 'Nearby-Transfer-Desktop', Accept: 'application/vnd.github+json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub Releases HTTP ${res.statusCode}`));
        try {
          const data = JSON.parse(body);
          const version = String(data.tag_name || '').replace(/^v/i, '');
          const assets = Array.isArray(data.assets) ? data.assets : [];
          const apkAsset = assets.find((a) => /Nearby-Transfer-.*\.apk$/i.test(a.name));
          resolve({
            currentVersion: appVersion(), latestVersion: version, updateAvailable: compareVersions(version, appVersion()) > 0,
            releaseUrl: data.html_url || 'https://github.com/ShiyouQi888/Nearby-Transfer/releases',
            desktopUrl: (assets.find((a) => /Nearby-Transfer-Setup-.*\.exe$/i.test(a.name)) || {}).browser_download_url || data.html_url,
            apkUrl: apkAsset?.browser_download_url || '', apkAvailable: !!apkAsset, apkSize: apkAsset?.size || 0,
            publishedAt: data.published_at || '',
          });
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('检查更新超时')));
    req.on('error', reject);
  });
}

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// ─────────────────────────────────────────────────────────────
// 配置持久化（设备身份 / 信任设备 / 保存目录 / 历史）
// ─────────────────────────────────────────────────────────────

let CONFIG_DIR;
let CONFIG_FILE;
let STORE = {
  deviceId: null,
  deviceSecret: null,
  deviceName: null,
  saveDir: null,
  trusted: [],          // [{deviceId,name,type,fingerprint,trustedAt,lastSeenAt}]
  history: [],          // 传输历史
};

function loadStore() {
  CONFIG_DIR = path.join(app.getPath('userData'), 'ltp');
  CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      Object.assign(STORE, raw);
    }
  } catch (e) {
    console.error('读取配置失败', e);
  }
  let dirty = false;
  if (!STORE.deviceSecret) { STORE.deviceSecret = crypto.randomBytes(32).toString('hex'); dirty = true; }
  if (!STORE.deviceId) { STORE.deviceId = P.makeDeviceId('pc'); dirty = true; }
  if (!STORE.deviceName) { STORE.deviceName = os.hostname() || 'Windows PC'; dirty = true; }
  if (!STORE.saveDir) { STORE.saveDir = path.join(app.getPath('downloads'), 'LANTransfer'); dirty = true; }
  fs.mkdirSync(STORE.saveDir, { recursive: true });
  if (dirty) saveStore();
}

function saveStore() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // 历史最多留 500 条
    const out = { ...STORE, history: (STORE.history || []).slice(0, 500) };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    console.error('保存配置失败', e);
  }
}

// ─────────────────────────────────────────────────────────────
// 服务实例
// ─────────────────────────────────────────────────────────────

let win = null;
let tray = null;
let discovery = null;
let server = null;
let chatStore = null;
let selfDevice = null;

const FIREWALL_RULES = [
  { name: 'Nearby Transfer TCP 53317', protocol: 'TCP' },
  { name: 'Nearby Transfer UDP 53317', protocol: 'UDP' },
];

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ stdout, stderr });
    });
  });
}

async function firewallRuleExists(name) {
  if (process.platform !== 'win32') return true;
  try {
    await execFileAsync('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`]);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 首次启动时自动创建局域网入站规则。规则只开放专用/域网络，
 * 不会放开公网；如果系统需要管理员权限，会触发一次 UAC 确认。
 */
async function ensureFirewallRules() {
  if (process.platform !== 'win32') return { ok: true, changed: false, reason: 'not_windows' };
  // Store/MSIX 包通过 privateNetworkClientServer capability 获得局域网防火墙访问，
  // 不应尝试以 UAC 修改系统级规则。
  if (process.windowsStore) return { ok: true, changed: false, status: 'package_capability' };
  const missing = [];
  for (const rule of FIREWALL_RULES) {
    if (!(await firewallRuleExists(rule.name))) missing.push(rule);
  }
  if (!missing.length) return { ok: true, changed: false, status: 'ready' };

  const commands = missing.map((rule) =>
    `netsh advfirewall firewall add rule name="${rule.name}" dir=in action=allow protocol=${rule.protocol} localport=${P.PORT} profile=private,domain enable=yes`
  ).join(' && ');
  // 由 PowerShell 仅负责触发一次管理员 UAC，真正的规则由提升后的 cmd 执行。
  const script = `$p = Start-Process -FilePath 'cmd.exe' -Verb RunAs -ArgumentList @('/d','/s','/c',${JSON.stringify(commands)}) -Wait -PassThru; exit $p.ExitCode;`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    const ready = (await Promise.all(FIREWALL_RULES.map((r) => firewallRuleExists(r.name)))).every(Boolean);
    return ready ? { ok: true, changed: true, status: 'ready' } : { ok: false, reason: 'rule_not_found' };
  } catch (error) {
    return { ok: false, reason: 'permission_denied', message: String(error.message || error) };
  }
}

function buildSelf() {
  const ips = listLocalIPv4();
  selfDevice = {
    deviceId: STORE.deviceId,
    name: STORE.deviceName,
    type: 'desktop',
    os: `Windows ${os.release()}`,
    ip: ips.length ? ips[0].address : '127.0.0.1',
    port: P.PORT,
    fingerprint: P.makeFingerprint(STORE.deviceSecret),
    pairingRequired: true,
  };
  return selfDevice;
}

function pushToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startServices() {
  buildSelf();

  // ── 聊天会话存储（持久化到 %APPDATA%/ltp/chats*）
  chatStore = new ChatStore({
    dir: CONFIG_DIR,
    onChange: (ev) => pushToRenderer('ltp:chatevent', ev),
  });

  // ── 传输服务
  server = new TransferServer({
    self: selfDevice,
    deviceSecret: STORE.deviceSecret,
    port: P.PORT,
    saveDir: STORE.saveDir,
    trusted: STORE.trusted.map((t) => [t.deviceId, t]),
    chatStore,
  });

  // 转发全部事件给渲染层
  const forward = [
    'listening', 'http:listening', 'http:ready', 'http:error', 'http:ws-open',
    'session:new', 'session:error', 'device:connected', 'device:disconnected',
    'pair:failed', 'offer:incoming', 'offer:rejected', 'offer:auto', 'transfer:offered', 'transfer:start',
    'transfer:progress', 'transfer:file-complete', 'transfer:complete', 'transfer:error',
    'transfer:cancelled', 'transfer:peer-progress', 'trust:changed',
    'chat:message', 'chat:delivered', 'chat:read',
  ];
  forward.forEach((ev) => server.on(ev, (payload) => {
    // 进度事件量大，单独走轻量通道
    if (ev === 'transfer:progress' || ev === 'transfer:peer-progress') {
      pushToRenderer('ltp:progress', { ev, payload });
    } else {
      pushToRenderer('ltp:event', { ev, payload });
    }
    if (ev === 'trust:changed') { STORE.trusted = payload.trusted; saveStore(); }
    // 聊天来源的传输：把进度/完成回写到对应聊天消息，让气泡内的进度条动起来
    if (ev === 'transfer:progress' && chatStore && payload) {
      syncChatTransferProgress(payload.transferId, payload.overall, payload.speed, payload.etaMs);
    }
    if (ev === 'transfer:complete' || ev === 'transfer:cancelled') {
      const t = payload.transfer;
      if (t) {
        syncChatTransferComplete(t, ev === 'transfer:cancelled');
        const rec = {
          transferId: t.transferId, direction: t.direction, device: t.device,
          totalBytes: t.totalBytes, transferredBytes: t.transferredBytes,
          status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt,
          durationMs: t.durationMs, fileCount: t.files.length,
          files: t.files.map((f) => ({ name: f.name, size: f.size, status: f.status, path: f.path })),
          error: t.error || null,
        };
        STORE.history = [rec, ...(STORE.history || []).filter((h) => h.transferId !== t.transferId)];
        saveStore();
        pushToRenderer('ltp:history', STORE.history.slice(0, 100));
      }
    }
  }));

  server.listen().then(() => {
    pushToRenderer('ltp:event', { ev: 'server:listening', payload: { port: P.PORT } });
  }).catch((e) => {
    pushToRenderer('ltp:event', { ev: 'server:error', payload: { message: String(e.message || e) } });
  });

  // ── 发现服务
  discovery = new Discovery({ self: selfDevice, port: P.PORT });
  ['device:up', 'device:down', 'device:update', 'scan:progress', 'scan:done', 'started', 'error']
    .forEach((ev) => discovery.on(ev, (payload) => pushToRenderer('ltp:event', { ev: 'discovery:' + ev, payload })));
  discovery.start();

  // 服务启动后自动检查防火墙；已有规则不会重复弹出 UAC。
  ensureFirewallRules().then((payload) => {
    pushToRenderer('ltp:event', { ev: 'firewall:status', payload });
  });

  // 定期把设备列表推给 UI
  setInterval(() => {
    if (discovery) pushToRenderer('ltp:devices', discovery.list());
  }, 1500);
}

// ─────────────────────────────────────────────────────────────
// 窗口
// ─────────────────────────────────────────────────────────────

function createWindow() {
  const iconPath = appResource('icon.png');
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    title: '邻传 Nearby Transfer',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#0d1215',
    autoHideMenuBar: true,
    // 自绘标题栏：去掉系统原生边框与标题栏，由渲染层顶栏承担拖拽与窗口控制，
    // 使「关闭/最小化/最大化」与软件整体视觉一致（而不是系统灰白按钮）。
    frame: false,
    // Windows 下保留圆角与投影观感
    roundedCorners: true,
    // 无边框窗口在部分 Windows 缩放/多屏场景下会出现 1px 白边，用深色兜底
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // 首帧就绪后再显示，避免深色界面出现白色闪屏
  win.once('ready-to-show', () => win.show());
  // Minimize means "send to tray". The tray icon is bundled as an extra resource
  // (outside app.asar), so Windows keeps a visible restore/quit entry point.
  win.on('minimize', (event) => {
    if (!app.isQuitting) { event.preventDefault(); win.hide(); }
  });

  // 最大化状态变化时主动通知渲染层，保证「最大化/还原」按钮图标与实际状态同步
  const pushWinState = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('ltp:winState', { maximized: win.isMaximized() });
    }
  };
  win.on('maximize', pushWinState);
  win.on('unmaximize', pushWinState);
  win.on('closed', () => { win = null; });

  // 开发用截图钩子：仅当 LTP_SHOT=1 时启用（脚本 scripts/shoot-desktop.js 调用）
  if (process.env.LTP_SHOT === '1') hookScreenshot(win);
}

/** 依次切换标签页并截图到 _shots/，完成后退出（仅开发调试用） */
function hookScreenshot(win) {
  const outDir = process.env.LTP_SHOT_DIR || path.join(process.cwd(), '_shots');
  const plan = (process.env.LTP_SHOT_PLAN || 'devices:desktop.png,pair:pair.png,trusted:trusted.png').split(',');
  const seedChat = process.env.LTP_SHOT_SEED_CHAT === '1';
  win.webContents.once('did-finish-load', async () => {
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 2600));
    // 可选：注入一段示例会话，用于截图检查聊天气泡/文件卡片/状态的渲染
    if (seedChat) {
      try {
        // 注意：不要 await 这个表达式 —— __ltpSeedChat 内部有若干 IPC 往返，
        // 返回的 Promise 在本阶段可能长时间不 settle，会把截图流程整个挂住。
        win.webContents.executeJavaScript('window.__ltpSeedChat && window.__ltpSeedChat()')
          .catch((e) => console.error('[shot] 注入示例会话失败', e && e.message));
        await new Promise((r) => setTimeout(r, 1200));
      } catch (e) { console.error('[shot] 注入示例会话失败', e.message); }
    }
    for (const item of plan) {
      const [tab, file] = item.split(':');
      await win.webContents.executeJavaScript(
        `document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.tab===${JSON.stringify(tab)}));` +
        `document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.id==='tab-'+${JSON.stringify(tab)}));`,
      );
      await new Promise((r) => setTimeout(r, 700));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, file), img.toPNG());
      console.log('[shot]', file);
    }
    app.quit();
  });
}

function createTray() {
  try {
    const trayPath = appResource('tray.png');
    const fallbackPath = appResource('icon.png');
    const trayImage = fs.existsSync(trayPath) ? nativeImage.createFromPath(trayPath) : nativeImage.createEmpty();
    const img = trayImage.isEmpty() && fs.existsSync(fallbackPath) ? nativeImage.createFromPath(fallbackPath) : trayImage;
    if (img.isEmpty()) throw new Error('Tray and app icons are unavailable');
    tray = new Tray(img);
    tray.setToolTip('邻传 Nearby Transfer');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开邻传 / Open Nearby Transfer', click: showMainWindow },
      { type: 'separator' },
      { label: '退出 / Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
  } catch (error) { console.error('[tray] Unable to create tray icon:', error); }
}

// ─────────────────────────────────────────────────────────────
// 聊天 ↔ 传输联动
//
// 文件消息先落一条聊天记录，随后才走传输链路。这里负责把传输层的
// 进度与结果回写到那条聊天消息上，让气泡里的进度条/状态跟着走。
// 关联键是 attachment.transferId。
// ─────────────────────────────────────────────────────────────

/** 找出引用该 transferId 的聊天消息（返回 { peerId, msgId }） */
function findChatMessageByTransfer(transferId) {
  if (!chatStore || !transferId) return null;
  for (const chat of chatStore.chats.values()) {
    const list = chatStore.list(chat.peerId, { limit: P.CHAT_HISTORY_LIMIT || 2000 }).messages;
    const m = list.find((x) => x.attachment && x.attachment.transferId === transferId);
    if (m) return { peerId: chat.peerId, msgId: m.msgId, message: m };
  }
  return null;
}

function syncChatTransferProgress(transferId, transferredBytes, speed, etaMs) {
  const hit = findChatMessageByTransfer(transferId);
  if (!hit) return;
  chatStore.updateStatus(hit.peerId, hit.msgId, {
    attachment: { ...hit.message.attachment, transferredBytes, speed, etaMs, progress: true },
  });
}

function syncChatTransferComplete(transfer, cancelled) {
  if (!transfer) return;
  const hit = findChatMessageByTransfer(transfer.transferId);
  if (!hit) return;
  const status = cancelled ? 'cancelled'
    : transfer.status === 'done' ? 'done'
    : (transfer.status === 'rejected' ? 'rejected' : 'failed');
  chatStore.updateStatus(hit.peerId, hit.msgId, {
    status,
    attachment: {
      ...hit.message.attachment,
      transferredBytes: transfer.transferredBytes,
      totalBytes: transfer.totalBytes,
      progress: false,
      savePaths: (transfer.files || []).map((f) => f.path).filter(Boolean),
    },
  });
  pushToRenderer('ltp:chatevent', { kind: 'message:update', peerId: hit.peerId, transferId: transfer.transferId });
}

// ─────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────

function registerIpc() {
  // ── 窗口控制（自绘标题栏）
  ipcMain.handle('ltp:winMinimize', () => { if (win && !win.isDestroyed()) win.minimize(); return true; });
  ipcMain.handle('ltp:winFocus', () => { showMainWindow(); return true; });
  ipcMain.handle('ltp:winToggleMaximize', () => {
    if (!win || win.isDestroyed()) return { maximized: false };
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return { maximized: win.isMaximized() };
  });
  ipcMain.handle('ltp:winClose', () => { if (win && !win.isDestroyed()) win.close(); return true; });
  ipcMain.handle('ltp:winIsMaximized', () => (win && !win.isDestroyed() ? win.isMaximized() : false));

  // ── 关于页：版本信息与外链
  ipcMain.handle('ltp:getAppInfo', () => ({
    name: '邻传',
    nameEn: 'Nearby Transfer',
    version: appVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${os.type()} ${os.release()}`,
    arch: process.arch,
    storeManagedUpdates: !!process.windowsStore,
    protocol: P.PROTOCOL_ID,
  }));
  ipcMain.handle('ltp:checkForUpdates', async () => {
    if (process.windowsStore) return { ok: true, storeManaged: true };
    try { return { ok: true, ...(await checkGithubRelease()) }; }
    catch (e) { return { ok: false, error: e && e.message ? e.message : '检查更新失败' }; }
  });
  ipcMain.handle('ltp:getMobileDownloadInfo', async () => {
    try {
      const release = await checkGithubRelease();
      const target = release.apkUrl || release.releaseUrl;
      let qrDataUrl = null;
      try {
        const QRCode = require('qrcode');
        qrDataUrl = await QRCode.toDataURL(target, { width: 360, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#101612', light: '#ffffff' } });
      } catch (_) {}
      return { ok: true, latestVersion: release.latestVersion, apkAvailable: release.apkAvailable, apkUrl: release.apkUrl, apkSize: release.apkSize, releaseUrl: release.releaseUrl, qrDataUrl };
    } catch (error) {
      return { ok: false, error: error?.message || 'download_info_unavailable' };
    }
  });

  // 只允许 http/https/mailto，避免渲染层被注入后调用 shell 打开任意协议
  ipcMain.handle('ltp:openExternal', (e, url) => {
    const s = String(url || '');
    if (!/^(https?|mailto):/i.test(s)) return { ok: false, error: 'protocol_not_allowed' };
    shell.openExternal(s);
    return { ok: true };
  });

  // 基础信息
  ipcMain.handle('ltp:getSelf', () => ({
    ...selfDevice,
    saveDir: STORE.saveDir,
    lanIPs: listLocalIPv4(),
    protocol: P.PROTOCOL_ID,
    port: P.PORT,
  }));

  // 本地图片缩略图：仅允许常见图片格式且限制大小，避免把任意文件暴露给渲染层。
  ipcMain.handle('ltp:getImagePreview', (e, filePath) => {
    const p = String(filePath || '');
    const ext = path.extname(p).toLowerCase();
    const mime = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    }[ext];
    if (!mime || !fs.existsSync(p)) return { ok: false };
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile() || stat.size > 3 * 1024 * 1024) return { ok: false };
      return { ok: true, dataUrl: `data:${mime};base64,${fs.readFileSync(p).toString('base64')}` };
    } catch (_) { return { ok: false }; }
  });

  ipcMain.handle('ltp:ensureFirewall', async () => ensureFirewallRules());

  ipcMain.handle('ltp:getDevices', () => (discovery ? discovery.list() : []));
  ipcMain.handle('ltp:getTrusted', () => server.listTrusted());
  ipcMain.handle('ltp:getHistory', () => (STORE.history || []).slice(0, 200));
  ipcMain.handle('ltp:deleteHistory', (e, transferId) => {
    const id = String(transferId || '');
    const before = STORE.history || [];
    STORE.history = before.filter((h) => h.transferId !== id);
    saveStore();
    pushToRenderer('ltp:history', STORE.history.slice(0, 100));
    return { ok: STORE.history.length !== before.length };
  });
  ipcMain.handle('ltp:clearHistory', () => { STORE.history = []; saveStore(); pushToRenderer('ltp:history', []); return { ok: true }; });
  ipcMain.handle('ltp:getSessions', () => (server ? server.allSessions() : []));
  ipcMain.handle('ltp:getTransfers', () => (server ? server.listTransfers() : []));

  // 网段扫描
  ipcMain.handle('ltp:scan', async (e, { range } = {}) => {
    if (!discovery) return { error: '服务未启动' };
    try { return await discovery.scan(range); }
    catch (err) { return { error: String(err.message || err) }; }
  });
  ipcMain.handle('ltp:cancelScan', () => { if (discovery) discovery.cancelScan(); return true; });

  // 配对码 / 二维码
  ipcMain.handle('ltp:newPairCode', () => (server ? { code: server.newPairCode(), ttlMs: P.PAIR_CODE_TTL_MS } : null));

  /**
   * 生成二维码。直接在主进程用 Node 版 qrcode 渲染成 PNG data URL，
   * 渲染层无需引入前端二维码库（同时也避免 CSP 放宽）。
   */
  ipcMain.handle('ltp:makeQr', async () => {
    if (!server) return null;
    const { payload, token } = server.makeQrPayload();
    let dataUrl = null;
    try {
      const QRCode = require('qrcode');
      dataUrl = await QRCode.toDataURL(payload, {
        width: 460,              // 2x 便于高分屏显示
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' },
      });
    } catch (e) {
      // 前端库不可用时退化为「文本 + 手动导入」
      dataUrl = null;
    }
    return { payload, token, ttlMs: P.QR_TOKEN_TTL_MS, dataUrl };
  });

  // 设备信息修改
  ipcMain.handle('ltp:setDeviceName', (e, name) => {
    const n = String(name || '').trim().slice(0, 32);
    if (!n) return { ok: false };
    STORE.deviceName = n;
    saveStore();
    buildSelf();
    if (discovery) { discovery.self = selfDevice; discovery.announce(); }
    if (server) server.self = selfDevice;
    return { ok: true, name: n };
  });

  // 保存目录
  ipcMain.handle('ltp:chooseSaveDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择接收文件的保存目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: STORE.saveDir,
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    STORE.saveDir = r.filePaths[0];
    fs.mkdirSync(STORE.saveDir, { recursive: true });
    saveStore();
    if (server) server.saveDir = STORE.saveDir;
    return { ok: true, saveDir: STORE.saveDir };
  });

  ipcMain.handle('ltp:openPath', (e, p) => { shell.openPath(String(p)); return true; });
  ipcMain.handle('ltp:showInFolder', (e, p) => { shell.showItemInFolder(String(p)); return true; });
  ipcMain.handle('ltp:copyText', (e, t) => { clipboard.writeText(String(t)); return true; });

  // 读取剪贴板：优先文件（资源管理器复制的文件），否则文本
  ipcMain.handle('ltp:readClipboard', () => {
    // Windows 下复制文件时 clipboard 会带 'FileNameW' 自定义格式
    const fmt = clipboard.availableFormats();
    const files = [];
    if (fmt.some((f) => /FileNameW/i.test(f))) {
      try {
        const raw = clipboard.readBuffer('FileNameW').toString('utf16le').replace(/\0+$/, '');
        raw.split('\0').forEach((p) => {
          const s = p.trim();
          if (s && fs.existsSync(s)) files.push(s);
        });
      } catch { /* 忽略 */ }
    }
    if (files.length) return { files };
    const text = clipboard.readText();
    return { text: text || '' };
  });

  // 选择要发送的文件
  ipcMain.handle('ltp:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要发送的文件',
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('ltp:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要发送的文件夹',
      properties: ['openDirectory'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  // 给指定设备发送
  ipcMain.handle('ltp:sendTo', async (e, { deviceId, paths, maxBytesPerSec }) => {
    if (!server) return { ok: false, reason: 'no_server' };

    // 文本项（{ text }）先落地成临时 .txt 文件，再走统一的文件发送链路
    const realPaths = [];
    for (const p of (paths || [])) {
      if (p && typeof p === 'object' && p.text != null) {
        const dir = path.join(app.getPath('temp'), 'ltp-text');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fp = path.join(dir, `文字内容-${stamp}.txt`);
        fs.writeFileSync(fp, String(p.text), 'utf8');
        realPaths.push(fp);
      } else if (typeof p === 'string' && p) {
        realPaths.push(p);
      }
    }
    if (!realPaths.length) return { ok: false, reason: 'empty' };

    // 已在连接的会话直接用；否则先按信任状态建立连接
    let session = server.sessionOf(deviceId);
    if (!session) {
      const dev = (discovery ? discovery.list() : []).find((d) => d.deviceId === deviceId);
      if (!dev) return { ok: false, reason: 'device_not_found' };
      try {
        session = await connectToDevice(dev);
      } catch (err) {
        return { ok: false, reason: 'connect_failed', message: String(err.message || err) };
      }
    }
    if (!session) return { ok: false, reason: 'not_trusted' };
    try {
      return await session.startSend(realPaths, { maxBytesPerSec });
    } catch (err) {
      return { ok: false, reason: 'send_failed', message: String(err.message || err) };
    }
  });

  // 接受 / 拒绝 incoming offer
  ipcMain.handle('ltp:acceptOffer', async (e, { sessionId, transferId }) => {
    const s = server && server.sessions.get(sessionId);
    if (!s) return { ok: false, reason: 'no_session' };
    return s.acceptOffer(transferId);
  });
  ipcMain.handle('ltp:rejectOffer', (e, { sessionId, transferId, reason }) => {
    const s = server && server.sessions.get(sessionId);
    if (!s) return { ok: false, reason: 'no_session' };
    return s.rejectOffer(transferId, reason || 'user_denied');
  });

  // 取消传输
  ipcMain.handle('ltp:cancelTransfer', (e, { sessionId, transferId }) => {
    const s = server && server.sessions.get(sessionId);
    if (!s) return { ok: false };
    return s.cancelTransfer(transferId);
  });

  // 撤销信任
  ipcMain.handle('ltp:untrust', (e, deviceId) => ({ ok: server ? server.untrust(deviceId) : false }));

  // ── 聊天 ───────────────────────────────────────────────
  ipcMain.handle('ltp:getChats', () => (chatStore ? chatStore.summary() : []));
  ipcMain.handle('ltp:getChatMessages', (e, { peerId, before, limit } = {}) =>
    (chatStore ? chatStore.list(String(peerId || ''), { before, limit }) : { messages: [], hasMore: false }));

  /** 发送文本消息；对端离线时保留为 pending，返回 offline 让 UI 提示 */
  ipcMain.handle('ltp:sendChatText', async (e, { peerId, text } = {}) => {
    if (!server || !chatStore) return { ok: false, reason: 'no_server' };
    const p = String(text || '').trim();
    if (!p) return { ok: false, reason: 'empty' };
    if (p.length > P.CHAT_TEXT_MAX) return { ok: false, reason: 'too_long' };

    const chat = chatStore.openChat({ deviceId: peerId });
    const msgId = P.makeMsgId(STORE.deviceId);
    const session = server.sessionOf(peerId);
    const status = session ? 'sent' : 'pending';
    const { message } = chatStore.append(peerId, {
      msgId, dir: 'out', kind: 'text', text: p, ts: Date.now(), status,
    });
    if (session) session.sendChat({ kind: 'text', text: p, msgId });
    return { ok: true, msgId, message, delivered: !!session, reason: session ? null : 'offline', chatId: chat.chatId };
  });

  /**
   * 发送文件消息：先落一条 file 类型聊天消息（气泡立刻出现），
   * 再用现有 startSend 走传输链路（send_offer 带 chatId + origin:'chat'）。
   */
  ipcMain.handle('ltp:sendChatFiles', async (e, { peerId, paths, maxBytesPerSec } = {}) => {
    if (!server || !chatStore) return { ok: false, reason: 'no_server' };
    const session = server.sessionOf(peerId);
    if (!session) return { ok: false, reason: 'offline' };

    const realPaths = (paths || []).filter((p) => typeof p === 'string' && p);
    if (!realPaths.length) return { ok: false, reason: 'empty' };

    // 先建 file 消息（此时还不知道 transferId，用占位；startSend 后回填）
    const chat = chatStore.openChat({ deviceId: peerId });
    const msgId = P.makeMsgId(STORE.deviceId);
    const { message } = chatStore.append(peerId, {
      msgId, dir: 'out', kind: 'file', ts: Date.now(), status: 'sending',
      attachment: { transferId: null, files: realPaths.map((p, i) => ({
        fileId: `f_${i + 1}`, name: path.basename(p), size: 0, isDir: false, relPath: '',
      })), totalBytes: 0, localPaths: realPaths },
    });

    try {
      const r = await session.startSend(realPaths, { maxBytesPerSec, chatId: chat.chatId, origin: 'chat' });
      if (!r || !r.ok) {
        chatStore.updateStatus(peerId, msgId, { status: 'failed' });
        return { ok: false, reason: (r && r.reason) || 'send_failed' };
      }
      // 回填真实 transferId 与文件元数据
      chatStore.updateStatus(peerId, msgId, {
        attachment: { transferId: r.transferId, files: r.fileList || message.attachment.files, totalBytes: r.totalBytes, localPaths: realPaths },
      });
      session.sendChat({
        kind: 'file', msgId,
        attachment: { transferId: r.transferId, files: r.fileList || message.attachment.files, totalBytes: r.totalBytes },
      });
      return { ok: true, msgId, transferId: r.transferId, message };
    } catch (err) {
      chatStore.updateStatus(peerId, msgId, { status: 'failed' });
      return { ok: false, reason: 'send_failed', message: String(err.message || err) };
    }
  });

  /** 标记本地已读（清零未读 + 回执给对端） */
  ipcMain.handle('ltp:markChatRead', (e, peerId) => {
    if (!chatStore) return { ok: false };
    const r = chatStore.markLocalRead(String(peerId || ''));
    const session = server && server.sessionOf(peerId);
    if (session) session.sendChatRead();
    return r;
  });

  /** 用户点了「接受会话」——此后该会话内的文件静默接收 */
  ipcMain.handle('ltp:acceptChatSession', (e, peerId) => {
    if (!chatStore) return { ok: false };
    const chat = chatStore.acceptSession(String(peerId || ''));
    return chat ? { ok: true, chat } : { ok: false };
  });

  ipcMain.handle('ltp:clearChat', (e, peerId) => (chatStore ? chatStore.clear(String(peerId || '')) : { ok: false }));
  ipcMain.handle('ltp:deleteChat', (e, peerId) => (chatStore ? chatStore.deleteChat(String(peerId || '')) : { ok: false }));

  /** 重发一条 pending 的出站消息（对端重新上线后） */
  ipcMain.handle('ltp:retryChatMessage', async (e, { peerId, msgId } = {}) => {
    if (!server || !chatStore) return { ok: false, reason: 'no_server' };
    const session = server.sessionOf(peerId);
    if (!session) return { ok: false, reason: 'offline' };
    const list = chatStore.list(peerId, { limit: P.CHAT_HISTORY_LIMIT || 2000 }).messages;
    const m = list.find((x) => x.msgId === msgId);
    if (!m) return { ok: false, reason: 'not_found' };
    session.sendChat({
      kind: m.kind, text: m.text, msgId: m.msgId, attachment: m.attachment,
    });
    chatStore.updateStatus(peerId, msgId, { status: 'sent' });
    return { ok: true };
  });

  /**
   * 开发调试专用：往会话里注入一批假消息，用于截图检查气泡渲染。
   * 仅当 LTP_SHOT=1（截图脚本）时注册，正常运行时不存在这个通道。
   */
  if (process.env.LTP_SHOT === '1') {
    ipcMain.handle('ltp:seedChatMessages', (e, { peerId, messages } = {}) => {
      if (!chatStore || !peerId) return { ok: false };
      chatStore.openChat({ deviceId: String(peerId), name: '我的手机', type: 'mobile' });
      (messages || []).forEach((m, i) => {
        chatStore.append(String(peerId), {
          msgId: `seed_${Date.now()}_${i}`,
          dir: m.dir, kind: m.kind, text: m.text, ts: m.ts,
          status: m.status, progress: m.progress, done: m.done,
          attachment: m.attachment || null,
        });
      });
      chatStore.markLocalRead(String(peerId));
      return { ok: true };
    });
  }
}

/** 由电脑端主动连接某个已发现设备（主要面向手机端作为服务端的场景） */
function connectToDevice(dev) {
  return new Promise((resolve, reject) => {
    if (!server) return reject(new Error('服务未启动'));
    // 复用 TransferServer 的反向连接能力：这里构造一个出站会话
    const net = require('net');
    const { Session } = require('./server.js');
    const sock = net.connect({ host: dev.ip, port: dev.port || P.PORT }, () => {
      const s = new Session(sock, { server, direction: 'outbound' });
      server.sessions.set(s.id, s);
      s.on('disconnected', () => server.sessions.delete(s.id));
      // 用已存令牌握手
      const rec = server.trusted.get(dev.deviceId);
      const token = P.signToken(STORE.deviceSecret, STORE.deviceId, Date.now(), 0);
      s.send(P.makeMessage(P.MSG.HELLO, {
        device: selfDevice,
        auth: { mode: 'paired', deviceId: STORE.deviceId, token },
      }, STORE.deviceId));
      const t = setTimeout(() => reject(new Error('握手超时')), 5000);
      const onAck = (msg) => {
        if (msg.type === P.MSG.HELLO_ACK) {
          clearTimeout(t);
          if (msg.accepted) { s.paired = true; resolve(s); }
          else reject(new Error(msg.reason || 'rejected'));
        }
      };
      s.decoder.onMessage = ((orig) => (m, b) => { onAck(m); return orig(m, b); })(s.decoder.onMessage);
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('连接超时')), 6000);
  });
}

// ─────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    loadStore();
    registerIpc();
    createWindow();
    startServices();
    if (!isDev) createTray();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：不退出，除非明确退出
    if (process.platform !== 'darwin' && app.isQuitting) app.quit();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (discovery) discovery.stop();
    if (server) server.close();
    saveStore();
  });
}
