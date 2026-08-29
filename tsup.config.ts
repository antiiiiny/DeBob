import { defineConfig } from 'tsup'

export default defineConfig({
  // The negations are load-bearing: without them vitest specs get compiled into dist/
  // and shipped with the package.
  entry: ['bin/debob.ts', 'src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.spec.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  target: 'node18',
  platform: 'node',
  outDir: 'dist',
  esbuildOptions(options) {
    options.conditions = ['node']
  },
})
