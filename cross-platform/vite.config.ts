import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [
    {
      name: 'inject-app-version',
      transformIndexHtml(html) {
        return html.replaceAll('%APP_VERSION%', packageJson.version);
      }
    },
    vue()
  ],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
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
  // The application bundle is kept as an IIFE for the desktop/web entrypoint,
  // but download workers must be emitted as real ES modules.  A module Worker
  // cannot reliably execute an IIFE bundle in Safari, Edge, or static hosting.
  worker: {
    format: 'es'
  },
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
