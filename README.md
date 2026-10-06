# 邻传 Nearby Transfer（LTP/1）

在**同一局域网内**让 Windows 电脑与 Android 手机互传文件 —— **不依赖任何外网服务器**，
数据只在两台设备之间点对点流动。支持图片 / 视频 / 文档 / 任意文件 / 文件夹 / 批量传输，
带实时进度、速度、剩余时间，支持大文件分片、断点续传与中途取消。

```
┌──────────────┐        UDP 组播 239.255.42.99:53317（设备发现）
│  Windows 电脑端 │ ◀────────────────────────────────────────────▶
│  (Electron)   │        TCP 53317 / WS 53318（文件与信令传输）
└───────┬───────┘
        │  同一 Wi-Fi
┌───────┴───────┐
│  Android 手机端 │
│  (Capacitor)  │
└───────────────┘
```

---

## 一、功能总览

| 需求 | 实现 |
|---|---|
| **设备发现** | UDP 组播 `239.255.42.99` 自动播报（在线设备名 / IP / 类型）；另支持手动扫描指定网段（如 `192.168.1.1-254`）并发探测 |
| **配对连接** | ① 扫码：二维码内含 IP、端口、临时令牌（5 分钟有效）；② 6 位匹配码配对；配对成功写入「已信任设备」，之后免配直连 |
| **文件传输** | 双向发送图片 / 视频 / 文档 / 文件夹 / 批量；实时进度、速度、剩余时间与传输历史；大文件分片（默认 256KB）、断点续传、中途取消 |
| **安全与交互** | 接收方确认后才接收并显示发送方设备名；未配对设备一律拒绝；全程局域网内传输，不经过任何第三方服务器 |
| **工程输出** | 两端技术选型与目录结构（本文）、协议消息格式（`docs/PROTOCOL.md`）、两端可运行核心代码 |
| **界面一致性** | 电脑端采用**无边框窗口 + 自绘标题栏**，关闭 / 最小化 / 最大化-还原按钮完全融入品牌配色，不再是系统原生灰白控件 |
| **中文排版** | 界面正文内嵌**思源黑体（Source Han Sans SC）可变字重子集**（100–900 轴，仅 1.0 MB），正文基准字重 450，标题更粗，全平台观感统一 |
| **关于与版权** | 侧栏「关于」页 + 设置弹窗「关于」页签双入口：作者、应用信息、运行环境、联系方式（邮箱 / 官网）、版权与字体授权说明 |

---

## 二、技术选型

### 电脑端（Windows）

| 关注点 | 选型 | 理由 |
|---|---|---|
| 桌面外壳 | **Electron 33** | 直接复用 Node 的网络能力（TCP/UDP），跨平台，界面用 Web 技术栈快速迭代 |
| 进程模型 | 主进程（网络 + 文件 IO） + 渲染进程（UI） | `contextIsolation` + `preload` contextBridge，安全隔离 |
| 网络 | 原生 `net` / `dgram` | 原始 TCP + UDP 组播，无中间层 |
| 二维码 | **qrcode**（服务端生成 PNG dataURL） | 规避渲染进程 CSP / 网络限制 |
| 打包 | **electron-builder**（NSIS 安装包） | 一键出 Windows 安装程序 |

### 手机端（Android）

| 关注点 | 选型 | 理由 |
|---|---|---|
| 应用外壳 | **Capacitor 6** | Web 前端 + 原生插件，打包成 APK |
| 前端构建 | **Vite 5** | ESM 原生、产物小、开发快 |
| 传输通道 | **原生 TCP Socket（首选）/ WebSocket 网关（降级）** | 浏览器无法开原始 TCP，降级方案免原生代码即可跑通 |
| 落盘 | Capacitor Filesystem（APK）/ OPFS（浏览器） | 自动探测环境 |
| 扫码 | 原生 `BarcodeDetector` | 不支持时提示改用匹配码 |

### 两端共享

