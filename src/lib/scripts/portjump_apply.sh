SERVICE_NAME="${NGP_PORTJUMP_SERVICE:-}"
TARGET_PORT="${NGP_PORTJUMP_TARGET:-}"
RANGE_SPEC="${NGP_PORTJUMP_RANGE:-}"

if [ -z "$SERVICE_NAME" ] || [ -z "$TARGET_PORT" ] || [ -z "$RANGE_SPEC" ]; then
  echo "NGP_ERROR=missing_portjump_args"
  exit 1
fi

case "$SERVICE_NAME" in
  *[!A-Za-z0-9_.@-]*)
    echo "NGP_ERROR=invalid_portjump_service"
    exit 1
    ;;
esac

case "$TARGET_PORT" in
  *[!0-9]*)
    echo "NGP_ERROR=invalid_portjump_target"
    exit 1
    ;;
esac

case "$RANGE_SPEC" in
  *[!0-9,:-]*)
    echo "NGP_ERROR=invalid_portjump_range"
    exit 1
    ;;
esac

if ! command -v iptables >/dev/null 2>&1; then
  ngp_try_install_package iptables || true
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "NGP_ERROR=missing_iptables"
  exit 1
fi

IPTABLES_BIN="$(command -v iptables)"
manager="$(ngp_service_manager)"

ngp_service_stop "$SERVICE_NAME" >/dev/null 2>&1 || true

case "$manager" in
  systemd)
    service_path="/etc/systemd/system/${SERVICE_NAME}.service"
    service_mode="0644"
    cat_unit="$(mktemp)"
    cat > "$cat_unit" <<UNIT
[Unit]
Description=NodeGet sing-box port-jump redirect (${TARGET_PORT})
After=network-online.target sing-box.service
Wants=network-online.target
PartOf=sing-box.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-${IPTABLES_BIN} -t nat -D PREROUTING -p udp -m multiport --dports ${RANGE_SPEC} -j REDIRECT --to-ports ${TARGET_PORT}
ExecStart=${IPTABLES_BIN} -t nat -A PREROUTING -p udp -m multiport --dports ${RANGE_SPEC} -j REDIRECT --to-ports ${TARGET_PORT}
ExecStop=${IPTABLES_BIN} -t nat -D PREROUTING -p udp -m multiport --dports ${RANGE_SPEC} -j REDIRECT --to-ports ${TARGET_PORT}

[Install]
WantedBy=multi-user.target
UNIT
    ;;
  openrc)
    service_path="/etc/init.d/${SERVICE_NAME}"
    service_mode="0755"
    cat_unit="$(mktemp)"
    cat > "$cat_unit" <<UNIT
#!/sbin/openrc-run
description="NodeGet sing-box port-jump redirect (${TARGET_PORT})"

depend() {
  need net
  after firewall sing-box
}

start() {
  ebegin "Applying ${SERVICE_NAME}"
  ${IPTABLES_BIN} -t nat -D PREROUTING -p udp -m multiport --dports ${RANGE_SPEC} -j REDIRECT --to-ports ${TARGET_PORT} >/dev/null 2>&1 || true
  ${IPTABLES_BIN} -t nat -A PREROUTING -p udp -m multiport --dports ${RANGE_SPEC} -j REDIRECT --to-ports ${TARGET_PORT}
  eend \$?
}

stop() {
  ebegin "Removing ${SERVICE_NAME}"
  ${IPTABLES_BIN} -t nat -D PREROUTING -p udp -m multiport --dports ${RANGE_SPEC} -j REDIRECT --to-ports ${TARGET_PORT} >/dev/null 2>&1 || true
  eend 0
}
UNIT
    ;;
  *)
    echo "NGP_ERROR=unsupported_service_manager"
    exit 1
    ;;
esac

ngp_write_root_file "$cat_unit" "$service_path" "$service_mode"
rm -f "$cat_unit"

ngp_service_reload
ngp_service_enable "$SERVICE_NAME" >/dev/null 2>&1 || true
ngp_service_start "$SERVICE_NAME"

printf 'NGP_PORTJUMP_SERVICE=%s\n' "$SERVICE_NAME"
printf 'NGP_PORTJUMP_ACTIVE=%s\n' "$(ngp_service_active "$SERVICE_NAME")"
printf 'NGP_SERVICE_MANAGER=%s\n' "$manager"
