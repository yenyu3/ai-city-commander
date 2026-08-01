import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_API_PROXY_TARGET
  const publicResultsTarget = env.VITE_PUBLIC_RESULTS_BASE_URL

  const proxy: Record<string, { target: string; changeOrigin: true }> = {}
  if (proxyTarget) proxy['/api'] = { target: proxyTarget, changeOrigin: true }
  if (publicResultsTarget) proxy['/public'] = { target: publicResultsTarget, changeOrigin: true }

  return {
    plugins: [react()],
    server: Object.keys(proxy).length ? { proxy } : undefined,
  }
})
