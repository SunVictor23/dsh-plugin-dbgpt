/** Resolve HarnessError across DSH package layouts. */

/** Package layouts, newest first. */
export const HARNESS_ERROR_PACKAGES = ['@deepseek-ai/dsh-error', '@deepseek-ai/dsh-llm']

/**
 * Whether an import failed because the requested package itself is absent.
 * A missing transitive dependency is not a compatibility signal and must stay visible.
 * @param {unknown} error - rejected dynamic import.
 * @param {string} specifier - package requested by the compatibility loader.
 * @returns {boolean} whether that exact package is missing.
 */
function isMissingPackage(error, specifier) {
  return error !== null && typeof error === 'object'
    && error.code === 'ERR_MODULE_NOT_FOUND'
    && String(error.message).includes(`'${specifier}'`)
}

/**
 * Load the HarnessError class exported by the installed DSH generation.
 * @param {(specifier: string) => Promise<object>} [importModule] - injectable importer for tests.
 * @returns {Promise<typeof Error>} the runtime's own HarnessError constructor.
 */
export async function loadHarnessError(importModule = specifier => import(specifier)) {
  const missing = []
  for (const specifier of HARNESS_ERROR_PACKAGES) {
    let module
    try {
      module = await importModule(specifier)
    } catch (error) {
      if (!isMissingPackage(error, specifier)) throw error
      missing.push(error)
      continue
    }
    if (typeof module.HarnessError !== 'function') {
      throw new TypeError(`dsh-plugin-dbgpt: ${specifier} does not export HarnessError`)
    }
    return module.HarnessError
  }
  throw new Error(
    `dsh-plugin-dbgpt: no compatible HarnessError export found; expected one of ${HARNESS_ERROR_PACKAGES.join(', ')}`,
    { cause: new AggregateError(missing, 'compatible DSH error packages are absent') },
  )
}
