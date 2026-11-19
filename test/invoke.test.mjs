import { strict as assert } from 'node:assert'
import test from 'node:test'
import { buildArgv, parseJsonArg, writeBody } from '../lib/invoke.js'

const json = (argv) => JSON.parse(argv.at(-1))

test('create sends only the workbench id', () => {
  assert.deepEqual(buildArgv('create', { workbench: 'run-1' }), ['workbench', 'workbench_create', '{"id":"run-1"}'])
})

test('put_file defaults to create-only and carries the observed generation', () => {
  const argv = buildArgv('put_file', {
    workbench: 'run-1', section: 'outputs', path: 'report.md', text: 'hi',
    expected_generation: 2, operation_id: 'a'.repeat(32),
  })
  assert.deepEqual(argv.slice(0, 2), ['workbench', 'workbench_put_file'])
  assert.deepEqual(json(argv), {
    id: 'run-1', section: 'outputs', path: 'report.md', replace: false, text: 'hi',
    expected_generation: 2, operation_id: 'a'.repeat(32),
  })
})

test('put_file replace:true is replace-only', () => {
  const body = writeBody('put_file', { workbench: 'w', section: 'outputs', path: 'a.txt', text: 'x', replace: true })
  assert.equal(body.replace, true)
})

test('append and edit map their own fields', () => {
  assert.deepEqual(writeBody('append', { workbench: 'w', section: 'logs', path: 'run.log', text: 'x' }),
    { id: 'w', section: 'logs', path: 'run.log', text: 'x' })
  assert.deepEqual(writeBody('edit', {
    workbench: 'w', section: 'scripts', path: 'main.py', old_string: 'a', new_string: 'b', replace_all: true,
  }), { id: 'w', section: 'scripts', path: 'main.py', old_string: 'a', new_string: 'b', replace_all: true })
})

test('commit parses the manifest JSON text', () => {
  const body = writeBody('commit', {
    workbench: 'w',
    content_digest_uri: 'sha256:' + '0'.repeat(64),
    manifest_json: '{"task":"smoke","ok":true}',
  })
  assert.deepEqual(body.manifest, { task: 'smoke', ok: true })
})

test('fork accepts either a commit or a snapshot selector', () => {
  assert.deepEqual(writeBody('fork', { workbench: 'w', destination: 'w-b', at_snapshot_name: 'pre' }),
    { id: 'w', destination_id: 'w-b', at_snapshot: 'pre' })
  assert.deepEqual(writeBody('fork', { workbench: 'w', destination: 'w-b', at_commit: 'f'.repeat(64) }),
    { id: 'w', destination_id: 'w-b', at_commit: 'f'.repeat(64) })
})

test('read maps paging and snapshot reads', () => {
  const body = JSON.parse(buildArgv('read', {
    workbench: 'w', section: 'outputs', path: 'a.json', format: 'structured',
    limit: 100, cursor: 'abc', at_snapshot_id: 7,
  }).at(-1))
  assert.deepEqual(body, {
    id: 'w', section: 'outputs', path: 'a.json', format: 'structured', limit: 100, cursor: 'abc', at_snapshot: 7,
  })
})

test('grep is literal, recursive by default, and carries extra patterns', () => {
  const body = JSON.parse(buildArgv('grep', {
    workbench: 'w', pattern: 'hello', patterns: ['world'], glob: '*.md',
  }).at(-1))
  assert.equal(body.recursive, true)
  assert.deepEqual(body.patterns, ['world'])
  assert.equal(body.glob, '*.md')
})

test('search parses predicates and sort JSON text', () => {
  const body = JSON.parse(buildArgv('search', {
    workbench: 'w',
    predicates_json: '[{"field":"kind","op":"eq","value":"file"}]',
    sort_json: '[{"field":"size_bytes","direction":"desc"}]',
    fields: ['path'],
  }).at(-1))
  assert.deepEqual(body.predicates, [{ field: 'kind', op: 'eq', value: 'file' }])
  assert.deepEqual(body.sort, [{ field: 'size_bytes', direction: 'desc' }])
  assert.deepEqual(body.fields, ['path'])
})

test('schema and operation_status are top-level CLI commands', () => {
  assert.deepEqual(buildArgv('schema', {}), ['schema'])
  assert.deepEqual(buildArgv('operation_status', { operation_id: 'b'.repeat(32) }),
    ['operation', 'status', 'b'.repeat(32)])
  assert.deepEqual(buildArgv('snapshot_list', { workbench: 'w' }).slice(0, 2), ['workbench', 'workbench_snapshot_list'])
})

test('invalid input fails before any process starts', () => {
  assert.throws(() => buildArgv('put_file', { workbench: 'w', section: 'outputs', path: 'a' }), /requires `text` or `base64`/)
  assert.throws(() => buildArgv('put_file', { workbench: 'w', section: 'nope', path: 'a', text: 'x' }), /section must be one of/)
  assert.throws(() => buildArgv('create', {}), /requires `workbench`/)
  assert.throws(() => buildArgv('read', { workbench: 'w', section: 'outputs', path: 'a', limit: 301 }), /at most 300/)
  assert.throws(() => buildArgv('teleport', {}), /unknown nokv op/)
  assert.throws(() => parseJsonArg('{bad', 'manifest_json'), /must be valid JSON text/)
})
