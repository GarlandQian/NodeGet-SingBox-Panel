CONFIG_FILE="/etc/sing-box/config.json"
META_FILE="/etc/nodeget-singbox-panel/nodeget.json"
LEGACY_META_FILE="/etc/sing-box/nodeget.json"

if command -v sing-box >/dev/null 2>&1; then
  printf 'NGP_SINGBOX_VERSION=%s\n' "$(sing-box version 2>/dev/null | head -n 1 | awk '{print $NF}' || echo unknown)"
  printf 'NGP_SINGBOX_BIN=%s\n' "$(ngp_singbox_bin 2>/dev/null || echo unknown)"
else
  printf 'NGP_SINGBOX_VERSION=%s\n' "missing"
  printf 'NGP_SINGBOX_BIN=%s\n' "missing"
fi

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(ngp_service_active sing-box)"
printf 'NGP_SERVICE_ENABLED=%s\n' "$(ngp_service_enabled sing-box)"
printf 'NGP_SERVICE_MANAGER=%s\n' "$(ngp_service_manager)"
printf 'NGP_HOST_ARCH=%s\n' "$(uname -m)"
printf 'NGP_HOST_KERNEL=%s\n' "$(uname -r)"
ngp_migrate_legacy_meta "$META_FILE" "$LEGACY_META_FILE"

echo 'NGP_CONFIG_BEGIN'
if ngp_root test -f "$CONFIG_FILE"; then
  ngp_root cat "$CONFIG_FILE"
fi
echo 'NGP_CONFIG_END'

echo 'NGP_META_BEGIN'
if ngp_root test -f "$META_FILE"; then
  ngp_root cat "$META_FILE"
elif ngp_root test -f "$LEGACY_META_FILE"; then
  ngp_root cat "$LEGACY_META_FILE"
fi
echo 'NGP_META_END'

echo 'NGP_CONFIG_CHECK_BEGIN'
if command -v sing-box >/dev/null 2>&1 && ngp_root test -f "$CONFIG_FILE"; then
  if ngp_root "$(ngp_singbox_bin)" check -c "$CONFIG_FILE" 2>&1; then
    echo "check_ok"
  else
    echo "check_failed"
  fi
else
  echo "check_skipped"
fi
echo 'NGP_CONFIG_CHECK_END'

echo 'NGP_PROCESS_BEGIN'
if ps -eo pid,args >/dev/null 2>&1; then
  ps -eo pid,args | awk '/[s]ing-box/ { print }' || true
else
  ps | awk '/[s]ing-box/ { print }' || true
fi
echo 'NGP_PROCESS_END'

echo 'NGP_LISTEN_BEGIN'
if command -v ss >/dev/null 2>&1; then
  ss -lntup 2>/dev/null | awk 'NR == 1 || /sing-box|LISTEN|udp/ { print }' || true
elif command -v netstat >/dev/null 2>&1; then
  netstat -lntup 2>/dev/null | awk 'NR <= 2 || /sing-box|LISTEN|udp/ { print }' || true
else
  echo "missing_ss_or_netstat"
fi
echo 'NGP_LISTEN_END'

echo 'NGP_SERVICE_LOG_BEGIN'
if command -v journalctl >/dev/null 2>&1; then
  ngp_root journalctl -u sing-box --no-pager -n 80 2>&1 || true
elif command -v logread >/dev/null 2>&1; then
  ngp_root logread 2>/dev/null | awk '/sing-box/ { print }' | tail -n 80 || true
elif ngp_root test -f /var/log/messages; then
  ngp_root_sh "grep 'sing-box' /var/log/messages 2>/dev/null | tail -n 80" || true
else
  echo "missing_service_log_backend"
fi
echo 'NGP_SERVICE_LOG_END'
