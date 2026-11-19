/**
 * dsh-nokv: NoKV workspace state as model tools.
 *
 * Two tools, not eighteen. `nokv_workspace` covers the publishing side
 * (create, writes, commit, snapshot, fork); `nokv_query` covers the read side
 * and the escape hatches (`schema`, `operation_status`). Both delegate to the
 * native `nokv` CLI — the CLI contract is the integration surface — so this
 * plugin adds deployment plumbing, typed inputs, and a stable failure
 * vocabulary rather than a second client implementation.
 *
 * Docs: ../README.md for use, ../docs/DETAIL.md for the layer below.
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runNokv } from './nokv.js'
import { QUERY_OPS, SECTIONS, WRITE_OPS, buildArgv } from './invoke.js'

/** Cordis plugin name, addressed by the bundle patch row id rather than this. */
export const name = 'tool-nokv'

/** The registries this plugin consumes. */
export const inject = ['tools']

const HEX32 = '32 lowercase hex characters; the same id replays the original receipt'

/** Deployment facts plus the few knobs a user adjusts. */
export const Config = z.object({
  nokvPath: z.string().default('nokv').description('`nokv` executable name or absolute path. Empty means `nokv` from PATH.'),
  rootId: z.string().default('').description('`--root-id`, a 32-hex root identity. Required by every agent command.'),
  agentId: z.string().default('').description('`--agent-id`, a 32-hex Agent identity. Required unless the deployment uses RPC TLS.'),
  controlDir: z.string().default('').description('`--control-dir` for a single-host control plane. Empty leaves it unset; set it or `etcdEndpoint`.'),
  etcdEndpoint: z.string().default('').description('`--etcd-endpoint` for a multi-host control plane. Empty leaves it unset.'),
  objectBucket: z.string().default('').description('`--object-bucket` holding artifact bytes. Required by artifact operations.'),
  objectEndpoint: z.string().default('').description('`--object-endpoint`, e.g. `http://127.0.0.1:9000` for MinIO, RustFS, or Ceph. Empty means AWS S3.'),
  objectRoot: z.string().default('').description('`--object-root` prefix inside the bucket. Empty leaves the CLI default.'),
  objectRegion: z.string().default('').description('`--object-region`. Empty leaves the CLI default (`us-east-1`).'),
  objectNamespaceId: z.string().default('').description('`--object-namespace-id` when the deployment pins one. Empty leaves it unset.'),
  timeoutMs: z.number().default(30000).description('Deadline for one call, in milliseconds.'),
  maxOutputBytes: z.number().default(200000).description('Largest accepted CLI answer, in bytes; larger answers are refused rather than truncated.'),
  allowWrites: z.boolean().default(true).description('Register and allow the publishing tool. Turn off for a read-only agent.'),
})

/** Options shared by both tools; kept short because parameter text is per-request context. */
const COMMON = {
  workbench: { type: 'string', description: 'Workbench id (letters, digits, `_`, `-`; at most 128 bytes).' },
  section: { type: 'string', enum: [...SECTIONS], description: 'One of the five standard sections; paths are relative to it.' },
  path: { type: 'string', description: 'Path relative to the section; no leading slash, `.`, `..`, backslash, or repeated section prefix.' },
  operation_id: { type: 'string', description: `Exact retry identity: ${HEX32}.` },
  expected_generation: { type: 'integer', description: 'Fail with a conflict instead of overwriting a newer generation.' },
  at_snapshot_name: { type: 'string', description: 'Read at a named snapshot instead of live state.' },
  at_snapshot_id: { type: 'integer', description: 'Read at a snapshot id instead of live state.' },
}

/**
 * One CLI call with the same deadline and cancellation the Harness hands us.
 * @param {Record<string, any>} config
 * @param {string} tool
 * @param {Record<string, any>} args
 * @param {{ signal?: AbortSignal }} exec
 */
async function call(config, tool, args, exec) {
  const argv = buildArgv(tool, args)
  const answer = await runNokv(config, argv, { signal: exec?.signal })
  return JSON.stringify(answer)
}

const READ_RENDER = (_args, value) => [{ type: 'text', text: value }]

