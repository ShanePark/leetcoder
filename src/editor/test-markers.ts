import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

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
  method: ReturnType<typeof syntaxTree>['topNode'],
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
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state)
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
