import type { AiModelList, AiUsageBucket, AiUsageSummary, AiUsageTotals } from '../backend'
import { iconFor } from '../icons'

export type LlmMessageTone = 'info' | 'success' | 'warning' | 'error'

export interface LlmMessage {
  tone: LlmMessageTone
  text: string
}

export interface LlmKeyViewModel {
  /** Whether the typed key is shown as plain text. A saved key is never readable. */
  revealed: boolean
  /** The user chose to enter a new key over the saved one. */
  replacing: boolean
  /** Null until the first status response. */
  configured: boolean | null
  statusLoading: boolean
  busy: boolean
  message: LlmMessage | null
}

export interface LlmModelsViewModel {
  configured: boolean | null
  list: AiModelList | null
  loading: boolean
  /** The list request itself rejected, as opposed to `list.error`. */
  failure: string | null
  selectedModelId: string | null
}

export type LlmUsagePeriod = 'day' | 'week'

export const LLM_USAGE_PERIODS: readonly LlmUsagePeriod[] = ['day', 'week']

export interface LlmUsageViewModel {
  /** The active tab. */
  period: LlmUsagePeriod
  usage: AiUsageSummary | null
  /** The period `usage` was requested for, which lags `period` during a tab switch. */
  dataPeriod: LlmUsagePeriod
  /** Null, or a start with no bucket, selects the newest bucket. */
  selectedStartMs: number | null
  modelList: AiModelList | null
  failure: string | null
  onSelectBucket: (startMs: number) => void
}

export interface LlmModelOption {
  value: string
  label: string
}

const DEFAULT_MODEL_LABEL = 'Default (newest Sonnet)'

function requiredElement<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const match = root.querySelector<T>(selector)
  if (!match) {
    throw new Error(`Missing editor element: ${selector}`)
  }
  return match
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) {
    element.textContent = text
  }
  return element
}

