import type { TestCaseResult, TestDiagnostic, TestResult } from '../backend'
import { iconFor } from '../icons'
import {
  charDiffSegments,
  conciseTestFailureMessage,
  defaultVisibleTests,
  filterTestDiagnostics,
  normalizeTestPhase,
  presentTestResult,
  relevantTestStackFrames,
  testOutputSegments,
  testResultKey,
  testStatusLabel,
} from './test-results'
import {
  sourceBasename,
  sourcePathsMatch,
  validSourceLine,
} from './path-helpers'
import { formatDuration, liveRunPhaseLabel, testRunFacts } from './layout'
import { shortcutLabel } from '../shortcuts'
import { liveSnapshotResult } from './test-results'
import type { TestRunSnapshot } from './types'

export const TEST_RUN_ROOT_KEY = '__leetcoder_test_run__'

export interface TestResultsViewModel {
  result: TestResult | null
  liveRun: TestRunSnapshot | null
  testMethod: string | null
  selectedTestKey: string | null
  selectedPath: string | null
  liveDiagnosticsError: string | null
  macPlatform: boolean
}

export interface TestResultsViewCallbacks {
  onSelectTest: (key: string, focus: boolean) => void
  onRevealLocation: (line: number, column?: number | null) => void
}

export interface TestResultsViewOutput {
  selectedTestKey: string | null
}

/**
 * Render the test result panel from a small immutable view model. The app
 * controller owns run state and selection; this view only creates DOM and
 * reports user gestures through callbacks.
 */
