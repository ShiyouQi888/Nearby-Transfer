/**
 * LanBridge 的 Web 兜底实现。
 *
 * 浏览器环境没有原始 TCP 能力，这里所有方法都抛错，
 * 目的是让 registerPlugin 的 web 分支行为明确——真正的降级逻辑
 * 由 client.js 的 openSocket() 决定（走 WebSocket 网关）。
 */
export class LanBridgeWeb {
  async connect() { throw new Error('Web 环境不支持原生 Socket，请改用 WebSocket 网关'); }
  async send() { throw new Error('Web 环境不支持原生 Socket'); }
  async close() { /* noop */ }
  async addListener() { return { remove: async () => {} }; }
  async removeAllListeners() { /* noop */ }
}
