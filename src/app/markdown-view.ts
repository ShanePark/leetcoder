/**
 * A small Markdown subset for model answers: headings, paragraphs, fenced code,
 * bullet and numbered lists, inline code, bold, and italic. The DOM is built with
 * `createElement` and text nodes only, so model text can never become markup.
 * Text that is still streaming renders sanely: an unclosed fence is an open code
 * block, and an unclosed inline marker stays literal text.
 */

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'em'; children: MarkdownInline[] }

export interface MarkdownListItem {
  text: string
  /** Lists nested under this item. */
  children: MarkdownList[]
}

export interface MarkdownList {
  type: 'list'
  ordered: boolean
  start: number
  items: MarkdownListItem[]
}

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  /** `closed` is false while the closing fence has not arrived. */
  | { type: 'code'; language: string | null; text: string; closed: boolean }
  | MarkdownList

const FENCE = /^( *)(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/

interface ListMarker {
  indent: number
  ordered: boolean
  start: number
  text: string
}

function listMarker(line: string): ListMarker | null {
  const match = LIST_ITEM.exec(line)
  if (!match) return null
  const ordered = /\d/.test(match[2])
  return {
    indent: match[1].length,
    ordered,
    start: ordered ? Number.parseInt(match[2], 10) : 1,
    text: (match[3] ?? '').trim(),
  }
}

const isBlank = (line: string): boolean => line.trim() === ''
const startsBlock = (line: string): boolean => FENCE.test(line) || HEADING.test(line)

export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line)) {
      index += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      index = parseFence(lines, index, fence, blocks)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] ?? '' })
      index += 1
      continue
    }
    if (listMarker(line)) {
      index = parseList(lines, index, blocks)
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const next = lines[index]
      if (isBlank(next) || startsBlock(next) || (paragraph.length > 0 && listMarker(next))) break
      paragraph.push(next.trim())
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}

/** A fence runs to a closing fence of the same character and at least its length, or to the end. */
function parseFence(lines: string[], start: number, fence: RegExpExecArray, blocks: MarkdownBlock[]): number {
  const indent = fence[1].length
  const marker = fence[2]
  const closing = new RegExp(`^ *${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
  const body: string[] = []
  let index = start + 1
  let closed = false
  while (index < lines.length) {
    const line = lines[index]
    index += 1
    if (closing.test(line)) {
      closed = true
      break
    }
    // Code inside an indented list item drops the fence's indentation.
    body.push(line.slice(Math.min(indent, line.length - line.trimStart().length)))
  }
  blocks.push({ type: 'code', language: fence[3] || null, text: body.join('\n'), closed })
  return index
}

/**
 * Items deeper than the current list by two or more spaces nest under its last
 * item. A blank line continues the list only when another item or an indented
 * line follows; a fence or heading ends it.
 */
function parseList(lines: string[], start: number, blocks: MarkdownBlock[]): number {
  const first = listMarker(lines[start])!
  const root: MarkdownList = { type: 'list', ordered: first.ordered, start: first.start, items: [] }
  const stack: Array<{ list: MarkdownList; indent: number }> = [{ list: root, indent: first.indent }]
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (startsBlock(line)) break
    if (isBlank(line)) {
      let next = index + 1
      while (next < lines.length && isBlank(lines[next])) next += 1
      const following = lines[next]
      if (following === undefined || startsBlock(following)) break
      if (!listMarker(following) && following.length - following.trimStart().length < 2) break
      index = next
      continue
    }
    const marker = listMarker(line)
    if (!marker) {
      const item = stack[stack.length - 1].list.items.at(-1)!
      item.text = item.text ? `${item.text}\n${line.trim()}` : line.trim()
      index += 1
      continue
    }
    while (stack.length > 1 && marker.indent < stack[stack.length - 1].indent) stack.pop()
    let top = stack[stack.length - 1]
    if (marker.indent >= top.indent + 2 && top.list.items.length > 0) {
      const nested: MarkdownList = { type: 'list', ordered: marker.ordered, start: marker.start, items: [] }
      top.list.items[top.list.items.length - 1].children.push(nested)
      top = { list: nested, indent: marker.indent }
      stack.push(top)
    } else if (stack.length === 1 && marker.ordered !== root.ordered) {
      // A different kind of list at the top level starts a new list.
      break
    }
    top.list.items.push({ text: marker.text, children: [] })
    index += 1
  }
  blocks.push(root)
  return index
}

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}_]/u.test(character)
const isSpace = (character: string | undefined): boolean => character === undefined || /\s/.test(character)

/** Where an emphasis run of `marker` that opens at `open` closes, or -1. */
function closingDelimiter(text: string, open: number, marker: string): number {
  const contentStart = open + marker.length
  if (isSpace(text[contentStart])) return -1
  // An underscore inside a word, as in snake_case, is not emphasis.
  if (marker[0] === '_' && isWordCharacter(text[open - 1])) return -1
  let search = contentStart + 1
  while (search <= text.length - marker.length) {
    const found = text.indexOf(marker, search)
    if (found === -1) return -1
    const before = text[found - 1]
    const after = text[found + marker.length]
    const single = marker.length === 1
    const doubled = single && (after === marker || before === marker)
    if (!isSpace(before) && !doubled && !(marker[0] === '_' && isWordCharacter(after))) return found
    search = found + 1
  }
  return -1
}

export function parseMarkdownInline(text: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = []
  let literal = ''
  const flush = (): void => {
    if (literal) nodes.push({ type: 'text', text: literal })
    literal = ''
  }
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character === '\\' && index + 1 < text.length && /[\\`*_#\-+.!>[\]()]/.test(text[index + 1])) {
      literal += text[index + 1]
      index += 2
      continue
    }
    if (character === '`') {
      let run = 1
      while (text[index + run] === '`') run += 1
      const fence = '`'.repeat(run)
      let close = text.indexOf(fence, index + run)
      while (close !== -1 && text[close + run] === '`') {
        let end = close
        while (text[end] === '`') end += 1
        close = text.indexOf(fence, end)
      }
      if (close === -1) {
        literal += fence
        index += run
        continue
      }
      let code = text.slice(index + run, close).replace(/\n/g, ' ')
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
      flush()
      nodes.push({ type: 'code', text: code })
      index = close + run
      continue
    }
    if (character === '*' || character === '_') {
      const strong = text[index + 1] === character
      const marker = strong ? character.repeat(2) : character
      const close = closingDelimiter(text, index, marker)
      if (close !== -1) {
        flush()
        const children = parseMarkdownInline(text.slice(index + marker.length, close))
        nodes.push(strong ? { type: 'strong', children } : { type: 'em', children })
        index = close + marker.length
        continue
      }
      literal += marker
      index += marker.length
      continue
    }
    literal += character
    index += 1
  }
  flush()
  return nodes
}

