#!/usr/bin/env bash
# Bring up a single-host NoKV deployment for local dsh-nokv use.
#
# What it does, in order:
#   1. starts a local S3-compatible endpoint (moto server) on 127.0.0.1:9000;
#   2. creates the `nokv` bucket;
#   3. provisions a root with fixed identities (once);
#   4. runs the owner in the foreground, so Ctrl-C stops it.
#
# Requirements: `nokv` on PATH (or NOKv_BIN), python3 with `moto[server]`
# (python3 -m venv .venv && .venv/bin/pip install "moto[server]"). Any
# S3-compatible store works instead of moto; see the README.
#
# Usage:
#   scripts/local-dev.sh            # moto + provision + owner
#   NOKv_ROOT_ID=... scripts/local-dev.sh
#   scripts/local-dev.sh --no-s3    # reuse an S3 endpoint you already run
set -euo pipefail

ROOT="${NOKv_DEV_DIR:-/tmp/nokv-local}"
NOKV="${NOKv_BIN:-nokv}"
MOTO="${MOTO_SERVER:-moto_server}"
ROOT_ID="${NOKV_ROOT_ID:-11111111111111111111111111111111}"
AGENT_ID="${NOKV_AGENT_ID:-44444444444444444444444444444444}"
SHARD_ID="${NOKV_SHARD_ID:-22222222222222222222222222222222}"
BUCKET="${NOKV_BUCKET:-nokv}"
ENDPOINT="${NOKV_S3_ENDPOINT:-http://127.0.0.1:9000}"
START_S3=1
[ "${1:-}" = "--no-s3" ] && START_S3=0

# moto accepts any credentials; a real store needs its own.
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-testkey}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-testsecret}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_EC2_METADATA_DISABLED=true

mkdir -p "$ROOT/control" "$ROOT/metadata"
COMMON=(--root-id "$ROOT_ID" --control-dir "$ROOT/control" --object-bucket "$BUCKET" --object-endpoint "$ENDPOINT")
CLIENT=("$NOKV" "${COMMON[@]}" --agent-id "$AGENT_ID")

if [ "$START_S3" = 1 ]; then
  if curl -sf -o /dev/null --max-time 2 "$ENDPOINT" 2>/dev/null || \
     [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$ENDPOINT" 2>/dev/null)" != "000" ]; then
    echo "S3 endpoint already answers on $ENDPOINT"
  else
    echo "starting moto S3 on $ENDPOINT"
    "$MOTO" -H 127.0.0.1 -p 9000 >"$ROOT/moto.log" 2>&1 &
    MOTO_PID=$!
    trap 'kill "$MOTO_PID" 2>/dev/null || true' EXIT
    for _ in $(seq 1 40); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$ENDPOINT" 2>/dev/null)" != "000" ] && break
      sleep 0.25
    done
  fi
fi

if command -v aws >/dev/null 2>&1; then
  aws --endpoint-url "$ENDPOINT" s3 mb "s3://$BUCKET" >/dev/null 2>&1 || true
  echo "bucket $BUCKET ready"
else
  echo "warning: aws CLI not found; create bucket '$BUCKET' yourself" >&2
fi

if [ ! -f "$ROOT/control/.nokv-provisioned" ]; then
  echo "provisioning root $ROOT_ID"
  "$NOKV" "${COMMON[@]}" --agent-id "$AGENT_ID" provision "$SHARD_ID" --workbench-root /agents/local/wb >/dev/null
  : > "$ROOT/control/.nokv-provisioned"
fi

echo
echo "plugin configuration (Plugins -> NoKV 工作区):"
echo "  nokvPath:        $(command -v "$NOKV" || echo "$NOKV")"
echo "  rootId:          $ROOT_ID"
echo "  agentId:         $AGENT_ID"
echo "  controlDir:      $ROOT/control"
echo "  objectBucket:    $BUCKET"
echo "  objectEndpoint:  $ENDPOINT"
echo
echo "starting the owner on 127.0.0.1:7750 (Ctrl-C stops it)"
exec "$NOKV" "${COMMON[@]}" --node-id owner-1 --bind 127.0.0.1:7750 \
  --advertise-endpoint 127.0.0.1:7750 --metadata-create "$ROOT/metadata" serve
