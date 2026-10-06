import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

// A real session hands the deny back wrapped in the engine's own words.
const DENY_REASON =
  'PreToolUse:Bash hook error: [SASY] Recursive delete of build/ is blocked (data_loss).\n' +
  'Fix:\n  delete the specific files instead.\n' +
  'EITHER follow the suggested fix above and retry.\n' +
  'OR ask the user for a one-time bypass.'
const ASK_REASON = '[SASY] Pushing to a public remote needs your approval (public_push).'
const BAND = {
  plugin: 'sasy-guard',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const
const GUARD = {
  command: 'guard',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

/** Stands for the plugin's own settings hook: denies `rm -rf`, asks on push. */
function settingsHook(on: On): void {
  on('classic.PreToolUse', ($, e) => {
    if (e.tool !== 'Bash') return {}
    if (e.command.startsWith('rm -rf')) return { deny: DENY_REASON }
    if (e.command.startsWith('git push')) return { ask: ASK_REASON }
    if (e.command.startsWith('curl')) return { deny: 'blocked by another hook' }
    return {}
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
}

/** Records every status line the mod pins. */
function statusLines(on: On): string[] {
  const lines: string[] = []
  on('ui.status', ($, e) => {
    lines.push(String(e.text))
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The engine's own band, drawn when the mod passes the site on.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as RenderElement
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return lines
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

test('counts every checked call and only [SASY] verdicts', async ($, on) => {
  mock.clock(on, { now: 0 })
  settingsHook(on)
  const lines = statusLines(on)

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await $.tool.call({ tool: 'Bash', command: 'curl example.com' })

  expect(denied.deny ?? denied.text).toContain('Recursive delete')
  expect(lines.at(-1)).toBe('4 checked · 1 denied · 1 asked')
})

test('the band explains the latest decision until dismissed', async ($, on) => {
  mock.clock(on, { now: 0 })
  settingsHook(on)
  statusLines(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ ...BAND, surface })
    expect(await empty.find({ key: 'dismiss' })).toBeUndefined()
    await empty.unmount()
  }

  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'sasy-guard denied Bash: rm -rf build' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Recursive delete of build/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\[SASY\]|hook error/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /delete the specific files/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /EITHER/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '… full text: /guard' })).toBeDefined()
    expect(await ui.find({ key: 'engine' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /needs approval for Bash: git push/ })).toBeDefined()
  await again.unmount()
})

test('/guard reports daemon health and recent decisions without a model turn', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, { SASY_WATCH_PORT: '51799' })
  settingsHook(on)
  statusLines(on)
  const urls: string[] = []
  on('http.fetch', ($, e) => {
    urls.push(e.url)
    const health = { ready: true, endpoint: 'localhost:50061', failMode: 'closed', sessions: 1 }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(health) } }
  })

  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  const out = await $.command.run(GUARD)

  expect(urls).toEqual(['http://127.0.0.1:51799/healthz'])
  expect(out.text).toContain('daemon: up, policy engine ready · endpoint localhost:50061')
  expect(out.text).toContain('this session: 1 checked · 1 denied · 0 asked')
  expect(out.text).toContain('deny  Bash  rm -rf build')
  expect(out.text).toContain('OR ask the user for a one-time bypass.')
})

test('/guard says so when the daemon is unreachable', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, {})
  on('http.fetch', () => ({ deny: 'connection refused' }))
  statusLines(on)

  await $.session.start(START)
  const out = await $.command.run(GUARD)

  expect(out.text).toContain('daemon: unreachable at http://127.0.0.1:51711/healthz')
  expect(out.text).toContain('no denials or approval requests yet')
})

test('/guard tells a malformed health answer from an unreachable daemon', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, {})
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '<html>' } }))
  statusLines(on)

  await $.session.start(START)
  const out = await $.command.run(GUARD)

  expect(out.text).toContain('answered HTTP 200 with a body that is not JSON')
})

test('the status entry is pinned again after /clear', async ($, on) => {
  mock.clock(on, { now: 0 })
  settingsHook(on)
  const lines = statusLines(on)
  on('classic.SessionStart', () => ({}))

  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  const before = lines.length
  await $.classic.SessionStart({ source: 'clear' })

  expect(lines.length).toBe(before + 1)
})
