/**
 * Preload：通过 contextBridge 暴露受限的 API 给渲染层
 * 渲染层无法直接访问 Node / Electron 对象，只能调用这里列出的方法。
 */

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('ltp', {
  // Electron 32+ removed File.path; resolve OS-dropped File objects in preload.
  getPathForFile: (file) => webUtils.getPathForFile(file),
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
  setAvatar: (data) => invoke('ltp:setAvatar', data),
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

  // ── 聊天
  getChats: () => invoke('ltp:getChats'),
  getChatMessages: (peerId, opts) => invoke('ltp:getChatMessages', { peerId, ...(opts || {}) }),
  getGroups: () => invoke('ltp:getGroups'),
  markGroupRead: (groupId) => invoke('ltp:markGroupRead', groupId),
  createGroup: (name) => invoke('ltp:createGroup', name),
  getGroupInvite: (groupId) => invoke('ltp:getGroupInvite', groupId),
  refreshGroupInvite: (groupId) => invoke('ltp:refreshGroupInvite', groupId),
  joinGroup: (invite) => invoke('ltp:joinGroup', invite),
  sendGroupText: (groupId, text) => invoke('ltp:sendGroupText', { groupId, text }),
  sendGroupFiles: (groupId, paths) => invoke('ltp:sendGroupFiles', { groupId, paths }),
  removeGroupMember: (groupId, deviceId) => invoke('ltp:removeGroupMember', { groupId, deviceId }),
  dissolveGroup: (groupId) => invoke('ltp:dissolveGroup', groupId),
  leaveGroup: (groupId) => invoke('ltp:leaveGroup', groupId),
  onGroupEvent: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on('ltp:groupevent', h); return () => ipcRenderer.removeListener('ltp:groupevent', h); },
  sendChatText: (peerId, text) => invoke('ltp:sendChatText', { peerId, text }),
  sendChatFiles: (peerId, paths, maxBytesPerSec) => invoke('ltp:sendChatFiles', { peerId, paths, maxBytesPerSec }),
  markChatRead: (peerId) => invoke('ltp:markChatRead', peerId),
  acceptChatSession: (peerId) => invoke('ltp:acceptChatSession', peerId),
  clearChat: (peerId) => invoke('ltp:clearChat', peerId),
  deleteChat: (peerId) => invoke('ltp:deleteChat', peerId),
  setChatAlias: (peerId, alias) => invoke('ltp:setChatAlias', { peerId, alias }),
  retryChatMessage: (peerId, msgId) => invoke('ltp:retryChatMessage', { peerId, msgId }),
  // 开发调试（仅在 LTP_SHOT=1 时后端才注册，正常运行时调用会 reject，调用方需容错）
  seedChatMessages: (peerId, messages) => invoke('ltp:seedChatMessages', { peerId, messages }),
  onChatEvent: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ltp:chatevent', h);
    return () => ipcRenderer.removeListener('ltp:chatevent', h);
  },

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
