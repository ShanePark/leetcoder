const BASE_PACKAGE = 'shane.leetcode.problems'

/** Render the repository's intentionally unfinished Java problem template. */
export function renderJavaProblemSource(
  packageName: string,
  className: string,
  methodSignature: string | null,
): string {
  const lines = [
    `package ${packageName};`,
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'import static org.assertj.core.api.Assertions.assertThat;',
    '',
    `public class ${className} {`,
    '',
    '    @Test',
    '    public void test() {',
    '        assertThat()',
    '    }',
  ]

  if (methodSignature) {
    const normalizedSignature = methodSignature
      .trim()
      .replace(/\s*\{\s*$/, '')
      .replace(/\s+/g, ' ')
    if (normalizedSignature.length > 0) {
      lines.push('', `    ${normalizedSignature} {`, '', '    }')
    }
  }

  lines.push('}', '')
  return lines.join('\n')
}

export { BASE_PACKAGE }