**`shared/protocol.js` 是唯一的协议事实来源**，被电脑端（CommonJS `require`）与手机端
（经 `scripts/gen-protocol-mjs.js` 生成浏览器 ESM 版 `shared/protocol.mjs`）共同使用，
保证编解码、消息定义、分片帧格式、令牌算法两端**字节级一致**。

---

## 三、目录结构

```
win-shouji-huchuan/
├── README.md                    # 本文件
├── docs/
│   └── PROTOCOL.md              # LTP/1 完整协议规范（消息目录 / 帧格式 / 状态机 / 容错）
├── shared/
│   ├── protocol.js              # ★ 协议单一事实来源（CommonJS + 浏览器同构垫片）
│   └── protocol.mjs             #   由脚本自动生成的浏览器 ESM 版本（勿手改）
├── desktop/                     # ── Windows 电脑端（Electron）
│   ├── package.json
│   ├── resources/               # 应用图标（由 scripts/gen-icons.py 生成）
│   │   ├── icon.png             #   512×512 窗口/任务栏图标
│   │   ├── icon.ico             #   多尺寸 ICO（16…256，安装包 + exe）
│   │   └── tray.png             #   32×32 托盘图标
│   └── src/
│       ├── main/
│       │   ├── main.js          # 主进程：配置、服务编排、23 个 IPC、托盘
│       │   ├── discovery.js     # UDP 组播发现 + 网段并发扫描
│       │   ├── server.js        # TCP 会话服务 + HTTP/WebSocket 网关
│       │   └── transfer.js      # 分片发送器 / 接收器 / 断点续传
│       ├── preload/preload.js   # contextBridge：31 个安全 API
│       └── renderer/            # 界面：设备 / 配对 / 传输 / 历史 / 已信任 / 关于
│           ├── index.html
│           ├── app.js
│           ├── style.css
│           ├── icons.js         # 统一内联 SVG 图标系统（53 个）
│           ├── logo.png
│           └── fonts/
│               └── source-han-sans-sc-subset.woff2  # 思源黑体可变字重子集（1.0 MB）
├── mobile/                      # ── Android 手机端（Capacitor）
│   ├── package.json
│   ├── vite.config.js
│   ├── capacitor.config.json
│   ├── index.html
│   ├── public/                  # 静态资源：logo.png / icon-192 / icon-512 / manifest
│   ├── resources/               # Capacitor Assets 源图（由 scripts/gen-icons.py 生成）
│   │   ├── icon.png             #   1024×1024 应用图标
│   │   ├── icon-foreground.png  #   自适应图标前景（62% 安全区）
│   │   ├── icon-background.png  #   自适应图标背景（品牌绿）
│   │   ├── splash.png           #   2732×2732 启动图
│   │   └── splash-dark.png      #   深色启动图
│   └── src/
│       ├── core/
│       │   ├── client.js        # MobileClient / Socket 抽象 / 分片收发
│       │   ├── storage.js       # 落盘（CapFS/OPFS）+ 身份持久化
│       │   ├── lan-bridge.js    # 原生 Socket 插件注册层
│       │   └── lan-bridge.web.js
│       └── ui/
│           ├── app.js           # UI 主逻辑
│           ├── icons.js         # 统一内联 SVG 图标系统
│           └── style.css
└── scripts/                     # ── 测试与工具
    ├── gen-protocol-mjs.js      # 由 protocol.js 生成浏览器 ESM 版
    ├── gen-icons.py             # 由源 logo 生成两端全套图标资源
    ├── gen-fonts.py             # 由系统思源黑体子集化出 1.0 MB 可变字重 woff2
    ├── test-protocol.js         # 协议单元测试（33）
    ├── test-e2e.js              # 真机 TCP 端到端测试（60）
    ├── test-ws.js               # WebSocket 网关测试（26）
    ├── test-smoke.js            # 冒烟 + 静态接线检查（32）
    ├── verify-package.js        # 打包产物校验（15，asar/协议层/exe）
    ├── verify-win-ctrl.js       # 自绘标题栏与窗口控制校验（15）
    ├── verify-font-about.js     # 思源黑体加载 + 关于页/版权/联系方式校验（30）
    ├── overflow-audit-mobile.js # 手机端多断点横向溢出审计
    ├── shoot-desktop.js         # 电脑端 Electron 截图（开发用）
    └── shoot-mobile.mjs         # 手机端 CDP 移动视口截图（开发用）
```

