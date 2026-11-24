import { describe, expect, it } from 'vitest'

import { parseMarkdown, parseMarkdownInline, renderMarkdown } from '../../../src/app/markdown-view'

/** Elements and text nodes, serialized to a compact tag tree for assertions. */
class FakeNode {
  className = ''
  textContent = ''
  readonly attributes = new Map<string, string>()
  readonly children: FakeNode[] = []
  innerHTMLWrites = 0

  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}

  set innerHTML(_value: string) {
    this.innerHTMLWrites += 1
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }

  /** `#text` nodes print their text; elements print `<tag.class attr>children</tag>`. */
  html(): string {
    if (this.tagName === '#text') return this.textContent
    const classes = this.className ? `.${this.className.split(' ').join('.')}` : ''
    const attributes = [...this.attributes].map(([name, value]) => ` ${name}=${value}`).join('')
    const inner = this.children.length > 0 ? this.children.map((child) => child.html()).join('') : this.textContent
    return `<${this.tagName}${classes}${attributes}>${inner}</${this.tagName}>`
  }
}

class FakeDocument {
  readonly created: FakeNode[] = []

  createElement(tagName: string): FakeNode {
    const node = new FakeNode(tagName, this)
    this.created.push(node)
    return node
  }

  createTextNode(text: string): FakeNode {
    const node = new FakeNode('#text', this)
    node.textContent = text
    return node
  }
}

const render = (text: string): { html: string; container: FakeNode; document: FakeDocument } => {
  const document = new FakeDocument()
  const container = document.createElement('div')
  renderMarkdown(container as unknown as HTMLElement, text)
  return { html: container.children.map((child) => child.html()).join(''), container, document }
}

describe('markdown blocks', () => {
  it('parses headings, paragraphs, fenced code, and lists', () => {
    expect(parseMarkdown([
      '## Fix ##',
      'First line',
      'second line',
      '',
      '```java',
      'int x = 1;',
      '  return x;',
      '```',
      '- one',
      '- two',
      '',
      '3. three',
      '4. four',
    ].join('\n'))).toEqual([
      { type: 'heading', level: 2, text: 'Fix' },
      { type: 'paragraph', text: 'First line\nsecond line' },
      { type: 'code', language: 'java', text: 'int x = 1;\n  return x;', closed: true },
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [{ text: 'one', children: [] }, { text: 'two', children: [] }],
      },
      {
        type: 'list',
        ordered: true,
        start: 3,
        items: [{ text: 'three', children: [] }, { text: 'four', children: [] }],
      },
    ])
  })

  it('renders an unclosed fence as an open code block holding the rest of the text', () => {
    expect(parseMarkdown('Look:\n```java\nint x = 1;\n## not a heading')).toEqual([
      { type: 'paragraph', text: 'Look:' },
      { type: 'code', language: 'java', text: 'int x = 1;\n## not a heading', closed: false },
    ])
    expect(render('```\n').html).toBe('<pre.md-code.is-open><code></code></pre>')
    expect(parseMarkdown('``')).toEqual([{ type: 'paragraph', text: '``' }])
  })

  it('closes a fence only with the same character and at least its length', () => {
    expect(parseMarkdown('````\n```\n~~~\n````\nafter')).toEqual([
      { type: 'code', language: null, text: '```\n~~~', closed: true },
      { type: 'paragraph', text: 'after' },
    ])
  })

  it('nests indented items and keeps loose items in one list', () => {
    expect(parseMarkdown('1. outer\n   - inner\n   - inner two\n\n2. next\n   continued')).toEqual([{
      type: 'list',
      ordered: true,
      start: 1,
      items: [
        {
          text: 'outer',
          children: [{
            type: 'list',
            ordered: false,
            start: 1,
            items: [{ text: 'inner', children: [] }, { text: 'inner two', children: [] }],
          }],
        },
        { text: 'next\ncontinued', children: [] },
      ],
    }])
  })

  it('ends a list at an unindented paragraph, a heading, or a fence', () => {
    expect(parseMarkdown('- a\n\nAfter').map((block) => block.type)).toEqual(['list', 'paragraph'])
    expect(parseMarkdown('- a\n# H').map((block) => block.type)).toEqual(['list', 'heading'])
    expect(parseMarkdown('1. a\n   ```java\n   int x;\n   ```\n2. b')).toEqual([
      { type: 'list', ordered: true, start: 1, items: [{ text: 'a', children: [] }] },
      { type: 'code', language: 'java', text: 'int x;', closed: true },
      { type: 'list', ordered: true, start: 2, items: [{ text: 'b', children: [] }] },
    ])
  })

  it('does not take rules, numbers, or hashtags for blocks', () => {
    expect(parseMarkdown('---\n3.14 is pi\n#tag\n**bold** line').map((block) => block.type)).toEqual(['paragraph'])
    expect(parseMarkdown('## Using C#')).toEqual([{ type: 'heading', level: 2, text: 'Using C#' }])
  })
})

