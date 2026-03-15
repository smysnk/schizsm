#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/fleet-defaults.sh
source "${script_dir}/lib/fleet-defaults.sh"

usage() {
  cat <<USAGE
Usage:
  deploy-fleet.sh [options]

Options:
  --gitrepo-file <path>      Fleet GitRepo manifest (default: fleet/gitrepo.yml)
  --fleet-namespace <name>   Fleet namespace for GitRepo (default: GitRepo metadata namespace)
  --name <name>              GitRepo resource name to watch (default: GitRepo metadata name)
  --app-namespace <name>     Application namespace to check (default: fleet.yaml defaultNamespace)
  --web <deployment>         Web deployment to check (default: <releaseName>-web)
  --api <deployment>         API deployment to check (default: <releaseName>-api)
  --kubeconfig <path>        Optional KUBECONFIG path
  --restart                  Restart workloads after syncing Fleet so mutable tags repull
  --wait-seconds <seconds>   Wait timeout for rollout status (default: 600)
  --help                     Show this help
USAGE
}

current_cluster_server() {
  kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}'
}

server_host() {
  local server="${1:-}"
  server="${server#http://}"
  server="${server#https://}"
  server="${server%%/*}"
  server="${server%%:*}"
  printf '%s\n' "$server"
}

is_private_ipv4() {
  local host="${1:-}"
  local a b c d

  if [[ ! "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    return 1
  fi

  IFS='.' read -r a b c d <<< "$host"

  if [[ "$a" -eq 10 ]]; then
    return 0
  fi

  if [[ "$a" -eq 192 && "$b" -eq 168 ]]; then
    return 0
  fi

  if [[ "$a" -eq 172 && "$b" -ge 16 && "$b" -le 31 ]]; then
    return 0
  fi

  return 1
}

assert_cluster_reachable() {
  local server host version_output status

  server="$(current_cluster_server)"
  host="$(server_host "$server")"

  set +e
  version_output="$(kubectl version --request-timeout=10s 2>&1)"
  status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    return 0
  fi

  echo "Error: unable to reach the Kubernetes API at ${server}" >&2

  if is_private_ipv4 "$host"; then
    echo "The kubeconfig points at private cluster address ${host}, which GitHub-hosted runners cannot reach." >&2
    echo "Use a self-hosted runner on the cluster network, or regenerate/override the kubeconfig with a public API server URL." >&2
  else
    echo "Check that the API endpoint is reachable from the runner and that the kubeconfig credentials are still valid." >&2
  fi

  if [[ -n "$version_output" ]]; then
    echo "$version_output" >&2
  fi

  exit 1
}

wait_for_deployment() {
  local namespace="${1:?namespace required}"
  local deployment="${2:?deployment required}"
  local wait_seconds="${3:?wait seconds required}"
  local start_time elapsed

  start_time="$(date +%s)"

  while true; do
    if kubectl -n "$namespace" get deployment "$deployment" >/dev/null 2>&1; then
      return 0
    fi

    elapsed="$(( $(date +%s) - start_time ))"
    if [[ "$elapsed" -ge "$wait_seconds" ]]; then
      echo "Timed out waiting for deployment/${deployment} to appear in namespace/${namespace}" >&2
      return 1
    fi

    sleep 5
  done
}

GITREPO_FILE="${GITREPO_FILE}"
FLEET_NAMESPACE="$(gitrepo_namespace)"
NAME="$(gitrepo_name)"
APP_NAMESPACE="$(fleet_default_namespace)"
WEB_DEPLOYMENT="$(deployment_name web)"
API_DEPLOYMENT="$(deployment_name api)"
KUBECONFIG_PATH=""
RESTART_AFTER_SYNC="0"
WAIT_SECONDS="600"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gitrepo-file)
      GITREPO_FILE="${2:-}"
      shift 2
      ;;
    --fleet-namespace)
      FLEET_NAMESPACE="${2:-}"
      shift 2
      ;;
    --name)
      NAME="${2:-}"
      shift 2
      ;;
    --app-namespace)
      APP_NAMESPACE="${2:-}"
      shift 2
      ;;
    --web)
      WEB_DEPLOYMENT="${2:-}"
      shift 2
      ;;
    --api)
      API_DEPLOYMENT="${2:-}"
      shift 2
      ;;
    --kubeconfig)
      KUBECONFIG_PATH="${2:-}"
      shift 2
      ;;
    --restart)
      RESTART_AFTER_SYNC="1"
      shift
      ;;
    --wait-seconds)
      WAIT_SECONDS="${2:-600}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v kubectl >/dev/null 2>&1; then
  echo "Error: kubectl is required" >&2
  exit 1