---

## 四、传输协议 LTP/1（摘要）

> 完整规范见 **[`docs/PROTOCOL.md`](docs/PROTOCOL.md)**。

- **端口**：TCP `53317`（主服务）、`53318`（HTTP + WebSocket 网关）、UDP `53317`（发现）。
- **信令**：NDJSON（每行一个 JSON 消息），UTF-8。
- **数据**：自定义二进制帧，与 NDJSON 复用**同一条 TCP 流**：

  ```
  magic "LTPC"(4B) | fileIdLen(2B) | fileId | seq(4B) | payloadLen(4B) | payload
                     └────────── 头部固定 14 + fileIdLen 字节 ──────────┘
  ```

  以首字节区分类型：`{`(0x7B)=文本消息，`L`(0x4C)=二进制帧。
- **消息目录**：`announce` / `probe` / `bye` / `hello` / `hello_ack` / `pair_request` /
  `pair_result` / `send_offer` / `send_accept` / `send_reject` / `chunk_ack` / `progress` /
  `complete` / `cancel` / `error`。
- **分片**：默认 256KB，每 16 片或 200ms 回一次 ACK；进度每 300ms 上报。
- **断点续传**：写入 `.lpart` 分片文件，完成后原子重命名；重连时按已有字节数从对应分片继续。
- **安全**：HMAC-SHA256 无状态长期令牌、6 位匹配码、5 分钟二维码临时令牌；
  未配对设备拒绝；路径穿越防护（`sanitizeRelPath`）。

---

## 五、快速开始

### 1. 启动电脑端

```bash
cd desktop
npm install
npm start          # 或 npm run dev（开发模式）
```

启动后：
- 「设备」页会显示本机 IP、端口，并自动发现同网段的其他设备；
- 「配对」页可生成**二维码**与 **6 位匹配码**供手机端连接。

> Windows 防火墙首次会弹窗询问，请允许专用网络访问。

### 2. 启动手机端

```bash
cd mobile
npm install
npm run dev        # 浏览器调试，http://<本机IP>:5175
```

浏览器打开后，任选一种方式连接电脑（扫码 / 匹配码 / 手动 IP / 网段扫描）。

> 想装成 APK 走原生 TCP 直连？见 [`mobile/README.md`](mobile/README.md)。

---

## 六、打包电脑端（Windows）

已用 electron-builder 打成 NSIS 安装包，**双击即装，无需 Node/Electron 环境**。

```bash
cd desktop
npm run build          # = electron-builder --win --x64
```

产物：

| 文件 | 说明 |
| --- | --- |
| `desktop/release/邻传 Setup 1.0.0.exe` | NSIS 安装包（约 79 MB），可选安装目录、创建桌面快捷方式 |
| `desktop/release/win-unpacked/邻传.exe` | 免安装绿色版（约 180 MB） |

安装包特性：

- 安装/卸载/安装向导头图三处均使用 `resources/icon.ico`（多尺寸 16–256）；
- `oneClick: false` + `allowToChangeInstallationDirectory: true`，可自选安装路径；
- 快捷方式名为「邻传」；
- 协议层通过 `extraResources` 打到 `resources/shared/`，与 `app.asar` 平级。

### 打包后自检

```bash
NODE_PATH=desktop/node_modules node scripts/verify-package.js
```

15 项断言：asar 内 10 个核心源文件齐全 → `renderer/logo.png` 是合法 PNG（防占位符/空文件）→ `extraResources` 的协议层能被 `require` 且导出完整 → `邻传.exe` 与安装包均已生成。

