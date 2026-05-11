set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    NGP_SUDO=sudo
  else
    echo "NGP_ERROR=root_or_sudo_required"
    exit 1
  fi
else
  NGP_SUDO=
fi

ngp_root() {
  if [ -n "$NGP_SUDO" ]; then
    "$NGP_SUDO" "$@"
  else
    "$@"
  fi
}

ngp_root_sh() {
  if [ -n "$NGP_SUDO" ]; then
    "$NGP_SUDO" sh -c "$1"
  else
    sh -c "$1"
  fi
}

ngp_decode_to() {
  local var_name="$1"
  local target_path="$2"
  local var_value
  eval "var_value=\${$var_name:-}"
  if [ -z "$var_value" ]; then
    echo "NGP_ERROR=missing_$var_name"
    exit 1
  fi
  local tmp
  tmp="$(mktemp)"
  printf '%s' "$var_value" | base64 -d > "$tmp"
  ngp_root install -d -m 0755 "$(dirname "$target_path")"
  ngp_root install -m 0644 "$tmp" "$target_path"
  rm -f "$tmp"
}
