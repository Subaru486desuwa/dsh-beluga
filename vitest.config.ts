import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/plugin/tests/**/*.spec.ts', 'packages/plugin/tests/**/*.spec.tsx'], testTimeout: 20000, hookTimeout: 30000 } })
