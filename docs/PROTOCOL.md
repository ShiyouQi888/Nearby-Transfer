# 局域网互传协议 v1 (LAN Transfer Protocol, LTP/1)

本协议定义 Windows 电脑端与手机端之间的通信契约。**两端必须严格遵循本文件**，
任何一端修改消息格式都必须同步版本号并更新本文件。

- 传输层：TCP（文件数据）+ UDP（设备发现）
- 应用层：NDJSON（Newline Delimited JSON），每行一条 JSON 消息，`\n` 结尾
- 字符编码：UTF-8
- 端口：`PORT = 53317`（TCP 服务 + UDP 发现，两端一致）
- 组播地址：`239.255.42.99:53317`
- 协议版本：`LTP/1`

---

## 1. 消息总览

| 分类 | type | 方向 | 说明 |
|---|---|---|---|
| 发现 | `announce` | 双向广播 | UDP 组播宣告自身在线 |
| 发现 | `probe` | 单向广播 | UDP 主动探测，请求所有设备回应 |
| 发现 | `bye` | 双向广播 | 设备离线告警 |
| 握手 | `hello` | 连接发起方 → 接收方 | TCP 建连后第一条消息 |
| 握手 | `hello_ack` | 接收方 → 发起方 | 握手应答，携带配对状态 |
| 配对 | `pair_request` | 手机 → 电脑 | 提交 6 位匹配码 / 令牌 |
| 配对 | `pair_result` | 电脑 → 手机 | 配对结果 |
| 配对 | `trust_list` | 电脑 → 手机 | 已信任设备列表 |
| 准备 | `send_offer` | 发送方 → 接收方 | 文件元数据 + 询问是否接收 |
| 准备 | `send_accept` | 接收方 → 发送方 | 同意接收，携带断点信息 |
| 准备 | `send_reject` | 接收方 → 发送方 | 拒绝接收 |
| 数据 | `chunk_meta` | 发送方 → 接收方 | 分片头信息 |
| 数据 | `chunk` | 发送方 → 接收方 | 分片原始字节（二进制帧） |
| 数据 | `chunk_ack` | 接收方 → 发送方 | 分片确认（用于滑窗/断点） |
| 进度 | `progress` | 双向 | 传输进度上报 |
| 结束 | `complete` | 双向 | 单个文件传输完成 |
| 结束 | `cancel` | 双向 | 中途取消 |
| 心跳 | `ping` / `pong` | 双向 | 保活 |
| 聊天 | `chat_send` | 双向 | 一条聊天消息（文本 / 文件元数据），见 §9 |
| 聊天 | `chat_ack` | 双向 | 消息送达回执 |
| 聊天 | `chat_read` | 双向 | 消息已读回执 |
| 错误 | `error` | 双向 | 错误通知 |

所有消息公共字段：

```jsonc
{
  "v": 1,                    // 协议版本
  "type": "send_offer",      // 消息类型
  "seq": 1024,               // 消息序号（每条递增，用于日志与幂等）
  "ts": 1730000000000,       // 发送时间戳（毫秒）
  "deviceId": "pc-a1b2c3",   // 发送方设备 ID
  "transferId": "t_xxx"      // 传输会话 ID（握手/发现类消息可省略）
}
```

---

## 2. 设备发现（UDP）

### 2.1 announce — 在线宣告

每 3 秒组播一次，TTL=1（限制在同网段）。收到后写入设备表，15 秒无 announce 判定离线。

```jsonc
{
  "v": 1, "type": "announce", "ts": 1730000000000,
  "device": {
    "deviceId": "pc-a1b2c3",       // 稳定唯一 ID（电脑端为机器码，手机端为随机持久化 UUID）
    "name": "DESKTOP-齐世有",       // 展示名，默认取主机名/设备名
    "type": "desktop",             // "desktop" | "mobile"
    "os": "Windows 11",            // 系统描述
    "ip": "192.168.1.23",          // 宣告方探测到的本机局域网 IP
    "port": 53317,                 // TCP 服务端口
    "protocol": "LTP/1",
    "pairingRequired": true,       // 是否要求配对后才能传输
    "fingerprint": "AB12-CD34"     // 设备证书短指纹（配对时校验用，v1 为设备码派生）
  }
}
```

### 2.2 probe — 主动探测

手动扫描网段时，对 `192.168.1.1` ~ `192.168.1.254` 依次发送 unicast UDP `probe`，
同时向组播地址发一份。收到 `probe` 的设备立即单播回一份 `announce`。

```jsonc
{ "v": 1, "type": "probe", "ts": 1730000000000, "deviceId": "pc-a1b2c3", "wantReply": true }
```

