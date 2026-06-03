#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-}"
EXTENSION_ID="${2:-}"
BROWSER="${3:-chrome}"

if [[ -z "${REPO_ROOT}" ]]; then
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  REPO_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
fi

if [[ -z "${EXTENSION_ID}" ]]; then
  read -r -p "Extension ID: " EXTENSION_ID
fi

if [[ -z "${EXTENSION_ID}" ]]; then
  echo "Extension ID is required." >&2
  exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TEMPLATE_PATH="${SCRIPT_DIR}/com.codex.bridge.template.json"
LOCAL_DIR="${HOME}/.chrome-bridge/native-messaging"
LOCAL_MANIFEST="${LOCAL_DIR}/com.codex.bridge.json"
case "${BROWSER}" in
  edge) HOST_DIR="${HOME}/.config/microsoft-edge/NativeMessagingHosts" ;;
  chromium) HOST_DIR="${HOME}/.config/chromium/NativeMessagingHosts" ;;
  *)
    if [[ "$(uname -s)" == "Darwin" ]]; then
      HOST_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    else
      HOST_DIR="${HOME}/.config/google-chrome/NativeMessagingHosts"
    fi
    ;;
esac

mkdir -p "${LOCAL_DIR}" "${HOST_DIR}"
LAUNCHER_PATH="${REPO_ROOT}/scripts/start-bridge.sh"
sed -e "s|__EXTENSION_ID__|${EXTENSION_ID}|g" -e "s|__LAUNCHER_PATH__|${LAUNCHER_PATH}|g" "${TEMPLATE_PATH}" > "${LOCAL_MANIFEST}"
cp "${LOCAL_MANIFEST}" "${HOST_DIR}/com.codex.bridge.json"

echo "Installed native host manifest to ${LOCAL_MANIFEST}"
echo "Copied host manifest to ${HOST_DIR}/com.codex.bridge.json"
