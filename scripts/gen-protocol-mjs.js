/**
 * 由 shared/protocol.js（CommonJS，单一事实来源）生成浏览器 ESM 版本
 * shared/protocol.mjs。
 *
 * 为什么需要生成而不是手写第二份：
 *   - 两端必须严格共用同一份协议实现，手抄必然漂移。
 *   - 电脑端 33 个测试与全部主进程代码 require 的是 protocol.js，不能改动其形态。
 *
 * 转换动作（只做最小机械变换）：
 *   1) 'use strict' 前缀 → 去掉（ESM 天然严格模式）
 *   2) const crypto = require('crypto') 相关的 Node 分支 → 固定走「浏览器垫片」分支
 *   3) 末尾 module.exports = { ... }  → export { ... }
 *
 * 用法：node scripts/gen-protocol-mjs.js
 * 已接入 mobile 的 predev / prebuild（见 mobile/package.json）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'shared', 'protocol.js');
const OUT = path.join(ROOT, 'shared', 'protocol.mjs');

let code = fs.readFileSync(SRC, 'utf8');

// 1) 去掉 'use strict';
code = code.replace(/^'use strict';\s*\n/, '');

// 2) Node 分支 → 浏览器固定分支
//    把 IS_NODE 判定为固定 false：const IS_NODE = false;
code = code.replace(
  /const IS_NODE = typeof process !== 'undefined' && !!\(process\.versions && process\.versions\.node\);/,
  'const IS_NODE = false; // [生成] 浏览器版本固定为非 Node',
);

// 3) module.exports = { A, B }; → export { A, B };
const me = code.match(/module\.exports\s*=\s*\{([\s\S]*?)\};?\s*$/m);
if (!me) throw new Error('未在 protocol.js 末尾找到 module.exports');

const names = me[1]
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const exportBlock = `export {\n  ${names.join(',\n  ')},\n};\n\nexport default {\n  ${names.join(',\n  ')},\n};\n`;

code = code.replace(/module\.exports\s*=\s*\{[\s\S]*?\};?\s*$/m, exportBlock);

const banner = `/**
 * ⚠️ 自动生成文件，请勿手工编辑。
 * 源文件：shared/protocol.js
 * 生成命令：node scripts/gen-protocol-mjs.js
 * 用途：供手机端（浏览器 ESM / Vite）导入，与电脑端共用同一份协议实现。
 */

`;

fs.writeFileSync(OUT, banner + code, 'utf8');
console.log(`[gen-protocol-mjs] 已生成 ${path.relative(ROOT, OUT)}（${names.length} 个导出）`);
