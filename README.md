# dsh-nokv

NoKV workspace state as [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) model tools.

A [NoKV](https://github.com/NoKV-Lab/NoKV) workbench is a durable, versioned workspace with five sections — `input`, `scripts`, `outputs`, `logs`, `metadata` — plus generation-fenced writes, exact-retry operation receipts, commits, leased snapshots, and forks that never copy payload bytes. This bundle gives the model two tools over those guarantees, so an agent's work survives its sandbox and can be re-opened, branched, or audited instead of silently overwritten.

## Requirements

- DeepSeek Harness `0.2.x` (the bundle declares `>=0.2.1-rc.2 <0.3.0-0`).
- A `nokv` executable on `PATH`, or an absolute path in the configuration. NoKV 0.20 is the tested CLI contract: `brew install NoKV-Lab/tap/nokv`, the container image `ghcr.io/nokv-lab/nokv`, or `cargo build --release -p nokv --bin nokv`.
- A NoKV deployment: an S3-compatible bucket, a control directory or etcd, and a running owner process. `nokv --help` and the [NoKV docs](https://github.com/NoKV-Lab/NoKV/tree/main/docs) cover provisioning.

## Install

From the Plugins page: **Add plugin** → paste this directory (or the npm spec) → **Install** → **Enable now**. From an agent or the CLI:

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-nokv
```

Installing writes the profile's dependency and inserts the `nokv` row. Uninstalling removes both; configuration written through the row is kept in the profile patch.

## Configure

The row's configuration holds deployment facts. Set them in **Plugins → NoKV 工作区** or in the profile patch:

```yaml
- id: nokv
  config:
    nokvPath: /opt/homebrew/bin/nokv
    rootId: '11111111111111111111111111111111'   # 32 hex
    agentId: '44444444444444444444444444444444'  # 32 hex
    controlDir: /var/lib/nokv/control            # or etcdEndpoint
    objectBucket: nokv
    objectEndpoint: http://127.0.0.1:9000        # omit for AWS S3
    timeoutMs: 30000
    maxOutputBytes: 200000
    allowWrites: true
```

S3 credentials are **not** plugin configuration: NoKV reads them from the AWS standard chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`). For the Desktop app, put them in `$DSH_HOME/.env`, which the Harness loads into the process environment.

Set `allowWrites: false` for a read-only agent: the publishing tool is then not registered at all.

## Local development

A single-host deployment needs an S3-compatible bucket, a control directory, and an owner process. NoKV has no macOS binary release, so build the CLI from the `v0.20.0` source (`cargo build --release -p nokv --bin nokv`, ~2 minutes on Apple Silicon) or use the container image.

For a throwaway local stack:

```bash
# one-time: python3 -m venv .venv && .venv/bin/pip install "moto[server]"
scripts/local-dev.sh
```

It starts a moto S3 endpoint, creates the bucket, provisions the root, prints the matching plugin configuration, and runs the owner in the foreground. With that running, set the row's configuration to those values (or copy them into `cordis.patch.yml`), and a plain `nokv` on `PATH` is enough — moto accepts unauthenticated requests, so no AWS credentials are needed for this local case. A real S3 store needs the standard AWS environment instead.

## Tools

| Tool | What it covers |
| --- | --- |
| `nokv_workspace` | `create`, `put_file` (create-only or replace-only, never upsert), `append`, `edit`, `commit`, `snapshot`, `snapshot_retire`, `fork` |
| `nokv_query` | `read` (paged, structured or byte ranges), `list`, `stat`, `grep` (literal, not regex), `search`, `catalog`, `find`, `snapshot_list`, `operation_status`, `schema` |

Practical rules the tools are shaped around:

- **Pass `operation_id`** (32 lowercase hex) on writes so a retried call returns the original receipt instead of applying twice; the same id with different input is an `identity_conflict`.
- **Pass `expected_generation`** to turn a stale write into a conflict instead of an overwrite.
- **Read the digest before committing**: `put_file` answers `digest_uri`; `commit` takes `content_digest_uri` (`sha256:` + 64 hex) and `manifest_json`.
- **Fork, don't mutate history**: `fork` restores a commit or an alive snapshot into a new destination workbench; the source is untouched.
- **`schema` is the escape hatch**: it returns the CLI's own input schemas for every workbench tool, so the model can recover exact fields without another documentation hop.

## Layout

```
lib/index.js     the Cordis plugin: Config, two defineTool registrations
lib/invoke.js    pure tool-call → nokv argv mapping (unit-tested)
lib/nokv.js      route flags, spawn, JSON/exit-code failure taxonomy
docs/DETAIL.md   implementation notes (and their limits)
locale/          display metadata for the Plugins page
```

## Limitations

- One process per call; the persistent `nokv workbench-session` transport is not used yet, so each call pays CLI startup.
- `materialize` and `collect` (host-filesystem adapters) are not exposed: they trade in local paths, and a sandboxed agent should not silently pull bytes out of NoKV.
- No `workbench_aggregate` typing yet; it is reachable through `schema` only. Contributions welcome.

## License

Apache-2.0, matching NoKV.
