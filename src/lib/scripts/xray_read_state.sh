if ngp_root test -e "$XRAY_ROOT" || ngp_root test -e "$XRAY_BIN"; then
  ngp_xray_require_owner
  ngp_root mkdir "$XRAY_ROOT/.lock" 2>/dev/null || ngp_error xray_operation_locked
  trap 'ngp_root rmdir "$XRAY_ROOT/.lock" 2>/dev/null || true' EXIT
  trap 'exit 1' HUP INT TERM
fi
printf 'NGP_XRAY_VERSION=%s\n' "$(ngp_xray_version)"
printf 'NGP_XRAY_SERVICE_ACTIVE=%s\n' "$(ngp_service_active "$XRAY_SERVICE" | tail -n 1)"
printf 'NGP_XRAY_SERVICE_ENABLED=%s\n' "$(ngp_service_enabled "$XRAY_SERVICE" | tail -n 1)"
xray_read_config_hash="$(ngp_xray_hash "$XRAY_CONFIG")"
xray_read_meta_hash="$(ngp_xray_hash "$XRAY_META")"
printf 'NGP_XRAY_CONFIG_SHA256=%s\n' "$xray_read_config_hash"
printf 'NGP_XRAY_META_SHA256=%s\n' "$xray_read_meta_hash"
echo NGP_XRAY_CONFIG_BEGIN
if ngp_root test -f "$XRAY_CONFIG"; then ngp_root cat "$XRAY_CONFIG"; fi
echo NGP_XRAY_CONFIG_END
echo NGP_XRAY_META_BEGIN
if ngp_root test -f "$XRAY_META"; then ngp_root cat "$XRAY_META"; fi
echo NGP_XRAY_META_END
echo NGP_XRAY_CONFIG_CHECK_BEGIN
if ngp_root test -x "$XRAY_BIN" && ngp_root test -f "$XRAY_CONFIG"; then
  if ngp_root "$XRAY_BIN" run -test -config "$XRAY_CONFIG" 2>&1; then
    echo check_ok
  else
    echo check_failed
  fi
else
  echo check_skipped
fi
echo NGP_XRAY_CONFIG_CHECK_END
echo NGP_XRAY_SERVICE_LOG_BEGIN
if command -v journalctl >/dev/null 2>&1; then
  ngp_root journalctl -u "$XRAY_SERVICE" --no-pager -n 20 2>&1 || true
elif ngp_root test -f /var/log/nodeget-xray.log; then
  ngp_root tail -n 20 /var/log/nodeget-xray.log || true
fi
echo NGP_XRAY_SERVICE_LOG_END
[ "$(ngp_xray_hash "$XRAY_CONFIG")" = "$xray_read_config_hash" ] || ngp_error xray_config_changed_since_read
[ "$(ngp_xray_hash "$XRAY_META")" = "$xray_read_meta_hash" ] || ngp_error xray_meta_changed_since_read
echo NGP_XRAY_STATE_COMPLETE=1
