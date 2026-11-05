XRAY_ROOT=/etc/nodeget-singbox-panel/xray
XRAY_BIN=/usr/local/lib/nodeget-singbox-panel/xray
XRAY_SERVICE=nodeget-xray
XRAY_CONFIG="$XRAY_ROOT/config.json"
XRAY_META="$XRAY_ROOT/nodeget.json"

ngp_xray_hash() {
  if ngp_root test -f "$1"; then
    if command -v sha256sum >/dev/null 2>&1; then
      ngp_root sha256sum "$1" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
      ngp_root openssl dgst -sha256 "$1" | awk '{print $NF}'
    else
      ngp_error xray_sha256_tool_missing
    fi
  else
    echo absent
  fi
}

ngp_xray_version() {
  if ngp_root test -x "$XRAY_BIN"; then
    ngp_root "$XRAY_BIN" version | head -n 1 | awk '{print $2}'
  else
    echo missing
  fi
}

ngp_xray_check_paths() {
  for path in /etc/nodeget-singbox-panel "$XRAY_ROOT" /usr/local/lib/nodeget-singbox-panel; do
    if ngp_root test -L "$path"; then ngp_error xray_symlink_refused; fi
    if ngp_root test -e "$path" && ! ngp_root test -d "$path"; then ngp_error xray_unmanaged_paths; fi
  done
  for path in "$XRAY_BIN" "$XRAY_CONFIG" "$XRAY_META" "$XRAY_BIN.bak" "$XRAY_CONFIG.bak" "$XRAY_META.bak" \
    "$XRAY_BIN.stage" "$XRAY_ROOT/config.stage" "$XRAY_ROOT/meta.stage" "$XRAY_ROOT/managed-by-nodeget"; do
    if ngp_root test -L "$path"; then ngp_error xray_symlink_refused; fi
    if ngp_root test -e "$path" && ! ngp_root test -f "$path"; then ngp_error xray_unmanaged_paths; fi
  done
}

ngp_xray_require_owner() {
  ngp_xray_check_paths
  ngp_root test -f "$XRAY_ROOT/managed-by-nodeget" || ngp_error xray_unmanaged_paths
}

ngp_xray_prepare() {
  umask 077
  ngp_xray_check_paths
  if ngp_root test -e "$XRAY_ROOT" || ngp_root test -e "$XRAY_BIN"; then
    ngp_xray_require_owner
  else
    ngp_root mkdir -p "$XRAY_ROOT" /usr/local/lib/nodeget-singbox-panel
    ngp_root chmod 0700 "$XRAY_ROOT"
    ngp_root touch "$XRAY_ROOT/managed-by-nodeget"
    ngp_root chmod 0600 "$XRAY_ROOT/managed-by-nodeget"
  fi
  ngp_root chmod 0700 "$XRAY_ROOT"
  ngp_root mkdir "$XRAY_ROOT/.lock" 2>/dev/null || ngp_error xray_operation_locked
}

ngp_xray_check_revision() {
  [ "$(ngp_xray_hash "$XRAY_CONFIG")" = "$NGP_XRAY_CONFIG_SHA256" ] || ngp_error xray_config_changed_since_read
  [ "$(ngp_xray_hash "$XRAY_META")" = "$NGP_XRAY_META_SHA256" ] || ngp_error xray_meta_changed_since_read
}

