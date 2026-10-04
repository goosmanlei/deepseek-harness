/** Local source-reading diagnostics for the profile loading call chain. */
import { inspect } from 'node:util'

let sequence = 0

/** Print a numbered profile-loading observation with untruncated object values to stderr.
 * @param scope Function producing this observation.
 * @param stage Loading step or branch, described for source readers.
 * @param value Optional inputs, outputs, or error for this step.
 */
export function profileDebug(scope: string, stage: string, value?: unknown): void {
  const detail = value === undefined ? '' : `\n${inspect(value, {
    depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false,
  })}`
  console.error(`[profile:${String(++sequence).padStart(4, '0')}][${scope}] ${stage}${detail}`)
}
