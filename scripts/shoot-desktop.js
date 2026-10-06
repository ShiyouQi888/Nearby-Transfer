/**
 * 桌面端截图工具（开发用）
 *
 * 启动 Electron → 由 main.js 中的截图钩子（LTP_SHOT=1）逐标签页截图 → 退出。
 * 用法：node scripts/shoot-desktop.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const OUT = path.join(ROOT, '_shots');

const env = {
  ...process.env,
  LTP_NO_GPU: '1',
  NO_SANDBOX: '1',
  LTP_SHOT: '1',
  LTP_SHOT_DIR: OUT,
  LTP_SHOT_PLAN: 'devices:desktop.png,pair:pair.png,transfers:transfers.png,history:history.png,trusted:trusted.png',
};
// 沙箱环境下 ELECTRON_RUN_AS_NODE=1 会让 electron 以纯 Node 模式启动，
// 必须清除，否则 app/ipcMain 等 API 不可用。
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [DESKTOP],
  { env, stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code || 0));