> 注意：asar 的路径校验**没有**使用 `@electron/asar` 的 `extractFile()`——该方法在 Windows 上存在按 `path.sep` 切分却传入 `/` 分隔路径的缺陷，恒抛 "was not found in this archive"。脚本改为按 asar 头里的 `offset/size` 直接读字节。

### 打包环境注意（Windows）

- `extraResources.from` 以 `package.json` 所在目录为基准（即 `desktop/`），**不是** 相对 `build` 字段。写成 `../../shared` 会静默失效、产出一个缺协议层的包。
- `win-unpacked/邻传.exe` 会被 Windows Defender 实时扫描锁定，导致二次打包报 `app.asar 被占用`；此时换输出目录即可：
  ```bash
  npx electron-builder --win --x64 --config.directories.output=release-v2
  ```
- 构建末尾删除临时 `.nsis.7z` 若被安全策略拦截，属于**构建后清理**，安装包此时已完整生成，可忽略并手动清理。

---

## 七、电脑端窗口外观

电脑端采用**无边框窗口（`frame: false`）+ 自绘标题栏**，让「关闭 / 最小化 / 最大化」与软件整体视觉统一，而不是系统默认的灰白控件。

| 位置 | 实现 |
| --- | --- |
| 窗口 | `BrowserWindow({ frame: false, roundedCorners: true, show: false })`，`ready-to-show` 后再显示，避免深色界面白闪 |
| 拖拽 | 整条顶栏 `-webkit-app-region: drag`；所有按钮/胶囊/下拉显式 `no-drag`（否则点击会被窗口拖动吞掉） |
| 按钮 | 三个 40×40 圆角按钮，内联 SVG 图标（`winMin` / `winMax` / `winRestore` / `winClose`），线宽与图标库一致 |
| 分隔 | 与「刷新 / 设置 / 运行中」之间有一条竖线分隔，视觉上与业务操作区分层 |
| 交互 | 最大化 / 还原图标**随窗口状态自动切换**；双击标题栏也可切换最大化（拖动区惯例） |
| 关闭态 | 悬停转为危险色（红底白叉），符合系统惯例但配色走品牌体系 |

窗口控制 IPC 通道：`ltp:winMinimize` / `ltp:winToggleMaximize` / `ltp:winClose` / `ltp:winIsMaximized`，并由主进程在 `maximize` / `unmaximize` 事件上通过 `ltp:winState` 主动推送状态，保证多屏拖动、快捷键最大化等场景下按钮图标不错位。

自绘标题栏的功能验证（含真实点击最小化/最大化/还原、图标切换、悬停配色）：

```bash
node scripts/verify-win-ctrl.js
```

---

## 八、中文字体与「关于」页

### 8.1 内嵌思源黑体可变字重子集

界面正文默认字重偏细，观感单薄。这里**内嵌思源黑体**（Source Han Sans SC，Adobe × Google 联合开源，SIL OFL 1.1），并把正文基准字重提到 **450**，标题更粗，中文观感更扎实。

字体**不引外链**（局域网离线也要能显示），而是从系统字体子集化出仅含常用字的 woff2：

```bash
python scripts/gen-fonts.py      # 或 cd desktop && npm run gen:fonts
```

| 项目 | 说明 |
| --- | --- |
| 源字体 | `C:\Windows\Fonts\NotoSansSC-VF.ttf`（思源黑体的 Google 发行版，**可变字体**，`wght` 轴 100–900） |
| 收录字符 | ASCII + 中文标点 + 常用符号 + **GB2312 一级汉字**（3755 字）+ 项目扫描出的全部界面用字 |
| 体积 | **16.9 MB → 1.0 MB**（压缩到 5.9%），3965 字形 |
| 字重轴 | 保留完整 `wght` 100–900 可变轴，**一个文件覆盖所有字重**（若改用 3 个静态字重需 1.6 MB，故选可变字体） |
| 声明 | `@font-face { font-family: "Source Han Sans SC"; font-weight: 100 900; src: url("fonts/source-han-sans-sc-subset.woff2") format("woff2-variations"); }` |
| 兜底 | 字体栈：`"Source Han Sans SC", "Source Han Sans CN", "Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif` |
| 授权 | SIL Open Font License 1.1，允许内嵌再分发，界面已注明 |

