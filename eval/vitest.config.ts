import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from '../vite.config'

const THREE_HOURS_MS = 3 * 60 * 60 * 1000

// Kept apart from the root config so `npm test` never reaches the eval.
export default mergeConfig(
  viteConfig,
  defineConfig({
    root: fileURLToPath(new URL('..', import.meta.url)),
    test: {
      include: ['eval/prompt-eval.ts'],
      testTimeout: THREE_HOURS_MS,
      maxWorkers: 1,
      disableConsoleIntercept: true,
    },
  }),
)
