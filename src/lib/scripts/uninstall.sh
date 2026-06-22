ngp_service_disable_now sing-box >/dev/null 2>&1 || true
ngp_root rm -rf /etc/sing-box

# Remove all nodeget-singbox-portjump-* services
for unit_path in /etc/systemd/system/nodeget-singbox-portjump-*.service; do
  if [ -e "$unit_path" ]; then
    svc="$(basename "$unit_path" .service)"
    ngp_service_disable_now "$svc" >/dev/null 2>&1 || true
    ngp_root rm -f "$unit_path"
  fi
done

for init_path in /etc/init.d/nodeget-singbox-portjump-*; do
  if [ -e "$init_path" ]; then
    svc="$(basename "$init_path")"
    ngp_service_disable_now "$svc" >/dev/null 2>&1 || true
    ngp_root rm -f "$init_path"
  fi
done

ngp_service_reload >/dev/null 2>&1 || true

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(ngp_service_active sing-box)"
printf 'NGP_SERVICE_MANAGER=%s\n' "$(ngp_service_manager)"
echo 'NGP_UNINSTALLED=1'
