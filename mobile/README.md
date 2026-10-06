# 邻传 Nearby Transfer · 手机端（Android）

与「邻传 Nearby Transfer」Windows 电脑端配对，在**同一 Wi-Fi 内**双向传输文件，无需外网服务器。

## 技术选型

| 关注点 | 选型 | 说明 |
|---|---|---|
| 应用外壳 | **Android 原生 Activity** | 原生 Java UI、原生 TCP Socket、系统文件选择器，不依赖 WebView |
| 构建 | **Android Gradle Plugin 8** | 直接生成 APK |
| 协议层 | **共享 `shared/protocol.js`** | 与电脑端**同一份**协议实现（经 `scripts/gen-protocol-mjs.js` 生成浏览器 ESM 版） |
| 传输通道 | 原生 TCP Socket | 直连电脑端 53317 端口 |
| 文件读取 | Android Storage Access Framework | 通过系统文件选择器，不申请全盘存储权限 |

原生 APK 直接使用 Android `Socket` 与电脑端 TCP 服务通信，不再经过 WebView、JavaScript 或 WebSocket 降级层。

## 目录结构

```
mobile/
├── index.html                    # 单页 UI（连接引导 / 主界面 / 弹层）
├── package.json
├── vite.config.js                # @shared 别名 + fs.allow 仓库根目录
├── android/                      # 原生 Android 工程
└── src/
    ├── core/
    │   ├── client.js             # MobileClient / Socket 抽象 / 分片收发
    │   ├── storage.js            # 落盘（CapFS / OPFS）+ 身份持久化
    │   ├── lan-bridge.js         # 原生 Socket 插件的 JS 注册层
    │   └── lan-bridge.web.js     # 浏览器兜底（明确抛错，触发降级）
    └── ui/
        ├── app.js                # UI 主逻辑（连接 / 发送 / 接收 / 渲染）
        └── style.css             # 深色移动端主题
```

## 开发与运行

```bash
cd mobile
npm install

# 生成浏览器版协议（会自动在 dev/build 前执行）
npm run gen:protocol

# 浏览器调试（推荐先用这条验证与电脑端联通）
npm run dev          # http://<本机IP>:5175
```

> 浏览器调试时走 **WebSocket 网关**——电脑端必须已启动，且两端在同一局域网。

### 打包成 Android APK

```bash
cd android
./gradlew assembleDebug
```

APK 输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 使用流程

1. 手机与电脑连接**同一个 Wi-Fi**。
2. 任选一种方式连接：
   - **扫码**：点「扫描电脑上的二维码」，对准电脑端「配对」页的二维码；
   - **匹配码**：在电脑端生成 6 位匹配码，手机端输入并填写电脑 IP；
   - **手动**：直接输入电脑 IP 与端口；
   - **网段扫描**：输入 `192.168.1.1-254`，自动探测局域网内的电脑端。
3. 首次连接需在电脑端确认配对；配对成功后记入「已配对的电脑」，下次一键直连。
4. 连接后点四个磁贴（图片/视频/文档/其他）选择文件即可发送；电脑端发来文件时会弹出确认框。

## 权限策略

手机端遵循最小权限原则：

- `INTERNET`、`ACCESS_NETWORK_STATE`、`ACCESS_WIFI_STATE`：用于同一局域网内连接和探测电脑。
- `CAMERA`：仅用户点击「扫描电脑上的二维码」后申请，用于扫码；拒绝后仍可使用 6 位匹配码、手动地址和网段扫描。
- 文件/照片：通过 Android 系统文件选择器读取，不申请通讯录、定位、后台位置或全盘存储权限。

应用内「设置 → 设备权限」可以查看摄像头权限状态。Android 原生工程的声明位于
`android/app/src/main/AndroidManifest.xml`；执行 `npm run cap:sync` 后会同步前端资源，运行时摄像头授权仍由用户首次扫码时决定。

## 常见问题

- **连不上**：确认同一网段、电脑防火墙放行 `53317/53318`、电脑端应用已启动。
- **扫码无反应**：部分浏览器内核不支持 `BarcodeDetector`，请改用 6 位匹配码。
- **速度慢**：浏览器调试走 WebSocket，性能不如原生通道；打包 APK 并实现 `LanBridge` 后走 TCP 直连更快。
