#!/usr/bin/env bash
# End-to-end verification of the Nova docker sandbox backend.
# Run once Docker Desktop (or another daemon) is up:  bash deploy/sandbox/verify-docker.sh
set -euo pipefail

IMAGE="${NOVA_SANDBOX_IMAGE:-nova-sandbox:latest}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> 1/4 Checking Docker daemon"
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable. Start Docker Desktop and retry." >&2
  exit 1
fi
docker version --format '    server {{.Server.Version}}'

echo "==> 2/4 Building $IMAGE from deploy/sandbox/Dockerfile"
docker build -t "$IMAGE" "$HERE"

echo "==> 3/4 Running a hardened container (read-only root, no caps, no net) against a scratch workspace"
WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT
docker run --rm \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 512 --memory 2g --cpus 2 --tmpfs /tmp:size=512m \
  -v "$WS:/workspace:rw" -w /workspace -e HOME=/workspace \
  "$IMAGE" \
  bash -c 'set -e; echo "bun: $(bun --version)"; echo "claude: $(claude --version 2>/dev/null || echo missing)"; echo hello > /workspace/probe.txt; cat /workspace/probe.txt'
test -f "$WS/probe.txt" && echo "    workspace write persisted to host: OK"

echo "==> 4/4 Confirming the hardening actually bites (write outside workspace must fail)"
if docker run --rm --read-only --tmpfs /tmp:size=512m "$IMAGE" bash -c 'echo x > /etc/should-fail' 2>/dev/null; then
  echo "    UNEXPECTED: wrote to read-only root" >&2; exit 1
else
  echo "    read-only root blocks writes outside /workspace and /tmp: OK"
fi

echo
echo "docker sandbox E2E PASSED"
