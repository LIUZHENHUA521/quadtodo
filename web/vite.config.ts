import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// dev 时前端跑 5173，API/WS proxy 到 5677 上的后端
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5677',
      '/ws': { target: 'ws://127.0.0.1:5677', ws: true },
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
})
