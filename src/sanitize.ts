/**
 * Strict allowlist sanitizer for LeetCode problem description HTML.
 *
 * The input comes from the network, so it is never trusted: the source is
 * parsed with DOMParser (inert — scripts do not run there) and a brand-new
 * tree is rebuilt with createElement/textContent only. Nothing from the raw
 * markup — no attribute, no style, no handler — is copied across except the
 * few fields listed below.
 */

/** Tags rebuilt as-is, with every attribute dropped. */
const ALLOWED_TAGS = new Set([
  'p', 'pre', 'code', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u',
  'sup', 'sub', 'br', 'hr', 'blockquote', 'span',
])

/**
 * Rebuild untrusted problem HTML into a safe DOM fragment.
 *
 * - Allowlisted tags are recreated without attributes.
 * - `img` keeps only an `https://` src plus alt, constrained to the column.
 * - `a` is flattened to its text content (the link target is dropped).
 * - Any other element is skipped, but its children are still walked so the
 *   text inside unknown wrappers is not lost.
 */
export function sanitizeProblemHtml(html: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  if (typeof DOMParser === 'undefined') {
    fragment.append(document.createTextNode(html))
    return fragment
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  appendSanitizedChildren(parsed.body, fragment)
  return fragment
}

function appendSanitizedChildren(source: Node, target: Node): void {
  for (const child of Array.from(source.childNodes)) {
    const sanitized = sanitizeNode(child)
    if (sanitized) {
      target.appendChild(sanitized)
    }
  }
}

function sanitizeNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent ?? '')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null
  }
  const element = node as Element
  const tag = element.tagName.toLowerCase()

  if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
    return null
  }

  if (tag === 'a') {
    // Links are flattened to plain text: the app never navigates from the
    // description, and untrusted hrefs are never emitted.
    return document.createTextNode(element.textContent ?? '')
  }

  if (tag === 'img') {
    const src = element.getAttribute('src') ?? ''
    if (!src.startsWith('https://')) {
      return null
    }
    const image = document.createElement('img')
    image.src = src
    const alt = element.getAttribute('alt')
    if (alt) {
      image.alt = alt
    }
    image.style.maxWidth = '100%'
    return image
  }

  if (ALLOWED_TAGS.has(tag)) {
    const rebuilt = document.createElement(tag)
    appendSanitizedChildren(element, rebuilt)
    return rebuilt
  }

  // Unknown wrapper (div, table, font, …): drop the element but keep the
  // content underneath so no description text disappears.
  const fragment = document.createDocumentFragment()
  appendSanitizedChildren(element, fragment)
  return fragment
}
