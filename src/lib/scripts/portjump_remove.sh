SERVICES="${NGP_PORTJUMP_SERVICES:-}"

if [ -z "$SERVICES" ]; then
  echo "NGP_PORTJUMP_REMOVED=0"
  exit 0
fi

removed=0
for svc in $SERVICES; do
  unit_path="/etc/systemd/system/${svc}.service"
  init_path="/etc/init.d/${svc}"
  existed=0
  ngp_service_disable_now "$svc" >/dev/null 2>&1 || true
  if ngp_root test -f "$unit_path"; then
    ngp_root rm -f "$unit_path"
    existed=1
  fi
  if ngp_root test -f "$init_path"; then
    ngp_root rm -f "$init_path"
    existed=1
  fi
  if [ "$existed" -eq 1 ]; then
    removed=$((removed + 1))
  fi
done

ngp_service_reload >/dev/null 2>&1 || true
printf 'NGP_PORTJUMP_REMOVED=%s\n' "$removed"
