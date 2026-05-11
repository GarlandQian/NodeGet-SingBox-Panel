ngp_root systemctl disable --now sing-box >/dev/null 2>&1 || true
ngp_root rm -rf /etc/sing-box
ngp_root systemctl daemon-reload >/dev/null 2>&1 || true

printf 'NGP_SERVICE_ACTIVE=%s\n' "$(systemctl is-active sing-box 2>/dev/null || echo inactive)"
echo 'NGP_UNINSTALLED=1'
