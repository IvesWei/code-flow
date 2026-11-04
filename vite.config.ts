import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, normalizePath } from 'vite'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'DATA_DIR')
  const dataDirectory = normalizePath(resolve(process.env.DATA_DIR || environment.DATA_DIR || 'data'))
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5174,
      proxy: { '/api': 'http://127.0.0.1:3001' },
      watch: {
        ignored: [
          '**/data/**',
          '**/dist-server/**',
          '**/server/**',
          '**/docs/**',
          (path: string) => {
            const normalized = normalizePath(resolve(path))
            return normalized === dataDirectory || normalized.startsWith(`${dataDirectory}/`)
          },
        ],
      },
    },
  }
})
