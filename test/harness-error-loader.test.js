import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HARNESS_ERROR_PACKAGES, loadHarnessError } from '../src/harness-error-loader.js'

class SplitHarnessError extends Error {}
class LlmHarnessError extends Error {}

function missing(specifier) {
  return Object.assign(new Error(`Cannot find package '${specifier}' imported from test`), { code: 'ERR_MODULE_NOT_FOUND' })
}

test('prefers the split dsh-error package when it exists', async () => {
  const seen = []
  const result = await loadHarnessError(async (specifier) => {
    seen.push(specifier)
    return { HarnessError: SplitHarnessError }
  })
  assert.equal(result, SplitHarnessError)
  assert.deepEqual(seen, ['@deepseek-ai/dsh-error'])
})

test('falls back to dsh-llm when the split package is absent', async () => {
  const seen = []
  const result = await loadHarnessError(async (specifier) => {
    seen.push(specifier)
    if (specifier === '@deepseek-ai/dsh-error') throw missing(specifier)
    return { HarnessError: LlmHarnessError }
  })
  assert.equal(result, LlmHarnessError)
  assert.deepEqual(seen, HARNESS_ERROR_PACKAGES)
})

test('does not hide a broken dsh-error package behind the fallback', async () => {
  const failure = missing('@deepseek-ai/dsh-error-transitive')
  await assert.rejects(loadHarnessError(async () => { throw failure }), error => error === failure)
})

test('rejects a package that does not export HarnessError', async () => {
  await assert.rejects(loadHarnessError(async () => ({})), /does not export HarnessError/)
})

test('reports both supported packages when neither is installed', async () => {
  await assert.rejects(
    loadHarnessError(async specifier => { throw missing(specifier) }),
    error => HARNESS_ERROR_PACKAGES.every(specifier => error.message.includes(specifier)),
  )
})
