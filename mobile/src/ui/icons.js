/**
 * 图标系统（手机端）
 *
 * 与电脑端共用同一套图标几何语言（1.7px 描边、round 端点、24×24 视框），
 * 保证两端视觉一致。以 currentColor 着色，随主题自动适配。
 *
 * 手机端文件更小，这里用 ES 模块导出，供 app.js 直接 import。
 */

const SVG = (inner, size = 24, sw = 1.7) =>
  `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${inner}</svg>`;

export const PATHS = {
  mobile: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  desktop: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>',
  wifi: '<path d="M2.5 8.5a14 14 0 0 1 19 0"/><path d="M5.5 11.8a9.5 9.5 0 0 1 13 0"/><path d="M8.6 15a5 5 0 0 1 6.8 0"/><circle cx="12" cy="18.5" r="1"/>',
  qrScan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>',
  key: '<circle cx="8" cy="15.5" r="3.5"/><path d="m10.5 13 7.5-7.5M15 8.5l2 2M17.5 6l2 2"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5C9.8 18.1 8.7 15.2 8.7 12S9.8 5.9 12 3.5z"/>',
  radar: '<path d="M12 12 5.5 5.5"/><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/><path d="M12 7.2a4.8 4.8 0 1 0 4.8 4.8"/><circle cx="12" cy="12" r="1.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/>',
  send: '<path d="M20 4 3.5 10.5l6.5 2.2L12.2 20z"/><path d="M20 4 10 12.7"/>',
  arrowUp: '<path d="M12 19V5m0 0-5.5 5.5M12 5l5.5 5.5"/>',
  arrowDown: '<path d="M12 5v14m0 0-5.5-5.5M12 19l5.5-5.5"/>',
  inbox: '<path d="M3.5 13.5 6 5.5a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 5.5l2.5 8v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5h4l1.5 2.5h6l1.5-2.5h4"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5 3.2 3.2 3-3L20 17"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9.5 5 2.5-5 2.5z"/>',
  doc: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><path d="M8.5 13h4M8.5 16.5h6"/>',
  clip: '<path d="M20 11.5 12.3 19a4.5 4.5 0 0 1-6.4-6.4l7.6-7.6a3 3 0 0 1 4.3 4.3l-7.6 7.6a1.5 1.5 0 0 1-2.1-2.1l7-7"/>',
  file: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/>',
  folderOpen: '<path d="M3 7.5a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v1H6.4a2 2 0 0 0-1.9 1.4L3 16.5z"/><path d="M3 16.5 4.7 12a2 2 0 0 1 1.9-1.4H22l-2.1 6.5a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2z"/>',
  music: '<path d="M9 18V6l9-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="15.5" cy="16" r="2.5"/>',
  zip: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 3v3.5M13 6.5v3.5M11 10v3.5M13 13.5V17"/>',
  pdf: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/>',
  sheet: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><path d="M8.5 13.5h7M8.5 17h7"/>',
  slides: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/>',
  package: '<path d="m12 2.8 8 4.2v10l-8 4.2-8-4.2v-10z"/><path d="M4 7 12 11.2 20 7M12 11.2V21"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  transfer: '<path d="M7 4v13m0 0-3-3m3 3 3-3"/><path d="M17 20V7m0 0-3 3m3-3 3 3"/>',
  arrowRight: '<path d="M5 12h14m0 0-6-6m6 6-6 6"/>',
  download: '<path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v3.5H7"/><path d="M12 8v4.5l3 1.8"/>',
  shield: '<path d="M12 3 5 5.6v5.2c0 4.3 2.9 7.9 7 9.2 4.1-1.3 7-4.9 7-9.2V5.6z"/><path d="m9.2 12 2 2 3.6-3.8"/>',
  chat: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.7L3.5 21l1.3-4.7A8.5 8.5 0 1 1 20.5 12z"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v4.6M12 16.1v.1"/>',
  dots: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 4.5V10H15"/>',
};

export function icon(name, size = 24, sw = 1.7) {
  const d = PATHS[name] || PATHS.file;
  return SVG(d, size, sw);
}

/** 文件类型 → 语义图标 + 色相 */
const EXT_MAP = {
  jpg: ['image', 'image'], jpeg: ['image', 'image'], png: ['image', 'image'], gif: ['image', 'image'],
  webp: ['image', 'image'], bmp: ['image', 'image'], heic: ['image', 'image'], svg: ['image', 'image'],
  mp4: ['video', 'video'], mov: ['video', 'video'], avi: ['video', 'video'], mkv: ['video', 'video'],
  webm: ['video', 'video'], '3gp': ['video', 'video'],
  mp3: ['music', 'audio'], wav: ['music', 'audio'], m4a: ['music', 'audio'], flac: ['music', 'audio'],
  zip: ['zip', 'zip'], rar: ['zip', 'zip'], '7z': ['zip', 'zip'],
  pdf: ['pdf', 'pdf'],
  doc: ['doc', 'doc'], docx: ['doc', 'doc'], rtf: ['doc', 'doc'],
  xls: ['sheet', 'sheet'], xlsx: ['sheet', 'sheet'], csv: ['sheet', 'sheet'],
  ppt: ['slides', 'slides'], pptx: ['slides', 'slides'],
  apk: ['package', 'pkg'], aab: ['package', 'pkg'], ipa: ['package', 'pkg'],
  txt: ['file', 'text'], md: ['file', 'text'], json: ['file', 'text'],
};

/** 生成带语义色底的图标标签 */
export function fileIcon(name, size = 30) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const [d, tone] = EXT_MAP[ext] || ['file', 'text'];
  return `<span class="fi fi-${tone}" style="--fi-size:${size}px">${icon(d, Math.round(size * 0.56), 1.75)}</span>`;
}
