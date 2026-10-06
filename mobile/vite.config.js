import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * 手机端构建配置
 *
 * 关键点：
 *  1) 共享协议层 shared/protocol.js 位于仓库根目录（mobile 之外），
 *     因此必须把「仓库根目录」加入 server.fs.allow，否则 dev server 会拒绝加载。
 *  2) 用别名 @shared 指向共享协议，避免深层相对路径（../../..）到处乱飞。
 *  3) dev 端口固定 5175（规避本机 5173/5174 常被其他项目占用）。
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    fs: {
      // 允许读取仓库根目录（含 shared/）
      allow: [repoRoot],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
  },
});
