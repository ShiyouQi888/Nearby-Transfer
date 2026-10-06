/**
 * 图标系统（电脑端渲染进程）
 *
 * 用一套统一几何语言的内联 SVG 取代 emoji：
 *   - 统一线宽（1.6）、统一端点（round）、统一 24×24 视框
 *   - 颜色随 currentColor，自动适配深色主题与状态色
 *   - 无外部依赖、无字体、无网络请求，保证离线与 CSP 安全
 *
 * 用法：el.innerHTML = icon('device')  /  icon('file', 'pdf')
 */
(function () {
  'use strict';

  // SVG 包装：统一视框与描边属性
  const SVG = (inner, opts = {}) => {
    const size = opts.size || 24;
    const sw = opts.sw || 1.6;
    return `<svg class="ic ${opts.cls || ''}" viewBox="0 0 24 24" width="${size}" height="${size}"
      fill="none" stroke="currentColor" stroke-width="${sw}"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  };

  // ── 基础图形库 ──────────────────────────────────────────
  const P = {
    // 设备 / 导航
    desktop: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>',
    mobile: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    link: '<path d="M10 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 1 0-5-5L11 7.5"/><path d="M14 10.5a3.5 3.5 0 0 0-5 0L6.5 13a3.5 3.5 0 1 0 5 5l1.5-1.5"/>',
    transfer: '<path d="M7 4v13m0 0-3-3m3 3 3-3"/><path d="M17 20V7m0 0-3 3m3-3 3 3"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v3.5H7"/><path d="M12 8v4.5l3 1.8"/>',
    shield: '<path d="M12 3 5 5.6v5.2c0 4.3 2.9 7.9 7 9.2 4.1-1.3 7-4.9 7-9.2V5.6z"/><path d="m9.2 12 2 2 3.6-3.8"/>',
    // 动作
    refresh: '<path d="M20 11a8 8 0 0 0-13.7-5.3L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 13.7 5.3L20 16"/><path d="M20 20v-4h-4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/>',
    scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
    folderOpen: '<path d="M3 7.5a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v1H6.4a2 2 0 0 0-1.9 1.4L3 16.5z"/><path d="M3 16.5 4.7 12a2 2 0 0 1 1.9-1.4H22l-2.1 6.5a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
    download: '<path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
    upload: '<path d="M12 20V8m0 0-4.5 4.5M12 8l4.5 4.5"/><path d="M4.5 4.5h15"/>',
    send: '<path d="M20 4 3.5 10.5l6.5 2.2L12.2 20z"/><path d="M20 4 10 12.7"/>',
    arrowUp: '<path d="M12 19V5m0 0-5.5 5.5M12 5l5.5 5.5"/>',
    arrowDown: '<path d="M12 5v14m0 0-5.5-5.5M12 19l5.5-5.5"/>',
    arrowRight: '<path d="M5 12h14m0 0-6-6m6 6-6 6"/>',
    wifi: '<path d="M2.5 8.5a14 14 0 0 1 19 0"/><path d="M5.5 11.8a9.5 9.5 0 0 1 13 0"/><path d="M8.6 15a5 5 0 0 1 6.8 0"/><circle cx="12" cy="18.5" r="1"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5 3.2 3.2 3-3L20 17"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9.5 5 2.5-5 2.5z"/>',
    music: '<path d="M9 18V6l9-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="15.5" cy="16" r="2.5"/>',
    zip: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 3v3.5M13 6.5v3.5M11 10v3.5M13 13.5V17"/><rect x="10.6" y="16.4" width="2.8" height="2.8" rx=".6"/>',
    pdf: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><path d="M8.5 17v-3h1.2a1 1 0 0 1 0 2H8.5m3.8 1v-3h1.1a1.5 1.5 0 0 1 0 3zm3.4 0v-3h1.6m-1.6 1.5h1.3"/>',
    doc: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><path d="M8.5 13h4M8.5 16.5h6"/>',
    sheet: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><path d="M8.5 13.5h7M8.5 17h7M11.5 13.5V17"/>',
    slides: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><rect x="8.5" y="13" width="7" height="4.5" rx="1"/>',
    package: '<path d="m12 2.8 8 4.2v10l-8 4.2-8-4.2v-10z"/><path d="M4 7 12 11.2 20 7M12 11.2V21"/>',
    key: '<circle cx="8" cy="15.5" r="3.5"/><path d="m10.5 13 7.5-7.5M15 8.5l2 2M17.5 6l2 2"/>',
    qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2"/><path d="M14 14h2.5v2.5M20.5 14v2.5M14 20.5h2.5M20.5 17.5v3M17.5 17.5h3"/>',
    trash: '<path d="M4.5 6.5h15M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5M6.5 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12.5"/>',
    inbox: '<path d="M3.5 13.5 6 5.5a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 5.5l2.5 8v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5h4l1.5 2.5h6l1.5-2.5h4"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    sparkle: '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18.2l-1.8-5.6L4.7 10.8 10.2 9z"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 9.5v4.5M12 17v.4"/>',
    chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
    // 设计稿补充
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.4 15.4 4.1 4.1"/>',
    folderPlus: '<path d="M3 7.5a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11.5v5M9.5 14h5"/>',
    clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3.5A1.5 1.5 0 0 1 10.5 2h3A1.5 1.5 0 0 1 15 3.5v1"/><path d="M9 11h6M9 15h4"/>',
    edit: '<path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5z"/><path d="M14.5 6.5 17.5 9.5"/>',
    bars: '<path d="M4.5 7h9M4.5 12h15M4.5 17h6"/><circle cx="16.5" cy="7" r="1.6"/><circle cx="13.5" cy="17" r="1.6"/>',
    bolt: '<path d="M13.5 2.5 5 13.5h5.5L10 21.5l8.5-11H13z"/>',
    radar: '<circle cx="12" cy="12" r="3"/><path d="M12 9V3.5M12 20.5V15M15 12h5.5M3.5 12H9"/><path d="M12 12l6-4.5"/><circle cx="12" cy="12" r="8.5"/>',
    // 品牌标识：双气泡（大泡 + 小泡错位，模拟双向传输）
    brand: '<rect x="2.6" y="3.2" width="13.4" height="11" rx="3.6"/><path d="M6.4 14.2v3.1l3.4-3.1"/><rect x="11.4" y="10.4" width="10" height="8.2" rx="3"/><path d="M18.4 18.6v2.6l2.4-2.6"/>',
    // 窗口控制（自绘标题栏）：几何与系统惯例对齐，线宽沿用 1.6
    winMin: '<path d="M6 12h12"/>',
    winMax: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    winRestore: '<rect x="8.5" y="4.5" width="11" height="11" rx="2"/><path d="M15.5 15.5v2a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2"/>',
    winClose: '<path d="m7 7 10 10M17 7 7 17"/>',
  };

  // 文件类型 → 图标 + 语义色
  const EXT_ICON = {
    image: { d: 'image', tone: 'image' },
    video: { d: 'video', tone: 'video' },
    audio: { d: 'music', tone: 'audio' },
    zip: { d: 'zip', tone: 'zip' },
    pdf: { d: 'pdf', tone: 'pdf' },
    doc: { d: 'doc', tone: 'doc' },
    sheet: { d: 'sheet', tone: 'sheet' },
    slides: { d: 'slides', tone: 'slides' },
    package: { d: 'package', tone: 'pkg' },
    text: { d: 'file', tone: 'text' },
  };

  const EXT_MAP = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', heic: 'image', svg: 'image',
    mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', flv: 'video', wmv: 'video', m4v: 'video',
    mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', m4a: 'audio', ogg: 'audio',
    zip: 'zip', rar: 'zip', '7z': 'zip', tar: 'zip', gz: 'zip',
    pdf: 'pdf',
    doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc',
    xls: 'sheet', xlsx: 'sheet', csv: 'sheet',
    ppt: 'slides', pptx: 'slides',
    apk: 'package', aab: 'package', ipa: 'package', exe: 'package', msi: 'package',
    txt: 'text', md: 'text', json: 'text', log: 'text',
  };

  function icon(name, opts) {
    const d = P[name];
    if (!d) return SVG(P.file, opts || {});
    return SVG(d, opts || {});
  }

  /**
   * 文件的图标标签（含语义色底）
   * @param {string} fileName
   * @param {object} [opts] { size }
   */
  function fileIcon(fileName, opts = {}) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    const kind = EXT_MAP[ext] || 'text';
    const meta = EXT_ICON[kind];
    const size = opts.size || 24;
    const inner = P[meta.d] || P.file;
    return `<span class="fi fi-${meta.tone}" style="--fi-size:${size}px">${SVG(inner, { size: Math.round(size * 0.58), sw: 1.7 })}</span>`;
  }

  /**
   * 场景插画（横幅/装饰用，非图标）
   * 设计稿要求：hero 区一台笔记本 + 一部手机 + 波纹信号；
   * 侧栏底部为绿色重叠圆斑装饰。
   * @param {string} name  devices | blob
   */
  function illust(name) {
    if (name === 'devices') return ILLUST_DEVICES;
    if (name === 'blob') return ILLUST_BLOB;
    return '';
  }

  // 在线设备插画：笔记本 + 手机 + 信号弧（对齐设计稿）
  const ILLUST_DEVICES = `
<svg class="illus" viewBox="0 0 420 190" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="il-g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#24e39a"/>
      <stop offset="1" stop-color="#00c47a"/>
    </linearGradient>
    <radialGradient id="il-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#00d283" stop-opacity=".16"/>
      <stop offset="1" stop-color="#00d283" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <ellipse cx="210" cy="172" rx="168" ry="16" fill="url(#il-glow)"/>

  <!-- 笔记本 -->
  <g>
    <rect x="96" y="58" width="150" height="96" rx="8" fill="#1a2226" stroke="#39474b" stroke-width="1.6"/>
    <rect x="104" y="66" width="134" height="80" rx="4" fill="#12201c"/>
    <!-- 屏幕内容：品牌气泡 + 进度条 -->
    <g transform="translate(152,86)">
      <rect x="0" y="0" width="16" height="13" rx="4" fill="none" stroke="url(#il-g)" stroke-width="1.8"/>
      <path d="M5 13v3l3-3" stroke="url(#il-g)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <rect x="20" y="3" width="12" height="10" rx="3" fill="none" stroke="url(#il-g)" stroke-width="1.6" opacity=".8"/>
    </g>
    <rect x="126" y="110" width="52" height="6" rx="3" fill="#2a383c"/>
    <rect x="126" y="110" width="34" height="6" rx="3" fill="url(#il-g)"/>
    <rect x="126" y="124" width="76" height="6" rx="3" fill="#2a383c"/>
    <!-- 底座 -->
    <path d="M78 160h188a8 8 0 0 0-8-6H86a8 8 0 0 0-8 6z" fill="#283336" stroke="#39474b" stroke-width="1.4"/>
  </g>

  <!-- 信号弧（笔记本与手机之间） -->
  <g stroke="url(#il-g)" stroke-width="1.9" stroke-linecap="round" fill="none" opacity=".9">
    <path d="M258 74a20 20 0 0 1 10 17"/>
    <path d="M270 62a32 32 0 0 1 16 26"/>
  </g>
  <circle cx="252" cy="98" r="3.4" fill="url(#il-g)"/>

  <!-- 手机 -->
  <g>
    <rect x="286" y="52" width="66" height="112" rx="12" fill="#1a2226" stroke="#39474b" stroke-width="1.6"/>
    <rect x="293" y="60" width="52" height="96" rx="7" fill="#12201c"/>
    <g transform="translate(310,84)">
      <rect x="0" y="0" width="15" height="12" rx="3.6" fill="none" stroke="url(#il-g)" stroke-width="1.7"/>
      <path d="M4.5 12v2.8l2.8-2.8" stroke="url(#il-g)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <rect x="18.5" y="3" width="11" height="9" rx="2.8" fill="none" stroke="url(#il-g)" stroke-width="1.5" opacity=".8"/>
    </g>
    <rect x="302" y="112" width="34" height="5" rx="2.5" fill="#2a383c"/>
    <rect x="302" y="112" width="22" height="5" rx="2.5" fill="url(#il-g)"/>
    <rect x="302" y="124" width="28" height="5" rx="2.5" fill="#2a383c"/>
    <rect x="302" y="140" width="34" height="9" rx="4.5" fill="#00d283" opacity=".26"/>
    <circle cx="319" cy="166" r="3" fill="#39474b"/>
  </g>
</svg>`;

  // 侧栏装饰：重叠圆斑（大块墨绿 + 翡翠绿渐变）
  const ILLUST_BLOB = `
<svg class="illus" viewBox="0 0 300 240" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="bl-a" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#0f5f42"/>
      <stop offset="1" stop-color="#00d283"/>
    </linearGradient>
    <linearGradient id="bl-b" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#11694a"/>
      <stop offset="1" stop-color="#1fd693"/>
    </linearGradient>
    <linearGradient id="bl-c" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d4a34"/>
      <stop offset="1" stop-color="#0a6d4b"/>
    </linearGradient>
  </defs>
  <circle cx="52" cy="182" r="96" fill="url(#bl-c)" opacity=".55"/>
  <circle cx="120" cy="150" r="78" fill="url(#bl-a)" opacity=".5"/>
  <circle cx="196" cy="118" r="58" fill="url(#bl-b)" opacity=".38"/>
</svg>`;

  window.Icons = { icon, fileIcon, illust, names: Object.keys(P) };
})();
