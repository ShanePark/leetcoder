import { javaLanguage } from '@codemirror/lang-java'
import type { SyntaxNode } from '@lezer/common'
import { isJavaTestMethod } from './test-markers'

const COMMENTS = new Set(['LineComment', 'BlockComment'])

/** Whether a method or constructor has no body or holds only comments between its braces. */
function hasBlankBody(declaration: SyntaxNode): boolean {
  const body = declaration.getChild('Block') ?? declaration.getChild('ConstructorBody')
  for (let child = body?.firstChild; child; child = child.nextSibling) {
    if (child.name !== '{' && child.name !== '}' && !COMMENTS.has(child.name)) return false
  }
  return true
}

/**
 * Whether the solution is still unwritten: every method and constructor that is
 * not a @Test method, nested classes' members included, has a body of only
 * whitespace and comments. A file with no such method counts as unwritten, as
 * the scaffold of a design problem is. One statement anywhere makes it written.
 */
export function isJavaSolutionUnimplemented(source: string): boolean {
  let blank = true
  javaLanguage.parser.parse(source).iterate({
    enter(node) {
      if (!blank) return false
      if (node.name === 'ConstructorDeclaration'
        || (node.name === 'MethodDeclaration' && !isJavaTestMethod(source, node.node))) {
        blank = hasBlankBody(node.node)
        return false
      }
      // A @Test method's body may hold a local class; it is not the solution.
      return node.name === 'MethodDeclaration' ? false : undefined
    },
  })
  return blank
}
