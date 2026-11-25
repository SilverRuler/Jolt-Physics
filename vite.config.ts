import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ['jolt-physics'],
  },
  server: {
    port: 4000,
    host: true,
  },
  build: {
    target: 'es2022',
  },
});
