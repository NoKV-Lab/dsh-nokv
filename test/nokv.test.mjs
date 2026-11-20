/**
 * Unit test for the CLI bridge, run with `node --test test/`.
 * A fake `nokv` stands in for a deployment: no network, no Rust, no object
 * store. What it proves is argv construction, JSON parsing, and the failure
 * taxonomy the tool layer depends on.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { routeArgs, runNokv, NokvError } from '../lib/nokv.js'

const fake = new URL('./fake-nokv', import.meta.url).pathname
const logDir = mkdtempSync(join(tmpdir(), 'dsh-nokv-test-'))
const logFile = join(logDir, 'calls.jsonl')
process.env.NOKV_FAKE_LOG = logFile

const config = {
  nokvPath: fake,
  rootId: 'root-abc',
  agentId: 'agent-1',
  objectBucket: '',
  timeoutMs: 3000,
}

test('route options keep documented order and skip empty values', () => {
  assert.deepEqual(routeArgs(config), ['--root-id', 'root-abc', '--agent-id', 'agent-1'])
  assert.deepEqual(routeArgs({}), [])
})

test('artifact ceiling is a route option and zero means unset', () => {
  assert.deepEqual(routeArgs({ rootId: 'r'.repeat(32), maxArtifactBytes: 0 }), ['--root-id', 'r'.repeat(32)])
  assert.deepEqual(
    routeArgs({ maxArtifactBytes: 33554432 }),
    ['--max-artifact-bytes', '33554432'],
  )
})

test('a successful answer is the parsed JSON envelope', async () => {
  const answer = await runNokv(config, ['workbench', 'workbench_put_file', '{"id":"run-1","section":"outputs","path":"a.txt","text":"hi"}'])
  assert.equal(answer.ok, true)
  assert.equal(answer.verb, 'workbench_put_file')
  assert.equal(answer.workbench_id, 'run-1')
  assert.equal(answer.generation, 3)
})

test('a refusal keeps the CLI exit code meaning', async () => {
  await assert.rejects(
    runNokv(config, ['workbench', 'workbench_put_file', '{"id":"run-1","fail":"permission"}']),
    (error) => {
      assert.ok(error instanceof NokvError)
      assert.equal(error.code, 'permission_denied')
      assert.equal(error.exitCode, 11)
      assert.match(error.message, /exit 11/)
      return true
    },
  )
})

test('an operator-only refusal is its own code', async () => {
  await assert.rejects(
    runNokv(config, ['workbench', 'workbench_create', '{"fail":"operator"}']),
    (error) => error.code === 'operator_required',
  )
})

test('a timeout reports the configured budget', async () => {
  await assert.rejects(
    runNokv({ ...config, timeoutMs: 200 }, ['workbench', 'workbench_list', '{"sleep_ms":2000}']),
    (error) => error.code === 'timeout' && /200 ms/.test(error.message),
  )
})

test('an abort signal cancels the child', async () => {
  const controller = new AbortController()
  const pending = runNokv(config, ['workbench', 'workbench_list', '{"sleep_ms":5000}'], { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, (error) => error.code === 'aborted')
})

test('output over the configured bound is refused, not truncated silently', async () => {
  await assert.rejects(
    runNokv({ ...config, maxOutputBytes: 100 }, ['workbench', 'workbench_grep', '{"big":5000}']),
    (error) => error.code === 'output-too-large',
  )
})

test('a missing executable is a spawn failure, not a crash', async () => {
  await assert.rejects(
    runNokv({ nokvPath: '/nonexistent/nokv' }, ['schema']),
    (error) => error.code === 'spawn-failed',
  )
})
