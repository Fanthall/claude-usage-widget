import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default']
  },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
})
