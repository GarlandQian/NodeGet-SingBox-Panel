ngp_require_command sha256sum coreutils
ngp_xray_prepare
xray_work="$(mktemp -d)"
xray_commit=0
xray_complete=0
xray_had_config=0
xray_had_meta=0
xray_had_bin=0
xray_was_active="$(ngp_service_active "$XRAY_SERVICE" | tail -n 1)"
xray_was_enabled="$(ngp_service_enabled "$XRAY_SERVICE" | tail -n 1)"

rollback_xray() {
  xray_rollback_status=0
  if [ "$xray_had_config" -eq 1 ]; then
    ngp_root cp "$XRAY_CONFIG.bak" "$XRAY_CONFIG" || xray_rollback_status=1
  else
    ngp_root rm -f "$XRAY_CONFIG" || xray_rollback_status=1
  fi
  if [ "$xray_had_meta" -eq 1 ]; then
    ngp_root cp "$XRAY_META.bak" "$XRAY_META" || xray_rollback_status=1
  else
    ngp_root rm -f "$XRAY_META" || xray_rollback_status=1
  fi
  if [ "$xray_had_bin" -eq 1 ]; then
    ngp_root cp "$XRAY_BIN.bak" "$XRAY_BIN.stage" && ngp_root mv -f "$XRAY_BIN.stage" "$XRAY_BIN" || xray_rollback_status=1
  else
    ngp_root rm -f "$XRAY_BIN" || xray_rollback_status=1
  fi
  if [ "$xray_was_active" = active ]; then
    ngp_service_restart "$XRAY_SERVICE" >/dev/null 2>&1 || xray_rollback_status=1
  else
    ngp_service_stop "$XRAY_SERVICE" >/dev/null 2>&1 || xray_rollback_status=1
  fi
  if [ "$xray_was_enabled" != enabled ]; then
    ngp_service_disable "$XRAY_SERVICE" >/dev/null 2>&1 || xray_rollback_status=1
  fi
  return "$xray_rollback_status"
}

cleanup_xray() {
  if [ "$xray_commit" -eq 1 ] && [ "$xray_complete" -eq 0 ]; then
    rollback_xray || printf 'NGP_ERROR=xray_rollback_failed\n'
  fi
  ngp_root rm -f "$XRAY_ROOT/config.stage.json" "$XRAY_ROOT/meta.stage" "$XRAY_BIN.stage"
  rm -f "$xray_work/release.json" "$xray_work/xray.zip" "$xray_work/xray" "$xray_work/service" "$xray_work/config" "$xray_work/meta"
  rmdir "$xray_work" 2>/dev/null || true
  ngp_root rmdir "$XRAY_ROOT/.lock" 2>/dev/null || true
}
trap cleanup_xray EXIT
trap 'exit 1' HUP INT TERM
ngp_xray_check_revision

case "$NGP_XRAY_OPERATION" in
  deploy)
    printf '%s' "$NGP_CONFIG_B64" | ngp_base64_decode > "$xray_work/config"
    printf '%s' "$NGP_META_B64" | ngp_base64_decode > "$xray_work/meta"
    ;;
  upgrade)
    ngp_root test -f "$XRAY_CONFIG" || ngp_error xray_config_missing
    ngp_root cat "$XRAY_CONFIG" > "$xray_work/config"
    ngp_root cat "$XRAY_META" > "$xray_work/meta"
    ;;
  *) ngp_error xray_invalid_operation ;;
esac
# Stage in private directories before changing any live file.
ngp_write_root_file "$xray_work/config" "$XRAY_ROOT/config.stage.json" 0600
ngp_write_root_file "$xray_work/meta" "$XRAY_ROOT/meta.stage" 0600
rm -f "$xray_work/config" "$xray_work/meta"
xray_old_version="$(ngp_xray_version)"
if [ "$xray_old_version" = missing ] || [ "$NGP_XRAY_OPERATION" = upgrade ]; then
  ngp_xray_download
  ngp_write_root_file "$xray_work/xray" "$XRAY_BIN.stage" 0755
else
  [ "$xray_old_version" = "${NGP_XRAY_RELEASE#v}" ] || ngp_error xray_version_not_baseline
  ngp_root cp "$XRAY_BIN" "$XRAY_BIN.stage"
fi
xray_config_hash="$(ngp_xray_hash "$XRAY_ROOT/config.stage.json")"
xray_meta_hash="$(ngp_xray_hash "$XRAY_ROOT/meta.stage")"
echo NGP_XRAY_CHECK_BEGIN
if ! ngp_root "$XRAY_BIN.stage" run -test -config "$XRAY_ROOT/config.stage.json"; then
  echo NGP_XRAY_CHECK_END
  ngp_error xray_config_rejected
fi
echo NGP_XRAY_CHECK_END
ngp_xray_ensure_service
ngp_xray_check_revision
if ngp_root test -f "$XRAY_CONFIG"; then
  ngp_root cp "$XRAY_CONFIG" "$XRAY_CONFIG.bak"
  ngp_root chmod 0600 "$XRAY_CONFIG.bak"
  xray_had_config=1
fi
if ngp_root test -f "$XRAY_META"; then
  ngp_root cp "$XRAY_META" "$XRAY_META.bak"
  ngp_root chmod 0600 "$XRAY_META.bak"
  xray_had_meta=1
fi
if ngp_root test -f "$XRAY_BIN"; then
  ngp_root cp "$XRAY_BIN" "$XRAY_BIN.bak"
  xray_had_bin=1
fi
xray_commit=1
ngp_root mv -f "$XRAY_BIN.stage" "$XRAY_BIN"
ngp_root mv -f "$XRAY_ROOT/config.stage.json" "$XRAY_CONFIG"
ngp_root mv -f "$XRAY_ROOT/meta.stage" "$XRAY_META"
if [ "$NGP_XRAY_OPERATION" = deploy ] || [ "$xray_was_active" = active ]; then
  if [ "$NGP_XRAY_OPERATION" = deploy ]; then ngp_service_enable "$XRAY_SERVICE"; fi
  ngp_service_restart "$XRAY_SERVICE" || ngp_error xray_restart_failed_rolled_back
  sleep 1
  [ "$(ngp_service_active "$XRAY_SERVICE" | tail -n 1)" = active ] || ngp_error xray_unhealthy_rolled_back
fi
[ "$(ngp_xray_hash "$XRAY_CONFIG")" = "$xray_config_hash" ] || ngp_error xray_commit_hash_mismatch
[ "$(ngp_xray_hash "$XRAY_META")" = "$xray_meta_hash" ] || ngp_error xray_commit_hash_mismatch
ngp_xray_status
printf 'NGP_CONFIG_FILE=%s\n' "$XRAY_CONFIG"
printf 'NGP_META_FILE=%s\n' "$XRAY_META"
printf 'NGP_XRAY_VERSION_OLD=%s\n' "$xray_old_version"
printf 'NGP_XRAY_PREVIOUS_SERVICE_ACTIVE=%s\n' "$xray_was_active"
printf 'NGP_XRAY_PREVIOUS_SERVICE_ENABLED=%s\n' "$xray_was_enabled"
printf 'NGP_XRAY_EXPECTED_CONFIG_SHA256=%s\n' "$xray_config_hash"
printf 'NGP_XRAY_EXPECTED_META_SHA256=%s\n' "$xray_meta_hash"
printf 'NGP_XRAY_OPERATION=%s\n' "$NGP_XRAY_OPERATION"
echo NGP_XRAY_OPERATION_COMPLETE=1
xray_complete=1