ngp_xray_download() {
  ngp_require_command curl curl
  ngp_require_command jq jq
  ngp_require_command unzip unzip
  case "$(uname -m)" in
    x86_64|amd64) xray_arch=64 ;;
    aarch64|arm64) xray_arch=arm64-v8a ;;
    armv7l|armv7) xray_arch=arm32-v7a ;;
    armv6l|armv6) xray_arch=arm32-v6 ;;
    i386|i486|i586|i686|x86) xray_arch=32 ;;
    riscv64) xray_arch=riscv64 ;;
    loongarch64|loong64) xray_arch=loong64 ;;
    *) ngp_error xray_unsupported_arch ;;
  esac
  xray_asset="Xray-linux-${xray_arch}.zip"
  curl -fsSL --connect-timeout 10 --max-time 30 \
    "https://api.github.com/repos/XTLS/Xray-core/releases/tags/$NGP_XRAY_RELEASE" \
    -o "$xray_work/release.json" || ngp_error xray_release_metadata_failed
  xray_digest="$(jq -r --arg tag "$NGP_XRAY_RELEASE" --arg asset "$xray_asset" \
    'select(.tag_name == $tag and .prerelease == false and .draft == false) | .assets[] | select(.name == $asset) | .digest' "$xray_work/release.json")"
  printf '%s\n' "$xray_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || ngp_error xray_release_digest_missing
  curl -fL --connect-timeout 10 --max-time 180 \
    "https://github.com/XTLS/Xray-core/releases/download/$NGP_XRAY_RELEASE/$xray_asset" \
    -o "$xray_work/xray.zip" || ngp_error xray_release_download_failed
  [ "$(sha256sum "$xray_work/xray.zip" | awk '{print $1}')" = "${xray_digest#sha256:}" ] || ngp_error xray_release_checksum_mismatch
  unzip -p "$xray_work/xray.zip" xray > "$xray_work/xray" || ngp_error xray_release_extract_failed
  chmod 0700 "$xray_work/xray"
  [ "$("$xray_work/xray" version | head -n 1 | awk '{print $2}')" = "${NGP_XRAY_RELEASE#v}" ] || ngp_error xray_release_version_mismatch
}

ngp_xray_ensure_service() {
  xray_service_file=
  case "$(ngp_service_manager)" in
    systemd)
      xray_service_file=/etc/systemd/system/nodeget-xray.service
      if ngp_root test -L "$xray_service_file"; then ngp_error xray_service_not_owned; fi
      if ngp_root systemctl cat nodeget-xray.service >/dev/null 2>&1; then
        ngp_root systemctl cat nodeget-xray.service | grep -q '^# Managed by NodeGet Xray$' || ngp_error xray_service_not_owned
        return
      fi
      cat > "$xray_work/service" <<EOF
# Managed by NodeGet Xray
[Unit]
Description=NodeGet Xray XHTTP service
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$XRAY_BIN run -config $XRAY_CONFIG
Restart=on-failure
RestartSec=5
UMask=0077
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
      ngp_write_root_file "$xray_work/service" "$xray_service_file" 0644
      ngp_service_reload
      ;;
    openrc)
      xray_service_file=/etc/init.d/nodeget-xray
      if ngp_root test -L "$xray_service_file"; then ngp_error xray_service_not_owned; fi
      if ngp_root test -e "$xray_service_file"; then
        ngp_root cat "$xray_service_file" | grep -q '^# Managed by NodeGet Xray$' || ngp_error xray_service_not_owned
        return
      fi
      cat > "$xray_work/service" <<EOF
#!/sbin/openrc-run
# Managed by NodeGet Xray
description="NodeGet Xray XHTTP service"
command="$XRAY_BIN"
command_args="run -config $XRAY_CONFIG"
command_background="yes"
pidfile="/run/nodeget-xray.pid"
output_log="/var/log/nodeget-xray.log"
error_log="/var/log/nodeget-xray.log"
umask="0077"
depend() {
  need net
  after firewall
}
EOF
      ngp_write_root_file "$xray_work/service" "$xray_service_file" 0755
      ;;
    *) ngp_error xray_unsupported_service_manager ;;
  esac
}

ngp_xray_status() {
  printf 'NGP_SERVICE_ACTIVE=%s\n' "$(ngp_service_active "$XRAY_SERVICE" | tail -n 1)"
  printf 'NGP_SERVICE_ENABLED=%s\n' "$(ngp_service_enabled "$XRAY_SERVICE" | tail -n 1)"
  printf 'NGP_SERVICE_MANAGER=%s\n' "$(ngp_service_manager)"
  printf 'NGP_CONFIG_SHA256=%s\n' "$(ngp_xray_hash "$XRAY_CONFIG")"
  printf 'NGP_META_SHA256=%s\n' "$(ngp_xray_hash "$XRAY_META")"
  printf 'NGP_XRAY_VERSION=%s\n' "$(ngp_xray_version)"
}
