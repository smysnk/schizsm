#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/fleet-defaults.sh
source "${script_dir}/lib/fleet-defaults.sh"

usage() {
  cat <<USAGE
Usage:
  create-fleet-kubeconfig.sh [options]

Options:
  --fleet-namespace <name>       Namespace that contains the Fleet GitRepo (default: fleet/gitrepo.yml metadata.namespace)
  --app-namespace <name>         Namespace that contains the application deployments (default: fleet.yaml defaultNamespace)
  --service-account <name>       Service account name to create (default: <releaseName>-fleet-deployer)
  --service-account-namespace <name>
                                 Namespace for the service account (default: Fleet namespace)
  --server <url>                 Override the Kubernetes API server URL embedded in the kubeconfig
  --use-system-ca               Do not embed a cluster CA in the kubeconfig; rely on system trust roots
  --output <path>                Write kubeconfig to this path (default: /tmp/<service-account>.kubeconfig)
  --github-secret                Update the repository FLEET_KUBECONFIG secret with the generated kubeconfig
  --github-secret-name <name>    GitHub secret name to update (default: FLEET_KUBECONFIG)
  --help                         Show this help
USAGE
}

require_command() {
  local command_name="${1:-}"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: required command not found: $command_name" >&2
    exit 1
  fi
}

base64_no_wrap() {
  base64 | tr -d '\n'
}

current_cluster_name() {
  kubectl config view --raw --minify -o jsonpath='{.clusters[0].name}'
}

current_cluster_server() {
  kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}'
}

current_cluster_ca_data() {
  local ca_data
  local ca_file

  ca_data="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
  if [[ -n "$ca_data" ]]; then
    printf '%s\n' "$ca_data"
    return 0
  fi

  ca_file="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority}')"
  if [[ -z "$ca_file" || ! -f "$ca_file" ]]; then
    echo "Error: unable to resolve certificate-authority-data from the current kubeconfig" >&2
    exit 1
  fi

  base64_no_wrap < "$ca_file"
}

create_service_account_token() {
  local namespace="${1:?namespace required}"
  local name="${2:?service account name required}"
  local token=""

  set +e
  token="$(kubectl -n "$namespace" create token "$name" --duration=2160h 2>/dev/null)"
  local status=$?
  set -e

  if [[ $status -eq 0 && -n "$token" ]]; then
    printf '%s\n' "$token"
    return 0
  fi

  kubectl -n "$namespace" create token "$name"
}

