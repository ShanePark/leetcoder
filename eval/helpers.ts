import { javaLanguage } from '@codemirror/lang-java'
import { findJavaTestBlock } from '../src/editor/test-markers'

const ASSERT_THAT_IMPORT = 'import static org.assertj.core.api.Assertions.assertThat;'
const MAX_DETAIL_LINES = 6
const MAX_DETAIL_LENGTH = 300

/**
 * Turn a solved file back into what the button expects: `test()` is the bare stub,
 * and `assertThat` is imported as the template does, since older solved files use
 * `Assertions.assertThat` or nothing. Other tests stay, because they are never run.
 */
export function resetTestBody(source: string): string {
  const block = findJavaTestBlock(source, javaLanguage.parser.parse(source).topNode)
  if (!block) {
    throw new Error('The source has no @Test method named test.')
  }
  const reset = `${source.slice(0, block.from)}{\n        assertThat()\n    }${source.slice(block.to)}`
  return reset.includes(ASSERT_THAT_IMPORT) ? reset : addImport(reset)
}

function addImport(source: string): string {
  const imports = [...source.matchAll(/^import [^\n]*;$/gm)]
  const last = imports.at(-1)
  if (!last) {
    throw new Error('The source has no import block.')
  }
  const end = last.index + last[0].length
  return `${source.slice(0, end)}\n${ASSERT_THAT_IMPORT}${source.slice(end)}`
}

/** The class a source file declares, from its package line and file name. */
export function fullyQualifiedClassName(source: string, path: string): string {
  const packageName = /^package\s+([\w.]+);/m.exec(source)?.[1]
  if (!packageName) {
    throw new Error(`No package line in ${path}.`)
  }
  return `${packageName}.${path.slice(path.lastIndexOf('/') + 1).replace(/\.java$/, '')}`
}

/** How many examples the problem shows, so a test can be held to all of them. */
export function countExamples(content: string): number {
  const numbers = [...content.matchAll(/\bExample(?:\s+(\d+))?\s*:/g)].map((match) => match[1] ?? '1')
  return new Set(numbers).size
}

/**
 * How many scenarios the statements exercise: calls to the entry method, or for a
 * design problem, the instances of its class.
 */
export function countScenarios(
  statements: readonly string[],
  entryPoint: string | null,
  javaSnippet: string | null,
): number {
  const pattern = scenarioPattern(entryPoint, javaSnippet)
  return pattern
    ? statements.reduce((total, statement) => total + [...statement.matchAll(pattern)].length, 0)
    : 0
}

function scenarioPattern(entryPoint: string | null, javaSnippet: string | null): RegExp | null {
  const method = entryPoint && /(\w+)\s*\(/.exec(entryPoint)?.[1]
  if (method) {
    return new RegExp(`\\b${method}\\s*\\(`, 'g')
  }
  const code = javaSnippet?.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const designClass = code && /\bclass\s+(\w+)/.exec(code)?.[1]
  return designClass ? new RegExp(`\\bnew\\s+${designClass}\\s*\\(`, 'g') : null
}

export type Verdict =
  | { kind: 'pass' }
  | { kind: 'compile' | 'assertion' | 'timeout' | 'tool'; details: string[] }

/** One line of `eval/JavaGradeRunner.java`'s results. */
export interface RunnerResult {
  status: 'pass' | 'compile' | 'failure' | 'timeout' | 'tool'
  detail: string
}

/** Separate what the model got wrong from what is wrong with the tool. */
export function classifyRunnerResult({ status, detail }: RunnerResult): Verdict {
  switch (status) {
    case 'pass': return { kind: 'pass' }
    case 'compile': return { kind: 'compile', details: compileErrors(detail) }
    case 'failure': return { kind: 'assertion', details: [detail.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH)] }
    default: return { kind: status, details: [detail] }
  }
}

function compileErrors(output: string): string[] {
  const lines = output.split('\n')
  const details: string[] = []
  lines.forEach((line, index) => {
    if (!/: error: /.test(line)) return
    const location = line.slice(line.lastIndexOf('/') + 1)
    details.push(location, ...lines.slice(index + 1, index + 3).map((next) => next.trimEnd()))
  })
  return (details.length > 0 ? details : lines.filter(Boolean)).slice(0, MAX_DETAIL_LINES)
}
