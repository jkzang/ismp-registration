import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Keep the browser's Host header so Django's CSRF origin check sees one origin.
      '/api': { target: 'http://localhost:8000', changeOrigin: false },
    },
  },
})
