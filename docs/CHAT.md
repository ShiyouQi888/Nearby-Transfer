# 局域网聊天（Chat over LTP/1）技术调研与设计

> 目标：在现有「邻传 Nearby Transfer」的局域网互传能力之上，增加**聊天对话式**的交互：
> 文本消息 + 以「聊天气泡」形式发送文件，双向、实时、可追溯。
> 本文先做技术点与难点调研，再给出落地设计（协议扩展 / 两端实现）。

---

## 1. 结论先行

| 结论 | 说明 |
|---|---|
| **不要新开一条传输链路** | 复用现有 TCP 会话（+ WebSocket 降级网关）。聊天与文件传输跑在**同一条已配对连接**上，白拿「配对鉴权、NAT 穿透无关、局域网隔离」三件套。 |
| **文本消息 = 一条 NDJSON 消息** | 新增 `chat_send`（正文）+ `chat_ack`（回执）。纯文本走 JSON 行，无需二进制帧。 |
| **文件消息 = 复用 `send_offer` 状态机** | 关键取巧点：`send_offer` 已支持 `files[]` 批量 + 分片 + 断点续传；聊天里的「发文件」本质就是**带 `chatId` 的 `send_offer`**，无需重写传输层。 |
| **最大难点不是传输，而是「会话模型」** | 现有代码只有「一次性的 transfer 记录」，没有「持久化会话 + 消息时间线 + 顺序/去重/已读」这套模型。这是本次真正要新建的东西。 |
| **收件人确认策略要改** | 现有 `send_offer` **强制用户点确认**才接收（协议 §6.2）。聊天语境下每次收文件都弹窗会毁掉体验 —— 但直接静默落盘又违背「安全与交互」的原始约束。折中方案见 §5。 |

---

## 2. 现有能力盘点（可直接复用的部分）

### 2.1 传输层

| 能力 | 位置 | 聊天能否复用 |
|---|---|---|
| TCP 长连接 + NDJSON 解码器（文本/二进制同流复用） | `shared/protocol.js` `NdjsonDecoder`、`server.js` `Session` | ✅ 完全复用 |
| WebSocket 网关（浏览器/WebView 降级） | `server.js` `listenHttp` / `setupWebSocket` / `WsSession` | ✅ 完全复用 |
| 配对鉴权（6 位码 / 二维码 / 长期令牌 HMAC） | `protocol.js` `signToken`/`verifyToken`，`server.js` `_onHello` | ✅ 聊天天然要求「已配对」，正好拿来做准入 |
| 分片 + 二进制帧 `LTPC` | `protocol.js` `encodeChunkFrame` | ✅ 文件消息复用 |
| 断点续传（`.lpart` + `resumeToken`） | `transfer.js` `FileReceiver` | ✅ 文件消息复用 |
| 进度 / 速度 / ETA | `SpeedMeter`，`transfer.js` 的 `progress` 事件 | ✅ 内联到文件气泡 |

### 2.2 现有状态机（关键）

```
发送方                         接收方
  │  send_offer        ──────▶
  │                            用户确认（弹窗）
  │  ◀──────  send_accept / send_reject
  │  chunk (二进制)     ──────▶  写 .lpart
  │  ◀──────  chunk_ack / progress
  │  complete          ──────▶  rename
```

聊天里「发文件」= 上面这段 + 一个 `chatId` 关联到会话时间线。
**不需要**改动分片逻辑，只需要：
1. `send_offer` 增加可选字段 `chatId`、`origin: 'chat'`；
2. 接收完成后把文件消息回写到聊天时间线（而不是只写 transfer 历史）。

### 2.3 现有数据落地

- 电脑端：`%APPDATA%/ltp/config.json`（`STORE.trusted` / `STORE.history`），`saveStore()` 原子写。
- 手机端：`loadTrusted/saveTrusted`（localStorage），落盘由 `storage.js` 的 `storageFactory` 负责。

**聊天需要新增**：`chats.json`（会话索引）+ `messages/<peerId>.json`（消息时间线），两端各存一份。

---

## 3. 消息模型设计

### 3.1 核心消息类型（新增）

| type | 方向 | 说明 |
|---|---|---|
| `chat_send` | 双向 | 一条聊天消息（文本 / 文件引用 / 系统提示） |
| `chat_ack` | 双向 | 已收到（写入本地时间线成功），驱动「已送达」 |
| `chat_read` | 双向 | 对方已读（打开会话时批量上报 `upToTs`） |

> 设计取舍：**不做 `chat_typing`（正在输入）**。理由：收益低、状态易残留（断连后一直显示「对方正在输入」），且会显著增加消息量。v1 先不做，协议留扩展位。

### 3.2 `chat_send` 消息格式

