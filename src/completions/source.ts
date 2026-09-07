import {
  JAVA_KEYWORDS,
  TYPE_GROUPS,
  type JavaDefinition,
  type JavaIdentifier,
  type JavaIterableCandidate,
  type JavaMethod,
  type JavaSymbol,
} from './model'

function visibleJavaSymbols(symbols: JavaSymbol[], position: number): JavaSymbol[] {
  const visible = symbols.filter((symbol) => symbol.scopeStart <= position
    && position <= symbol.scopeEnd
    && (symbol.kind === 'field' || symbol.declaredAt <= position))
  const byName = new Map<string, JavaSymbol>()
  for (const symbol of visible) {
    const current = byName.get(symbol.name)
    if (!current) {
      byName.set(symbol.name, symbol)
      continue
    }
    const symbolWidth = symbol.scopeEnd - symbol.scopeStart
    const currentWidth = current.scopeEnd - current.scopeStart
    if (symbolWidth < currentWidth || (symbolWidth === currentWidth && symbol.declaredAt > current.declaredAt)) {
      byName.set(symbol.name, symbol)
    }
  }
  return [...byName.values()]
}

const IRREGULAR_SINGULARS: Readonly<Record<string, string>> = {
  children: 'child',
  feet: 'foot',
  geese: 'goose',
  indices: 'index',
  matrices: 'matrix',
  men: 'man',
  people: 'person',
  teeth: 'tooth',
  vertices: 'vertex',
  women: 'woman',
}

function singularIdentifier(name: string): string {
  const match = /^(.*?)([A-Za-z_$][\w$]*)$/.exec(name)
  if (!match) return name
  const prefix = match[1]
  const word = match[2]
  const lower = word.toLowerCase()
  const irregular = IRREGULAR_SINGULARS[lower]
  if (irregular) return `${prefix}${irregular}`
  if (lower.endsWith('ies') && word.length > 3) return `${prefix}${word.slice(0, -3)}y`
  if (lower.endsWith('ses') && word.length > 3) return `${prefix}${word.slice(0, -2)}`
  if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us') && !lower.endsWith('is')) {
    return `${prefix}${word.slice(0, -1)}`
  }
  return name
}

function typeVariableName(elementType: string | undefined): string {
  if (!elementType) return 'item'
  if (elementType.endsWith('[]')) return 'row'
  const base = simpleTypeName(elementType.replace(/<.*>/, ''))
  if (!base) return 'item'
  const candidate = `${base[0].toLowerCase()}${base.slice(1)}`
  return JAVA_KEYWORDS.includes(candidate) ? 'item' : candidate
}

