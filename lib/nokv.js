/**
 * Update of the CLI bridge against the NoKV 0.20 CLI contract:
 *
 * - success prints one multi-line pretty JSON document on stdout;
 * - a failure prints one compact JSON envelope on stderr and exits non-zero;
 * - the envelope carries `code`, `class`, `next_action`, `retryable`, `details`.
 *
 * Everything the tool layer needs to explain a refusal lives in `NokvError`.
 */
import { spawn } from 'node:child_process'

/** Deployment route options, in the order the CLI documents them. */
const ROUTE_OPTIONS = [
  ['--root-id', 'rootId'],
  ['--agent-id', 'agentId'],
  ['--control-dir', 'controlDir'],
  ['--etcd-endpoint', 'etcdEndpoint'],
  ['--object-bucket', 'objectBucket'],
  ['--object-endpoint', 'objectEndpoint'],
  ['--object-root', 'objectRoot'],
  ['--object-region', 'objectRegion'],
  ['--object-namespace-id', 'objectNamespaceId'],
]

/** Exit codes with a stable meaning in the CLI contract (cli.rs / failure_envelope.rs). */
const EXIT_CODES = {
  1: 'internal',
  2: 'invalid_input',
  3: 'not_found',
  4: 'precondition_failed',
  5: 'transient',
  6: 'outcome_unknown',
  7: 'identity_conflict',
  8: 'incompatible',
  9: 'operator_required',
  10: 'unauthenticated',
  11: 'permission_denied',
}

/** A NoKV refusal or transport failure, carrying the stable parts of the answer. */
export class NokvError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'NokvError'
    this.code = code
    Object.assign(this, detail)
  }
}

/**
 * Build the global route option argv from plugin config.
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
export function routeArgs(config) {
  const argv = []
  for (const [flag, key] of ROUTE_OPTIONS) {
    const value = config[key]
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text === '') continue
    argv.push(flag, text)
  }
  return argv
}

/**
 * Read one CLI answer: a JSON document on stdout, or `{ text }` for a surface
 * that answered plain text.
 * @param {string} stdout
 */
export function parseAnswer(stdout) {
  const text = stdout.trim()
  if (text === '') return { status: 'success' }
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

/**
 * Read the failure envelope the CLI prints on stderr. The contract is one
 * compact JSON object; anything else is kept as diagnostic text.
 * @param {string} stderr
 * @returns {{ code?: string, class?: string, nextAction?: string, message?: string, details?: unknown, text?: string }}
 */
export function parseFailure(stderr) {
  const text = stderr.trim()
  if (text === '') return {}
  const line = text.split('\n').filter(Boolean).at(-1) ?? ''
  try {
    const envelope = JSON.parse(line)
    if (envelope && typeof envelope === 'object') {
      return {
        code: typeof envelope.code === 'string' ? envelope.code : undefined,
        class: typeof envelope.class === 'string' ? envelope.class : undefined,
        nextAction: typeof envelope.next_action === 'string' ? envelope.next_action : undefined,
        message: typeof envelope.message === 'string' ? envelope.message : undefined,
        details: envelope.details,
      }
    }
  } catch {
    // fall through: a deployment that does not speak the envelope
  }
  return { text: text.slice(-4000) }
}

/**
 * Run one `nokv` invocation and resolve with its parsed answer.
 *
 * @param {Record<string, any>} config plugin Config
 * @param {string[]} argv arguments after the global route options
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export function runNokv(config, argv, options = {}) {
  const executable = String(config.nokvPath || '').trim() || 'nokv'
  const args = [...routeArgs(config), ...argv]
  const timeoutMs = Number(options.timeoutMs ?? config.timeoutMs ?? 30000)
  const maxOutputBytes = Number(config.maxOutputBytes ?? 200000)

  return new Promise((resolve, reject) => {
    let settled = false
    let child
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }

    try {
      child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      })
    } catch (error) {
      reject(new NokvError('spawn-failed', `cannot start ${executable}: ${error.message}`, { argv }))
      return
    }

    let stdout = ''
    let stderr = ''
    let overflow = false

    child.stdout?.on('data', (chunk) => {
      if (overflow) return
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) > maxOutputBytes) overflow = true
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 64000) stderr = stderr.slice(-64000)
    })

    const onAbort = () => {
      child.kill('SIGTERM')
      finish(reject, new NokvError('aborted', 'nokv call aborted', { argv }))
    }
    options.signal?.addEventListener?.('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(reject, new NokvError('timeout', `nokv did not answer within ${timeoutMs} ms`, {
        argv, stderr: stderr.slice(-4000),
      }))
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (error) => {
      finish(reject, new NokvError('spawn-failed', `cannot start ${executable}: ${error.message}`, { argv }))
    })

    child.on('close', (exitCode, signal) => {
      if (exitCode === 0) {
        if (overflow) {
          finish(reject, new NokvError('output-too-large',
            `nokv answered more than ${maxOutputBytes} bytes; narrow the query with limit/cursor`, { argv }))
          return
        }
        finish(resolve, parseAnswer(stdout))
        return
      }
      const failure = parseFailure(stderr)
      const kind = EXIT_CODES[exitCode] ?? (Number.isInteger(exitCode) ? `exit_${exitCode}` : `signal_${signal}`)
      const label = [failure.code, failure.class].filter(Boolean).join(' / ') || kind
      const reason = failure.message || failure.text || 'no diagnostic'
      const next = failure.nextAction && failure.nextAction !== 'none' ? `; next_action: ${failure.nextAction}` : ''
      finish(reject, new NokvError(kind,
        `nokv refused this call (${label}, exit ${exitCode}): ${reason}${next}`, {
          argv,
          exitCode,
          signal,
          failureCode: failure.code,
          failureClass: failure.class,
          nextAction: failure.nextAction,
          details: failure.details,
          stderr: stderr.slice(-8000),
        }))
    })
  })
}
