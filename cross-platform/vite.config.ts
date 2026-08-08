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
  // Workers must be emitted as ES modules. The application entrypoint remains
  // an IIFE so the built page can still be opened from file:// on Windows.
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
