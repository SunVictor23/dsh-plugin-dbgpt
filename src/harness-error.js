/** HarnessError from either the split error package or the earlier LLM package. */
import { loadHarnessError } from './harness-error-loader.js'

export const HarnessError = await loadHarnessError()
