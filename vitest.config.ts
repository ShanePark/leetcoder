import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Keep split suites and javac subprocesses from oversubscribing resources.
      maxWorkers: 4,
    },
  }),
)
