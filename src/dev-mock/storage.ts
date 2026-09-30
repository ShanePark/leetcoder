const MOCK_REPO_PATH = '/Users/shane/ps'

/** localStorage-compatible seeded store so the mock boots into a loaded repo. */
export function createDevMockStorage(): Storage {
  const data = new Map<string, string>([
    ['leetcoder.repository-path', MOCK_REPO_PATH],
  ])
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key)
    },
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}
