import { describe, expect, it } from 'vitest'
import { collectDiagnosticEditorIssues } from '../../../src/app/test-results'

describe('compiler issue mapping', () => {
  it('preserves compiler snippets and distinct messages at the same position', () => {
    const diagnostic = {
      severity: 'error',
      file: 'src/main/java/Q1.java',
      line: 3,
      column: 9,
      message: "')' expected",
      sourceLine: '  call(value;',
      caret: '        ^',
    }
    const issues = collectDiagnosticEditorIssues([
      diagnostic,
      { ...diagnostic, message: 'illegal start of expression' },
      { ...diagnostic, message: "  ')' expected  " },
      { ...diagnostic, severity: 'warning' },
      { ...diagnostic, file: 'src/main/java/Q2.java' },
    ], 'src/main/java/Q1.java')

    expect(issues).toEqual([
      {
        file: 'src/main/java/Q1.java', line: 3, column: 9,
        message: "')' expected", sourceLine: '  call(value;', caret: '        ^',
      },
      {
        file: 'src/main/java/Q1.java', line: 3, column: 9,
        message: 'illegal start of expression', sourceLine: '  call(value;', caret: '        ^',
      },
    ])
  })
})
