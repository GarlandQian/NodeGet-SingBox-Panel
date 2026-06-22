set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail || true

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export PATH

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

ngp_error() {
  echo "NGP_ERROR=$1"
  exit 1
}

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

ngp_try_install_package() {
  pkg="$1"
  if command -v apk >/dev/null 2>&1; then
    ngp_root apk add --no-cache "$pkg" >/dev/null 2>&1
    return $?
  fi
  if command -v apt-get >/dev/null 2>&1; then
    ngp_root apt-get update >/dev/null 2>&1 || return 1
    ngp_root apt-get install -y "$pkg" >/dev/null 2>&1
    return $?
  fi
  if command -v dnf >/dev/null 2>&1; then
    ngp_root dnf install -y "$pkg" >/dev/null 2>&1
    return $?
  fi
  if command -v yum >/dev/null 2>&1; then
    ngp_root yum install -y "$pkg" >/dev/null 2>&1
    return $?
  fi
  return 1
}

ngp_require_command() {
  cmd="$1"
  pkg="${2:-$1}"
  if command -v "$cmd" >/dev/null 2>&1; then
    return
  fi
  ngp_try_install_package "$pkg" || true
  command -v "$cmd" >/dev/null 2>&1 || ngp_error "missing_$cmd"
}

ngp_base64_decode() {
  if base64 -d </dev/null >/dev/null 2>&1; then
    base64 -d
  else
    base64 --decode
  fi
}

ngp_write_root_file() {
  src="$1"
  target="$2"
  mode="${3:-0644}"
  target_dir="$(dirname "$target")"
  ngp_root mkdir -p "$target_dir"
  ngp_root cp "$src" "$target"
  ngp_root chmod "$mode" "$target"
}

ngp_decode_to() {
  var_name="$1"
  target_path="$2"
  eval "var_value=\${$var_name:-}"
  if [ -z "$var_value" ]; then
    ngp_error "missing_$var_name"
  fi
  tmp="$(mktemp)"
  printf '%s' "$var_value" | ngp_base64_decode > "$tmp"
  ngp_write_root_file "$tmp" "$target_path" 0644
  rm -f "$tmp"
}

ngp_service_manager() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    echo "systemd"
    return
  fi
  if command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
    echo "openrc"
    return
  fi
  if command -v service >/dev/null 2>&1; then
    echo "service"
    return
  fi
  echo "none"
}

ngp_service_reload() {
  case "$(ngp_service_manager)" in
    systemd)
      ngp_root systemctl daemon-reload
      ;;
    *)
      true
      ;;
  esac
}

ngp_service_start() {
  svc="$1"
  case "$(ngp_service_manager)" in
    systemd)
      ngp_root systemctl start "$svc"
      ;;
    openrc)
      ngp_root rc-service "$svc" start
      ;;
    service)
      ngp_root service "$svc" start
      ;;
    *)
      ngp_error "unsupported_service_manager"
      ;;
  esac
}

ngp_service_stop() {
  svc="$1"
  case "$(ngp_service_manager)" in
    systemd)
      ngp_root systemctl stop "$svc"
      ;;
    openrc)
      ngp_root rc-service "$svc" stop
      ;;
    service)
      ngp_root service "$svc" stop
      ;;
    *)
      return 1
      ;;
  esac
}

ngp_service_restart() {
  svc="$1"
  case "$(ngp_service_manager)" in
    systemd)
      ngp_root systemctl restart "$svc"
      ;;
    openrc)
      ngp_root rc-service "$svc" restart
      ;;
    service)
      ngp_root service "$svc" restart
      ;;
    *)
      ngp_error "unsupported_service_manager"
      ;;
  esac
}

ngp_service_enable() {
  svc="$1"
  case "$(ngp_service_manager)" in
    systemd)
      ngp_root systemctl enable "$svc" >/dev/null 2>&1
      ;;
    openrc)
      ngp_root rc-update add "$svc" default >/dev/null 2>&1
      ;;
    *)
      true
      ;;
  esac
}

ngp_service_disable() {
  svc="$1"
  case "$(ngp_service_manager)" in
    systemd)
      ngp_root systemctl disable "$svc" >/dev/null 2>&1
      ;;
    openrc)
      ngp_root rc-update del "$svc" default >/dev/null 2>&1
      ;;
    *)
      true
      ;;
  esac
}

ngp_service_disable_now() {
  svc="$1"
  ngp_service_stop "$svc" >/dev/null 2>&1 || true
  ngp_service_disable "$svc" >/dev/null 2>&1 || true
}

ngp_service_active() {
  svc="$1"
  case "$(ngp_service_manager)" in
    systemd)
      systemctl is-active "$svc" 2>/dev/null || echo "inactive"
      ;;
    openrc)
      if ngp_root rc-service "$svc" status >/dev/null 2>&1; then
        echo "active"
      else
        echo "inactive"
      fi
      ;;
    service)
      if ngp_root service "$svc" status >/dev/null 2>&1; then
        echo "active"
      else
        echo "inactive"
      fi
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

ngp_service_enabled() {
  svc="$1"
  case "$(ngp_service_manager)" in
    systemd)
      systemctl is-enabled "$svc" 2>/dev/null || echo "disabled"
      ;;
    openrc)
      if rc-update show 2>/dev/null | awk -v svc="$svc" '$1 == svc { found = 1 } END { exit found ? 0 : 1 }'; then
        echo "enabled"
      else
        echo "disabled"
      fi
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

ngp_singbox_bin() {
  if command -v sing-box >/dev/null 2>&1; then
    command -v sing-box
    return
  fi
  if [ -x /usr/local/bin/sing-box ]; then
    echo "/usr/local/bin/sing-box"
    return
  fi
  if [ -x /usr/bin/sing-box ]; then
    echo "/usr/bin/sing-box"
    return
  fi
  if [ -x /bin/sing-box ]; then
    echo "/bin/sing-box"
    return
  fi
  return 1
}

ngp_ensure_singbox_service() {
  manager="$(ngp_service_manager)"
  case "$manager" in
    systemd|service)
      return
      ;;
    openrc)
      singbox_bin="$(ngp_singbox_bin)" || ngp_error "missing_sing-box"
      tmp="$(mktemp)"
      cat > "$tmp" <<EOF
#!/sbin/openrc-run
description="sing-box service"
command="$singbox_bin"
command_args="run -c /etc/sing-box/config.json"
command_background="yes"
pidfile="/run/sing-box.pid"

depend() {
  need net
  after firewall
}
EOF
      ngp_write_root_file "$tmp" /etc/init.d/sing-box 0755
      rm -f "$tmp"
      ;;
    *)
      ngp_error "unsupported_service_manager"
      ;;
  esac
}

ngp_ensure_singbox() {
  if ! ngp_singbox_bin >/dev/null 2>&1; then
    ngp_require_command curl curl
    install_status=0
    ngp_root_sh 'curl -fsSL https://sing-box.app/install.sh | sh' || install_status=$?
    if ! ngp_singbox_bin >/dev/null 2>&1; then
      ngp_error "singbox_install_failed_$install_status"
    fi
  fi
  ngp_ensure_singbox_service
}