fi

if [[ -n "$KUBECONFIG_PATH" ]]; then
  export KUBECONFIG="$KUBECONFIG_PATH"
fi

if [[ ! -f "$GITREPO_FILE" ]]; then
  echo "Error: gitrepo manifest not found: $GITREPO_FILE" >&2
  exit 1
fi

assert_cluster_reachable

echo "Applying Fleet GitRepo from: $GITREPO_FILE"
set +e
APPLY_OUTPUT="$(kubectl apply --validate=false -f "$GITREPO_FILE" 2>&1)"
APPLY_STATUS=$?
set -e

if [[ $APPLY_STATUS -ne 0 ]]; then
  echo "$APPLY_OUTPUT"
  if echo "$APPLY_OUTPUT" | grep -q 'unknown field "spec.helm"'; then
    echo "Detected legacy GitRepo schema mismatch (spec.helm). Recreating GitRepo/${NAME}."
    kubectl -n "$FLEET_NAMESPACE" delete gitrepo "$NAME" --ignore-not-found=true
    kubectl create --validate=false -f "$GITREPO_FILE"
  else
    exit $APPLY_STATUS
  fi
else
  echo "$APPLY_OUTPUT"
fi

echo "Current GitRepo status:"
kubectl -n "$FLEET_NAMESPACE" get gitrepo "$NAME" -o wide || true

echo "Current bundles in ${FLEET_NAMESPACE}:"
kubectl -n "$FLEET_NAMESPACE" get bundle || true
kubectl -n "$FLEET_NAMESPACE" get bundledeployment -o wide || true

echo "Waiting for deployment/${WEB_DEPLOYMENT} to exist in namespace/${APP_NAMESPACE}"
wait_for_deployment "$APP_NAMESPACE" "$WEB_DEPLOYMENT" "$WAIT_SECONDS"

echo "Waiting for deployment/${API_DEPLOYMENT} to exist in namespace/${APP_NAMESPACE}"
wait_for_deployment "$APP_NAMESPACE" "$API_DEPLOYMENT" "$WAIT_SECONDS"

if [[ "$RESTART_AFTER_SYNC" == "1" ]]; then
  echo "Restarting deployment/${WEB_DEPLOYMENT} in namespace/${APP_NAMESPACE}"
  kubectl -n "$APP_NAMESPACE" rollout restart deployment "$WEB_DEPLOYMENT"
  echo "Restarting deployment/${API_DEPLOYMENT} in namespace/${APP_NAMESPACE}"
  kubectl -n "$APP_NAMESPACE" rollout restart deployment "$API_DEPLOYMENT"
fi

echo "Waiting for rollout of deployment/${WEB_DEPLOYMENT} in namespace/${APP_NAMESPACE}"
kubectl -n "$APP_NAMESPACE" rollout status deployment "$WEB_DEPLOYMENT" --timeout="${WAIT_SECONDS}s"

echo "Waiting for rollout of deployment/${API_DEPLOYMENT} in namespace/${APP_NAMESPACE}"
kubectl -n "$APP_NAMESPACE" rollout status deployment "$API_DEPLOYMENT" --timeout="${WAIT_SECONDS}s"

echo "Deployment complete. Current resources:"
kubectl -n "$APP_NAMESPACE" get deploy,svc,ingress,configmap,secret
