import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['jolt-physics'],
  },
  server: {
    port: 4000,
    host: true,
    proxy: {
      '/api': {
        target: 'https://win.silverruler.xyz',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
  },
});
