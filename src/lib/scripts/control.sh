action="${NGP_ACTION:-status}"

case "$action" in
  start|stop|restart)
    "ngp_service_$action" sing-box
    ;;
  status)
    ;;
  *)
    echo "NGP_ERROR=unknown_action_$action"
    exit 1
    ;;
esac

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(ngp_service_active sing-box)"
printf 'NGP_SERVICE_ENABLED=%s\n' "$(ngp_service_enabled sing-box)"
printf 'NGP_SERVICE_MANAGER=%s\n' "$(ngp_service_manager)"
