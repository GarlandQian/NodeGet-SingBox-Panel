ngp_root systemctl disable --now sing-box >/dev/null 2>&1 || true
ngp_root rm -rf /etc/sing-box

# Remove all nodeget-singbox-portjump-* services
for unit_path in /etc/systemd/system/nodeget-singbox-portjump-*.service; do
  if [ -e "$unit_path" ]; then
    svc="$(basename "$unit_path" .service)"
    ngp_root systemctl disable --now "$svc.service" >/dev/null 2>&1 || true
    ngp_root rm -f "$unit_path"
  fi
done

ngp_root systemctl daemon-reload >/dev/null 2>&1 || true

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(systemctl is-active sing-box 2>/dev/null || echo inactive)"
echo 'NGP_UNINSTALLED=1'