### 2.3 bye — 离线告警

退出前广播，收到后立即从设备表移除。

```jsonc
{ "v": 1, "type": "bye", "ts": 1730000000000, "deviceId": "pc-a1b2c3" }
```

---

## 3. 配对连接（TCP）

TCP 建连后，**发起方先发 `hello`，接收方回 `hello_ack`**，之后才允许发业务消息。

### 3.1 hello

```jsonc
{
  "v": 1, "type": "hello", "ts": 1730000000000,
  "device": { /* 同 announce 的 device 对象 */ },
  "auth": {
    "mode": "paired",          // "paired"=已配对 | "pair"=请求配对 | "none"=匿名
    "deviceId": "mobile-9f8e7d",
    "token": "eyJhbGci...",    // paired 模式下携带已保存的长期令牌
    "pairCode": "482913"       // pair 模式下携带 6 位匹配码（或二维码里的临时令牌）
  }
}
```

### 3.2 hello_ack

```jsonc
{
  "v": 1, "type": "hello_ack", "ts": 1730000000000,
  "accepted": true,
  "reason": "paired" ,         // paired | need_pair | rejected | bad_token
  "server": { /* 接收方 device 对象 */ },
  "token": "eyJhbGci...",      // 配对成功时下发长期令牌，手机端本地保存
  "expiresAt": 1760000000000   // 令牌有效期（0 表示永久）
}
```

未配对设备：`accepted: false, reason: "need_pair"`，随后服务端主动关闭连接。

---

## 4. 依赖与加密

- v1 不引入 TLS，依赖「配对令牌 + 局域网隔离」。协议预留 `secure: true` 字段，
  后续版本可切换到 TLS/1.3 自签证书 + 指纹校验。
- 令牌 = HMAC-SHA256(设备码, deviceId + 签发时间) 的 Base64 截断，服务端可无状态校验。

---

## 5. 二维码内容

电脑端展示的二维码为一行 JSON 的 Base64URL 编码，前缀 `LTP1:`：

```
LTP1:eyJpcCI6IjE5Mi4xNjguMS4yMyIsInBvcnQiOjUzMzE3LCJ0b2tlbiI6...
```

解码后：

```jsonc
{
  "ip": "192.168.1.23",
  "port": 53317,
  "token": "a1b2c3d4",        // 临时配对令牌（5 分钟有效）
  "name": "DESKTOP-齐世有",
  "deviceId": "pc-a1b2c3",
  "protocol": "LTP/1"
}
```

---

## 6. 文件传输

### 6.1 send_offer — 发送文件元数据

批量发送时，`files` 数组可含多项；发送方逐个文件串行传输。

```jsonc
{
  "v": 1, "type": "send_offer", "ts": 1730000000000,
  "deviceId": "mobile-9f8e7d", "transferId": "t_1730000001",
  "files": [
    {
      "fileId": "f_1",
      "name": "IMG_2026.jpg",
      "size": 4823912,
      "mime": "image/jpeg",
      "relPath": "DCIM/Camera/IMG_2026.jpg",   // 文件夹传输时保留相对路径
      "isDir": false,
      "mtime": 1760000000000,
      "chunkSize": 262144,                      // 每片 256KB
      "sha256": ""                              // 可选：整文件校验值（大文件可为空）
    }
  ],
  "totalBytes": 4823912
}
```

### 6.2 send_accept / send_reject

接收方**必须由用户确认**后才回 accept。accept 携带每个文件已收到的字节数（断点续传）。

```jsonc
{
  "v": 1, "type": "send_accept", "ts": 1730000000000,
  "transferId": "t_1730000001",
  "acceptedBy": "DESKTOP-齐世有",
  "resume": [
    { "fileId": "f_1", "receivedBytes": 1048576, "resumeToken": "rs_7f3a" }
  ],
  "saveTo": "C:/Users/User/Downloads/LANTransfer"
}
```

```jsonc
{ "v": 1, "type": "send_reject", "ts": 1730000000000, "transferId": "t_1730000001", "reason": "user_denied" }
```

### 6.3 分片传输 — 二进制帧

为了效率，分片走**二进制帧**而非 Base64。帧格式（大端）：

```
┌──────────┬────────────┬──────────────┬──────────┬──────────────┬─────────────┐
│ magic 4B │fileIdLen 2B│ fileId 变长  │ seq 4B   │ payloadLen 4B│ payload     │
│ "LTPC"   │            │ (UTF-8)      │ 分片序号 │ 本片字节数   │ 变长        │
└──────────┴────────────┴──────────────┴──────────┴──────────────┴─────────────┘
```

