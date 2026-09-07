import { HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'

/**
 * Editor palette references the design tokens in styles/theme.css. CSS variables are
 * used instead of resolved colors so an appearance change can update the
 * CodeMirror surface without rebuilding the editor state.
 */
const editorPalette = {
  background: 'var(--bg)',
  surface: 'var(--surface-2)',
  text: 'var(--text)',
  textDim: 'var(--text-dim)',
  textFaint: 'var(--text-faint)',
  accent: 'var(--accent)',
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
  violet: 'var(--editor-violet)',
  blue: 'var(--editor-blue)',
  selection: 'var(--editor-selection)',
  activeLine: 'var(--editor-active-line)',
} as const

export const leetcoderTheme = EditorView.theme({
  '&': {
    color: editorPalette.text,
    backgroundColor: editorPalette.background,
    fontSize: '14px',
    height: '100%',
  },
  '.cm-content': {
    caretColor: editorPalette.accent,
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: editorPalette.accent,
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: editorPalette.selection,
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--editor-link-background)',
  },
  '.cm-activeLine': {
    backgroundColor: editorPalette.activeLine,
  },
  '.cm-gutters': {
    backgroundColor: editorPalette.background,
    color: editorPalette.textFaint,
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: editorPalette.activeLine,
    color: editorPalette.textDim,
  },
  '.cm-test-gutter': {
    flex: '0 0 0',
    width: '0',
    minWidth: '0',
    overflow: 'visible',
    zIndex: '1',
  },
  '.cm-test-gutter .cm-gutterElement': {
    position: 'relative',
    width: '0',
    overflow: 'visible',
  },
  '.cm-foldGutter': {
    minWidth: '14px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    color: editorPalette.textFaint,
    cursor: 'pointer',
    padding: '0 2px',
  },
  '.cm-foldGutter .cm-gutterElement:hover': {
    color: editorPalette.textDim,
  },
  '.cm-foldPlaceholder': {
    margin: '0 2px',
    padding: '0 6px',
    border: '1px solid var(--editor-link-border)',
    borderRadius: '4px',
    backgroundColor: editorPalette.surface,
    color: editorPalette.textDim,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '12px',
  },
  '.cm-foldPlaceholder:hover': {
    borderColor: editorPalette.accent,
    color: editorPalette.text,
  },
  '.cm-test-run-button': {
    display: 'inline-flex',
    position: 'absolute',
    top: '50%',
    left: '2px',
    transform: 'translateY(-50%)',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    padding: '0',
    border: '0',
    borderRadius: '4px',
    backgroundColor: 'transparent',
    color: editorPalette.green,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '1',
    opacity: '0.8',
  },
  '.cm-test-run-button:hover': {
    backgroundColor: 'var(--green-soft)',
    opacity: '1',
  },
  '.cm-test-run-button:focus-visible': {
    outline: `2px solid ${editorPalette.accent}`,
    outlineOffset: '1px',
  },
  '.cm-specialChar': {
    color: editorPalette.red,
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--editor-link-background)',
    outline: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: editorPalette.surface,
    color: editorPalette.text,
    border: '1px solid var(--border-strong)',
    borderRadius: '8px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: editorPalette.text,
  },
  '.cm-panels': {
    backgroundColor: editorPalette.surface,
    color: editorPalette.text,
  },
}, { dark: true })

export const leetcoderHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.self], color: editorPalette.violet },
  { tag: [tags.string, tags.character, tags.special(tags.string)], color: editorPalette.green },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null], color: editorPalette.amber },
  { tag: [tags.comment, tags.blockComment, tags.lineComment, tags.docComment], color: editorPalette.textFaint, fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: editorPalette.blue },
  { tag: [tags.annotation, tags.meta], color: editorPalette.amber },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: editorPalette.text },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.operator], color: editorPalette.textDim },
  { tag: [tags.propertyName, tags.variableName], color: editorPalette.text },
  { tag: tags.invalid, color: editorPalette.red },
])
