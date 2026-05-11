action="${NGP_ACTION:-status}"

case "$action" in
  start|stop|restart)
    ngp_root systemctl "$action" sing-box
    ;;
  status)
    ;;
  *)
    echo "NGP_ERROR=unknown_action_$action"
    exit 1
    ;;
esac

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(systemctl is-active sing-box 2>/dev/null || echo inactive)"
printf 'NGP_SERVICE_ENABLED=%s\n' "$(systemctl is-enabled sing-box 2>/dev/null || echo disabled)"
