/**
 * LanBridge —— 手机端原生 Socket 桥接（JS 侧注册）
 *
 * 为什么需要它：
 *   浏览器 / 普通 WebView 无法创建原始 TCP Socket，也无法做 UDP 组播发现。
 *   本插件通过 Capacitor 自定义插件，把 Android 的 java.net.Socket 暴露给 Web 层，
 *   实现与电脑端完全一致的字节流通道（复用 LTP/1 协议）。
 *
 * 原生侧需要实现（Android/Java，见 android/app/src/main/java/.../LanBridgePlugin.java）：
 *   connect(host, port, id)   → 建立 TCP 连接
 *   send(id, base64)          → 发送二进制（以 base64 传输，规避 JS Bridge JSON 限制）
 *   close(id)                 → 关闭连接
 *   事件：
 *     data  → { id, base64 }  收到数据
 *     close → { id }          连接关闭
 *     error → { id, message } 出错
 *
 * 若未安装原生插件（如浏览器调试），window.LanBridge 不存在，
 * client.js 会自动降级到电脑端的 WebSocket 网关（ws://ip:53318/ws）。
 */

import { registerPlugin } from '@capacitor/core';

/**
 * 自定义插件定义。
 * 使用 registerPlugin 让 Capacitor 在原生环境自动桥接到 LanBridgePlugin；
 * 在 Web 环境下该对象的方法会抛错（因为没有原生实现），
 * 因此 client.js 通过 `window.LanBridge` 是否存在来判断能否走原生通道。
 */
export const LanBridge = registerPlugin('LanBridge', {
  web: () => import('./lan-bridge.web.js').then((m) => new m.LanBridgeWeb()),
});

/**
 * 安装到 window：让不依赖 ESM 的 client.js 也能探测到原生能力。
 * 在 Capacitor 原生环境中，registerPlugin 返回的代理对象会直接转发到原生。
 */
export function installLanBridge() {
  if (typeof window === 'undefined') return;
  try {
    window.LanBridge = {
      connect: (host, port, id) => LanBridge.connect({ host, port, id }),
      send: (id, base64) => LanBridge.send({ id, base64 }),
      close: (id) => LanBridge.close({ id }),
      onData: (cb) => LanBridge.addListener('data', (e) => cb(e)),
      onClose: (cb) => LanBridge.addListener('close', (e) => cb(e)),
      onError: (cb) => LanBridge.addListener('error', (e) => cb(e)),
    };
  } catch (_) { /* Web 环境忽略 */ }
}
