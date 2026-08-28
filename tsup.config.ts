import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['bin/debob.ts', 'src/**/*.ts'],
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
  // Exclude test/spec files
  esbuildOptions(options) {
    options.conditions = ['node']
  },
})
