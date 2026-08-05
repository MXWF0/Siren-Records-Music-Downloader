import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: './',
  clearScreen: false,
  server: {
    strictPort: true,
    host: true
  },
  preview: {
    host: true,
    strictPort: true
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome105', 'safari13'],
    rollupOptions: {
      output: {
        format: 'iife',
        name: 'SirenRecordsApp',
        inlineDynamicImports: true
      }
    }
  }
});