/** Render `text` as the children of `container`, replacing what it held. */
export function renderMarkdown(container: HTMLElement, text: string): void {
  const documentRef = container.ownerDocument
  const element = (tag: string, className: string): HTMLElement => {
    const created = documentRef.createElement(tag)
    created.className = className
    return created
  }
  const inline = (parent: HTMLElement, source: string): HTMLElement => {
    const append = (target: HTMLElement, nodes: readonly MarkdownInline[]): void => {
      for (const node of nodes) {
        if (node.type === 'text') {
          target.append(documentRef.createTextNode(node.text))
        } else if (node.type === 'code') {
          const code = element('code', 'md-inline-code')
          code.textContent = node.text
          target.append(code)
        } else {
          const wrapper = element(node.type === 'strong' ? 'strong' : 'em', '')
          append(wrapper, node.children)
          target.append(wrapper)
        }
      }
    }
    append(parent, parseMarkdownInline(source))
    return parent
  }
  const list = (block: MarkdownList): HTMLElement => {
    const listElement = element(block.ordered ? 'ol' : 'ul', 'md-list')
    if (block.ordered && block.start !== 1) listElement.setAttribute('start', String(block.start))
    for (const item of block.items) {
      const itemElement = inline(element('li', 'md-list-item'), item.text)
      itemElement.append(...item.children.map(list))
      listElement.append(itemElement)
    }
    return listElement
  }
  const nodes = parseMarkdown(text).map((block): HTMLElement => {
    switch (block.type) {
      case 'heading':
        return inline(element(`h${Math.min(6, block.level + 3)}`, `md-heading md-heading-${block.level}`), block.text)
      case 'paragraph':
        return inline(element('p', 'md-paragraph'), block.text)
      case 'code': {
        const pre = element('pre', block.closed ? 'md-code' : 'md-code is-open')
        if (block.language) pre.setAttribute('data-language', block.language)
        const code = element('code', '')
        code.textContent = block.text
        pre.append(code)
        return pre
      }
      case 'list':
        return list(block)
    }
  })
  container.replaceChildren(...nodes)
}
