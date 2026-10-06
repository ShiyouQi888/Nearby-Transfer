'use strict';

/* Lightweight bilingual UI layer. The selected language is persisted locally so
 * the renderer and all dynamically inserted pages use the same language. */
(function () {
  const dict = {
    '邻传 · Nearby Transfer': 'Nearby Transfer', '运行中': 'Running', '正在启动…': 'Starting…', '刷新': 'Refresh', '设置': 'Settings', '最小化': 'Minimize', '最大化': 'Maximize', '关闭': 'Close',
    '连接与设备': 'Connection & devices', '设备': 'Devices', '配对': 'Pairing', '传输中心': 'Transfer center', '传输': 'Transfers', '接收': 'Receive', '记录与管理': 'Records & management', '历史': 'History', '历史设备': 'Trusted devices', '软件': 'Software', '关于': 'About', '简单 · 安全 · 高效': 'Simple · Secure · Fast', '让文件在设备间自由流动': 'Move files freely between devices',
    '在线设备': 'Online devices', '发现同一 Wi-Fi 下的设备，自动扫描并显示可连接的设备。': 'Discover devices on the same Wi-Fi network.', '当前网络：': 'Current network:', '自动': 'Auto', '扫描网络': 'Scan network', '或指定网段 192.168.1.1-254': 'Or specify range 192.168.1.1-254', '扫描中…': 'Scanning…', '暂无发现在线设备': 'No online devices found', '请确保手机与电脑连接到同一 Wi-Fi 网络': 'Make sure your phone and computer use the same Wi-Fi network',
    '快速发送': 'Quick send', '选择内容后，在下方选择目标设备即可发送，无需返回上方设备列表。': 'Choose content and a target below to send without returning to the device list.', '选择文件': 'Choose files', '选择文件夹': 'Choose folder', '粘贴内容': 'Paste content', '可在此输入要发送的文字内容...': 'Enter text to send here…', '发送文字': 'Send text', '尚未选择任何内容': 'No content selected', '全选': 'Select all', '取消勾选': 'Clear selection', '清空待发送': 'Clear queue', '发送到': 'Send to', '请先选择目标设备': 'Choose a target device first', '暂无在线设备，请先扫描': 'No online devices; scan first', '发送': 'Send', '传输限制': 'Transfer limit', '不限制': 'No limit', '支持多设备同时传输 · 局域网内高速直连': 'Multiple devices · Fast LAN direct transfer',
    '扫码配对': 'QR pairing', '用手机端「扫一扫」对准二维码即可直接连接。': 'Scan this QR code with the phone to connect.', '二维码生成中…': 'Generating QR code…', '刷新二维码': 'Refresh QR code', '6 位匹配码': '6-digit pairing code', '手机端手动输入下方 6 位数字完成配对，5 分钟内有效。': 'Enter this 6-digit code on the phone. Valid for 5 minutes.', '生成新匹配码': 'Generate pairing code', '复制': 'Copy', '连接须知': 'Connection tips', '未配对设备会被直接拒绝连接，只有通过二维码或匹配码配对后的设备才能传输。': 'Unpaired devices are rejected. Pair with a QR code or pairing code before transferring.', '配对成功后电脑会下发长期令牌，手机端下次连接免配对。': 'After pairing, the computer issues a long-term token for future connections.', '所有数据仅在局域网内传输，不经过任何外网服务器。': 'All data stays on the local network and never uses an external server.',
    '进行中': 'In progress', '实时进度、速度与剩余时间。': 'Live progress, speed and remaining time.', '当前没有进行中的传输。': 'No transfers in progress.', '接收文件': 'Receive files', '手机或其他设备发送到电脑的文件会在这里确认和查看。': 'Files sent to this computer appear here for confirmation and viewing.', '打开接收目录': 'Open receive folder', '暂无接收记录。收到文件时会弹出确认窗口。': 'No received files. A confirmation dialog will appear for new files.', '传输历史': 'Transfer history', '查看、定位或删除历史传输记录。': 'View, locate or delete transfer records.', '清空历史': 'Clear history', '打开保存目录': 'Open save folder', '暂无传输记录。': 'No transfer history.', '最近配对过的设备，可快捷发送；删除后需要重新配对。': 'Recently paired devices for quick sending. Removing one requires pairing again.', '还没有历史设备。': 'No trusted devices yet.',
    '可从 GitHub Releases 检查新版本': 'Check GitHub Releases for updates', '检查更新': 'Check for updates', '下载新版': 'Download update', '联系我们': 'Contact us', '使用中遇到问题，或想提建议，欢迎随时联系。': 'Questions or suggestions? Get in touch.', '作者': 'Author', '电子邮箱': 'Email', '官方网站': 'Website', '点击邮箱或官网可直接唤起系统应用。': 'Click email or website to open the system app.', '版权信息': 'Copyright', '开源许可与运行环境。': 'License and runtime information.', '收到文件': 'Incoming files', '来自未知设备': 'From unknown device', '拒绝': 'Reject', '接收': 'Accept', '常规': 'General', '本机身份、接收目录与软件信息': 'Device identity, receive folder and software information', '设备名称': 'Device name', '接收文件保存目录': 'Receive folder', '更改…': 'Change…', '协议信息': 'Protocol', '局域网权限': 'LAN permission', '正在检测防火墙权限…': 'Checking firewall permission…', '自动配置': 'Configure automatically', '仅允许专用/域网络访问邻传端口 53317，不开放公网。': 'Only private/domain networks can access port 53317; public access is blocked.', '关闭': 'Close', '保存': 'Save', '语言': 'Language', '简体中文': 'Simplified Chinese', 'English': 'English'
  };
  const replacements = Object.keys(dict).sort((a, b) => b.length - a.length);
  const state = { lang: localStorage.getItem('ltp.language') || 'zh-CN' };
  function t(value) {
    if (state.lang !== 'en-US' || value == null) return value;
    let out = String(value);
    replacements.forEach((key) => { out = out.split(key).join(dict[key]); });
    return out;
  }
  function apply(root) {
    if (state.lang !== 'en-US' || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; let node;
    while ((node = walker.nextNode())) if (node.parentElement && !['SCRIPT', 'STYLE'].includes(node.parentElement.tagName)) nodes.push(node);
    nodes.forEach((n) => { const next = t(n.nodeValue); if (next !== n.nodeValue) n.nodeValue = next; });
    root.querySelectorAll('[placeholder],[title],[aria-label]').forEach((el) => ['placeholder', 'title', 'aria-label'].forEach((attr) => { if (el.hasAttribute(attr)) el.setAttribute(attr, t(el.getAttribute(attr))); }));
  }
  function setLanguage(lang) { state.lang = lang === 'en-US' ? 'en-US' : 'zh-CN'; localStorage.setItem('ltp.language', state.lang); location.reload(); }
  window.LTP_I18N = { t, apply, setLanguage, getLanguage: () => state.lang };
  document.addEventListener('DOMContentLoaded', () => {
    apply(document.body);
    const observer = new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => { if (node.nodeType === 1) apply(node); })));
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
