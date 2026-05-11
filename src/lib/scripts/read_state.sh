CONFIG_FILE="/etc/sing-box/config.json"
META_FILE="/etc/sing-box/nodeget.json"

if command -v sing-box >/dev/null 2>&1; then
  printf 'NGP_SINGBOX_VERSION=%s\n' "$(sing-box version 2>/dev/null | head -n 1 | awk '{print $NF}' || echo unknown)"
else
  printf 'NGP_SINGBOX_VERSION=%s\n' "missing"
fi

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(systemctl is-active sing-box 2>/dev/null || echo inactive)"
printf 'NGP_SERVICE_ENABLED=%s\n' "$(systemctl is-enabled sing-box 2>/dev/null || echo disabled)"
printf 'NGP_HOST_ARCH=%s\n' "$(uname -m)"
printf 'NGP_HOST_KERNEL=%s\n' "$(uname -r)"

echo 'NGP_CONFIG_BEGIN'
if ngp_root test -f "$CONFIG_FILE"; then
  ngp_root cat "$CONFIG_FILE"
fi
echo 'NGP_CONFIG_END'

echo 'NGP_META_BEGIN'
if ngp_root test -f "$META_FILE"; then
  ngp_root cat "$META_FILE"
fi
echo 'NGP_META_END'