- 帧头总计 `4 + 2 + fileIdLen + 4 + 4 = 14 + fileIdLen` 字节
- **`payloadLen` 不可省略**：TCP 是字节流，多帧首尾相连，没有长度字段就无法切分帧边界。
  末片长度 `= fileSize - (lastSeq * chunkSize)`，其余片均为 `chunkSize`。
- 接收方通过**首字节**区分帧类型（文本与二进制混在同一条 TCP 流中）：
  - 文本消息首字节为 `{` (0x7B)
  - 二进制帧首字节为 `L` (0x4C，即 magic "LTPC" 开头)
- 分片序号从 `0` 开始，第 n 片对应文件偏移 `n * chunkSize`
- **断点续传**：发送方从 `send_accept.resume.receivedBytes` 计算起始分片号
  `startSeq = floor(receivedBytes / chunkSize)`，并回到该分片的字节偏移处读写。
- 安全上限：单帧 `payloadLen` 超过 64MB 时判定为流损坏，接收方丢弃 4 字节后重新同步。

### 6.4 chunk_ack — 分片确认

每接收 **16 片**（4MB）或每 200ms 回一次批量确认，避免逐片 ack 拖慢吞吐。

```jsonc
{
  "v": 1, "type": "chunk_ack", "ts": 1730000000000,
  "transferId": "t_1730000001", "fileId": "f_1",
  "ackedSeq": 63,                // 已确认收到第 63 片（含）
  "receivedBytes": 16777216
}
```

发送方维护「已 ack 序号」，断线重连后从 `ackedSeq + 1` 续传。

### 6.5 progress — 进度上报

接收方每 300ms 回一次进度，供发送方展示对端接收情况。

```jsonc
{
  "v": 1, "type": "progress", "ts": 1730000000000,
  "transferId": "t_1730000001", "fileId": "f_1",
  "transferredBytes": 2097152, "totalBytes": 4823912,
  "speed": 12582912,             // 字节/秒
  "etaMs": 217                 // 预计剩余毫秒，未知为 null
}
```

### 6.6 complete

```jsonc
{
  "v": 1, "type": "complete", "ts": 1730000000000,
  "transferId": "t_1730000001", "fileId": "f_1",
  "path": "C:/Users/User/Downloads/LANTransfer/IMG_2026.jpg",
  "size": 4823912, "sha256": "…", "durationMs": 3842
}
```

### 6.7 cancel

任一方可随时发 `cancel`，收到后立即停止读写、删除未完成的 `.part` 临时文件（或保留供续传）。

```jsonc
{ "v": 1, "type": "cancel", "ts": 1730000000000, "transferId": "t_1730000001",
  "by": "receiver", "reason": "user_cancelled", "keepPartial": true }
```

### 6.8 error

```jsonc
{ "v": 1, "type": "error", "ts": 1730000000000, "transferId": "t_1730000001",
  "code": "DISK_FULL", "message": "磁盘空间不足" }
```

---

## 7. 状态机

```
发送方                          接收方
  │  send_offer        ──────▶
  │                             用户确认
  │  ◀──────  send_accept / send_reject
  │  chunk (二进制)     ──────▶  写 .part 文件
  │  ◀──────  chunk_ack / progress
  │  ...重复直到发完...
  │  complete          ──────▶  改名为正式文件
  │  ◀──────  complete
```

## 8. 容错规则

| 场景 | 处理 |
|---|---|
| 分片丢失/乱序 | TCP 保证有序；ack 序号用于重连续传，不做应用层重传 |
| 连接中断 | 保留 `.part` 文件 + `resumeToken`，重连后凭 token 续传 |
| 令牌过期 | `hello_ack.reason = "bad_token"` → 手机端清除缓存，要求重新配对 |
| 5 分钟无心跳 | `ping`/`pong` 超时 → 关闭连接，标记传输为失败 |
| 未配对连接 | 服务端立即 `hello_ack{accepted:false, reason:"need_pair"}` 后断开 |

## 9. 聊天（Chat over LTP/1）

聊天**不引入新的传输链路**，完全复用已配对的那条 TCP 会话。这样配对、鉴权、
局域网隔离这些约束天然成立——能聊天的设备，必然是已经配对成功的设备。

设计取舍与难点分析见 [`docs/CHAT.md`](./CHAT.md)，本节只定义线上协议。

### 9.1 消息类型

| 类型 | 方向 | 作用 |
|---|---|---|
| `chat_send` | 双向 | 一条聊天消息（文本或文件元数据） |
| `chat_ack` | 双向 | 「已收到并写入时间线」，用于送达回执 |
| `chat_read` | 双向 | 「我已读到某位点」，用于已读回执 |

### 9.2 `chat_send`

