'use strict';

/* Lightweight bilingual UI layer. The selected language is persisted locally so
 * the renderer and all dynamically inserted pages use the same language. */
(function () {
  // Light is the safer first-run default for a desktop productivity tool;
  // an explicit dark-mode choice is still preserved across launches.
  const savedTheme = localStorage.getItem('ltp.theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = savedTheme;
  const dict = {
    '确认操作': 'Confirm action', '解散后所有成员都会被移出群聊，且无法恢复。': 'Dissolving removes all members and cannot be undone.', '退出后将停止接收此群聊的新消息。': 'You will stop receiving new messages from this group.', '创建失败，请确认群聊端口可用': 'Could not create the group. Check that the group port is available.',
    '已允许局域网访问端口 53317、53318、53300': 'LAN access is allowed on ports 53317, 53318 and 53300',
    '新建群聊': 'Create group', '加入群聊': 'Join group', '创建一个局域网群聊，口令仅在同一网络中可用。': 'Create a group on your LAN. The invite code works only on the same network.', '输入群主分享的 6 位口令，自动查找局域网中的群主。': 'Enter the 6-digit code to find the host on your local network.', '群聊名称': 'Group name', '给群聊起个名字': 'Name this group', '6 位邀请口令': '6-digit invite code', '输入群主分享的 6 位数字': 'Enter the 6-digit code from the host', '创建群聊': 'Create group', '查找并加入': 'Find and join', '让对方在同一局域网内输入此口令加入': 'They can enter this code to join from the same LAN', '群聊已创建': 'Group created', '口令有效期 10 分钟 · 仅限同一局域网': 'Code expires in 10 minutes · same LAN only', '口令 10 分钟后失效': 'Code expires in 10 minutes', '口令还剩 ': 'Expires in ', ' 分钟 · 仅限同一局域网': ' min · same LAN only', '口令已过期 · 请刷新后继续': 'Code expired · refresh to continue', '刷新口令': 'Refresh code', '复制口令': 'Copy code', '群聊管理': 'Group management', '显示邀请口令': 'Show invite code', '刷新邀请口令': 'Refresh invite code', '移除成员': 'Remove member', '退出群聊': 'Leave group', '解散群聊': 'Dissolve group', '位成员 · 本机主持': 'members · hosted here', '位成员 · 群主主持': 'members · hosted by owner', '群聊口令已复制': 'Group code copied', '口令已刷新，旧口令失效': 'Code refreshed; the old code no longer works', '请输入完整的 6 位数字口令': 'Enter the full 6-digit code', '正在查找…': 'Searching…', '已加入群聊': 'Joined group', '口令无效或已过期，请确认双方在同一局域网并向群主索取新口令': 'Invalid or expired code. Make sure both devices are on the same LAN and ask the host for a new code',
    '邻传 · Nearby Transfer': 'Nearby Transfer', '邻传': 'Nearby Transfer', '连接': 'Connect', '发送': 'Send', '运行中': 'Running', '正在启动…': 'Starting…', '刷新': 'Refresh', '设置': 'Settings', '最小化': 'Minimize', '最大化': 'Maximize', '关闭': 'Close', '折叠侧栏': 'Collapse sidebar', '展开侧栏': 'Expand sidebar',
    '连接与设备': 'Connection & devices', '设备': 'Devices', '配对': 'Pairing', '传输中心': 'Transfer center', '传输': 'Transfers', '接收': 'Receive', '记录与管理': 'Records & management', '历史': 'History', '历史设备': 'Trusted devices', '软件': 'Software', '关于': 'About', '简单 · 安全 · 高效': 'Simple · Secure · Fast', '让文件在设备间自由流动': 'Move files freely between devices',
    '在线设备': 'Online devices', '发现同一 Wi-Fi 下的设备，自动扫描并显示可连接的设备。': 'Discover devices on the same Wi-Fi network.', '当前网络：': 'Current network:', '自动': 'Auto', '扫描网络': 'Scan network', '或指定网段 192.168.1.1-254': 'Or specify range 192.168.1.1-254', '扫描中…': 'Scanning…', '暂无发现在线设备': 'No online devices found', '请确保手机与电脑连接到同一 Wi-Fi 网络': 'Make sure your phone and computer use the same Wi-Fi network',
    '快速发送': 'Quick send', '发送文件': 'Send files', '拖拽文件到这里': 'Drop files here', '支持多个文件、文件夹和批量发送': 'Multiple files, folders and batch sending supported', '也可以使用下方的选择按钮': 'You can also use the buttons below', '点击此区域选择文件': 'Click this area to choose files', '拖拽文件或点击选择文件': 'Drop files or click to choose', '选择内容后，在下方选择目标设备即可发送，无需返回上方设备列表。': 'Choose content and a target below to send without returning to the device list.', '选择文件': 'Choose files', '选择文件夹': 'Choose folder', '粘贴内容': 'Paste content', '可在此输入要发送的文字内容...': 'Enter text to send here…', '发送文字': 'Send text', '尚未选择任何内容': 'No content selected', '全选': 'Select all', '取消勾选': 'Clear selection', '清空待发送': 'Clear queue', '发送到': 'Send to', '请先选择目标设备': 'Choose a target device first', '暂无在线设备，请先扫描': 'No online devices; scan first', '传输限制': 'Transfer limit', '不限制': 'No limit', '支持多设备同时传输 · 局域网内高速直连': 'Multiple devices · Fast LAN direct transfer',
    '扫码配对': 'QR pairing', '用手机端「扫一扫」对准二维码即可直接连接。': 'Scan this QR code with the phone to connect.', '二维码生成中…': 'Generating QR code…', '刷新二维码': 'Refresh QR code', '6 位匹配码': '6-digit pairing code', '手机端手动输入下方 6 位数字完成配对，5 分钟内有效。': 'Enter this 6-digit code on the phone. Valid for 5 minutes.', '生成新匹配码': 'Generate pairing code', '复制': 'Copy', '复制消息内容': 'Copy message', '消息内容已复制': 'Message copied', '本机 IP 地址': 'Local IP address', '复制 IP': 'Copy IP', '连接须知': 'Connection tips', '未配对设备会被直接拒绝连接，只有通过二维码或匹配码配对后的设备才能传输。': 'Unpaired devices are rejected. Pair with a QR code or pairing code before transferring.', '配对成功后电脑会下发长期令牌，手机端下次连接免配对。': 'After pairing, the computer issues a long-term token for future connections.', '所有数据仅在局域网内传输，不经过任何外网服务器。': 'All data stays on the local network and never uses an external server.', '当前传输链路未加密，请仅在可信的家庭或办公局域网中使用。': 'Transfers are not encrypted. Use only on a trusted home or office network.',
    '进行中': 'In progress', '实时进度、速度与剩余时间。': 'Live progress, speed and remaining time.', '当前没有进行中的传输。': 'No transfers in progress.', '接收文件': 'Receive files', '手机或其他设备发送到电脑的文件会在这里确认和查看。': 'Files sent to this computer appear here for confirmation and viewing.', '打开接收目录': 'Open receive folder', '暂无接收记录。收到文件时会弹出确认窗口。': 'No received files. A confirmation dialog will appear for new files.', '传输历史': 'Transfer history', '查看、定位或删除历史传输记录。': 'View, locate or delete transfer records.', '清空历史': 'Clear history', '打开保存目录': 'Open save folder', '暂无传输记录。': 'No transfer history.', '最近配对过的设备，可快捷发送；删除后需要重新配对。': 'Recently paired devices for quick sending. Removing one requires pairing again.', '还没有历史设备。': 'No trusted devices yet.',
    '可从 GitHub Releases 检查新版本': 'Check GitHub Releases for updates', '检查更新': 'Check for updates', '下载新版': 'Download update', '联系我们': 'Contact us', '使用中遇到问题，或想提建议，欢迎随时联系。': 'Questions or suggestions? Get in touch.', '作者': 'Author', '电子邮箱': 'Email', '官方网站': 'Official website', '点击邮箱或官网可直接唤起系统应用。': 'Click an email or website link to open it.', '版权信息': 'Copyright', '版权': 'Copyright', '界面字体：思源黑体（SIL Open Font License 1.1）': 'Interface font: Source Han Sans (SIL Open Font License 1.1)', '开源许可与运行环境。': 'License and runtime', '收到文件': 'Incoming files', '来自未知设备': 'From unknown device', '拒绝': 'Reject', '接收': 'Accept', '常规': 'General', '本机身份、接收目录与软件信息': 'Device identity, receive folder and app information', '设备名称': 'Device name', '接收文件保存目录': 'Receive folder', '更改…': 'Change…', '协议信息': 'Protocol', '局域网权限': 'LAN access', '正在检测防火墙权限…': 'Checking firewall access…', '自动配置': 'Configure automatically', '仅允许专用/域网络访问邻传端口 53317，不开放公网。': 'Allow port 53317 only on private/domain networks; never expose it publicly.', '关闭': 'Close', '保存': 'Save', '语言': 'Language', '简体中文': 'Simplified Chinese', 'English': 'English', '选择语言': 'Choose language', '连接与设备': 'Connection & devices', '传输中心': 'Transfer center', '记录与管理': 'Records & management', '软件': 'Software', '局域网高速互传': 'Fast LAN transfer', '网络扫描雷达': 'Network scan radar', '扫描待命': 'Scan ready', '正在扫描': 'Scanning', '正在并发探测…': 'Probing devices…', '扫描失败': 'Scan failed', '扫描完成：探测': 'Scan complete: probed', '个地址，发现在线设备': 'addresses, found', '台': 'device(s)', '已添加': 'Added', '项到发送队列': 'item(s) to the send queue', '已生成新的 6 位匹配码': 'New 6-digit pairing code generated', '本机 IP 已复制：': 'Local IP copied: ', '暂无可复制的本机 IP': 'No local IP to copy', '已生成新二维码': 'New QR code generated', '服务未启动': 'Service is not running', '选择发送目标': 'Choose a destination', '独立发送页面': 'Standalone send page', '拖入文件即可加入队列，选择目标设备后发送。': 'Drop files into the queue, choose a destination, then send.', '位匹配码': '6-digit pairing code', '含 IP、端口与临时令牌': 'Includes IP, port and temporary token', '有效期': 'Valid for', '分钟 · 令牌': 'minutes · token', '该匹配码已过期，请重新生成': 'This pairing code has expired. Generate a new one.', '剩余有效时间': 'Time remaining', '协议': 'Protocol', '版本': 'Version', '运行环境': 'Runtime', '系统': 'System', '局域网地址': 'LAN address', '设备 ID': 'Device ID', '设备指纹': 'Device fingerprint', '监听端口': 'Listening port', '启动时自动配置；如被系统拦截，请点击“自动配置”并允许管理员权限。': 'Configured at startup. If Windows blocks it, click “Configure automatically” and allow administrator access.', '正在请求 Windows 管理员权限…': 'Requesting Windows administrator permission…', '已允许局域网访问端口 53317': 'LAN access on port 53317 is allowed', '未完成配置，请在 Windows UAC 中允许操作后重试。': 'Configuration incomplete. Allow the Windows UAC request and try again.', '邻传 Nearby Transfer · 保留所有权利。': 'Nearby Transfer · All rights reserved.', '局域网文件互传 · 无需联网 · 数据不出内网': 'LAN file transfer · No internet required · Data stays local', '邻传是一款面向局域网的跨设备文件互传工具。所有文件仅在同一 Wi-Fi 下点对点直传，': 'Nearby Transfer sends files directly between devices on the same Wi-Fi network.', '不经过任何第三方服务器，也不上传云端；未配对的设备一律拒绝连接。': 'No third-party servers or cloud uploads; unpaired devices are always rejected.', '联系方式': 'Contact', '版权与运行环境': 'Copyright & runtime', '邻传': 'Nearby Transfer'
  };
  dict['更新由 Microsoft Store 管理'] = 'Updates are managed by the Microsoft Store';
  Object.assign(dict, {
    '手机端下载': 'Download for Android',
    'Android 应用下载二维码': 'QR code to download the Android app',
    'Android · Nearby Transfer': 'Android · Nearby Transfer',
    '在 Android 手机上安装邻传，通过局域网与电脑直接互传文件。': 'Install Nearby Transfer on your Android phone and transfer files directly with your PC over the local network.',
    '正在获取下载信息…': 'Loading download information…',
    '查看全部 Releases': 'View all releases',
    '正在连接 GitHub Releases…': 'Connecting to GitHub Releases…',
    '扫码下载 Android 版': 'Scan to get the Android app',
    '使用手机相机或浏览器扫码': 'Scan with your phone camera or browser',
    '同一局域网直连': 'Direct transfer over your local network',
    '手机和电脑连接到同一 Wi-Fi 后即可配对与传输。': 'Connect your phone and PC to the same Wi-Fi to pair and transfer files.',
    '从官方 Releases 获取': 'Get it from official Releases',
    '安装包由项目 GitHub Releases 提供；请仅安装来自官方发布页的版本。': 'The installer is provided by the project’s GitHub Releases. Only install versions from the official release page.',
    '最新版本': 'Latest version',
    '来源：GitHub Releases': 'Source: GitHub Releases',
    '暂未找到 APK 安装包，请打开 Releases 查看。': 'No APK installer was found. Open Releases to check.',
    '下载 Android APK': 'Download Android APK',
    '打开 GitHub Releases': 'Open GitHub Releases',
    '重试获取': 'Retry',
    '暂时无法获取下载信息，请稍后重试或查看 Releases。': 'Download information is unavailable. Try again later or view Releases.',
    '聊天': 'Chat', '会话': 'Conversations', '单聊': 'Direct chat', '群聊': 'Group chat', '在线设备': 'Online devices', '设置设备备注': 'Set device nickname', '管理群聊': 'Manage group',
    '还没有会话。在下方选择一个在线设备开始聊天。': 'No conversations yet. Choose an online device below to start chatting.',
    '选择一个会话': 'Select a conversation', '支持发送文字消息，也可以直接在对话里发送文件': 'Send text messages or files directly in the conversation',
    '松手即可发送文件': 'Release to send files', '备注': 'Nickname', '管理群聊': 'Manage group', '清空': 'Clear',
    '输入消息，按 Enter 发送…': 'Type a message and press Enter to send…', '新建单聊': 'New direct chat', '新建或加入群聊': 'Create or join a group',
    '选择在线设备发起会话': 'Choose an online device to start a conversation', '还没有消息，发送第一条吧': 'No messages yet. Send the first one.',
    '暂无消息': 'No messages', '我：': 'Me: ', '[文件]': '[File]', '手机': 'Phone', '电脑': 'Computer', '已连接': 'Connected', '未连接': 'Not connected',
    '离线 · 等待重连': 'Offline · reconnecting', '已连接 · 等待重连': 'Connected · waiting to reconnect', '当前没有在线设备': 'No online devices',
    '当前没有在线设备，请先在「连接」页扫描': 'No online devices. Scan from the Connect page first.', '已发送': 'Sent', '已送达': 'Delivered', '已读': 'Read',
    '未送达': 'Not delivered', '发送中': 'Sending', '发送失败': 'Failed to send', '文件': 'File', '个文件': ' file(s)', '已完成': 'Completed', '已中断': 'Interrupted',
    '打开': 'Open', '定位': 'Show in folder', '重发': 'Resend', '复制失败': 'Copy failed', '对方当前不在线，稍后再试': 'The other device is offline. Try again later.',
    '群主离线，消息未发送': 'The group host is offline. Message not sent.', '对方不在线，消息已保留为未送达': 'The other device is offline. The message was saved as not delivered.',
    '发送失败': 'Send failed', '发送文件': 'Send file', '对方不在线，无法发送文件': 'The other device is offline. File not sent.',
    '文件发送失败：': 'File send failed: ', '已在会话中发送 ': 'Sent ', ' 个文件': ' file(s) in the conversation', '文件读取失败': 'Could not read the file',
    '无法刷新口令': 'Could not refresh the code', '无法刷新口令': 'Could not refresh the code', '已清空当前会话': 'Conversation cleared',
    '为这台设备设置备注（留空恢复设备原名）': 'Set a nickname for this device (leave empty to restore its name)', '设备备注已保存': 'Device nickname saved',
    '已恢复设备原名': 'Original device name restored', '读取拖入文件失败，请重试或使用附件按钮选择文件': 'Could not read the dropped files. Try again or use the attachment button.',
    '群聊口令已复制': 'Group code copied', '口令已刷新，旧口令失效': 'Code refreshed; the old code no longer works',
    '界面主题': 'Appearance', '深色模式': 'Dark mode', '浅色模式': 'Light mode', '跟随系统': 'Follow system', '浅色模式已启用': 'Light mode enabled', '深色模式已启用': 'Dark mode enabled'
  });
  const replacements = Object.keys(dict).sort((a, b) => b.length - a.length);
  const state = { lang: localStorage.getItem('ltp.language') || 'zh-CN', theme: savedTheme };
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
    root.querySelectorAll('[placeholder],[title],[aria-label],[alt]').forEach((el) => ['placeholder', 'title', 'aria-label', 'alt'].forEach((attr) => { if (el.hasAttribute(attr)) el.setAttribute(attr, t(el.getAttribute(attr))); }));
  }
  function setLanguage(lang) { state.lang = lang === 'en-US' ? 'en-US' : 'zh-CN'; localStorage.setItem('ltp.language', state.lang); location.reload(); }
  function setTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    localStorage.setItem('ltp.theme', state.theme);
    document.documentElement.dataset.theme = state.theme;
  }
  window.LTP_I18N = { t, apply, setLanguage, getLanguage: () => state.lang, setTheme, getTheme: () => state.theme };
  function bindTopLanguage() {
    const control = document.getElementById('topLanguage');
    if (!control || control.dataset.bound === '1') return;
    control.dataset.bound = '1';
    control.textContent = state.lang === 'en-US' ? 'EN' : '中';
    control.title = state.lang === 'en-US' ? 'Switch to Chinese' : '切换到英文';
    control.addEventListener('click', () => setLanguage(state.lang === 'en-US' ? 'zh-CN' : 'en-US'));
  }
  document.addEventListener('DOMContentLoaded', () => {
    bindTopLanguage();
    apply(document.body);
    const observer = new MutationObserver((records) => records.forEach((record) => {
      record.addedNodes.forEach((node) => { if (node.nodeType === 1) apply(node); });
      if (record.type === 'characterData' && record.target.parentElement) apply(record.target.parentElement);
    }));
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  });
})();
