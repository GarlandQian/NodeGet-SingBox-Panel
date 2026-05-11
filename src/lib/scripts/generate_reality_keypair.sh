if ! command -v sing-box >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "NGP_ERROR=missing_curl"
    exit 1
  fi
  ngp_root_sh 'curl -fsSL https://sing-box.app/install.sh | sh'
fi

keypair="$(sing-box generate reality-keypair)"
private_key="$(printf '%s\n' "$keypair" | awk -F': *' '/PrivateKey/ {print $2; exit}')"
public_key="$(printf '%s\n' "$keypair" | awk -F': *' '/PublicKey/ {print $2; exit}')"

if [ -z "$private_key" ] || [ -z "$public_key" ]; then
  echo "NGP_ERROR=keypair_parse_failed"
  exit 1
fi

printf 'NGP_REALITY_PRIVATE_KEY=%s\n' "$private_key"
printf 'NGP_REALITY_PUBLIC_KEY=%s\n' "$public_key"