/**
 * Register both tools on the profile's tool registry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export async function apply(ctx, config) {
  const settings = { ...config }

  if (settings.allowWrites !== false) {
    ctx.tools.register(defineTool({
      name: 'nokv_workspace',
      description:
        'Change durable NoKV workspace state. A workbench is a versioned workspace with five sections (input, scripts, outputs, logs, metadata); tool paths are relative to a section. '
        + 'Call `create` once per workbench id, then `put_file` (`replace:false` is create-only, `replace:true` is replace-only — never upsert), `append`, or `edit` (exact UTF-8 string replacement). '
        + '`commit` seals one run manifest with the `content_digest_uri` and `manifest_json` you supply. `snapshot` leases a point-in-time view; `fork` restores a commit or snapshot into a new destination workbench and leaves the source untouched; `snapshot_retire` releases a lease. '
        + 'Writes are generation-fenced: pass `expected_generation` from the previous answer to get a conflict instead of overwriting newer state, and pass `operation_id` so a retry returns the original receipt rather than applying twice. '
        + 'A successful call answers with the CLI JSON envelope (workbench_id, generation, digest_uri, size_bytes, commit_identity, ...).',
      parameters: {
        op: { type: 'string', required: true, enum: [...WRITE_OPS], description: 'Which publishing operation to run.' },
        workbench: { ...COMMON.workbench, required: true },
        section: COMMON.section,
        path: COMMON.path,
        text: { type: 'string', description: 'UTF-8 body for put_file/append.' },
        base64: { type: 'string', description: 'Base64 body for put_file/append; mutually exclusive with `text`.' },
        content_type: { type: 'string', description: 'Optional media type recorded beside the artifact.' },
        replace: { type: 'boolean', description: 'put_file: false (default) creates only, true replaces only. commit: replace an existing manifest.' },
        old_string: { type: 'string', description: 'edit: the exact text to find.' },
        new_string: { type: 'string', description: 'edit: the replacement text.' },
        replace_all: { type: 'boolean', description: 'edit: replace every match instead of requiring exactly one.' },
        expected_generation: COMMON.expected_generation,
        operation_id: COMMON.operation_id,
        content_digest_uri: { type: 'string', description: 'commit: `sha256:` followed by 64 hex characters.' },
        manifest_json: { type: 'string', description: 'commit: the run manifest as a JSON object string.' },
        name: { type: 'string', description: 'snapshot: lease name; snapshot_retire: retire by name.' },
        snapshot_id: { type: 'integer', description: 'snapshot_retire: retire by snapshot id instead of name.' },
        ttl_days: { type: 'integer', description: 'snapshot: lease length in days, 1–90 (default 7).' },
        reason: { type: 'string', description: 'Why this commit/snapshot is taken, recorded in audit material.' },
        metadata_json: { type: 'string', description: 'snapshot: annotation object as JSON text.' },
        destination: { type: 'string', description: 'fork: the new workbench id to create from the source.' },
        at_commit: { type: 'string', description: 'fork: the 64-hex commit identity to branch from.' },
        at_snapshot_name: { type: 'string', description: 'fork: an alive snapshot name to branch from.' },
        at_snapshot_id: { type: 'integer', description: 'fork: an alive snapshot id to branch from.' },
      },
      output: { schema: { type: 'string' }, render: READ_RENDER },
      async execute(args, exec) {
        return call(settings, args.op, args, exec)
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'nokv_query',
    description:
      'Read durable NoKV workspace state without changing it. '
      + '`read` returns one artifact in pages of at most 300 items/bytes (`format:structured` parses JSON/YAML, `format:bytes` returns base64 ranges) and needs `section` and `path`; '
      + '`list` and `stat` inspect one section/path; `grep` is case-insensitive literal matching (not regex, up to 16 `patterns`); '
      + '`search` queries indexed metadata with `predicates_json`/`sort_json`; `catalog` lists queryable fields and operators; `find` locates workbenches by committed manifest; '
      + '`snapshot_list` reports lease state; `operation_status` polls one write by `operation_id`; `schema` returns the full CLI contract for every NoKV tool. '
      + 'Pass `at_snapshot_name`/`at_snapshot_id` to read frozen history.',
    parameters: {
      op: { type: 'string', required: true, enum: [...QUERY_OPS], description: 'Which read operation to run.' },
      workbench: COMMON.workbench,
      section: COMMON.section,
      path: COMMON.path,
      at_snapshot_name: COMMON.at_snapshot_name,
      at_snapshot_id: COMMON.at_snapshot_id,
      format: { type: 'string', enum: ['structured', 'bytes'], description: 'read: parse structured records, or return base64 byte ranges.' },
      offset: { type: 'integer', description: 'read: byte offset for `format:bytes` or item index for structured reads.' },
      limit: { type: 'integer', description: 'read: items per page (at most 300).' },
      cursor: { type: 'string', description: 'Opaque continuation token from the previous page.' },
      if_none_match: { type: 'integer', description: 'read: answer nothing changed when the generation matches.' },
      pattern: { type: 'string', description: 'grep: literal text to find (case-insensitive).' },
      patterns: { type: 'array', items: { type: 'string' }, description: 'grep: additional literal patterns, at most 16 in total.' },
      glob: { type: 'string', description: 'grep: basename glob filter, e.g. `*.md`.' },
      recursive: { type: 'boolean', description: 'grep: search recursively (default true).' },
      predicates_json: { type: 'string', description: 'search: predicate array as JSON text, e.g. `[{"field":"kind","op":"eq","value":"file"}]`.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'search: metadata fields to project.' },
      sort_json: { type: 'string', description: 'search: sort array as JSON text, e.g. `[{"field":"size_bytes","direction":"desc"}]`.' },
      facets: { type: 'array', items: { type: 'string' }, description: 'search: fields to facet on.' },
      field_prefix: { type: 'string', description: 'catalog: only list fields whose id starts with this prefix.' },
      include_facets: { type: 'boolean', description: 'catalog: include facetable fields.' },
      committed: { type: 'boolean', description: 'find: only committed workbenches (false: uncommitted).' },
      manifest_pattern: { type: 'string', description: 'find: literal text that must match the run manifest.' },
      include_manifest: { type: 'boolean', description: 'find: include the full manifest in each match.' },
      operation_id: { type: 'string', description: `operation_status: ${HEX32}.` },
    },
    output: { schema: { type: 'string' }, render: READ_RENDER },
    async execute(args, exec) {
      return call(settings, args.op, args, exec)
    },
  }))
}
