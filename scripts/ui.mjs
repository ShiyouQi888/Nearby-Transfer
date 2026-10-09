// 安卓模拟器 UI 驱动小工具：基于 uiautomator 层级 dump 精确点击/输入，
// 不再依赖手算截图缩放比例（那条路已经错过两次）。
//
// 用法：
//   node scripts/ui.mjs dump                      列出当前页所有可点元素的中心坐标
//   node scripts/ui.mjs tap "聊天"                 按文本精确点击
//   node scripts/ui.mjs tap "聊天" --index 1       文本重复时取第 index 个
//   node scripts/ui.mjs type "10.0.2.2"           向当前焦点输入（自动做 adb input text 转义）
//   node scripts/ui.mjs shot _shots/x.png          截图
//   node scripts/ui.mjs key back|esc|enter         发送按键
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 沙箱环境下 Node spawnSync 直接起 adb.exe 会报 EBUSY，
// 走 sh 包装脚本（scripts/_adbwrap.sh）让 shell 负责进程创建，稳定通过。
const ADB = process.env.ADB || new URL('./_adbwrap.sh', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
/** 设备上用于中转层级 dump 的文件。 */
const UI_XML = '/sdcard/ui.xml';

function adb(args, opts = {}) {
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: opts.encoding === null ? null : 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function dumpTree() {
  adb(['shell', 'uiautomator', 'dump', UI_XML]);
  return adb(['exec-out', 'cat', UI_XML], { encoding: 'utf8' });
}

function parseNodes(xml) {
  const nodes = [];
  for (const m of xml.matchAll(/<node[^>]*>/g)) {
    const tag = m[0];
    const text = (tag.match(/text="([^"]*)"/) || [, ''])[1];
    const desc = (tag.match(/content-desc="([^"]*)"/) || [, ''])[1];
    const bounds = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    const clickable = /clickable="true"/.test(tag);
    nodes.push({ text, desc, x1, y1, x2, y2, cx: (x1 + x2) >> 1, cy: (y1 + y2) >> 1, clickable });
  }
  return nodes;
}

function findNodes(nodes, needle) {
  const n = needle.trim();
  return nodes.filter((x) => (x.text && x.text.includes(n)) || (x.desc && x.desc.includes(n)));
}

const [cmd, ...rest] = process.argv.slice(2);
const flagIndex = rest.indexOf('--index');
const index = flagIndex >= 0 ? Number(rest[flagIndex + 1]) : 0;
const positional = rest.filter((_, i) => i !== flagIndex && i !== flagIndex + 1);
const arg = positional.join(' ');

function tapAt(x, y) {
  adb(['shell', 'input', 'tap', String(x), String(y)]);
}

switch (cmd) {
  case 'dump': {
    const nodes = parseNodes(dumpTree());
    for (const n of nodes) {
      const label = (n.text || n.desc || '').replace(/\n/g, '⏎');
      if (!label.trim()) continue;
      console.log(`${label.slice(0, 30).padEnd(32)} cx=${String(n.cx).padStart(5)} cy=${String(n.cy).padStart(5)} clickable=${n.clickable}`);
    }
    break;
  }
  case 'tap': {
    let nodes = parseNodes(dumpTree());
    let hits = findNodes(nodes, arg);
    if (!hits.length) { console.error(`未找到文本「${arg}」`); process.exit(2); }
    // 优先点可点击的祖先：命中节点里挑 clickable 的，没有就点自己。
    const clickable = hits.filter((h) => h.clickable);
    const target = (clickable.length ? clickable : hits)[index] || hits[index];
    if (!target) { console.error(`索引 ${index} 越界，共 ${hits.length} 个匹配`); process.exit(2); }
    tapAt(target.cx, target.cy);
    console.log(`TAP "${arg}" -> (${target.cx}, ${target.cy})`);
    break;
  }
  case 'type': {
    // adb input text 对空格和特殊字符敏感：空格要换成 %s，其余转义。
    const escaped = arg.replace(/([\\()<>|;&*~`"'$!#\[\]{}])/g, '\\$1').replace(/ /g, '%s');
    adb(['shell', 'input', 'text', escaped]);
    console.log(`TYPE "${arg}"`);
    break;
  }
  case 'key': {
    const map = { back: 4, home: 3, enter: 66, esc: 111, del: 67, tab: 61 };
    adb(['shell', 'input', 'keyevent', String(map[arg] ?? arg)]);
    console.log(`KEY ${arg}`);
    break;
  }
  case 'shot': {
    const buf = adb(['exec-out', 'screencap', '-p'], { encoding: null });
    writeFileSync(arg, buf);
    console.log(`SHOT ${arg}`);
    break;
  }
  default:
    console.error('未知命令。可用：dump | tap <文本> | type <文本> | key <键> | shot <路径>');
    process.exit(1);
}
