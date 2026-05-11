SERVICE_NAME="${NGP_PORTJUMP_SERVICE:-}"
TARGET_PORT="${NGP_PORTJUMP_TARGET:-}"
RANGE_SPEC="${NGP_PORTJUMP_RANGE:-}"

if [ -z "$SERVICE_NAME" ] || [ -z "$TARGET_PORT" ] || [ -z "$RANGE_SPEC" ]; then
  echo "NGP_ERROR=missing_portjump_args"
  exit 1
fi

unit_path="/etc/systemd/system/${SERVICE_NAME}.service"

if ! command -v iptables >/dev/null 2>&1; then
  echo "NGP_ERROR=missing_iptables"
  exit 1
fi

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
ExecStartPre=-/usr/sbin/iptables -t nat -D PREROUTING -p udp -m multiport --dports ${RANGE_SPEC} -j REDIRECT --to-ports ${TARGET_PORT}
ExecStart=/usr/sbin/iptables -t nat -A PREROUTING -p udp -m multiport --dports ${RANGE_SPEC} -j REDIRECT --to-ports ${TARGET_PORT}
ExecStop=/usr/sbin/iptables -t nat -D PREROUTING -p udp -m multiport --dports ${RANGE_SPEC} -j REDIRECT --to-ports ${TARGET_PORT}

[Install]
WantedBy=multi-user.target
UNIT

ngp_root install -m 0644 "$cat_unit" "$unit_path"
rm -f "$cat_unit"

ngp_root systemctl daemon-reload
ngp_root systemctl enable --now "$SERVICE_NAME.service" >/dev/null 2>&1

printf 'NGP_PORTJUMP_SERVICE=%s\n' "$SERVICE_NAME"
printf 'NGP_PORTJUMP_ACTIVE=%s\n' "$(systemctl is-active "$SERVICE_NAME.service" 2>/dev/null || echo unknown)"