apply_rbac() {
  local fleet_namespace="${1:?fleet namespace required}"
  local app_namespace="${2:?app namespace required}"
  local service_account_namespace="${3:?service account namespace required}"
  local service_account_name="${4:?service account name required}"
  local fleet_role_name="${service_account_name}-fleet"
  local app_role_name="${service_account_name}-app"

  cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${service_account_name}
  namespace: ${service_account_namespace}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${fleet_role_name}
  namespace: ${fleet_namespace}
rules:
  - apiGroups: ["fleet.cattle.io"]
    resources: ["gitrepos"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["fleet.cattle.io"]
    resources: ["bundles", "bundledeployments"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${fleet_role_name}
  namespace: ${fleet_namespace}
subjects:
  - kind: ServiceAccount
    name: ${service_account_name}
    namespace: ${service_account_namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${fleet_role_name}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${app_role_name}
  namespace: ${app_namespace}
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps", "secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${app_role_name}
  namespace: ${app_namespace}
subjects:
  - kind: ServiceAccount
    name: ${service_account_name}
    namespace: ${service_account_namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${app_role_name}
EOF
}

write_kubeconfig() {
  local output_path="${1:?output path required}"
  local cluster_name="${2:?cluster name required}"
  local server="${3:?server required}"
  local ca_data="${4:-}"
  local service_account_name="${5:?service account name required}"
  local token="${6:?token required}"
  local context_name="${service_account_name}@${cluster_name}"

  mkdir -p "$(dirname "$output_path")"

  cat > "$output_path" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: ${cluster_name}
    cluster:
      server: ${server}
users:
  - name: ${service_account_name}
    user:
      token: ${token}
contexts:
  - name: ${context_name}
    context:
      cluster: ${cluster_name}
      user: ${service_account_name}
current-context: ${context_name}
EOF

  if [[ -n "$ca_data" ]]; then
    python3 -c 'import pathlib, sys; path = pathlib.Path(sys.argv[1]); ca_data = sys.argv[2]; contents = path.read_text(encoding="utf-8"); updated = contents.replace("      server: " + sys.argv[3] + "\n", "      server: " + sys.argv[3] + "\n      certificate-authority-data: " + ca_data + "\n", 1); path.write_text(updated, encoding="utf-8")' "$output_path" "$ca_data" "$server"
  fi

  chmod 600 "$output_path"
}

update_github_secret() {
  local secret_name="${1:?secret name required}"
  local output_path="${2:?output path required}"

  require_command gh
  gh secret set "$secret_name" < "$output_path"
}

verify_permissions() {
  local kubeconfig_path="${1:?kubeconfig path required}"
  local fleet_namespace="${2:?fleet namespace required}"
  local app_namespace="${3:?app namespace required}"

  local permission_check=""

  permission_check="$(kubectl --kubeconfig "$kubeconfig_path" auth can-i create gitrepos.fleet.cattle.io -n "$fleet_namespace")"
  [[ "$permission_check" == "yes" ]] || { echo "Generated kubeconfig cannot create Fleet GitRepos in ${fleet_namespace}" >&2; exit 1; }

  permission_check="$(kubectl --kubeconfig "$kubeconfig_path" auth can-i watch bundledeployments.fleet.cattle.io -n "$fleet_namespace")"
  [[ "$permission_check" == "yes" ]] || { echo "Generated kubeconfig cannot watch Fleet bundledeployments in ${fleet_namespace}" >&2; exit 1; }

  permission_check="$(kubectl --kubeconfig "$kubeconfig_path" auth can-i patch deployments.apps -n "$app_namespace")"
  [[ "$permission_check" == "yes" ]] || { echo "Generated kubeconfig cannot patch deployments in ${app_namespace}" >&2; exit 1; }

  permission_check="$(kubectl --kubeconfig "$kubeconfig_path" auth can-i create secrets -n "$app_namespace")"
  [[ "$permission_check" == "yes" ]] || { echo "Generated kubeconfig cannot create secrets in ${app_namespace}" >&2; exit 1; }
}

FLEET_NAMESPACE="$(gitrepo_namespace)"
APP_NAMESPACE="$(fleet_default_namespace)"
SERVICE_ACCOUNT_NAME="$(fleet_release_name)-fleet-deployer"
SERVICE_ACCOUNT_NAMESPACE="$FLEET_NAMESPACE"
OUTPUT_PATH=""
SERVER_OVERRIDE=""
USE_SYSTEM_CA="0"
UPDATE_SECRET="0"
GITHUB_SECRET_NAME="FLEET_KUBECONFIG"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fleet-namespace)
      FLEET_NAMESPACE="${2:-}"
      shift 2
      ;;
    --app-namespace)
      APP_NAMESPACE="${2:-}"
      shift 2
      ;;
    --service-account)
      SERVICE_ACCOUNT_NAME="${2:-}"
      shift 2
      ;;
    --service-account-namespace)
      SERVICE_ACCOUNT_NAMESPACE="${2:-}"
      shift 2
      ;;
    --server)
      SERVER_OVERRIDE="${2:-}"
      shift 2
      ;;
    --use-system-ca)
      USE_SYSTEM_CA="1"
      shift
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    --github-secret)
      UPDATE_SECRET="1"
      shift
      ;;
    --github-secret-name)
      GITHUB_SECRET_NAME="${2:-}"
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

require_command kubectl

if [[ -z "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="/tmp/${SERVICE_ACCOUNT_NAME}.kubeconfig"
fi

echo "Creating Fleet deployer service account ${SERVICE_ACCOUNT_NAMESPACE}/${SERVICE_ACCOUNT_NAME}"
apply_rbac "$FLEET_NAMESPACE" "$APP_NAMESPACE" "$SERVICE_ACCOUNT_NAMESPACE" "$SERVICE_ACCOUNT_NAME" >/dev/null

echo "Generating kubeconfig from the current cluster context"
CLUSTER_NAME="$(current_cluster_name)"
SERVER="${SERVER_OVERRIDE:-$(current_cluster_server)}"
CA_DATA=""
if [[ "$USE_SYSTEM_CA" != "1" ]]; then
  CA_DATA="$(current_cluster_ca_data)"
fi
TOKEN="$(create_service_account_token "$SERVICE_ACCOUNT_NAMESPACE" "$SERVICE_ACCOUNT_NAME")"

write_kubeconfig "$OUTPUT_PATH" "$CLUSTER_NAME" "$SERVER" "$CA_DATA" "$SERVICE_ACCOUNT_NAME" "$TOKEN"
verify_permissions "$OUTPUT_PATH" "$FLEET_NAMESPACE" "$APP_NAMESPACE"

if [[ "$UPDATE_SECRET" == "1" ]]; then
  echo "Updating GitHub secret ${GITHUB_SECRET_NAME}"
  update_github_secret "$GITHUB_SECRET_NAME" "$OUTPUT_PATH"
fi

echo "Fleet kubeconfig written to: $OUTPUT_PATH"
echo "Verified access to Fleet namespace ${FLEET_NAMESPACE} and app namespace ${APP_NAMESPACE}"
