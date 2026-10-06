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

## 9. 版本演进

- `v` 字段为协议主版本，不兼容变更必须递增
- 新增可选字段不递增版本（接收方忽略未知字段）
- `protocol` 字符串 `LTP/1` 出现在 announce 中，用于快速识别不兼容对端