export function renderTestResults(
  root: HTMLElement,
  model: TestResultsViewModel,
  callbacks: TestResultsViewCallbacks,
): TestResultsViewOutput {
  const panel = requiredElement<HTMLElement>(root, '#tests-panel')
  const statusRow = requiredElement<HTMLElement>(root, '#test-status-row')
  const body = requiredElement<HTMLElement>(root, '#test-body')
  const result = model.result ?? (model.liveRun ? liveSnapshotResult(model.liveRun) : null)
  statusRow.className = 'test-status-row'
  statusRow.removeAttribute('title')
  statusRow.innerHTML = ''
  body.innerHTML = ''
  panel.setAttribute('aria-busy', model.liveRun ? 'true' : 'false')

  if (!result) {
    statusRow.classList.add('is-idle')
    const idle = document.createElement('span')
    idle.className = 'test-idle-copy'
    const kbd = document.createElement('kbd')
    const selectedKbd = document.createElement('kbd')
    kbd.textContent = shortcutLabel('run-test', model.macPlatform)
    selectedKbd.textContent = shortcutLabel('run-test-at-cursor', model.macPlatform)
    idle.append(
      document.createTextNode('Run '),
      kbd,
      document.createTextNode(' to test the current file · '),
      selectedKbd,
      document.createTextNode(' for the selected test'),
    )
    statusRow.append(idle)
    appendLiveDiagnosticsStatus(statusRow, model.liveDiagnosticsError)
    return { selectedTestKey: model.selectedTestKey }
  }

  const presentation = presentTestResult(result)
  const isRunning = model.liveRun !== null
  const phase = normalizeTestPhase(result.phase)
  const isRunnerError = model.liveRun?.status === 'error' || phase === 'runner'
  const hasFailure = !result.success || isRunnerError
  const diagnostics = filterTestDiagnostics(result.diagnostics)
  const errorDiagnostics = diagnostics.filter((entry) => entry.severity.trim().toLowerCase() === 'error')
  const warningDiagnostics = diagnostics.filter((entry) => entry.severity.trim().toLowerCase() === 'warning')

  if (isRunning) {
    statusRow.classList.add('is-running')
    statusRow.append(iconFor('loader', 'test-status-svg is-spinning'))
    const label = document.createElement('span')
    label.className = 'test-verdict'
    label.textContent = liveRunPhaseLabel(result.phase)
    statusRow.append(label)
    appendFacts(statusRow, testRunFacts(result.summary))
  } else {
    const verdict = document.createElement('span')
    verdict.className = 'test-verdict'
    const factParts: string[] = []
    if (!hasFailure) {
      statusRow.classList.add('is-success')
      statusRow.append(iconFor('check', 'test-status-svg'))
      verdict.textContent = 'Passed'
      if (result.summary.total > 0) {
        factParts.push(`${result.summary.total} test${result.summary.total === 1 ? '' : 's'}`)
      }
    } else if (phase === 'compile') {
      statusRow.classList.add('is-failure')
      statusRow.append(iconFor('close', 'test-status-svg'))
      verdict.textContent = 'Compile error'
      if (errorDiagnostics.length > 0) {
        factParts.push(`${errorDiagnostics.length} error${errorDiagnostics.length === 1 ? '' : 's'}`)
      }
    } else if (phase === 'noTests') {
      statusRow.classList.add('is-warning')
      statusRow.append(iconFor('alert', 'test-status-svg'))
      verdict.textContent = 'No tests ran'
    } else if (isRunnerError) {
      statusRow.classList.add('is-error')
      statusRow.append(iconFor('alert', 'test-status-svg'))
      verdict.textContent = 'Runner error'
    } else {
      statusRow.classList.add('is-failure')
      statusRow.append(iconFor('close', 'test-status-svg'))
      verdict.textContent = 'Failed'
      const failedCount = result.summary.failed + result.summary.errors
      if (failedCount > 0 && result.summary.total > 0) {
        factParts.push(`${failedCount} of ${result.summary.total} failed`)
      }
    }
    statusRow.append(verdict)
    if (result.summary.durationMs !== null && result.summary.durationMs !== undefined && phase !== 'compile') {
      factParts.push(formatDuration(result.summary.durationMs))
    }
    appendFacts(statusRow, factParts)
    if (hasFailure && presentation.failureMessage) {
      statusRow.title = presentation.failureMessage
    }
  }
  const targetedMethod = model.testMethod
  if (targetedMethod) {
    const target = document.createElement('span')
    target.className = 'test-run-target'
    target.textContent = `Only ${targetedMethod}()`
    statusRow.append(target)
  }
  appendLiveDiagnosticsStatus(statusRow, model.liveDiagnosticsError)

  if (!isRunning) {
    for (const diagnostic of errorDiagnostics) {
      body.append(renderDiagnostic(diagnostic, model.selectedPath, callbacks.onRevealLocation))
    }
    if (warningDiagnostics.length > 0) {
      const details = document.createElement('details')
      details.className = 'diagnostics-warnings'
      const heading = document.createElement('summary')
      heading.textContent = `${warningDiagnostics.length} warning${warningDiagnostics.length === 1 ? '' : 's'}`
      details.append(heading)
      for (const diagnostic of warningDiagnostics) {
        details.append(renderDiagnostic(diagnostic, model.selectedPath, callbacks.onRevealLocation))
      }
      body.append(details)
    }
  }

  // A phase without per-test rows explains itself in a full-width note.
  const hasFailedTestRows = result.tests.some((test) => test.status === 'failed' || test.status === 'error')
  if (!isRunning && hasFailure) {
    if (phase === 'noTests') {
      const note = document.createElement('div')
      note.className = 'run-note run-note-no-tests'
      const hint = document.createElement('p')
      hint.className = 'run-note-message'
      hint.textContent = 'No tests were found in this class. Add an @Test method with an assertion.'
      note.append(hint)
      body.append(note)
    } else if (
      phase !== 'compile'
      && errorDiagnostics.length === 0
      && (phase !== 'test' || !hasFailedTestRows)
      && presentation.failureMessage
    ) {
      const note = document.createElement('div')
      note.className = 'run-note run-note-runner'
      const message = document.createElement('p')
      message.className = 'run-note-message'
      message.textContent = presentation.failureMessage
      note.append(message)
      body.append(note)
    }
  }

  const visibleTests = defaultVisibleTests(result.tests, isRunning)
  const selectedTest = visibleTests.find((test) => testResultKey(test) === model.selectedTestKey) ?? null
  // A refreshed JUnit report can legitimately omit a test that was visible
  // during live progress. Fall back to the run item rather than leaving an
  // option marked selected with an empty detail pane.
  const selectedTestKey = model.selectedTestKey !== null && selectedTest === null
    ? null
    : model.selectedTestKey

  const workspace = document.createElement('div')
  workspace.className = 'test-results-workspace'

  const list = document.createElement('div')
  list.className = 'test-list test-results-tree'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Tests')
  list.setAttribute('aria-controls', 'test-detail-pane')
  list.append(renderTestTreeItem(null, result, isRunning, selectedTestKey, callbacks.onSelectTest))
  for (const test of visibleTests) {
    list.append(renderTestTreeItem(test, result, isRunning, selectedTestKey, callbacks.onSelectTest))
  }
  if (isRunning && result.tests.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'test-empty test-empty-running'
    empty.textContent = liveRunPhaseLabel(result.phase)
    list.append(empty)
  } else if (!isRunning && result.tests.length === 0 && phase !== 'compile' && phase !== 'noTests' && !isRunnerError) {
    const empty = document.createElement('div')
    empty.className = 'test-empty'
    empty.textContent = 'No tests were reported.'
    list.append(empty)
  }

  const detailPane = document.createElement('section')
  detailPane.id = 'test-detail-pane'
  detailPane.className = 'test-detail-pane'
  detailPane.setAttribute('role', 'region')
  detailPane.setAttribute('aria-live', 'polite')
  if (selectedTest) {
    detailPane.setAttribute('aria-label', `Details for ${selectedTest.displayName || selectedTest.name}`)
    detailPane.append(renderTestCase(selectedTest, model.selectedPath, callbacks.onRevealLocation))
  } else {
    detailPane.setAttribute('aria-label', 'Test run output')
    const heading = document.createElement('div')
    heading.className = 'test-detail-heading'
    const rootStatus = isRunning ? 'running' : result.success ? 'passed' : phase === 'noTests' ? 'skipped' : 'failed'
    heading.append(statusIcon(rootStatus))
    const title = document.createElement('h3')
    title.className = 'test-detail-title'
    title.textContent = isRunning ? 'Test run' : 'Test run output'
    heading.append(title)
    detailPane.append(heading)
    const summary = document.createElement('p')
    summary.className = 'test-detail-class'
    summary.textContent = testRunFacts(result.summary).join(' · ') || liveRunPhaseLabel(result.phase)
    detailPane.append(summary)
    const output = renderOutputConsole(result.stdout, result.stderr)
    if (output) {
      detailPane.append(output)
    }
  }
  workspace.append(list, detailPane)
  body.append(workspace)
  return { selectedTestKey }
}