function uniqueVariableName(base: string, symbols: JavaSymbol[], position: number): string {
  if (JAVA_KEYWORDS.includes(base)) base = 'item'
  const used = new Set(visibleJavaSymbols(symbols, position).map((symbol) => symbol.name))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}${suffix}`)) suffix += 1
  return `${base}${suffix}`
}

function iterVariableName(target: string, elementType: string | undefined, symbols: JavaSymbol[], position: number): string {
  const targetName = target.split('.').at(-1) ?? target
  const singular = singularIdentifier(targetName)
  const base = singular !== targetName ? singular : typeVariableName(elementType)
  return uniqueVariableName(base || 'item', symbols, position)
}

function isIterableSymbol(symbol: JavaSymbol): boolean {
  const declaredType = symbol.declaredType
  if (declaredType && declaredType !== 'var') {
    // The declared type controls whether enhanced-for is legal. Initializer
    // bases are still collected for member completion, so they must not make
    // an Object or other unrelated declaration look iterable here.
    if (declaredType.includes('[]')) return symbol.bases.includes('array')
    if (!isIterableType(declaredType)) return false
  }
  return symbol.bases.includes('array') || symbol.bases.includes('Iterable')
}

/** Return iterable values visible at a Java cursor, with loop defaults inferred. */
export function javaIterableCandidates(source: string, position = source.length): JavaIterableCandidate[] {
  const symbols = collectJavaSymbols(source, position)
  const masked = maskJavaCommentsAndLiterals(source)
  const codeSymbols = symbols.filter((symbol) => masked.slice(symbol.declaredAt, symbol.declaredAt + symbol.name.length)
    === source.slice(symbol.declaredAt, symbol.declaredAt + symbol.name.length))
  return visibleJavaSymbols(codeSymbols, position)
    .filter(isIterableSymbol)
    .sort((left, right) => {
      const leftKind = left.kind === 'field' ? 0 : 1
      const rightKind = right.kind === 'field' ? 0 : 1
      return rightKind - leftKind || right.declaredAt - left.declaredAt
    })
    .map((symbol) => ({
      name: symbol.name,
      ...(symbol.elementType ? { elementType: symbol.elementType } : {}),
      variableName: iterVariableName(symbol.name, symbol.elementType, codeSymbols, position),
    }))
}

function normalizeType(raw: string): string {
  return raw
    .replace(/@\w+(?:\([^)]*\))?\s*/g, '')
    .replace(/\b(?:final|volatile|transient)\s+/g, '')
    .replace(/\s+/g, '')
    .replace(/\.\.\./g, '[]')
}

export function simpleTypeName(raw: string): string {
  return raw.replace(/\[\]/g, '').split('.').at(-1) ?? raw
}

export function baseType(raw: string): string {
  const normalized = normalizeType(raw).replace(/\[\]/g, '')
  const generic = normalized.indexOf('<')
  return (generic >= 0 ? normalized.slice(0, generic) : normalized).replace(/^\?extends/, '')
}

function genericArguments(raw: string): string[] {
  const normalized = normalizeType(raw)
  const opening = normalized.indexOf('<')
  if (opening < 0) return []
  let depth = 0
  for (let index = opening; index < normalized.length; index += 1) {
    if (normalized[index] === '<') {
      depth += 1
    } else if (normalized[index] === '>') {
      depth -= 1
      if (depth === 0) {
        return splitTopLevel(normalized.slice(opening + 1, index))
      }
    }
  }
  return []
}

export function isIterableType(raw: string): boolean {
  const base = simpleTypeName(baseType(raw))
  return base === 'Iterable' || (TYPE_GROUPS[base] ?? []).includes('Iterable')
}

function cleanElementType(raw: string): string | null {
  const normalized = normalizeType(raw)
  if (!normalized || normalized === '?') return 'Object'
  if (normalized.startsWith('?extends')) return normalized.slice('?extends'.length) || 'Object'
  if (normalized.startsWith('?super')) return 'Object'
  return normalized
    .replace(/\?extends(?=[A-Za-z_$])/g, '? extends ')
    .replace(/\?super(?=[A-Za-z_$])/g, '? super ')
}

function literalElementType(raw: string): string | null {
  const value = raw.trim()
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return 'String'
  if (/^'(?:[^'\\]|\\.)*'$/.test(value)) return 'Character'
  if (/^(?:true|false)$/.test(value)) return 'Boolean'
  if (/^[+-]?\d+[lL]$/.test(value)) return 'Long'
  if (/^[+-]?(?:\d+\.\d*[dD]?|\d+[dD])$/.test(value)) return 'Double'
  if (/^[+-]?\d+$/.test(value)) return 'Integer'
  return null
}

function initializerElementType(initializer: string): string | null {
  const value = initializer.trim()
  const array = /^new\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\[[^\]]*\]\s*)+/.exec(value)
  if (array) {
    const dimensions = array[0].match(/\[[^\]]*\]/g)?.length ?? 1
    return `${normalizeType(array[1])}${'[]'.repeat(Math.max(0, dimensions - 1))}`
  }

  const created = /\bnew\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;{}()]*>)?)/.exec(value)
  if (created) {
    const typeArguments = genericArguments(created[1])
    if (typeArguments.length > 0) return cleanElementType(typeArguments[0])
  }

  const factory = /\b(?:Arrays\s*\.\s*asList|List\s*\.\s*of|Set\s*\.\s*of|Collections\s*\.\s*singletonList)\s*\(([^)]*)\)/.exec(value)
  if (factory) {
    const first = splitTopLevel(factory[1])[0]
    if (first) return literalElementType(first) ?? initializerElementType(first)
  }
  return literalElementType(value)
}

function inferElementType(typeText: string, initializer: string | undefined): string | undefined {
  const normalized = normalizeType(typeText)
  let element: string | null = null
  const array = normalized.indexOf('[]')
  if (array >= 0) {
    // Remove one array dimension. A two-dimensional array therefore iterates
    // over rows (`int[]`), just as Java's enhanced-for loop does.
    element = normalized.slice(0, array) + normalized.slice(array + 2)
  } else if (normalized !== 'var' && isIterableType(normalized)) {
    element = genericArguments(normalized)[0] ?? null
  }
  // An initializer can supply the type for `var`, but Java's declared type is
  // authoritative for explicit raw or unrelated declarations.
  if (!element && initializer && normalized === 'var') element = initializerElementType(initializer)
  const cleaned = element ? cleanElementType(element) : null
  return cleaned || undefined
}

function inferBases(typeText: string, initializer: string | undefined): string[] {
  const normalized = normalizeType(typeText)
  const declared = baseType(normalized)
  const bases = new Set<string>()
  const addBase = (base: string): void => {
    if (!base) return
    bases.add(base)
    const simple = simpleTypeName(base)
    if (simple && simple !== base) bases.add(simple)
  }
  if (declared && declared !== 'var') {
    addBase(declared)
  }
  if (initializer) {
    const newMatch = /\bnew\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;{}()]*>)?)/.exec(initializer)
    if (newMatch) {
      addBase(baseType(newMatch[1]))
    }
    if (/^\s*"(?:[^"\\]|\\.)*"/.test(initializer) || /^\s*'/.test(initializer)) bases.add('String')
    if (/\b(?:Arrays\s*\.\s*asList|List\s*\.\s*of|Collections\s*\.\s*(?:emptyList|singletonList))\s*\(/.test(initializer)) addBase('List')
    if (/\b(?:Set\s*\.\s*of)\s*\(/.test(initializer)) addBase('Set')
    if (/\bMap\s*\.\s*of(?:Entries)?\s*\(/.test(initializer)) addBase('Map')
    if (/^\s*new\s+[A-Za-z_$][\w$]*\s*\[/.test(initializer)) bases.add('array')
  }
  if (normalized.endsWith('[]')) bases.add('array')
  const expanded = new Set<string>()
  for (const base of bases) {
    for (const group of TYPE_GROUPS[base] ?? [base]) expanded.add(group)
  }
  return [...expanded]
}

function matchingBraces(source: string): { openToClose: Map<number, number>; closeToOpen: Map<number, number> } {
  const openToClose = new Map<number, number>()
  const closeToOpen = new Map<number, number>()
  const stack: number[] = []
  const masked = maskJavaCommentsAndLiterals(source)
  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i]
    if (char === '{') stack.push(i)
    if (char === '}') {
      const open = stack.pop()
      if (open !== undefined) {
        openToClose.set(open, i)
        closeToOpen.set(i, open)
      }
    }
  }
  return { openToClose, closeToOpen }
}

function enclosingScope(position: number, braces: ReturnType<typeof matchingBraces>): { start: number; end: number; depth: number } {
  const containing = [...braces.openToClose.entries()]
    .filter(([open, close]) => open < position && position < close)
  if (containing.length === 0) return { start: 0, end: Number.MAX_SAFE_INTEGER, depth: 0 }
  // The map is populated as closing braces are found, so insertion order is
  // innermost-first. Select the narrowest scope explicitly and count all
  // containing blocks for reliable field-vs-local classification.
  const [open, close] = containing.reduce((best, current) => {
    const bestWidth = best[1] - best[0]
    const currentWidth = current[1] - current[0]
    return currentWidth < bestWidth ? current : best
  })
  return { start: open + 1, end: close, depth: containing.length }
}

function splitTopLevel(value: string): string[] {
  const result: string[] = []
  let start = 0
  let angle = 0
  let paren = 0
  let bracket = 0
  let quote = ''
  let escaped = false
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      continue
    }
    if (char === '<') angle += 1
    else if (char === '>' && angle > 0) angle -= 1
    else if (char === '(') paren += 1
    else if (char === ')' && paren > 0) paren -= 1
    else if (char === '[') bracket += 1
    else if (char === ']' && bracket > 0) bracket -= 1
    else if (char === ',' && angle === 0 && paren === 0 && bracket === 0) {
      result.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  result.push(value.slice(start).trim())
  return result.filter(Boolean)
}

function parameterNameAndType(parameter: string): { name: string; type: string } | null {
  const clean = parameter
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/g, ' ')
    .replace(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*/g, '')
    .replace(/\bfinal\s+/g, '')
    .trim()
  const match = /^(.*?)\s+([A-Za-z_$][\w$]*)(\s*(?:\[\s*\])*)$/.exec(clean)
  if (!match) return null
  if (clean.includes(':')) return null
  if (/^(?:if|while|switch|catch|for)$/.test(match[1].trim())) return null
  return { type: `${match[1].trim()}${match[3] ?? ''}`, name: match[2] }
}

function extractParameters(source: string, position: number, braces: ReturnType<typeof matchingBraces>): JavaSymbol[] {
  const result: JavaSymbol[] = []
  const methodBody = /\(([^(){}]*)\)\s*(?:throws\s+[^{}]+)?\{/g
  let match: RegExpExecArray | null
  while ((match = methodBody.exec(source))) {
    const openBrace = methodBody.lastIndex - 1
    const closeBrace = braces.openToClose.get(openBrace) ?? source.length
    if (!(openBrace < position && position < closeBrace)) continue
    const parameters = splitTopLevel(match[1])
    for (const parameter of parameters) {
      const parsed = parameterNameAndType(parameter)
      if (!parsed) continue
      const nameStart = match.index + match[0].indexOf(parsed.name)
      const elementType = inferElementType(parsed.type, undefined)
      result.push({
        name: parsed.name,
        bases: inferBases(parsed.type, undefined),
        declaredType: normalizeType(parsed.type),
        ...(elementType ? { elementType } : {}),
        kind: 'parameter',
        declaredAt: nameStart,
        scopeStart: openBrace + 1,
        scopeEnd: closeBrace,
      })
    }
  }
  return result
}

function extractDeclarations(source: string, position: number, braces: ReturnType<typeof matchingBraces>): JavaSymbol[] {
  const result: JavaSymbol[] = []
  // A declaration starts after a statement/block boundary. Keeping the
  // boundary in the expression avoids treating method calls as declarations.
  const declaration = /(?:^|[;{}])\s*(?:(?:public|private|protected|static|final|volatile|transient|synchronized)\s+)*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;{}=]*?>)?\s*(?:\[\s*\])*)\s+([^;{}]+);/gm
  // Primitive names are legal declaration types even though Java classifies
  // them as keywords. Only these statement/control-flow words invalidate the
  // first token of a declaration match.
  const reserved = new Set(['return', 'throw', 'new', 'case', 'default', 'if', 'for', 'while', 'switch', 'do', 'else', 'try', 'catch'])
  let match: RegExpExecArray | null
  while ((match = declaration.exec(source))) {
    const typeText = match[1].trim()
    const typeBase = baseType(typeText)
    if (reserved.has(typeBase) || typeBase === 'void') continue
    const declarators = splitTopLevel(match[2])
    const boundaryOffset = match[0].indexOf(typeText)
    const declarationStart = match.index + Math.max(0, boundaryOffset)
    const scope = enclosingScope(declarationStart, braces)
    for (const declarator of declarators) {
      const variable = /^([A-Za-z_$][\w$]*)(\s*(?:\[\s*\])*)?(?:\s*=\s*([\s\S]*))?$/.exec(declarator)
      if (!variable) continue
      const declaredAt = match.index + match[0].indexOf(variable[1], boundaryOffset)
      const isField = scope.depth <= 1
      // Fields are visible throughout the class, including from methods
      // written before the field declaration. Local variables still obey the
      // normal declaration-before-use rule.
      if (declaredAt > position && !isField) continue
      const variableType = `${typeText}${variable[2] ?? ''}`
      const elementType = inferElementType(variableType, variable[3])
      result.push({
        name: variable[1],
        bases: inferBases(variableType, variable[3]),
        declaredType: normalizeType(variableType),
        ...(elementType ? { elementType } : {}),
        kind: isField ? 'field' : 'local',
        declaredAt,
        scopeStart: scope.start,
        scopeEnd: scope.end,
      })
    }
  }
  // `for (int i = 0; ...` has a parenthesis boundary rather than a statement
  // boundary. It is common enough in LeetCode solutions to handle separately.
  const forDeclaration = /\bfor\s*\(\s*(?:final\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;(){}]*?>)?\s*(?:\[\s*\])*)\s+([A-Za-z_$][\w$]*)(\s*(?:\[\s*\])*)\s*=\s*([^;]*)/g
  while ((match = forDeclaration.exec(source))) {
    const declaredAt = match.index + match[0].lastIndexOf(match[2])
    if (declaredAt > position) continue
    const scope = enclosingScope(match.index, braces)
    const variableType = `${match[1]}${match[3] ?? ''}`
    const elementType = inferElementType(variableType, match[4])
    result.push({
      name: match[2], bases: inferBases(variableType, match[4]), declaredType: normalizeType(variableType), ...(elementType ? { elementType } : {}), kind: 'local', declaredAt,
      scopeStart: scope.start, scopeEnd: scope.end,
    })
  }
  const enhancedForDeclaration = /\bfor\s*\(\s*(?:final\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;(){}]*?>)?\s*(?:\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*:\s*[^)]*\)/g
  while ((match = enhancedForDeclaration.exec(source))) {
    const declaredAt = match.index + match[0].lastIndexOf(match[2])
    if (declaredAt > position) continue
    const bodyOpen = source.indexOf('{', match.index + match[0].length)
    const bodyClose = bodyOpen >= 0 ? braces.openToClose.get(bodyOpen) : undefined
    const scope = bodyOpen >= 0 && bodyClose !== undefined
      ? { start: bodyOpen + 1, end: bodyClose }
      : enclosingScope(match.index, braces)
    const elementType = inferElementType(match[1], undefined)
    result.push({
      name: match[2], bases: inferBases(match[1], undefined), declaredType: normalizeType(match[1]), ...(elementType ? { elementType } : {}), kind: 'local', declaredAt,
      scopeStart: scope.start, scopeEnd: scope.end,
    })
  }
  return result
}

export function collectJavaSymbols(source: string, position = source.length): JavaSymbol[] {
  const braces = matchingBraces(source)
  return [...extractDeclarations(source, position, braces), ...extractParameters(source, position, braces)]
}

/**
 * Keep source offsets stable while hiding comments and literals from the
 * lightweight Java scanners below. This prevents strings from looking like
 * declarations or clickable calls.
 */
export function maskJavaCommentsAndLiterals(source: string): string {
  // `split('')` intentionally keeps UTF-16 code-unit indexing. CodeMirror
  // positions are UTF-16 offsets, while spreading a string would collapse
  // astral characters and shift every later source range.
  const chars = source.split('')
  let state: 'normal' | 'lineComment' | 'blockComment' | 'string' | 'char' | 'textBlock' = 'normal'
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index]
    const next = chars[index + 1]
    if (state === 'lineComment') {
      if (current === '\n' || current === '\r') {
        state = 'normal'
      } else {
        chars[index] = ' '
      }
      continue
    }
    if (state === 'blockComment') {
      if (current === '*' && next === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
        state = 'normal'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (state === 'string' || state === 'char') {
      if (current === '\\') {
        chars[index] = ' '
        if (index + 1 < chars.length && chars[index + 1] !== '\n' && chars[index + 1] !== '\r') {
          chars[index + 1] = ' '
          index += 1
        }
      } else if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) {
        chars[index] = ' '
        state = 'normal'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (state === 'textBlock') {
      if (current === '\\') {
        chars[index] = ' '
        if (index + 1 < chars.length && chars[index + 1] !== '\n' && chars[index + 1] !== '\r') {
          chars[index + 1] = ' '
          index += 1
        }
      } else if (current === '"' && next === '"' && chars[index + 2] === '"') {
        chars[index] = ' '
        chars[index + 1] = ' '
        chars[index + 2] = ' '
        index += 2
        state = 'normal'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (current === '/' && next === '/') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'lineComment'
    } else if (current === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'blockComment'
    } else if (current === '"' && next === '"' && chars[index + 2] === '"') {
      // Keep one non-whitespace placeholder so a literal counts as an
      // argument even when its contents are masked.
      chars[index] = '\u0001'
      chars[index + 1] = ' '
      chars[index + 2] = ' '
      index += 2
      state = 'textBlock'
    } else if (current === '"') {
      chars[index] = '\u0001'
      state = 'string'
    } else if (current === "'") {
      chars[index] = '\u0001'
      state = 'char'
    }
  }
  return chars.join('')
}

function javaClassNames(maskedSource: string): Set<string> {
  const names = new Set<string>()
  const classPattern = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null
  while ((match = classPattern.exec(maskedSource))) {
    names.add(match[1])
  }
  return names
}

function methodHasReturnType(match: RegExpExecArray, nameStartInMatch: number): boolean {
  let prefix = match[0].slice(0, nameStartInMatch)
  const boundary = Math.max(prefix.lastIndexOf('{'), prefix.lastIndexOf('}'), prefix.lastIndexOf(';'))
  if (boundary >= 0) {
    prefix = prefix.slice(boundary + 1)
  }
  const normalized = prefix
    .replace(/(?:@(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\([^)]*\))?\s*)+/g, ' ')
    .replace(/\b(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\b/g, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .trim()
  return normalized.length > 0
}

export function collectJavaMethods(source: string): JavaMethod[] {
  const maskedSource = maskJavaCommentsAndLiterals(source)
  const classNames = javaClassNames(maskedSource)
  const result: JavaMethod[] = []
  const method = /(?:^|[;{}])\s*(?:(?:@(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\([^)]*\))?\s*)+)?(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>{}]+>\s*)?(?:(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)(?:\s*<[^>{}]*>)?\s*(?:\[\s*\])*\s+)?([A-Za-z_$][\w$]*)\s*\(([^(){}]*)\)\s*(?:throws\s+[^{}]+)?\{/gm
  let match: RegExpExecArray | null
  while ((match = method.exec(maskedSource))) {
    const name = match[1]
    if (/^(?:if|for|while|switch|catch|try|synchronized)$/.test(name)) continue
    // Constructors have the class name but no return type. They are not
    // method definitions for the editor's same-file navigation feature.
    const signatureOpenParen = match[0].lastIndexOf('(')
    const nameStartInMatch = match[0].lastIndexOf(name, signatureOpenParen)
    const hasReturnType = methodHasReturnType(match, nameStartInMatch)
    if (!hasReturnType && classNames.has(name)) continue
    const nameStart = match.index + nameStartInMatch
    const parameters = splitTopLevel(match[2]).map(parameterNameAndType).filter((value): value is { name: string; type: string } => value !== null).map((value) => value.name)
    result.push({ name, parameters, declaredAt: match.index, nameStart, nameEnd: nameStart + name.length })
  }
  return result
}

/** Return the Java identifier under a source position, if it is code. */
export function javaIdentifierAt(source: string, position: number): JavaIdentifier | null {
  const maskedSource = maskJavaCommentsAndLiterals(source)
  let cursor = Math.max(0, Math.min(Math.trunc(position), source.length))
  if (cursor === source.length || !/[A-Za-z0-9_$]/.test(maskedSource[cursor] ?? '')) {
    cursor -= 1
  }
  if (cursor < 0 || !/[A-Za-z_$]/.test(maskedSource[cursor] ?? '')) {
    return null
  }
  let from = cursor
  let to = cursor + 1
  while (from > 0 && /[A-Za-z0-9_$]/.test(maskedSource[from - 1])) from -= 1
  while (to < maskedSource.length && /[A-Za-z0-9_$]/.test(maskedSource[to])) to += 1
  const name = source.slice(from, to)
  if (!name || maskedSource.slice(from, to) !== name) {
    return null
  }
  return { name, from, to }
}

function previousIdentifier(maskedSource: string, from: number): string | null {
  let cursor = from - 1
  while (cursor >= 0 && /\s/.test(maskedSource[cursor])) cursor -= 1
  const end = cursor + 1
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(maskedSource[cursor])) cursor -= 1
  const start = cursor + 1
  return start < end ? maskedSource.slice(start, end) : null
}

function callOpenParen(maskedSource: string, end: number): number | null {
  let cursor = end
  while (cursor < maskedSource.length && /\s/.test(maskedSource[cursor])) cursor += 1
  return maskedSource[cursor] === '(' ? cursor : null
}

function isGenericAngleOpen(maskedSource: string, index: number): boolean {
  let previous = index - 1
  while (previous >= 0 && /\s/.test(maskedSource[previous])) previous -= 1
  let next = index + 1
  while (next < maskedSource.length && /\s/.test(maskedSource[next])) next += 1
  if (previous < 0 || next >= maskedSource.length) return false
  const before = maskedSource.slice(0, index)
  const explicitTypeArguments = /\.\s*$/.test(before)
  if (!explicitTypeArguments && !/[A-Za-z0-9_$>\]]/.test(maskedSource[previous])) return false
  if (!/[A-Za-z0-9_$?@]/.test(maskedSource[next])) return false

  let previousStart = previous
  while (previousStart >= 0 && /[A-Za-z0-9_$]/.test(maskedSource[previousStart])) previousStart -= 1
  const previousToken = maskedSource.slice(previousStart + 1, previous + 1)
  const typeName = /^[A-Z_$]/.test(previousToken)
  const constructedType = /\bnew\s+[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*$/.test(before)
  if (!explicitTypeArguments && !typeName && !constructedType) return false

  // A comparison (`left < right`) has no closing angle before the current
  // call's argument boundary. Generic types do, including nested `>>`.
  let depth = 1
  let nestedParen = 0
  for (let cursor = next; cursor < maskedSource.length; cursor += 1) {
    const current = maskedSource[cursor]
    if (current === '<') {
      depth += 1
    } else if (current === '>') {
      depth -= 1
      if (depth === 0) {
        if (explicitTypeArguments || constructedType) return true
        let after = cursor + 1
        while (after < maskedSource.length && /\s/.test(maskedSource[after])) after += 1
        return after >= maskedSource.length || /[,\)\]}.(]/.test(maskedSource[after] ?? '')
      }
    } else if (current === '(') {
      nestedParen += 1
    } else if (current === ')') {
      if (nestedParen > 0) {
        nestedParen -= 1
      } else {
        return false
      }
    } else if (depth === 1 && current === ';') {
      return false
    }
  }
  return false
}

function callArgumentCount(maskedSource: string, openParen: number): number | null {
  let paren = 0
  let bracket = 0
  let brace = 0
  let angle = 0
  let commas = 0
  let hasValue = false
  for (let index = openParen + 1; index < maskedSource.length; index += 1) {
    const current = maskedSource[index]
    if (current === '<' && isGenericAngleOpen(maskedSource, index)) {
      angle += 1
    } else if (current === '>' && angle > 0) {
      angle -= 1
    } else if (current === '(') {
      paren += 1
      hasValue = true
    } else if (current === ')') {
      if (paren > 0) {
        paren -= 1
        hasValue = true
      } else if (bracket === 0 && brace === 0 && angle === 0) {
        return hasValue ? commas + 1 : commas
      }
    } else if (current === '[') {
      bracket += 1
      hasValue = true
    } else if (current === ']') {
      bracket = Math.max(0, bracket - 1)
      hasValue = true
    } else if (current === '{') {
      brace += 1
      hasValue = true
    } else if (current === '}') {
      brace = Math.max(0, brace - 1)
      hasValue = true
    } else if (current === ',' && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      commas += 1
      hasValue = false
    } else if (!/\s/.test(current)) {
      hasValue = true
    }
  }
  return null
}

/**
 * Resolve a same-file method call to the exact declaration name range.
 * Only unqualified/`this.` calls are considered.
 */
export function resolveJavaDefinition(source: string, position: number): JavaDefinition | null {
  const identifier = javaIdentifierAt(source, position)
  if (!identifier) return null
  const methods = collectJavaMethods(source)
  const declaration = methods.find((method) => identifier.from === method.nameStart && identifier.to === method.nameEnd)
  if (declaration) {
    return {
      name: declaration.name,
      from: declaration.nameStart,
      to: declaration.nameEnd,
      parameters: declaration.parameters,
      declaredAt: declaration.declaredAt,
    }
  }

  const maskedSource = maskJavaCommentsAndLiterals(source)
  const openParen = callOpenParen(maskedSource, identifier.to)
  if (openParen === null) return null
  if (previousIdentifier(maskedSource, identifier.from) === 'new') return null
  const beforeIdentifier = maskedSource.slice(0, identifier.from)
  if (/\.\s*$/.test(beforeIdentifier) && !/(?:^|[^\w$.])this\s*\.\s*$/.test(beforeIdentifier)) {
    return null
  }

  const candidates = methods.filter((method) => method.name === identifier.name)
  if (candidates.length === 0) return null
  const argumentCount = callArgumentCount(maskedSource, openParen)
  const selected = argumentCount === null
    ? candidates[0]
    : candidates.find((method) => method.parameters.length === argumentCount) ?? candidates[0]
  return {
    name: selected.name,
    from: selected.nameStart,
    to: selected.nameEnd,
    parameters: selected.parameters,
    declaredAt: selected.declaredAt,
  }
}

export function iterableElementTypeForExpression(source: string, target: string, position: number): string | null {
  const expression = target.trim()
  if (!expression) return null

  const symbols = visibleJavaSymbols(collectJavaSymbols(source, position), position)
  const simpleTarget = /^([A-Za-z_$][\w$]*)$/.exec(expression)
  if (simpleTarget) {
    const symbol = symbols.find((candidate) => candidate.name === simpleTarget[1])
    if (symbol && isIterableSymbol(symbol)) return symbol.elementType ?? 'var'
    return null
  }

  // String#toCharArray is especially useful while solving LeetCode string
  // problems and has an unambiguous char type.
  const chars = /^([A-Za-z_$][\w$]*)\s*\.\s*toCharArray\s*\(\s*\)$/.exec(expression)
  if (!chars) return null
  const symbol = symbols.find((candidate) => candidate.name === chars[1])
  if (!symbol) return null
  const declaredType = symbol.declaredType
  if (declaredType && declaredType !== 'var') {
    return !declaredType.includes('[]') && simpleTypeName(baseType(declaredType)) === 'String' ? 'char' : null
  }
  return declaredType === 'var' && symbol.bases.includes('String') ? 'char' : null
}
