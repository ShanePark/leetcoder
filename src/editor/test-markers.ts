import { javaLanguage } from '@codemirror/lang-java'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

type JavaSyntaxNode = ReturnType<typeof syntaxTree>['topNode']

const JAVA_IDENTIFIER_START = /^(?:[$_]|\p{ID_Start})$/u
const JAVA_IDENTIFIER_PART = /^(?:[$\p{ID_Continue}])$/u

function isJavaIdentifier(value: string): boolean {
  const characters = [...value]
  return characters.length > 0
    && JAVA_IDENTIFIER_START.test(characters[0])
    && characters.slice(1).every((character) => JAVA_IDENTIFIER_PART.test(character))
}

function isTestAnnotation(annotation: string): boolean {
  const withoutArguments = annotation.slice(1, annotation.indexOf('(') >= 0
    ? annotation.indexOf('(')
    : undefined).trim()
  const simpleName = withoutArguments.slice(withoutArguments.lastIndexOf('.') + 1)
  return simpleName === 'Test'
}

function testMethodNameAndAnnotation(
  source: string,
  method: JavaSyntaxNode,
): { methodName: string; annotationFrom: number } | null {
  const modifiers = method.getChild('Modifiers')
  let annotationFrom: number | null = null
  let hasTest = false
  for (let child = modifiers?.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'MarkerAnnotation' && child.name !== 'Annotation') {
      continue
    }
    const annotation = source.slice(child.from, child.to).trim()
    if (!isTestAnnotation(annotation)) {
      continue
    }
    hasTest = true
    annotationFrom = child.from
    break
  }
  if (!hasTest || annotationFrom === null) {
    return null
  }
  const definition = method.getChild('Definition')
  if (!definition) {
    return null
  }
  const methodName = source.slice(definition.from, definition.to)
  return isJavaIdentifier(methodName) ? { methodName, annotationFrom } : null
}

/**
 * Return the Java @Test method containing a CodeMirror document position.
 *
 * MethodDeclaration nodes include their modifiers, declaration, parameters,
 * and body, so a single range check covers all of the places where a user
 * reasonably expects a test-only run shortcut to work. The Java syntax tree
 * also keeps comments and string contents out of the declaration nodes.
 */
export function findJavaTestMethodAt(
  state: EditorState,
  position = state.selection.main.head,
): string | null {
  const source = state.doc.toString()
  const boundedPosition = Math.max(0, Math.min(position, source.length))
  let node: JavaSyntaxNode | null = syntaxTree(state)
    .resolveInner(boundedPosition, 1)
  while (node && node.name !== 'MethodDeclaration') {
    node = node.parent
  }
  if (!node || boundedPosition < node.from || boundedPosition >= node.to) {
    return null
  }
  return testMethodNameAndAnnotation(source, node)?.methodName ?? null
}

/**
 * A source-level run action for one Java @Test method. `from` is the start of
 * the @Test annotation (or, for a same-line annotation/declaration, the
 * declaration line), which is the position used by the CodeMirror gutter.
 */
export interface JavaTestMethodMarker {
  methodName: string
  /** Document position at the start of the annotation's line, as required by CodeMirror gutters. */
  from: number
  line: number
}

/**
 * Extract all test methods from the current Java syntax tree. This deliberately
 * uses syntax nodes instead of text matching so comments, strings, and
 * annotation-looking text cannot create source run actions.
 */
export function findJavaTestMethodMarkers(state: EditorState): JavaTestMethodMarker[] {
  const source = state.doc.toString()
  const markers: JavaTestMethodMarker[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'MethodDeclaration') {
        return
      }
      const testMethod = testMethodNameAndAnnotation(source, node.node)
      if (!testMethod) {
        return
      }
      markers.push({
        methodName: testMethod.methodName,
        from: state.doc.lineAt(testMethod.annotationFrom).from,
        line: state.doc.lineAt(testMethod.annotationFrom).number,
      })
    },
  })
  return markers.sort((left, right) => left.from - right.from)
}

/** Whether a MethodDeclaration node carries a @Test annotation. */
export function isJavaTestMethod(source: string, method: JavaSyntaxNode): boolean {
  return testMethodNameAndAnnotation(source, method) !== null
}

/** The text between the braces of a method body. */
export interface JavaBodyRange {
  from: number
  to: number
}

/** Whether the document's `test()` can receive generated statements. */
export type BareJavaTestLookup =
  | { status: 'missing' }
  | { status: 'filled' }
  | { status: 'bare'; body: JavaBodyRange }

function childNodes(node: JavaSyntaxNode): JavaSyntaxNode[] {
  const children: JavaSyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child)
  }
  return children
}

function methodsNamedTest(source: string, root: JavaSyntaxNode, name = 'test'): JavaSyntaxNode[] {
  const methods: JavaSyntaxNode[] = []
  root.cursor().iterate((node) => {
    if (node.name === 'MethodDeclaration'
      && testMethodNameAndAnnotation(source, node.node)?.methodName === name) {
      methods.push(node.node)
    }
  })
  return methods
}

/**
 * The Block of the only @Test method named exactly `name`. Null when there is
 * none or several, or when the method has no body or recovery lost a brace,
 * because then no body range can be trusted.
 */
export function findJavaTestBlock(source: string, root: JavaSyntaxNode, name = 'test'): JavaSyntaxNode | null {
  const methods = methodsNamedTest(source, root, name)
  const block = methods.length === 1 ? methods[0].getChild('Block') : null
  return block?.firstChild?.name === '{' && block.lastChild?.name === '}' ? block : null
}

/** The direct children of a Block between its braces. Comments are children too. */
export function javaBlockStatements(block: JavaSyntaxNode): JavaSyntaxNode[] {
  return childNodes(block).slice(1, -1)
}

/**
 * Comments and error nodes are children of the nodes checked here, so anything
 * beyond the exact `assertThat()` shape fails a child comparison. The one error
 * allowed is the empty node recovery places where the template's `;` is missing.
 */
function isBareBlock(source: string, block: JavaSyntaxNode): boolean {
  const statements = javaBlockStatements(block)
  if (statements.length === 0) {
    return true
  }
  if (statements.length !== 1 || statements[0].name !== 'ExpressionStatement') {
    return false
  }
  const [call, terminator, ...extra] = childNodes(statements[0])
  const terminated = !terminator
    || terminator.name === ';'
    || (terminator.type.isError && terminator.from === terminator.to)
  if (call?.name !== 'MethodInvocation' || !terminated || extra.length > 0) {
    return false
  }
  const [name, argumentList, ...rest] = childNodes(call)
  return name?.name === 'MethodName'
    && source.slice(name.from, name.to) === 'assertThat'
    && argumentList?.name === 'ArgumentList'
    && rest.length === 0
    && childNodes(argumentList).map((node) => node.name).join(' ') === '( )'
}

/**
 * Find the stub that AI test generation may fill. A bare stub is an empty body
 * or only `assertThat()` with an optional `;`; anything else, including a
 * comment, counts as filled. This parses `source` in full rather than reading
 * the editor's tree, which may still be unfinished for a long document.
 */
export function findBareJavaTest(source: string): BareJavaTestLookup {
  const root = javaLanguage.parser.parse(source).topNode
  const block = findJavaTestBlock(source, root)
  if (!block) {
    return { status: methodsNamedTest(source, root).length > 0 ? 'filled' : 'missing' }
  }
  return isBareBlock(source, block)
    ? { status: 'bare', body: { from: block.from + 1, to: block.to - 1 } }
    : { status: 'filled' }
}
