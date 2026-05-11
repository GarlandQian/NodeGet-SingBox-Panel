CONFIG_FILE="/etc/sing-box/config.json"
META_FILE="/etc/sing-box/nodeget.json"

if ! command -v sing-box >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "NGP_ERROR=missing_curl"
    exit 1
  fi
  ngp_root_sh 'curl -fsSL https://sing-box.app/install.sh | sh'
fi

ngp_decode_to NGP_CONFIG_B64 "$CONFIG_FILE"
ngp_decode_to NGP_META_B64 "$META_FILE"
ngp_root chmod 0600 "$CONFIG_FILE"

ngp_root sing-box check -c "$CONFIG_FILE"
ngp_root systemctl enable sing-box >/dev/null 2>&1 || true
ngp_root systemctl restart sing-box

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(systemctl is-active sing-box 2>/dev/null || echo unknown)"
printf 'NGP_CONFIG_FILE=%s\n' "$CONFIG_FILE"
printf 'NGP_META_FILE=%s\n' "$META_FILE"
