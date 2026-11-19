/**
 * Pure mapping from a model-facing tool call to one `nokv` argv.
 *
 * This module is deliberately free of Cordis and of child processes: it turns
 * the flattened tool parameters (`op`, `workbench`, `path`, ...) into the JSON
 * body each NoKV workbench tool expects, so the mapping can be unit-tested
 * against the CLI contract without a deployment.
 */

/** The five sections every workbench exposes; tool paths are relative to one. */
export const SECTIONS = ['input', 'scripts', 'outputs', 'logs', 'metadata']

/** Tools that publish state; they are refused when writes are disabled. */
export const WRITE_OPS = [
  'create',
  'put_file',
  'append',
  'edit',
  'commit',
  'snapshot',
  'snapshot_retire',
  'fork',
]

/** Tools that only read; they are always allowed when the CLI is reachable. */
export const QUERY_OPS = [
  'read',
  'list',
  'stat',
  'grep',
  'search',
  'catalog',
  'find',
  'snapshot_list',
  'operation_status',
  'schema',
]

/** Options that name a byte range rather than a whole artifact. */
const MAX_READ_ITEMS = 300

/**
 * Parse one JSON-string argument (the model sends JSON as text for free-form
 * bodies such as `manifest_json` or `predicates_json`).
 * @param {string | undefined} value
 * @param {string} label
 */
export function parseJsonArg(value, label) {
  if (value === undefined || value === null || value === '') return undefined
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} must be valid JSON text: ${error.message}`)
  }
}

function requireOne(args, keys, tool) {
  const present = keys.filter((key) => args[key] !== undefined && args[key] !== null && args[key] !== '')
  if (present.length === 0) throw new Error(`${tool} requires one of: ${keys.join(', ')}`)
  return present[0]
}

function requireArg(args, key, tool) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`${tool} requires \`${key}\``)
  }
  return args[key]
}

function workbenchId(args, tool) {
  return requireArg(args, 'workbench', tool)
}

function fileTarget(args, tool) {
  const section = requireArg(args, 'section', tool)
  if (!SECTIONS.includes(section)) {
    throw new Error(`${tool} section must be one of: ${SECTIONS.join(', ')}`)
  }
  return { section, path: requireArg(args, 'path', tool) }
}

/**
 * Build the JSON body of one write call.
 * @param {string} tool one of {@link WRITE_OPS}
 * @param {Record<string, any>} args flattened tool parameters
 */
export function writeBody(tool, rawArgs) {
  const args = normalizeArgs(rawArgs)
  const id = workbenchId(args, tool)
  const withOptional = (body) => {
    if (args.operation_id) body.operation_id = args.operation_id
    if (args.expected_generation !== undefined) body.expected_generation = args.expected_generation
    return body
  }
  switch (tool) {
    case 'create':
      return { id }
    case 'put_file': {
      const target = fileTarget(args, tool)
      if (args.text === undefined && args.base64 === undefined) {
        throw new Error('put_file requires `text` or `base64`')
      }
      const body = { id, ...target, replace: args.replace === true, ...withOptional({}) }
      if (args.text !== undefined) body.text = args.text
      else body.base64 = args.base64
      if (args.content_type) body.content_type = args.content_type
      return body
    }
    case 'append': {
      const target = fileTarget(args, tool)
      if (args.text === undefined && args.base64 === undefined) {
        throw new Error('append requires `text` or `base64`')
      }
      const body = { id, ...target, ...withOptional({}) }
      if (args.text !== undefined) body.text = args.text
      else body.base64 = args.base64
      if (args.content_type) body.content_type = args.content_type
      return body
    }
    case 'edit': {
      const target = fileTarget(args, tool)
      const body = {
        id,
        ...target,
        old_string: requireArg(args, 'old_string', tool),
        new_string: requireArg(args, 'new_string', tool),
        ...withOptional({}),
      }
      if (args.replace_all !== undefined) body.replace_all = args.replace_all
      return body
    }
    case 'commit': {
      const body = {
        id,
        content_digest_uri: requireArg(args, 'content_digest_uri', tool),
        manifest: parseJsonArg(args.manifest_json, 'manifest_json') ?? {},
      }
      if (args.replace !== undefined) body.replace = args.replace
      return body
    }
    case 'snapshot': {
      const body = { id }
      if (args.name) body.name = args.name
      if (args.ttl_days !== undefined) body.ttl_days = args.ttl_days
      if (args.reason) body.reason = args.reason
      if (args.metadata_json) body.metadata = parseJsonArg(args.metadata_json, 'metadata_json')
      return body
    }
    case 'snapshot_retire': {
      const body = { id }
      const by = requireOne(args, ['name', 'snapshot_id'], tool)
      body[by] = args[by]
      if (args.reason) body.reason = args.reason
      return body
    }
    case 'fork': {
      const body = {
        id,
        destination_id: requireArg(args, 'destination', tool),
      }
      const at = requireOne(args, ['at_snapshot', 'at_commit'], tool)
      body[at] = args[at]
      return body
    }
    default:
      throw new Error(`unknown write op: ${tool}`)
  }
}

