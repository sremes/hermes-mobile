#!/bin/bash
# Minimal smoke test for the hermes-mobile container candidate.
# Usage: smoke.sh <image-ref>
set -euo pipefail

ref="${1:?usage: smoke.sh <image-ref>}"
port=8080

echo "== rejects missing HERMES_GATEWAY_URL =="
if docker run --rm "$ref" true; then
  echo "expected failure without HERMES_GATEWAY_URL" >&2
  exit 1
fi

echo "== boots and serves the PWA, proxies /api =="
name="hermes-mobile-smoke-$$"
docker run -d --rm --name "$name" -p "127.0.0.1:${port}:80" \
  -e HERMES_GATEWAY_URL=http://127.0.0.1:9119 "$ref" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1' EXIT

ready=0
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:${port}/"; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "container never served /" >&2; exit 1; }

# No gateway listens, so the proxy must answer 502 (route alive).
# A 404 here would mean the request fell through to static files = misconfigured proxy.
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/fs/list")"
[ "$code" = 502 ] || { echo "expected 502 from /api proxy, got $code" >&2; exit 1; }

echo "smoke OK: $ref"
