SERVICES="${NGP_PORTJUMP_SERVICES:-}"

if [ -z "$SERVICES" ]; then
  echo "NGP_PORTJUMP_REMOVED=0"
  exit 0
fi

removed=0
for svc in $SERVICES; do
  unit_path="/etc/systemd/system/${svc}.service"
  ngp_root systemctl disable --now "$svc.service" >/dev/null 2>&1 || true
  if ngp_root test -f "$unit_path"; then
    ngp_root rm -f "$unit_path"
    removed=$((removed + 1))
  fi
done

ngp_root systemctl daemon-reload >/dev/null 2>&1 || true
printf 'NGP_PORTJUMP_REMOVED=%s\n' "$removed"