```jsonc
{
  "v": 1, "type": "chat_send", "ts": 1730000000000,
  "deviceId": "mobile-9f8e7d",
  "chatId": "c_pc-a1b2c3",        // 会话 ID = 对端 deviceId 派生，两端一致
  "msgId": "m_9f8e7d_1730000000123_a4f2",  // 全局唯一，用于去重
  "kind": "text",                 // text | file | system
  "text": "晚上把照片发我",        // kind=text 时的正文（≤ 4000 字）
  "attachment": {                 // kind=file 时存在
    "transferId": "t_xxx",
    "files": [ { "fileId": "f_1", "name": "IMG_2026.jpg", "size": 4823912, "mime": "image/jpeg", "relPath": "" } ],
    "totalBytes": 4823912
  }
}
```

- `msgId` 生成规则：`m_<senderDeviceShort>_<ts>_<4位随机>`，**发送方生成、全程不变**，接收方按 `msgId` 去重。
- `chatId` 生成规则：`c_` + 对端 deviceId。双方算出的 `chatId` 不同（各自以自己的对端算），**不做全局统一**，仅在本地时间线索引时用；跨端关联靠 `msgId`。

### 3.3 时序（发文件）

```
电脑                                    手机
 │ chat_send{kind:file, attachment}  ──▶  立即渲染文件气泡（灰色"等待接收"）
 │                                        （静默接收，见 §5）
 │ send_offer{chatId, origin:'chat'} ──▶  自动 accept（同一 chatId 已授权）
 │ ◀──── send_accept ─────────────────
 │ chunk...                          ──▶  气泡内进度条实时更新
 │ complete ─────────────────────────▶  气泡变"已完成"，可点开
 │ ◀──── chat_ack ───────────────────
```

关键：`chat_send` 先到 → 气泡先出现（用户立刻有反馈），随后 `send_offer` 才开始传字节。
**顺序必须这样**，否则用户会看到「先转圈再出现名字」的割裂感。

---

## 4. 技术难点清单

### 难点 1：会话模型是全新的（工作量主体）

现有代码里 `transfer` 是「一次性」的（`createTransfer` → `archive`），没有：
- 会话索引（按对端 deviceId 聚合）
- 消息时间线（有序、可分页）
- 未读数 / 最后一条消息摘要

**方案**：新增 `desktop/src/main/chat.js`，`class ChatStore`，接口：
```js
openChat(peer)                       // 取/建会话
append(peerId, message)              // 追加消息（自动去重 + 排序）
list(peerId, { before, limit })      // 分页取历史
markRead(peerId, upToTs)             // 更新已读位点
markDelivered(peerId, msgId)         // 更新送达
clear(peerId)                        // 清空会话
summary()                            // 会话列表（lastMsg / unread）
```

### 难点 2：顺序与去重

- TCP 保序 ⇒ 同一条连接内消息天然有序，**无需应用层排序**。
- 但**重连**会重放：手机端可能因断连重发 pending 消息 ⇒ 必须按 `msgId` 去重。
- 时间戳 `ts` 不可靠（两端时钟可能不同步，实测差几百毫秒很常见）⇒ **排序以「到达顺序」为准，`ts` 仅用于展示**。这是最容易踩的坑。

### 难点 3：离线消息（对方不在线）

v1 明确**不做离线消息队列**。理由：
- 需要服务端存储 + 拉取协议 + 冲突解决，复杂度陡增；
- 局域网场景下「对方不在线」就是「没连上」，直接提示「消息未送达，对方当前不在线」即可，符合直觉。

对应实现：`sendChat` 时若 `server.sessionOf(peerId)` 为空 ⇒ 返回 `{ ok:false, reason:'offline' }`，前端把气泡标为「未送达」+ 红色感叹号，允许重试。

### 难点 4：接收确认策略（最需要权衡的点）

现状：`send_offer` 一律弹窗要求用户确认。聊天语境下：
- **每来一个文件就弹窗** → 对话流被打断，体验崩塌；
- **完全静默接收** → 违背「接收方确认后才接收」的原始安全约束。

**折中方案（本设计采用）**：

| 场景 | 行为 |
|---|---|
| 会话中已存在（用户已主动打开过该会话 / 已配对信任） | **静默自动接收**，文件气泡内显示进度 |
| 首次收到该设备的消息（无历史会话） | **弹一次确认**：「X 想与你聊天，是否接受？」，接受后该设备后续文件静默接收 |
| 单次文件 > 500 MB 或数量 > 20 | **仍然弹窗确认**（避免对方误塞大文件打爆磁盘） |

即：**「接受一次会话」= 授权该会话内的文件自动接收**。安全性上等价于「信任设备」的既有语义，同时保住对话流体验。

### 难点 5：同一设备多会话 / 多设备并发

现有 `Session` 是「一条 socket 一个会话」，理论上同一设备可能建立多条连接（重连竞态）。
**方案**：`server.sessionOf(deviceId)` 已有实现，聊天统一取「该 deviceId 当前活跃 session」，不新增会话管理逻辑。