```json
{
  "v": 1, "type": "chat_send", "seq": 12, "ts": 1760000000000,
  "deviceId": "mobile-a1b2c3",
  "chatId": "c_desktop-9f8e7d",
  "msgId": "m_mobile_1760000000000_4f2a",
  "kind": "text",
  "text": "晚上把照片发我",
  "attachment": null
}
```

文件消息的 `kind` 为 `"file"`，`attachment` 携带元数据（字节仍走 `send_offer`）：

```json
{
  "kind": "file",
  "text": "",
  "attachment": {
    "totalBytes": 50331648,
    "files": [
      { "fileId": "f_1", "name": "周末露营-原图.zip", "size": 50331648, "mime": "application/zip", "relPath": "周末露营-原图.zip" }
    ]
  }
}
```

字段约定：

| 字段 | 说明 |
|---|---|
| `chatId` | 会话标识，`c_` + 对端 deviceId。**两端各自计算，天然不同**（A 侧是 `c_B`，B 侧是 `c_A`）；跨端关联一律靠 `msgId`，不靠 `chatId` |
| `msgId` | 消息唯一标识 `m_<端前缀>_<ts>_<rand>`；**去重唯一依据** |
| `kind` | `text` \| `file` |
| `text` | 文本正文；`kind=file` 时可为空 |
| `attachment` | 文件消息的元数据；`kind=text` 时为 `null` |

### 9.3 文件消息的完整时序

```
发送方                          接收方
  │  chat_send(kind=file)         │   ← 让气泡第一时间出现（含文件名/大小）
  ├──────────────────────────────►│
  │            chat_ack           │
  │◄──────────────────────────────┤
  │  send_offer(chatId, origin)   │   ← 字节走既有分片通道
  ├──────────────────────────────►│
  │      send_accept / reject     │   ← 未授权会话需用户确认；已授权则静默
  │◄──────────────────────────────┤
  │        (binary chunks)        │
  ├──────────────────────────────►│
  │          complete             │
  ├──────────────────────────────►│
```

`send_offer` 新增两个可选字段：

| 字段 | 说明 |
|---|---|
| `chatId` | 标识本次传输属于哪个聊天会话 |
| `origin` | `"chat"` 表示来自聊天；接收方据此决定是否走「静默接收」 |

### 9.4 静默接收策略

未配对设备本就无法连接，所以「是否接收」的粒度是**会话级信任**而不是文件级：

| 条件 | 行为 |
|---|---|
| 该会话**从未被用户接受过** | 仍弹确认框（保持协议 §6.2「接收方必须确认」） |
| 用户点过「接受会话」 | 该会话内后续文件静默接收，不再打断对话 |
| 静默接收时单次 > 500 MB | 仍弹确认框（`CHAT_SILENT_MAX_BYTES`） |
| 静默接收时单次 > 20 个文件 | 仍弹确认框（`CHAT_SILENT_MAX_FILES`） |

阈值定义在 `shared/protocol.js`，两端共用，避免行为分叉。

### 9.5 一致性与容错

| 场景 | 处理 |
|---|---|
| 同一 `msgId` 重复投递（重连重放） | 按 `msgId` 去重，不重复入库；但**仍然回复 `chat_ack`**（对方可能只是没收到回执） |
| 消息顺序 | 以**到达顺序**为准排序，`ts` 仅用于展示——两端时钟可能有偏差 |
| 文本超长 | `text.length > CHAT_TEXT_MAX(4000)` → 回 `error{code:"CHAT_TOO_LONG"}`，不投递 |
| 未配对设备发 `chat_send` | `error{code:"NOT_PAIRED"}` |
| 对端离线 | 消息存为 `pending`（本地），不进入任何队列；对端上线后可手动重发 |
| 离线消息队列 | **v1 不做**——不做服务端暂存，避免引入「谁是权威副本」的问题 |

### 9.6 本地消息状态（不参与线上传输）

| 状态 | 含义 |
|---|---|
| `pending` | 本地已入列，尚未发出（对端离线） |
| `sent` | 已写入 socket |
| `delivered` | 收到对端 `chat_ack` |
| `read` | 收到对端 `chat_read` |
| `failed` | 发送失败 |

## 10. 版本演进

- `v` 字段为协议主版本，不兼容变更必须递增
- 新增可选字段不递增版本（接收方忽略未知字段）
- `protocol` 字符串 `LTP/1` 出现在 announce 中，用于快速识别不兼容对端
- 聊天能力（§9）以**新增消息类型**的方式引入，未递增版本号；
  老版本对端收到未知 `type` 会静默忽略（§1 分发逻辑的 `default` 分支）