function requiredElement<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Missing editor element: ${selector}`)
  }
  return element
}

function appendFacts(row: HTMLElement, facts: string[]): void {
  if (facts.length === 0) {
    return
  }
  const element = document.createElement('span')
  element.className = 'test-facts'
  element.textContent = facts.join(' · ')
  row.append(element)
}

function appendLiveDiagnosticsStatus(statusRow: HTMLElement, error: string | null): void {
  if (!error) {
    return
  }
  const status = document.createElement('span')
  status.className = 'test-facts live-diagnostics-status'
  status.textContent = 'Live checks unavailable'
  status.title = error
  status.setAttribute('aria-label', `Live checks unavailable: ${error}`)
  statusRow.append(status)
}

function renderTestTreeItem(
  test: TestCaseResult | null,
  result: TestResult,
  isRunning: boolean,
  selectedTestKey: string | null,
  onSelectTest: (key: string, focus: boolean) => void,
): HTMLButtonElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = test
    ? `test-tree-item test-row-${test.status}`
    : 'test-tree-item test-tree-root'
  item.setAttribute('role', 'option')
  const key = test ? testResultKey(test) : TEST_RUN_ROOT_KEY
  const selected = test
    ? selectedTestKey === key
    : selectedTestKey === null
  item.dataset.testKey = key
  item.setAttribute('aria-selected', String(selected))
  // Roving tab stop keeps keyboard navigation inside the test list while
  // allowing arrow keys to move through every result.
  item.tabIndex = selected ? 0 : -1
  const status = test
    ? test.status
    : isRunning
      ? 'running'
      : result.success
        ? 'passed'
        : normalizeTestPhase(result.phase) === 'noTests'
          ? 'skipped'
          : 'failed'
  item.append(statusIcon(status))
  const name = document.createElement('span')
  name.className = 'test-name'
  name.textContent = test ? (test.displayName || test.name) : 'Test run'
  item.append(name)
  const facts = document.createElement('span')
  facts.className = 'test-tree-facts'
  if (test) {
    if (test.durationMs !== null && test.durationMs !== undefined) {
      facts.textContent = formatDuration(test.durationMs)
    }
    item.setAttribute('aria-label', `${test.displayName || test.name}, ${testStatusLabel(test.status)}${facts.textContent ? `, ${facts.textContent}` : ''}`)
    if (test.className) {
      item.title = test.className
    }
  } else {
    facts.textContent = testRunFacts(result.summary).join(' · ')
    item.setAttribute('aria-label', `Test run, ${testStatusLabel(status)}${facts.textContent ? `, ${facts.textContent}` : ''}`)
  }
  item.append(facts)
  item.addEventListener('click', () => {
    onSelectTest(key, true)
  })
  item.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return
    }
    const options = Array.from(item.parentElement?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    const currentIndex = options.indexOf(item)
    if (currentIndex < 0 || options.length === 0) {
      return
    }
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : Math.max(0, Math.min(
          options.length - 1,
          currentIndex + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1),
        ))
    event.preventDefault()
    const nextKey = options[nextIndex].dataset.testKey ?? TEST_RUN_ROOT_KEY
    onSelectTest(nextKey, true)
  })
  return item
}

function renderTestCase(
  test: TestCaseResult,
  selectedPath: string | null,
  onRevealLocation: (line: number, column?: number | null) => void,
): HTMLElement {
  const failed = test.status === 'failed' || test.status === 'error'
  const detail = document.createElement('div')
  detail.className = `test-detail-content test-row-${test.status}`
  const output = renderOutputConsole(test.stdout, test.stderr)
  if (output) {
    detail.append(output)
  }
  const hasExpected = test.expected !== null && test.expected !== undefined
  const hasActual = test.actual !== null && test.actual !== undefined
  const failureSummary = hasExpected && hasActual ? null : conciseTestFailureMessage(test)
  if (failureSummary) {
    const message = document.createElement('p')
    message.className = 'failure-message'
    message.textContent = failureSummary
    detail.append(message)
  }
  const diff = hasExpected && hasActual ? charDiffSegments(test.expected!, test.actual!) : null
  if (hasExpected) {
    detail.append(renderComparisonValue(
      'Expected',
      test.expected!,
      'expected-value',
      diff ? { prefix: diff.prefix, mid: diff.expectedMid, suffix: diff.suffix } : null,
    ))
  }
  if (hasActual) {
    detail.append(renderComparisonValue(
      'Actual',
      test.actual!,
      'actual-value',
      diff ? { prefix: diff.prefix, mid: diff.actualMid, suffix: diff.suffix } : null,
    ))
  }
  if (test.file && validSourceLine(test.line) !== null) {
    detail.append(renderLocation(test.file, validSourceLine(test.line)!, test.column, selectedPath, onRevealLocation))
  }
  if (test.details) {
    const stack = document.createElement('details')
    stack.className = 'test-full-stack'
    stack.open = failed
    const stackSummary = document.createElement('summary')
    stackSummary.textContent = 'Stack trace'
    stack.append(stackSummary)
    const relevantFrames = relevantTestStackFrames(test.details)
    if (relevantFrames.length > 0) {
      const userFrames = document.createElement('pre')
      userFrames.className = 'test-user-frames'
      userFrames.textContent = relevantFrames.join('\n')
      stack.append(userFrames)
    }
    const stacktrace = document.createElement('pre')
    stacktrace.className = 'test-stacktrace'
    stacktrace.textContent = test.details
    stack.append(stacktrace)
    detail.append(stack)
  }
  return detail
}

function renderOutputConsole(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
): HTMLElement | null {
  const segments = testOutputSegments(stdout, stderr)
  if (segments.length === 0) {
    return null
  }

  const output = document.createElement('section')
  output.className = 'test-console'
  output.setAttribute('aria-label', 'Console output')
  const content = document.createElement('pre')
  content.className = 'test-output-content'
  for (const segment of segments) {
    const stream = document.createElement('span')
    stream.className = `test-output-stream test-output-${segment.stream}`
    stream.textContent = segment.text
    content.append(stream)
  }
  output.append(content)
  return output
}

function renderDiagnostic(
  diagnostic: TestDiagnostic,
  selectedPath: string | null,
  onRevealLocation: (line: number, column?: number | null) => void,
): HTMLElement {
  const card = document.createElement('div')
  card.className = `diagnostic diagnostic-${diagnostic.severity}`
  const header = document.createElement('div')
  header.className = 'diagnostic-header'
  header.append(iconFor(diagnostic.severity === 'warning' ? 'alert' : 'close', 'diagnostic-icon'))
  const message = document.createElement('span')
  message.className = 'diagnostic-message'
  message.textContent = diagnostic.message
  header.append(message)
  card.append(header)
  if (diagnostic.sourceLine) {
    const snippet = document.createElement('pre')
    snippet.className = 'diagnostic-snippet'
    snippet.textContent = diagnostic.caret
      ? `${diagnostic.sourceLine}\n${diagnostic.caret}`
      : diagnostic.sourceLine
    card.append(snippet)
  }
  if (diagnostic.file && validSourceLine(diagnostic.line) !== null) {
    card.append(renderLocation(diagnostic.file, validSourceLine(diagnostic.line)!, diagnostic.column, selectedPath, onRevealLocation))
  }
  return card
}

function renderLocation(
  file: string,
  line: number,
  column: number | null | undefined,
  selectedPath: string | null,
  onRevealLocation: (line: number, column?: number | null) => void,
): HTMLElement {
  const location = document.createElement('button')
  location.type = 'button'
  location.className = 'result-location'
  const matchesCurrentFile = Boolean(selectedPath && sourcePathsMatch(selectedPath, file))
  location.append(
    iconFor('locate', 'result-location-icon'),
    document.createTextNode(`${sourceBasename(file)}:${line}${column ? `:${column}` : ''}`),
  )
  if (matchesCurrentFile) {
    location.title = 'Reveal this line in the editor'
    location.addEventListener('click', () => {
      onRevealLocation(line, column)
    })
  } else {
    location.disabled = true
    location.title = `${file} — this location belongs to another source file`
  }
  return location
}

function statusIcon(status: string): HTMLElement {
  const icon = document.createElement('span')
  icon.className = `test-status-icon test-status-${status}`
  icon.setAttribute('aria-label', status)
  switch (status) {
    case 'passed':
      icon.append(iconFor('check', 'test-status-svg'))
      break
    case 'failed':
      icon.append(iconFor('close', 'test-status-svg'))
      break
    case 'error':
      icon.append(iconFor('alert', 'test-status-svg'))
      break
    case 'running':
      icon.append(iconFor('loader', 'test-status-svg is-spinning'))
      break
    case 'skipped':
      icon.textContent = '–'
      break
    default:
      icon.textContent = '·'
  }
  return icon
}

function renderComparisonValue(
  label: string,
  value: string,
  className: string,
  diff: { prefix: string; mid: string; suffix: string } | null,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = `failure-value ${className}`
  const title = document.createElement('span')
  title.className = 'failure-value-label'
  title.textContent = label
  const content = document.createElement('code')
  content.className = 'failure-value-content'
  if (diff) {
    content.append(document.createTextNode(diff.prefix))
    const mark = document.createElement('mark')
    mark.className = 'diff-mark'
    mark.textContent = diff.mid
    content.append(mark, document.createTextNode(diff.suffix))
  } else {
    content.textContent = value
  }
  wrapper.append(title, content)
  return wrapper
}
