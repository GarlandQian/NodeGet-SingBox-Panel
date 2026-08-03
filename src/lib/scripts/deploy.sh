CONFIG_FILE="/etc/sing-box/config.json"
META_FILE="/etc/nodeget-singbox-panel/nodeget.json"
LEGACY_META_FILE="/etc/sing-box/nodeget.json"

ngp_ensure_singbox
ngp_root mkdir -p "$(dirname "$CONFIG_FILE")" "$(dirname "$META_FILE")"
ngp_migrate_legacy_meta "$META_FILE" "$LEGACY_META_FILE"

config_tmp="$(ngp_root mktemp "$(dirname "$CONFIG_FILE")/.nodeget-config.XXXXXX")"
meta_tmp="$(ngp_root mktemp "$(dirname "$META_FILE")/.nodeget-meta.XXXXXX")"

cleanup_deploy() {
  if [ "${commit_started:-0}" -eq 1 ] && [ "${commit_complete:-0}" -eq 0 ]; then
    rollback_deploy >/dev/null 2>&1 || true
  fi
  if [ -n "${config_tmp:-}" ]; then
    ngp_root rm -f "$config_tmp" >/dev/null 2>&1 || true
  fi
  if [ -n "${meta_tmp:-}" ]; then
    ngp_root rm -f "$meta_tmp" >/dev/null 2>&1 || true
  fi
}
trap cleanup_deploy EXIT
trap 'exit 1' HUP INT TERM

ngp_decode_to NGP_CONFIG_B64 "$config_tmp"
ngp_decode_to NGP_META_B64 "$meta_tmp"
ngp_root chmod 0600 "$config_tmp" "$meta_tmp"

ngp_root "$(ngp_singbox_bin)" check -c "$config_tmp"

had_config=0
had_meta=0
if ngp_root test -f "$CONFIG_FILE"; then
  ngp_root cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"
  ngp_root chmod 0600 "${CONFIG_FILE}.bak"
  had_config=1
fi
if ngp_root test -f "$META_FILE"; then
  ngp_root cp "$META_FILE" "${META_FILE}.bak"
  ngp_root chmod 0600 "${META_FILE}.bak"
  had_meta=1
fi

rollback_deploy() {
  if [ "$had_config" -eq 1 ]; then
    ngp_root cp "${CONFIG_FILE}.bak" "$CONFIG_FILE"
    ngp_root chmod 0600 "$CONFIG_FILE"
  else
    ngp_root rm -f "$CONFIG_FILE"
  fi
  if [ "$had_meta" -eq 1 ]; then
    ngp_root cp "${META_FILE}.bak" "$META_FILE"
    ngp_root chmod 0600 "$META_FILE"
  else
    ngp_root rm -f "$META_FILE"
  fi
}

commit_started=1
commit_complete=0
if ! ngp_root mv -f "$config_tmp" "$CONFIG_FILE"; then
  ngp_error "config_commit_failed"
fi
config_tmp=
if ! ngp_root mv -f "$meta_tmp" "$META_FILE"; then
  rollback_deploy
  commit_complete=1
  ngp_error "meta_commit_failed_rolled_back"
fi
meta_tmp=

if [ "$NGP_SERVICE_CREATED" -eq 1 ]; then
  ngp_service_enable sing-box >/dev/null 2>&1 || true
fi
if ! ngp_service_restart sing-box; then
  rollback_deploy
  ngp_service_restart sing-box >/dev/null 2>&1 || true
  commit_complete=1
  ngp_error "service_restart_failed_rolled_back"
fi
commit_complete=1

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(ngp_service_active sing-box)"
printf 'NGP_SERVICE_MANAGER=%s\n' "$(ngp_service_manager)"
if [ "$NGP_SERVICE_CREATED" -eq 1 ]; then
  printf 'NGP_SERVICE_DEFINITION=%s\n' "created"
else
  printf 'NGP_SERVICE_DEFINITION=%s\n' "preserved"
fi
printf 'NGP_CONFIG_FILE=%s\n' "$CONFIG_FILE"
printf 'NGP_META_FILE=%s\n' "$META_FILE"
