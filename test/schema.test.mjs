/**
 * Contract test: every request body this plugin produces must be acceptable to
 * the installed NoKV CLI. It reads the CLI's own `schema` command and checks,
 * for one representative call per operation, that
 *
 * - the CLI tool exists,
 * - every key we send is declared by that tool's input schema,
 * - every key it requires is present.
 *
 * The test skips when no `nokv` binary is available, so `node --test test/`
 * still works on a machine that only wants the pure mapping tests.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildArgv } from '../lib/invoke.js'

const NOKv = process.env.NOKV_BIN || 'nokv'

function loadSchema() {
  const out = spawnSync(NOKv, ['schema'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (out.error || out.status !== 0) return null
  return JSON.parse(out.stdout)
}

/** Collect `{ name -> input_schema }` from the CLI's schema document. */
function toolsOf(node, found = new Map()) {
  if (Array.isArray(node)) {
    for (const item of node) toolsOf(item, found)
  } else if (node && typeof node === 'object') {
    if (typeof node.name === 'string' && node.name.startsWith('workbench_') && node.input_schema) {
      found.set(node.name, node.input_schema)
    }
    for (const value of Object.values(node)) toolsOf(value, found)
  }
  return found
}

const schema = loadSchema()

/** One representative call per operation, covering every body key we can send. */
const CALLS = {
  create: { workbench: 'w1' },
  put_file: {
    workbench: 'w1', section: 'outputs', path: 'a.txt', text: 'hello',
    replace: true, expected_generation: 2, operation_id: 'a'.repeat(32), content_type: 'text/plain',
  },
  append: { workbench: 'w1', section: 'logs', path: 'run.log', text: 'line', operation_id: 'b'.repeat(32) },
  edit: {
    workbench: 'w1', section: 'scripts', path: 'main.py', old_string: 'a', new_string: 'b',
    replace_all: true, operation_id: 'c'.repeat(32),
  },
  commit: { workbench: 'w1', content_digest_uri: 'sha256:' + '0'.repeat(64), manifest_json: '{"task":"t"}', replace: true },
  snapshot: { workbench: 'w1', name: 'pre', ttl_days: 2, reason: 'test', metadata_json: '{"k":1}' },
  snapshot_retire: { workbench: 'w1', name: 'pre', reason: 'done' },
  fork: { workbench: 'w1', destination: 'w1-b', at_snapshot_name: 'pre' },
  read: {
    workbench: 'w1', section: 'outputs', path: 'a.txt', format: 'structured',
    offset: 0, limit: 10, if_none_match: 3, cursor: 'c1', at_snapshot_name: 'pre',
  },
  list: { workbench: 'w1', section: 'outputs', path: null, limit: 10, cursor: 'c1', at_snapshot_id: 7 },
  stat: { workbench: 'w1', section: 'outputs', path: 'a.txt', at_snapshot_name: 'pre' },
  grep: { workbench: 'w1', pattern: 'hello', patterns: ['world'], glob: '*.md', section: 'outputs', path: null, limit: 10, cursor: 'c1' },
  search: {
    workbench: 'w1', section: 'outputs', predicates_json: '[{"field":"kind","op":"eq","value":"file"}]',
    fields: ['path'], sort_json: '[{"field":"size_bytes","direction":"desc"}]', facets: ['kind'], limit: 10,
  },
  catalog: { workbench: 'w1', section: 'outputs', field_prefix: 'kind', include_facets: true },
  find: { committed: true, manifest_pattern: 'task', include_manifest: true, limit: 5, cursor: 'c1' },
  snapshot_list: { workbench: 'w1' },
}

test('nokv schema is readable', { skip: schema === null ? 'no nokv binary' : false }, () => {
  assert.ok(toolsOf(schema).size >= 18)
})

test('every body key is declared and every required key is present', {
  skip: schema === null ? 'no nokv binary' : false,
}, () => {
  const tools = toolsOf(schema)
  const problems = []
  for (const [op, args] of Object.entries(CALLS)) {
    const argv = buildArgv(op, args)
    assert.equal(argv[0], 'workbench', `${op} should be a workbench call`)
    const toolName = argv[1]
    const body = JSON.parse(argv[2])
    const cliTool = tools.get(toolName)
    if (!cliTool) {
      problems.push(`${op}: CLI has no tool ${toolName}`)
      continue
    }
    const props = Object.keys(cliTool.properties || {})
    for (const key of Object.keys(body)) {
      if (!props.includes(key)) problems.push(`${op}: ${toolName} does not declare \`${key}\``)
    }
    for (const key of cliTool.required || []) {
      if (!(key in body)) problems.push(`${op}: ${toolName} requires \`${key}\``)
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('schema and operation_status use the top-level CLI commands', {
  skip: schema === null ? 'no nokv binary' : false,
}, () => {
  assert.deepEqual(buildArgv('schema', {}), ['schema'])
  assert.deepEqual(buildArgv('operation_status', { operation_id: 'd'.repeat(32) }),
    ['operation', 'status', 'd'.repeat(32)])
})
