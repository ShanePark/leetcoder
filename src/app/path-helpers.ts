/**
 * Match a backend source path against the currently open repository-relative
 * path. Gradle/JUnit may report an absolute path, a repository suffix, or
 * only the Java basename depending on where the failure was discovered.
 */
export function sourcePathsMatch(selectedPath: string, reportedPath: string): boolean {
  const selected = normalizeSourcePath(selectedPath)
  const reported = normalizeSourcePath(reportedPath)
  if (!selected || !reported) {
    return false
  }
  if (selected === reported || selected.endsWith(`/${reported}`) || reported.endsWith(`/${selected}`)) {
    return true
  }
  // A basename-only report is common in JUnit stack traces. Once the
  // backend gives us directory information, require the suffix match above
  // so two unrelated files with the same name cannot mark this editor.
  return !reported.includes('/') && sourceBasename(selected) === reported
}

export function normalizeSourcePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .toLocaleLowerCase()
}

export function sameFilePath(left: string, right: string): boolean {
  return normalizeSourcePath(left) === normalizeSourcePath(right)
}

export function sourceBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function validSourceLine(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  const line = Math.trunc(value)
  return line > 0 ? line : null
}

export function validSourceColumn(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  const column = Math.trunc(value)
  return column > 0 ? column : null
}

export function gitFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

export function gitDirectoryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  const separator = normalized.lastIndexOf('/')
  return separator > 0 ? normalized.slice(0, separator) : ''
}

export function fqcnFromJavaPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const root = 'src/main/java/'
  const rootIndex = normalized.indexOf(root)
  if (rootIndex < 0 || !normalized.toLowerCase().endsWith('.java')) {
    return null
  }
  return normalized
    .slice(rootIndex + root.length, -'.java'.length)
    .split('/')
    .filter(Boolean)
    .join('.')
}
