/**
 * 校验打包产物能否真正启动（开发用）
 *
 * 不依赖 Electron GUI，直接在「模拟打包目录结构」下验证：
 *   - app.asar 内的主进程/预加载/渲染层文件是否齐全
 *   - renderer/logo.png 是否为合法 PNG（防占位符/空文件）
 *   - renderer/fonts/*.woff2 思源黑体子集是否为合法 woff2
 *   - extraResources 的协议层 resources/shared/protocol.js 能否被 require
 *   - 主程序 exe 是否生成
 *
 * 用法：NODE_PATH=desktop/node_modules node scripts/verify-package.js [--dir=release-v4]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argDir = (process.argv.find((a) => a.startsWith('--dir=')) || '').split('=')[1];
const RELEASE = argDir || process.env.LTP_RELEASE_DIR || 'release-v4';
const UNPACKED = path.join(ROOT, 'desktop', RELEASE, 'win-unpacked');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('  ok   ' + l); };
const bad = (l, d) => { fail++; console.log('  FAIL ' + l + (d ? ' :: ' + d : '')); };

/** 绕开 @electron/asar 在 Windows 上的 extractFile() bug，按 asar 头偏移自取字节 */
function readAsarEntry(asar, asarPath, relPath) {
  const hdr = asar.getRawHeader(asarPath).header;
  let node = hdr;
  for (const seg of relPath.replace(/^\//, '').split('/')) {
    node = node.files && node.files[seg];
    if (!node) throw new Error('asar 头里找不到 ' + relPath);
  }
  if (node.size == null) throw new Error(relPath + ' 不是文件节点');
  const dataOffset = 8 + asar.getRawHeader(asarPath).headerSize + Number(node.offset);
  const fd = fs.openSync(asarPath, 'r');
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, dataOffset);
  fs.closeSync(fd);
  return buf;
}

console.log('\n[A] app.asar 内容完整性  （目录：desktop/' + RELEASE + '）');
{
  const asar = require('@electron/asar');
  let files = [];
  try {
    files = asar.listPackage(ASAR).map((f) => f.replace(/\\/g, '/'));
  } catch (e) { bad('读取 app.asar', e.message); }

  const need = [
    '/src/main/main.js', '/src/main/server.js', '/src/main/discovery.js', '/src/main/transfer.js',
    '/src/preload/preload.js',
    '/src/renderer/index.html', '/src/renderer/app.js', '/src/renderer/style.css',
    '/src/renderer/icons.js', '/src/renderer/logo.png',
    '/src/renderer/fonts/source-han-sans-sc-subset.woff2',
  ];
  need.forEach((n) => (files.includes(n) ? ok('含 ' + n) : bad('缺 ' + n)));

  // renderer/logo.png 必须是真 PNG（否则界面顶栏会是空白）
  try {
    const buf = readAsarEntry(asar, ASAR, '/src/renderer/logo.png');
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const isPng = buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIG);
    isPng
      ? ok('renderer/logo.png 是合法 PNG（' + buf.length + ' B）')
      : bad('renderer/logo.png 签名非法', '实际头 ' + buf.subarray(0, 8).toString('hex'));
  } catch (e) { bad('提取 renderer/logo.png', e.message); }

  // 思源黑体子集必须是真 woff2（否则离线界面会退回系统字体，字重白调）
  try {
    const buf = readAsarEntry(asar, ASAR, '/src/renderer/fonts/source-han-sans-sc-subset.woff2');
    const WOFF2_SIG = Buffer.from([0x77, 0x4f, 0x46, 0x32]); // "wOF2"
    const sizeKb = (buf.length / 1024).toFixed(0);
    buf.length > 300 * 1024 && buf.subarray(0, 4).equals(WOFF2_SIG)
      ? ok('思源黑体子集是合法 woff2（' + sizeKb + ' KB，magic=wOF2）')
      : bad('思源黑体子集异常', buf.length + ' B, 头 ' + buf.subarray(0, 4).toString('hex'));
  } catch (e) { bad('提取思源黑体子集', e.message); }

  // 主进程/渲染层要包含这一轮新增的能力（防止旧文件被误打进去）
  try {
    const mainJs = readAsarEntry(asar, ASAR, '/src/main/main.js').toString('utf8');
    ['ltp:getAppInfo', 'ltp:openExternal', 'ltp:winMinimize', 'ltp:winToggleMaximize', 'ltp:winClose']
      .every((k) => mainJs.includes(k))
      ? ok('主进程含窗口控制与应用信息 IPC')
      : bad('主进程缺少新增 IPC 通道');
    /https?\|mailto/.test(mainJs) || mainJs.includes('mailto')
      ? ok('openExternal 带协议白名单')
      : bad('openExternal 未见协议白名单');
  } catch (e) { bad('读取 main.js', e.message); }

  try {
    const appJs = readAsarEntry(asar, ASAR, '/src/renderer/app.js').toString('utf8');
    ['renderAbout', 'bindContactRows', 'bindModalTabs', 'setWinMaxIcon']
      .every((k) => appJs.includes(k))
      ? ok('渲染层含关于页 / 联系方式 / 弹窗页签 / 窗口图标逻辑')
      : bad('渲染层缺少新增逻辑');
  } catch (e) { bad('读取 app.js', e.message); }

  try {
    const css = readAsarEntry(asar, ASAR, '/src/renderer/style.css').toString('utf8');
    /Source Han Sans SC/.test(css) && /woff2-variations/.test(css)
      ? ok('样式表已声明思源黑体 @font-face（woff2-variations）')
      : bad('样式表缺少思源黑体 @font-face');
  } catch (e) { bad('读取 style.css', e.message); }
}

console.log('\n[B] 协议层（extraResources）可加载性');
{
  const proto = path.join(UNPACKED, 'resources', 'shared', 'protocol.js');
  if (fs.existsSync(proto)) {
    ok('resources/shared/protocol.js 存在');
    try {
      /* eslint-disable global-require */
      const P = require(proto);
      const okExports = ['PROTOCOL_ID', 'makePairCode', 'encodeChunkFrame', 'decodeQrPayload', 'sanitizeRelPath']
        .every((k) => P[k] != null);
      okExports
        ? ok('协议层导出完整：' + P.PROTOCOL_ID + ' / 匹配码 ' + P.makePairCode().length + ' 位')
        : bad('协议层导出不完整');
    } catch (e) { bad('require 协议层', e.message); }
  } else {
    bad('resources/shared/protocol.js 缺失', '打包时 extraResources.from 路径不对');
  }
}

console.log('\n[C] 主程序');
{
  const exe = path.join(UNPACKED, '邻传.exe');
  fs.existsSync(exe)
    ? ok('邻传.exe 存在（' + Math.round(fs.statSync(exe).size / 1048576) + ' MB）')
    : bad('邻传.exe 缺失');

  const setup = path.join(ROOT, 'desktop', RELEASE, '邻传 Setup 1.0.0.exe');
  fs.existsSync(setup)
    ? ok('安装包 邻传 Setup 1.0.0.exe 存在（' + Math.round(fs.statSync(setup).size / 1048576) + ' MB）')
    : bad('安装包缺失');
}

console.log('\n══════════════════════════════');
console.log('  通过 ' + pass + ' · 失败 ' + fail);
console.log('══════════════════════════════\n');
process.exit(fail ? 1 : 0);
