import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' assert { type: 'json' };

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: '/vol3/@appshare/com.dustinky.qwenpaw/xray-ui-dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
