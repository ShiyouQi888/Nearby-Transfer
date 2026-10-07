/**
 * Preload：通过 contextBridge 暴露受限的 API 给渲染层
 * 渲染层无法直接访问 Node / Electron 对象，只能调用这里列出的方法。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('ltp', {
  // ── 窗口控制（自绘标题栏）
  winMinimize: () => invoke('ltp:winMinimize'),
  winFocus: () => invoke('ltp:winFocus'),
  winToggleMaximize: () => invoke('ltp:winToggleMaximize'),
  winClose: () => invoke('ltp:winClose'),
  winIsMaximized: () => invoke('ltp:winIsMaximized'),

  // ── 关于页
  getAppInfo: () => invoke('ltp:getAppInfo'),
  checkForUpdates: () => invoke('ltp:checkForUpdates'),
  getMobileDownloadInfo: () => invoke('ltp:getMobileDownloadInfo'),
  openExternal: (url) => invoke('ltp:openExternal', url),

  // ── 查询
  getSelf: () => invoke('ltp:getSelf'),
  getImagePreview: (filePath) => invoke('ltp:getImagePreview', filePath),
  getDevices: () => invoke('ltp:getDevices'),
  getTrusted: () => invoke('ltp:getTrusted'),
  getHistory: () => invoke('ltp:getHistory'),
  deleteHistory: (transferId) => invoke('ltp:deleteHistory', transferId),
  clearHistory: () => invoke('ltp:clearHistory'),
  getSessions: () => invoke('ltp:getSessions'),
  getTransfers: () => invoke('ltp:getTransfers'),
  ensureFirewall: () => invoke('ltp:ensureFirewall'),

  // ── 发现
  scan: (range) => invoke('ltp:scan', { range }),
  cancelScan: () => invoke('ltp:cancelScan'),

  // ── 配对
  newPairCode: () => invoke('ltp:newPairCode'),
  makeQr: () => invoke('ltp:makeQr'),

  // ── 设置
  setDeviceName: (name) => invoke('ltp:setDeviceName', name),
  chooseSaveDir: () => invoke('ltp:chooseSaveDir'),
  openPath: (p) => invoke('ltp:openPath', p),
  showInFolder: (p) => invoke('ltp:showInFolder', p),
  copyText: (t) => invoke('ltp:copyText', t),
  readClipboard: () => invoke('ltp:readClipboard'),

  // ── 发送
  pickFiles: () => invoke('ltp:pickFiles'),
  pickFolder: () => invoke('ltp:pickFolder'),
  sendTo: (deviceId, paths, maxBytesPerSec) => invoke('ltp:sendTo', { deviceId, paths, maxBytesPerSec }),

  // ── 接收确认
  acceptOffer: (sessionId, transferId) => invoke('ltp:acceptOffer', { sessionId, transferId }),
  rejectOffer: (sessionId, transferId, reason) => invoke('ltp:rejectOffer', { sessionId, transferId, reason }),

  // ── 控制
  cancelTransfer: (sessionId, transferId) => invoke('ltp:cancelTransfer', { sessionId, transferId }),
  untrust: (deviceId) => invoke('ltp:untrust', deviceId),

  // ── 事件订阅（返回取消订阅函数）
  onEvent: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ltp:event', h);
    return () => ipcRenderer.removeListener('ltp:event', h);
  },
  onProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ltp:progress', h);
    return () => ipcRenderer.removeListener('ltp:progress', h);
  },
  onDevices: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ltp:devices', h);
    return () => ipcRenderer.removeListener('ltp:devices', h);
  },
  onHistory: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ltp:history', h);
    return () => ipcRenderer.removeListener('ltp:history', h);
  },
  onWinState: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ltp:winState', h);
    return () => ipcRenderer.removeListener('ltp:winState', h);
  },
});
