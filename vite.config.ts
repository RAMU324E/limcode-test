import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { WEBVIEW_DEV_PORT } from './shared/extensionIdentity';

export default defineConfig({
  root: 'webview',
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@webview': path.resolve(__dirname, 'webview/src'),
      '@shared': path.resolve(__dirname, 'shared')
    }
  },
  server: {
    host: '127.0.0.1',
    port: WEBVIEW_DEV_PORT,
    strictPort: true,
    cors: true,
    hmr: {
      host: 'localhost',
      clientPort: WEBVIEW_DEV_PORT
    }
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'webview/index.html'),
        sidebar: path.resolve(__dirname, 'webview/sidebar.html')
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
