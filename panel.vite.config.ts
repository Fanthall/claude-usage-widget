import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Panel: tek sayfa. Ayni cikti iki yerde kullanilir: merkez (Docker) onu ev
 * agindan sunar, widget onu kendi panel penceresinde acar. `base: './'`
 * ikisinde de goreli yol demek (merkezde `/`, Electron'da `file://`).
 */
export default defineConfig({
  root: resolve(__dirname, 'src/panel'),
  base: './',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  build: {
    outDir: resolve(__dirname, 'out/panel'),
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false
  }
})
