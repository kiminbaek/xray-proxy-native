import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '/vol3/@appshare/com.dustinky.qwenpaw/xray-ui-dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