describe('markdown inline', () => {
  it('parses code, bold, and italic', () => {
    expect(parseMarkdownInline('Use `map.get(x)` with **care** and *speed* or __this__ _that_.')).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'code', text: 'map.get(x)' },
      { type: 'text', text: ' with ' },
      { type: 'strong', children: [{ type: 'text', text: 'care' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'speed' }] },
      { type: 'text', text: ' or ' },
      { type: 'strong', children: [{ type: 'text', text: 'this' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'that' }] },
      { type: 'text', text: '.' },
    ])
  })

  it('keeps unclosed markers, spaced stars, and snake_case as text', () => {
    expect(parseMarkdownInline('**unfinished and `open')).toEqual([{ type: 'text', text: '**unfinished and `open' }])
    expect(parseMarkdownInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }])
    expect(parseMarkdownInline('call max_value_of(a_b)')).toEqual([{ type: 'text', text: 'call max_value_of(a_b)' }])
  })

  it('does not format inside code and takes longer backtick runs', () => {
    expect(parseMarkdownInline('``a ` **b**``')).toEqual([{ type: 'code', text: 'a ` **b**' }])
    expect(parseMarkdownInline('\\*not em\\*')).toEqual([{ type: 'text', text: '*not em*' }])
  })

  it('nests italic inside bold', () => {
    expect(parseMarkdownInline('**a *b* c**')).toEqual([{
      type: 'strong',
      children: [
        { type: 'text', text: 'a ' },
        { type: 'em', children: [{ type: 'text', text: 'b' }] },
        { type: 'text', text: ' c' },
      ],
    }])
  })
})

describe('markdown rendering', () => {
  it('builds elements for each block and inline style', () => {
    const { html } = render('# Title\nSee **this** and `x`.\n\n```java\nint[] a;\n```\n- *one*\n  1. two')
    expect(html).toBe([
      '<h4.md-heading.md-heading-1>Title</h4>',
      '<p.md-paragraph>See <strong>this</strong> and <code.md-inline-code>x</code>.</p>',
      '<pre.md-code data-language=java><code>int[] a;</code></pre>',
      '<ul.md-list><li.md-list-item><em>one</em><ol.md-list><li.md-list-item>two</li></ol></li></ul>',
    ].join(''))
  })

  it('numbers an ordered list from its first item', () => {
    expect(render('5. five').html).toBe('<ol.md-list start=5><li.md-list-item>five</li></ol>')
  })

  it('never interprets model text as HTML', () => {
    const markup = '<img src=x onerror=alert(1)> **<b>bold</b>** `<script>`'
    const { container, document } = render(`${markup}\n\n\`\`\`html\n<script>alert(1)</script>\n\`\`\``)
    expect(document.created.every((node) => node.innerHTMLWrites === 0)).toBe(true)
    expect(document.created.map((node) => node.tagName).sort()).toEqual(['code', 'code', 'div', 'p', 'pre', 'strong'])
    expect(container.children[0].html()).toBe(
      '<p.md-paragraph><img src=x onerror=alert(1)> <strong><b>bold</b></strong> <code.md-inline-code><script></code></p>',
    )
    expect(container.children[1].children[0].textContent).toBe('<script>alert(1)</script>')
  })

  it('replaces what the container held', () => {
    const document = new FakeDocument()
    const container = document.createElement('div')
    renderMarkdown(container as unknown as HTMLElement, 'one')
    renderMarkdown(container as unknown as HTMLElement, 'two')
    expect(container.children.map((child) => child.html())).toEqual(['<p.md-paragraph>two</p>'])
  })
})