function noteElement(message: LlmMessage): HTMLElement {
  return createElement('p', `llm-message is-${message.tone}`, message.text)
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

function formatUsd(value: number): string {
  if (value === 0) {
    return '$0.00'
  }
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

/** The cost with any gap visible: "$X + N unpriced". */
export function formatLlmCost(totals: AiUsageTotals): string {
  if (totals.requests > 0 && totals.unpricedRequests >= totals.requests) {
    return 'Price unknown'
  }
  const cost = formatUsd(totals.costUsd)
  return totals.unpricedRequests > 0 ? `${cost} + ${formatCount(totals.unpricedRequests)} unpriced` : cost
}

function modelDisplayName(list: AiModelList | null, id: string): string {
  return list?.models.find((model) => model.id === id)?.displayName ?? id
}

function isPinMissingFromList(model: LlmModelsViewModel): boolean {
  const { list, selectedModelId } = model
  return selectedModelId !== null
    && list !== null
    && list.models.length > 0
    && !list.models.some((entry) => entry.id === selectedModelId)
}

export function llmModelOptions(model: LlmModelsViewModel): LlmModelOption[] {
  const { list, selectedModelId } = model
  const defaultId = list?.defaultModelId ?? null
  const defaultLabel = defaultId === null
    ? DEFAULT_MODEL_LABEL
    : `${DEFAULT_MODEL_LABEL}: ${modelDisplayName(list, defaultId)}`
  const options: LlmModelOption[] = [{ value: '', label: defaultLabel }]
  for (const entry of list?.models ?? []) {
    // An older model stays offered only while it is the pin, so the pin is not lost.
    if (entry.superseded && entry.id !== selectedModelId) {
      continue
    }
    options.push({
      value: entry.id,
      label: entry.deprecated ? `${entry.displayName} (deprecated)` : entry.displayName,
    })
  }
  // A pin stays selectable while the list is unknown or no longer includes it.
  if (selectedModelId !== null && !list?.models.some((entry) => entry.id === selectedModelId)) {
    options.push({
      value: selectedModelId,
      label: isPinMissingFromList(model) ? `${selectedModelId} (no longer listed)` : selectedModelId,
    })
  }
  return options
}

function llmModelNotes(model: LlmModelsViewModel): LlmMessage[] {
  const { configured, list, failure, selectedModelId } = model
  if (configured !== true) {
    return configured === false ? [{ tone: 'info', text: 'Add a key to load models.' }] : []
  }
  const notes: LlmMessage[] = []
  if (failure !== null) {
    notes.push({ tone: 'error', text: `Could not load the model list: ${failure}` })
  }
  if (list?.error) {
    notes.push(list.models.length === 0
      ? { tone: 'error', text: `Could not load the model list: ${list.error}` }
      : { tone: 'warning', text: `Could not refresh the model list: ${list.error} Showing the cached list.` })
  }
  if (list === null) {
    return notes
  }
  if (list.models.length === 0) {
    if (!list.error) {
      notes.push({ tone: 'warning', text: 'No models are available for this key.' })
    }
    return notes
  }
  if (isPinMissingFromList(model)) {
    notes.push({
      tone: 'warning',
      text: `${selectedModelId} is no longer in the model list. The default is used until you choose another model.`,
    })
  } else if (selectedModelId === null && list.defaultModelId === null) {
    notes.push({ tone: 'warning', text: 'No Sonnet model is available. Choose a model to generate tests.' })
  }
  return notes
}

/** Update key controls in place; the input's typed value is never written here. */
export function renderLlmKey(root: HTMLElement, model: LlmKeyViewModel): void {
  const { revealed, replacing, configured, statusLoading, busy, message } = model
  const saved = configured === true
  const keyFieldHidden = saved && !replacing
  requiredElement<HTMLElement>(root, '#llm-key-entry').hidden = keyFieldHidden
  requiredElement<HTMLElement>(root, '#llm-key-note').hidden = keyFieldHidden
  requiredElement<HTMLInputElement>(root, '#llm-api-key').type = revealed ? 'text' : 'password'
  const toggle = requiredElement<HTMLButtonElement>(root, '#llm-toggle-key')
  const toggleLabel = revealed ? 'Hide API key' : 'Show API key'
  toggle.title = toggleLabel
  toggle.setAttribute('aria-label', toggleLabel)
  toggle.setAttribute('aria-pressed', String(revealed))
  toggle.replaceChildren(iconFor(revealed ? 'eyeOff' : 'eye', 'button-icon'))
  requiredElement(root, '#llm-key-status').textContent = configured === true
    ? 'Key saved'
    : configured === false
      ? 'No key saved'
      : statusLoading
        ? 'Checking for a saved key…'
        : 'Key status unavailable'
  const input = requiredElement<HTMLInputElement>(root, '#llm-api-key')
  input.readOnly = busy
  input.placeholder = saved ? 'Enter a new key to replace the saved one' : 'Enter your API key'
  requiredElement<HTMLButtonElement>(root, '#llm-save-key').disabled = busy
  const cancel = requiredElement<HTMLButtonElement>(root, '#llm-cancel-replace-key')
  cancel.hidden = !saved || !replacing
  cancel.disabled = busy
  for (const selector of ['#llm-replace-key', '#llm-clear-key']) {
    const button = requiredElement<HTMLButtonElement>(root, selector)
    button.hidden = !saved || replacing
    button.disabled = busy
  }
  const messageElement = requiredElement<HTMLElement>(root, '#llm-key-message')
  messageElement.hidden = message === null
  messageElement.className = message === null ? 'llm-message' : `llm-message is-${message.tone}`
  messageElement.textContent = message?.text ?? ''
}

export function renderLlmClearKeyDialog(root: HTMLElement, open: boolean): void {
  requiredElement<HTMLElement>(root, '#clear-llm-key-dialog').hidden = !open
}

export function renderLlmModels(root: HTMLElement, model: LlmModelsViewModel): void {
  const select = requiredElement<HTMLSelectElement>(root, '#llm-model-select')
  const options = llmModelOptions(model)
  // Replacing options closes an open dropdown, so skip it when nothing changed.
  const signature = JSON.stringify(options)
  if (select.dataset.options !== signature) {
    select.replaceChildren(...options.map((option) => {
      const element = document.createElement('option')
      element.value = option.value
      element.textContent = option.label
      return element
    }))
    select.dataset.options = signature
  }
  select.value = model.selectedModelId ?? ''
  select.disabled = model.configured !== true
  const refresh = requiredElement<HTMLButtonElement>(root, '#llm-refresh-models')
  refresh.disabled = model.configured !== true || model.loading
  refresh.textContent = model.loading
    ? 'Refreshing…'
    : model.failure !== null || model.list?.error
      ? 'Retry'
      : 'Refresh'
  requiredElement(root, '#llm-model-notes').replaceChildren(...llmModelNotes(model).map(noteElement))
}

function shortDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const LATEST_BUCKET_LABELS: Record<LlmUsagePeriod, string> = {
  day: 'Today',
  week: 'This week',
}

const CHART_LABELS: Record<LlmUsagePeriod, string> = {
  day: 'Cost per day',
  week: 'Cost per week',
}

function bucketLabel(period: LlmUsagePeriod, startMs: number, latest: boolean): string {
  if (latest) {
    return LATEST_BUCKET_LABELS[period]
  }
  const date = shortDate(new Date(startMs))
  return period === 'day' ? date : `Week of ${date}`
}

function requestCount(requests: number): string {
  return `${formatCount(requests)} ${requests === 1 ? 'request' : 'requests'}`
}

function usageDetail(totals: AiUsageTotals): string {
  if (totals.requests === 0) {
    return 'No requests'
  }
  const cacheTokens = totals.cacheReadTokens + totals.cacheWriteTokens
  return [
    requestCount(totals.requests),
    `${formatCount(totals.inputTokens)} in`,
    `${formatCount(totals.outputTokens)} out`,
    ...(cacheTokens > 0 ? [`${formatCount(cacheTokens)} cache`] : []),
    ...(totals.refusedRequests > 0 ? [`${formatCount(totals.refusedRequests)} refused`] : []),
  ].join(' · ')
}

function usageHeadline(label: string, totals: AiUsageTotals): HTMLElement {
  const headline = createElement('div', 'llm-usage-headline')
  headline.append(
    createElement('p', 'llm-usage-label', label),
    createElement('p', 'llm-usage-cost', formatLlmCost(totals)),
    createElement('p', 'llm-usage-detail', usageDetail(totals)),
  )
  return headline
}

/** A share of the largest value, with a visible minimum so a tiny amount still shows. */
function barHeightPercent(cost: number, maxCost: number): number {
  return maxCost > 0 ? Math.max((cost / maxCost) * 100, 6) : 6
}

function usageChart(
  period: LlmUsagePeriod,
  buckets: readonly AiUsageBucket[],
  selected: AiUsageBucket,
  onSelect: (startMs: number) => void,
): { chart: HTMLElement; selectedBar: HTMLButtonElement | null } {
  const chart = createElement('div', 'llm-usage-chart')
  chart.setAttribute('role', 'group')
  chart.setAttribute('aria-label', CHART_LABELS[period])
  const maxCost = Math.max(...buckets.map((bucket) => bucket.totals.costUsd))
  let selectedBar: HTMLButtonElement | null = null
  buckets.forEach((bucket, index) => {
    const { startMs, totals } = bucket
    const label = bucketLabel(period, startMs, index === buckets.length - 1)
    const description = `${label}: ${formatLlmCost(totals)}, ${requestCount(totals.requests)}`
    const bar = createElement('button', 'llm-usage-bar')
    bar.type = 'button'
    bar.title = description
    bar.setAttribute('aria-label', description)
    bar.setAttribute('aria-pressed', String(bucket === selected))
    bar.addEventListener('click', () => onSelect(startMs))
    const mark = createElement('span', totals.requests > 0 ? 'llm-usage-bar-mark' : 'llm-usage-bar-mark is-empty')
    if (totals.requests > 0) {
      mark.style.height = `${barHeightPercent(totals.costUsd, maxCost)}%`
    }
    bar.append(mark)
    chart.append(bar)
    if (bucket === selected) {
      selectedBar = bar
    }
  })
  return { chart, selectedBar }
}

function usageAxis(period: LlmUsagePeriod, buckets: readonly AiUsageBucket[]): HTMLElement {
  const axis = createElement('div', 'llm-usage-axis')
  axis.append(
    createElement('span', '', shortDate(new Date(buckets[0].startMs))),
    createElement('span', '', LATEST_BUCKET_LABELS[period]),
  )
  return axis
}

function modelShare(entry: AiUsageTotals, total: AiUsageTotals): number {
  return total.costUsd > 0
    ? entry.costUsd / total.costUsd
    : entry.requests / Math.max(total.requests, 1)
}

function usageModels(bucket: AiUsageBucket, list: AiModelList | null): HTMLElement {
  const models = createElement('ul', 'llm-usage-models')
  models.setAttribute('aria-label', 'By model')
  const rows = bucket.perModel
    .map(({ model, totals }) => ({ name: modelDisplayName(list, model), totals }))
    .sort((left, right) => right.totals.costUsd - left.totals.costUsd
      || right.totals.requests - left.totals.requests
      || left.name.localeCompare(right.name))
  for (const { name, totals } of rows) {
    const share = createElement('span', 'llm-usage-share')
    const fill = createElement('span', 'llm-usage-share-fill')
    fill.style.width = `${modelShare(totals, bucket.totals) * 100}%`
    share.append(fill)
    const row = createElement('li', 'llm-usage-model')
    const nameElement = createElement('span', 'llm-usage-model-name', name)
    nameElement.title = name
    row.append(
      nameElement,
      share,
      createElement('span', 'llm-usage-model-requests', requestCount(totals.requests)),
      createElement('span', 'llm-usage-model-cost', formatLlmCost(totals)),
    )
    models.append(row)
  }
  return models
}

/** Returns the selected bar, because rendering replaces the one that may hold focus. */
export function renderLlmUsage(root: HTMLElement, model: LlmUsageViewModel): HTMLButtonElement | null {
  const { period, usage, dataPeriod, selectedStartMs, modelList, failure, onSelectBucket } = model
  const hasUsage = usage !== null && usage.allTime.requests > 0
  requiredElement<HTMLElement>(root, '#llm-usage-controls').hidden = !hasUsage
  requiredElement(root, '#llm-usage-all-time').textContent = hasUsage ? `All time ${formatLlmCost(usage.allTime)}` : ''
  const body = requiredElement<HTMLElement>(root, '#llm-usage-body')
  body.setAttribute('aria-labelledby', `llm-usage-${period}-tab`)
  for (const entry of LLM_USAGE_PERIODS) {
    const tab = requiredElement<HTMLButtonElement>(root, `#llm-usage-${entry}-tab`)
    const active = entry === period
    tab.classList.toggle('is-active', active)
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
  }
  const parts: HTMLElement[] = []
  let selectedBar: HTMLButtonElement | null = null
  if (failure !== null) {
    parts.push(noteElement({ tone: 'error', text: `Could not load usage: ${failure}` }))
  }
  if (usage !== null && !hasUsage) {
    parts.push(noteElement({ tone: 'info', text: 'No usage yet.' }))
  } else if (hasUsage && usage.buckets.length > 0) {
    const { buckets } = usage
    const newest = buckets[buckets.length - 1]
    const selected = buckets.find((bucket) => bucket.startMs === selectedStartMs) ?? newest
    const chart = usageChart(dataPeriod, buckets, selected, onSelectBucket)
    selectedBar = chart.selectedBar
    parts.push(
      usageHeadline(bucketLabel(dataPeriod, selected.startMs, selected === newest), selected.totals),
      chart.chart,
      usageAxis(dataPeriod, buckets),
      usageModels(selected, modelList),
    )
  }
  if (usage !== null && usage.skippedLines > 0) {
    parts.push(noteElement({
      tone: 'warning',
      text: `${formatCount(usage.skippedLines)} usage ${usage.skippedLines === 1 ? 'record' : 'records'} could not be read and ${usage.skippedLines === 1 ? 'is' : 'are'} not counted.`,
    }))
  }
  body.replaceChildren(...parts)
  return selectedBar
}