### 难点 6：文件消息与 transfer 历史的双写

文件消息既要在聊天时间线里出现，又要在「传输历史」里出现（保持既有页面不退化）。
**方案**：以聊天时间线为主，`transfer` 记录仍照常写；聊天里存 `attachment.transferId` 作为弱引用，点开文件时才去 `getTransfer` 查路径。

### 难点 7：UI 结构与现有渲染方式的冲突

现有 `app.js` 是「整体重绘」风格（`renderHistory` 全量 `innerHTML`），而聊天时间线**消息量大、需要增量追加 + 滚动锚定**。全量重绘会导致：
- 输入框失焦
- 滚动位置跳动
- 长列表卡顿

**方案**：聊天区域单独实现**增量追加**（`appendMessageEl`），只在切换会话时全量重建。进度更新走「按 `data-msgid` 定位 DOM」的局部更新（复刻现有 `onProgress` 里 `.xfer[data-tid]` 的做法）。

### 难点 8：CSP 与图片预览

现有 CSP 为 `img-src 'self' data:`，缩略图走主进程 `getImagePreview` 转 dataURL（有 3 MB 上限）。
聊天里的图片文件卡片**沿用同一机制**，不突破 CSP。

---

## 5. 协议扩展（具体改动点）

`shared/protocol.js`：

```js
MSG 新增：
  CHAT_SEND: 'chat_send',
  CHAT_ACK:  'chat_ack',
  CHAT_READ: 'chat_read',

新增常量：
  CHAT_TEXT_MAX = 4000
  CHAT_SILENT_MAX_BYTES = 500 * 1024 * 1024
  CHAT_SILENT_MAX_FILES = 20

新增函数：
  makeChatId(peerDeviceId)        // 'c_' + peerDeviceId
  makeMsgId(senderDeviceId, ts)   // 全局唯一
```

`send_offer` 增加**可选**字段（协议向后兼容：老端忽略未知字段）：
```jsonc
{ "type": "send_offer", "chatId": "c_xxx", "origin": "chat" }
```

`docs/PROTOCOL.md` 同步补一节「10. 聊天」。

---

## 6. 目录与文件改动清单

```
shared/protocol.js              + 消息类型、常量、makeChatId/makeMsgId
shared/protocol.mjs             （由 scripts/gen-protocol-mjs.js 重新生成）
docs/PROTOCOL.md                + 第 10 节 聊天
docs/CHAT.md                    （本文件）

desktop/src/main/chat.js        新建：ChatStore（会话 + 时间线 + 持久化）
desktop/src/main/server.js      Session._onChatSend/_onChatAck/_onChatRead；
                                TransferServer: chatStore 挂载、事件转发
desktop/src/main/main.js        IPC: ltp:getChats/getMessages/sendChat/
                                markChatRead/clearChat；转发 chat:* 事件
desktop/src/preload/preload.js  暴露对应 API + onChat 订阅
desktop/src/renderer/index.html + 「聊天」导航 + 对话页骨架
desktop/src/renderer/style.css  + 气泡 / 文件卡片 / 输入区样式
desktop/src/renderer/app.js     + 聊天渲染（增量）、发送、拖拽、进度

mobile/src/core/client.js       + sendChat / _onChatSend / onChat
mobile/src/ui/index.html        + 聊天面板
mobile/src/ui/app.js            + 聊天渲染与交互
mobile/src/ui/style.css         + 气泡样式
```

---

## 7. 实施顺序

1. 协议层（`protocol.js` + 重生成 `.mjs`）
2. 电脑端 `chat.js`（ChatStore）+ 单测式脚本验证读写
3. 电脑端 `server.js` / `main.js` / `preload.js` 打通链路
4. 电脑端 UI
5. 手机端 `client.js` + UI
6. 端到端验证（协议往返 + UI 接线差集 + 截图）

---

## 8. 明确不做（v1 范围外）

- 离线消息队列 / 消息漫游
- 群聊（仅 1:1）
- 「正在输入」指示
- 图片/视频内联预览的自动缩略大图（沿用现有小缩略图即可）
- 消息撤回 / 编辑
- 端到端加密（沿用现有「配对令牌 + 局域网隔离」，协议已预留 `secure` 字段）

---

## 9. 风险与回归点

| 风险 | 缓解 |
|---|---|
| 改动 `send_offer` 影响既有传输 | 新增字段全部可选；老端忽略；回归跑现有 `verify-*` 脚本 |
| `chat.js` 持久化损坏导致启动失败 | 读写包 try/catch，损坏时降级为空时间线并备份原文件 |
| 聊天高频进度事件拖慢 IPC | 复用现有 `ltp:progress` 轻量通道，不新增高频通道 |
| 全量重绘导致输入框失焦 | 聊天区强制增量更新（见难点 7） |
