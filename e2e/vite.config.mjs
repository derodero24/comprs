import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      'zflate-wasm32-wasi': fileURLToPath(new URL('../zflate.wasi-browser.js', import.meta.url)),
    },
  },
  server: {
    port: 4567,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
