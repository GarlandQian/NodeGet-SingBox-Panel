CONFIG_FILE="/etc/sing-box/config.json"
META_FILE="/etc/sing-box/nodeget.json"

ngp_ensure_singbox

ngp_decode_to NGP_CONFIG_B64 "$CONFIG_FILE"
ngp_decode_to NGP_META_B64 "$META_FILE"
ngp_root chmod 0600 "$CONFIG_FILE"

ngp_root "$(ngp_singbox_bin)" check -c "$CONFIG_FILE"
ngp_service_enable sing-box >/dev/null 2>&1 || true
ngp_service_restart sing-box

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(ngp_service_active sing-box)"
printf 'NGP_SERVICE_MANAGER=%s\n' "$(ngp_service_manager)"
printf 'NGP_CONFIG_FILE=%s\n' "$CONFIG_FILE"
printf 'NGP_META_FILE=%s\n' "$META_FILE"