> 注意：`style.css` 里存在**两套 CSS 变量块**（前置品牌变量 + 靠后的 `--ds-*` 覆盖块），后者的优先级更高，改字体栈/字重时**两处都要改**，否则会被覆盖回默认。

### 8.2 「关于我们 / 版权 / 联系方式」

提供**双入口**，内容一致：

| 入口 | 位置 |
| --- | --- |
| 侧栏「关于」页 | 左侧导航第 6 项，独立整页 |
| 设置弹窗「关于」页签 | 「设置」弹窗内 `常规 / 关于` 两个页签 |

内容包含：

- **应用信息**：logo、中文名「邻传 / Nearby Transfer」、简介、版本号（读 `desktop/package.json` 的 `version`）、协议号 `LTP/1`
- **运行环境**：版本 / 协议 / Electron + Chromium 版本 / 操作系统+架构
- **联系方式**：
  - 作者 `齐世有` → 纯展示信息，不可点击
  - 电子邮箱 `blacklaw@foxmail.com` → 唤起系统邮件客户端（`mailto:`）
  - 官网 `linchuan.aeback.com` → 用系统默认浏览器打开
- **版权信息**：`© 2026 邻传 Nearby Transfer · 保留所有权利` + 思源黑体 SIL OFL 1.1 授权说明

外链通过主进程 `ltp:openExternal` 打开，并做了**协议白名单**（仅放行 `http/https/mailto`），`file://`、`javascript:` 等一律拒绝，避免渲染进程被诱导执行本地程序。

功能验证（真实启动 Electron，读取字体加载状态 + 墨迹像素密度证明可变字重生效 + 点击联系方式）：

```bash
node scripts/verify-font-about.js
```

> 判断中文字体是否生效**不能用宽度对比**——汉字在思源黑体与回退字体里都占固定的 1em 宽（等宽方块字），宽度恒等。脚本改为**统计 canvas 墨迹像素**：字重越重墨迹越多，可同时证明字体被选中与可变轴生效。

---

## 九、测试

```bash
# 协议层单元测试（33 项）
node scripts/test-protocol.js

# 真机 TCP 端到端（60 项）：配对/拒绝/令牌伪造/8MB 分片/断点续传/取消/路径穿越
node scripts/test-e2e.js

# WebSocket 网关（26 项）
node scripts/test-ws.js

# 冒烟 + 静态接线检查（32 项）
NODE_PATH=desktop/node_modules node scripts/test-smoke.js

# 打包产物校验（15 项，需先 npm run build）
NODE_PATH=desktop/node_modules node scripts/verify-package.js

# 自绘标题栏 / 窗口控制（15 项，启动真实 Electron 点击验证）
node scripts/verify-win-ctrl.js

# 思源黑体加载 + 关于页/版权/联系方式（30 项，启动真实 Electron 校验）
node scripts/verify-font-about.js

# 手机端横向溢出审计（需先起 mobile 静态服务）
node scripts/overflow-audit-mobile.js http://127.0.0.1:5399/
```

**当前状态：151 项测试 + 15 项打包校验 + 15 项窗口控制校验 + 30 项字体/关于页校验全部通过**（33 + 60 + 26 + 32，打包 15，窗口控制 15，字体与关于页 30）。

---

## 十、应用图标

软件名称：**邻传 / Nearby Transfer**。图标由一份 1254×1254 的源图统一派生，避免两端视觉漂移：

```bash
# 重新生成两端全套图标（需要 Pillow）
python scripts/gen-icons.py
```

