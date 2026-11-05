ngp_xray_require_owner
ngp_root mkdir "$XRAY_ROOT/.lock" 2>/dev/null || ngp_error xray_operation_locked
trap 'ngp_root rmdir "$XRAY_ROOT/.lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
case "$NGP_ACTION" in
  start)
    ngp_root test -f "$XRAY_CONFIG" || ngp_error xray_config_missing
    ngp_root "$XRAY_BIN" run -test -config "$XRAY_CONFIG"
    ngp_service_enable "$XRAY_SERVICE"
    ngp_service_start "$XRAY_SERVICE"
    ;;
  restart)
    ngp_root test -f "$XRAY_CONFIG" || ngp_error xray_config_missing
    ngp_root "$XRAY_BIN" run -test -config "$XRAY_CONFIG"
    ngp_service_restart "$XRAY_SERVICE"
    ;;
  stop) ngp_service_stop "$XRAY_SERVICE" ;;
  *) ngp_error xray_invalid_action ;;
esac
if [ "$NGP_ACTION" != stop ]; then
  sleep 1
  [ "$(ngp_service_active "$XRAY_SERVICE" | tail -n 1)" = active ] || ngp_error xray_service_start_failed
fi
ngp_xray_status
