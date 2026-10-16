import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// 构建产物直接落进 ../web(server/app.mjs 的 serveStatic 原样服务那个目录,无缓存、
// 刷新浏览器立即生效,不用重启 Node 进程)。开发态 `npm run dev` 单独起一个端口(默认 5173),
// 服务端(:8890)完全没有 CORS 头,所以 /auth、/api 必须转发过去,否则浏览器直接拦。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/auth': 'http://localhost:8890',
      '/api': 'http://localhost:8890',
    },
  },
})