| 产物 | 尺寸 | 用途 |
|---|---|---|
| `desktop/resources/icon.png` | 512×512 | Electron 窗口 / 任务栏 |
| `desktop/resources/icon.ico` | 16…256 多尺寸 | electron-builder 安装包、exe、快捷方式 |
| `desktop/resources/tray.png` | 32×32 | 系统托盘 |
| `desktop/src/renderer/logo.png` | 128×128 | 界面顶栏 logo |
| `mobile/resources/icon.png` | 1024×1024 | Android 应用图标源 |
| `mobile/resources/icon-foreground.png` | 1024×1024 | 自适应图标前景（62% 安全区） |
| `mobile/resources/icon-background.png` | 1024×1024 | 自适应图标背景（品牌绿 `#00d283`） |
| `mobile/resources/splash[-dark].png` | 2732×2732 | 启动图（浅色 / 深色） |
| `mobile/public/icon-192.png` · `icon-512.png` | 192 / 512 | PWA / manifest |

打包时：电脑端由 `electron-builder` 的 `build.win.icon` 自动取用 `.ico`；
手机端在 `cap add android` 之后执行 `npm run cap:icon`（`@capacitor/assets`）写入 Android `res/`。

---

## 十一、安全说明

- 所有数据仅在**局域网内**两台设备间传输，**不经过任何外网服务器**。
- 未配对的设备无法建立会话，也无法发送或接收文件。
- 接收方必须**显式确认**后才会开始接收，并展示发送方设备名。
- 接收路径强制清洗，杜绝 `../` 路径穿越写入到目录之外。

---

## 十二、分发与仓库

代码仓库：<https://github.com/ShiyouQi888/Nearby-Transfer>

### 只提交源码，不提交构建产物

仓库**不承载大二进制**（安装包 / APK / 依赖 / 截图），全部由 `.gitignore` 排除：

| 排除项 | 原因 |
|---|---|
| `node_modules/` | 依赖由 `package-lock.json` 还原 |
| `desktop/release*/`、`dist-desktop/` | Electron 打包产物走 GitHub Releases |
| `mobile/dist/`、`mobile/android/**/build/` | 构建产物可重现 |
| `_shots/`、`_npmcache/` | 开发用截图与本机缓存 |

重新克隆后按「五、快速开始」还原依赖即可两端运行。

### 发行版走 GitHub Releases

Windows 安装包与 Android APK 作为 Release 附件托管，不进 git 历史：

```bash
# Windows 端：先打包
cd desktop && npm run build
# 产物：desktop/release/邻传 Setup 1.0.0.exe

# Android 端：先构建（需 JDK 17+ 与 Android SDK）
cd mobile && npm run cap:build
# 产物：mobile/android/app/build/outputs/apk/debug/app-debug.apk

# 发布 Release（附件建议用 ASCII 名，中文名会被 gh 截断）
gh release create v1.0.0 \
  "desktop/release/邻传 Setup 1.0.0.exe" \
  "mobile/android/app/build/outputs/apk/debug/app-debug.apk" \
  --title "邻传 Nearby Transfer v1.0.0" \
  --notes-file dist-mobile/RELEASE_NOTES.md
```

> **坑：`gh release create` 的 `源文件#新名字` 语法处理中文会截断** ——
> 实测 `邻传 Setup 1.0.0.exe` 会被截成 `Setup.1.0.0.exe`、`邻传-v1.0.0-debug.apk` 变成 `-v1.0.0-debug.apk`。
> 解决办法：上传后用 API 重命名（附件 ID 从
> `gh api repos/<owner>/<repo>/releases/tags/v1.0.0 --jq '.assets[] | "\(.id) \(.name)"'` 取）：
>
> ```bash
> gh api -X PATCH repos/<owner>/<repo>/releases/assets/<id> -f name="Nearby-Transfer-Setup-1.0.0.exe"
> ```

> Windows 沙箱环境下 `cap sync` 的批量清理可能被安全策略拦截，
> 此时可手动等价同步：清空 `mobile/android/app/src/main/assets/public/` 后
> 把 `mobile/dist/` 内容整体复制进去，再直接 `cd mobile/android && ./gradlew assembleDebug`。
