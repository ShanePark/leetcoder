import { afterEach, describe, expect, it } from 'vitest'

import { appIcons, iconFor } from '../../src/icons'

interface FakeSvgElement {
  tagName: string
  attributes: Map<string, string>
  children: FakeSvgElement[]
  setAttribute(name: string, value: string): void
  appendChild(child: FakeSvgElement): FakeSvgElement
  getAttribute(name: string): string | null
}

function fakeSvgElement(tagName: string): FakeSvgElement {
  return {
    tagName,
    attributes: new Map(),
    children: [],
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null
    },
  }
}

const originalDocument = globalThis.document

afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
  })
})

describe('Lucide app icons', () => {
  it('creates one decorative, consistently sized SVG per action icon', () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElementNS: (_namespace: string, tagName: string) => fakeSvgElement(tagName),
      },
    })

    for (const name of Object.keys(appIcons) as Array<keyof typeof appIcons>) {
      const icon = iconFor(name)
      expect(icon.tagName).toBe('svg')
      expect(icon.getAttribute('aria-hidden')).toBe('true')
      expect(icon.getAttribute('focusable')).toBe('false')
      expect(icon.getAttribute('width')).toBe('16')
      expect(icon.getAttribute('height')).toBe('16')
      expect(icon.getAttribute('stroke-width')).toBe('1.8')
      expect(icon.children.length).toBeGreaterThan(0)
      expect(icon.children.some((child) => child.tagName === 'svg')).toBe(false)
    }
  })

  it('uses distinct icon nodes for the primary action meanings', () => {
    const names: Array<keyof typeof appIcons> = [
      'folderOpen',
      'refresh',
      'externalLink',
      'filePlus',
      'play',
      'chevronDown',
      'chevronRight',
      'fileCode',
      'locate',
      'menu',
      'settings',
      'power',
    ]
    expect(new Set(names).size).toBe(names.length)
  })
})