/**
 * Build the JSON body of one query call. `schema` and `operation_status` are
 * not workbench tools and are handled by {@link buildArgv}.
 * @param {string} tool one of {@link QUERY_OPS}
 * @param {Record<string, any>} args flattened tool parameters
 */
export function queryBody(tool, rawArgs) {
  const args = normalizeArgs(rawArgs)
  const id = workbenchId(args, tool)
  const body = { id }
  if (args.section) body.section = args.section
  if (args.path) body.path = args.path
  if (args.at_snapshot !== undefined) body.at_snapshot = args.at_snapshot
  if (args.limit !== undefined) body.limit = args.limit
  if (args.cursor) body.cursor = args.cursor

  switch (tool) {
    case 'read': {
      if (args.format) body.format = args.format
      if (args.offset !== undefined) body.offset = args.offset
      if (args.if_none_match !== undefined) body.if_none_match = args.if_none_match
      return body
    }
    case 'list':
    case 'stat':
      return body
    case 'grep': {
      body.pattern = requireArg(args, 'pattern', tool)
      body.recursive = args.recursive !== false
      if (args.patterns) body.patterns = args.patterns
      if (args.glob) body.glob = args.glob
      return body
    }
    case 'search': {
      if (args.predicates_json) body.predicates = parseJsonArg(args.predicates_json, 'predicates_json')
      if (args.fields) body.fields = args.fields
      if (args.sort_json) body.sort = parseJsonArg(args.sort_json, 'sort_json')
      if (args.facets) body.facets = args.facets
      return body
    }
    case 'catalog': {
      if (args.field_prefix) body.field_prefix = args.field_prefix
      if (args.include_facets !== undefined) body.include_facets = args.include_facets
      return body
    }
    case 'find': {
      if (args.committed !== undefined) body.committed = args.committed
      if (args.manifest_pattern) body.manifest_pattern = args.manifest_pattern
      if (args.include_manifest !== undefined) body.include_manifest = args.include_manifest
      return body
    }
    case 'snapshot_list':
      return { id }
    default:
      throw new Error(`unknown query op: ${tool}`)
  }
}

/**
 * Normalize the two model-facing snapshot selectors into the one CLI field.
 * `at_snapshot` accepts a snapshot id or an alive snapshot name.
 * @param {Record<string, any>} args
 * @returns {Record<string, any>}
 */
export function normalizeArgs(args) {
  if (args.at_snapshot !== undefined) return args
  if (args.at_snapshot_name !== undefined) return { ...args, at_snapshot: args.at_snapshot_name }
  if (args.at_snapshot_id !== undefined) return { ...args, at_snapshot: args.at_snapshot_id }
  return args
}

/**
 * Turn a flattened tool call into the argv one `nokv` invocation takes (after
 * the global route options).
 * @param {string} tool one of {@link WRITE_OPS} or {@link QUERY_OPS}
 * @param {Record<string, any>} args
 * @returns {string[]}
 */
export function buildArgv(tool, rawArgs) {
  const args = normalizeArgs(rawArgs)
  if (tool === 'schema') return ['schema']
  if (tool === 'operation_status') {
    const id = requireArg(args, 'operation_id', tool)
    return ['operation', 'status', id]
  }
  if (WRITE_OPS.includes(tool)) {
    return ['workbench', `workbench_${tool}`, JSON.stringify(writeBody(tool, args))]
  }
  if (QUERY_OPS.includes(tool)) {
    const body = queryBody(tool, args)
    if (tool === 'read' && body.limit !== undefined && body.limit > MAX_READ_ITEMS) {
      throw new Error(`read limit is at most ${MAX_READ_ITEMS} items per call; use cursor to page`)
    }
    return ['workbench', `workbench_${tool}`, JSON.stringify(body)]
  }
  throw new Error(`unknown nokv op: ${tool}`)
}
