#!/bin/sh
set -eu

. /app/docker/container-bootstrap.sh

cmd="${1:-web}"

if [ "$#" -gt 0 ]; then
  shift
fi

case "$cmd" in
  web)
    cd /app/packages/web
    exec node ../../node_modules/next/dist/bin/next start -H 0.0.0.0 -p "${WEB_PORT:-3000}" "$@"
    ;;
  api)
    if [ "${PROMPT_RUNNER_ENABLED:-true}" != "false" ] && [ "${PROMPT_RUNNER_EXECUTION_MODE:-worktree}" != "kube-worker" ]; then
      echo "The api entrypoint is dispatch-only. Use PROMPT_RUNNER_EXECUTION_MODE=kube-worker, disable the runner, or launch 'api-inprocess' explicitly for legacy local execution." >&2
      exit 1
    fi

    cd /app
    exec node packages/server/dist/index.js "$@"
    ;;
  api-inprocess)
    configure_ssh
    configure_codex_auth
    sync_document_store_repo
    cd /app
    exec node packages/server/dist/index.js "$@"
    ;;
  worker)
    cd /app
    exec node packages/server/dist/worker/index.js "$@"
    ;;
  *)
    exec "$cmd" "$@"
    ;;
esac
