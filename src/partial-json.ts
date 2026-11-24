/** The text ended before a value could start, or while a literal or number was still unclear. */
const NOTHING = Symbol('nothing')

class SyntaxProblem extends Error {}

interface Parsed {
  value: unknown
  /** The value's closing text arrived. */
  complete: boolean
}

/**
 * Parse a JSON document that is still arriving. The text may stop anywhere: an
 * open string keeps the characters so far, open arrays and objects are closed
 * where the text stops, and a key without a value, a dangling comma, a cut
 * escape, or a literal or number that could still grow is left out. Returns
 * undefined when nothing usable has arrived or the text is not JSON.
 */
export function parsePartialJson(text: string): unknown {
  const parser = new PartialJsonParser(text)
  try {
    const parsed = parser.value()
    if (parsed === NOTHING) return undefined
    if (parsed.complete && !parser.atEnd()) return undefined
    return parsed.value
  } catch (error) {
    if (error instanceof SyntaxProblem) return undefined
    throw error
  }
}

class PartialJsonParser {
  private position = 0

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    this.skipWhitespace()
    return this.position >= this.text.length
  }

  value(): Parsed | typeof NOTHING {
    if (this.atEnd()) return NOTHING
    const char = this.text[this.position]
    if (char === '{') return this.object()
    if (char === '[') return this.array()
    if (char === '"') return this.string()
    if (char === '-' || (char >= '0' && char <= '9')) return this.number()
    return this.literal()
  }

  private object(): Parsed {
    this.position += 1
    const value: Record<string, unknown> = {}
    const open = { value, complete: false }
    if (this.atEnd()) return open
    if (this.text[this.position] === '}') {
      this.position += 1
      return { value, complete: true }
    }
    for (;;) {
      if (this.atEnd()) return open
      if (this.text[this.position] !== '"') throw new SyntaxProblem()
      const key = this.string()
      if (!key.complete || this.atEnd()) return open
      if (this.text[this.position] !== ':') throw new SyntaxProblem()
      this.position += 1
      const entry = this.value()
      if (entry === NOTHING) return open
      value[key.value as string] = entry.value
      if (!entry.complete || this.atEnd()) return open
      const next = this.text[this.position]
      this.position += 1
      if (next === '}') return { value, complete: true }
      if (next !== ',') throw new SyntaxProblem()
    }
  }

  private array(): Parsed {
    this.position += 1
    const value: unknown[] = []
    const open = { value, complete: false }
    if (this.atEnd()) return open
    if (this.text[this.position] === ']') {
      this.position += 1
      return { value, complete: true }
    }
    for (;;) {
      const item = this.value()
      if (item === NOTHING) return open
      value.push(item.value)
      if (!item.complete || this.atEnd()) return open
      const next = this.text[this.position]
      this.position += 1
      if (next === ']') return { value, complete: true }
      if (next !== ',') throw new SyntaxProblem()
    }
  }

  private string(): Parsed {
    this.position += 1
    let value = ''
    while (this.position < this.text.length) {
      const char = this.text[this.position]
      if (char === '"') {
        this.position += 1
        return { value, complete: true }
      }
      if (char !== '\\') {
        value += char
        this.position += 1
        continue
      }
      const escape = this.text[this.position + 1]
      if (escape === undefined) break
      if (escape === 'u') {
        const hex = this.text.slice(this.position + 2, this.position + 6)
        if (hex.length < 4) break
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxProblem()
        value += String.fromCharCode(parseInt(hex, 16))
        this.position += 6
        continue
      }
      const decoded = ESCAPES[escape]
      if (decoded === undefined) throw new SyntaxProblem()
      value += decoded
      this.position += 2
    }
    this.position = this.text.length
    return { value: withoutLoneHighSurrogate(value), complete: false }
  }

  private number(): Parsed | typeof NOTHING {
    const rest = this.text.slice(this.position)
    // A number that reaches the end of the text could still grow.
    if (/^-?(?:\d+(?:\.\d*)?(?:[eE][+-]?\d*)?)?$/.test(rest)) {
      this.position = this.text.length
      return NOTHING
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
    if (!match) throw new SyntaxProblem()
    this.position += match[0].length
    return { value: Number(match[0]), complete: true }
  }

  private literal(): Parsed | typeof NOTHING {
    const rest = this.text.slice(this.position)
    for (const [word, value] of LITERALS) {
      if (rest.startsWith(word)) {
        this.position += word.length
        return { value, complete: true }
      }
      if (word.startsWith(rest)) {
        this.position = this.text.length
        return NOTHING
      }
    }
    throw new SyntaxProblem()
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length && ' \t\n\r'.includes(this.text[this.position])) {
      this.position += 1
    }
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

const LITERALS: ReadonlyArray<readonly [string, unknown]> = [
  ['true', true],
  ['false', false],
  ['null', null],
]

/** A string cut between the halves of an escaped surrogate pair drops the first half. */
function withoutLoneHighSurrogate(value: string): string {
  const last = value.charCodeAt(value.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value
}
