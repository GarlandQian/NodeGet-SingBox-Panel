CONFIG_FILE="/etc/sing-box/config.json"

current_bin="$(ngp_singbox_bin)" || ngp_error "missing_sing-box"
current_version="$("$current_bin" version 2>/dev/null | head -n 1 | awk '{print $NF}')"
ngp_require_command curl curl

migration_count="${NGP_MIGRATION_COUNT:-0}"
case "$migration_count" in
  ""|*[!0-9]*)
    ngp_error "invalid_migration_count"
    ;;
esac

work_dir="$(mktemp -d)"
target_stage=""
config_stage=""
binary_replace_started=0
config_replace_started=0
replace_complete=0
config_had_original=0
backup_bin="${current_bin}.nodeget-pre-upgrade.bak"
backup_config="${CONFIG_FILE}.nodeget-pre-upgrade.bak"
config_candidate=""

rollback_upgrade() {
  if [ "$replace_complete" -eq 1 ]; then
    return
  fi

  if [ "$config_replace_started" -eq 1 ]; then
    if [ "$config_had_original" -eq 1 ] && ngp_root test -f "$backup_config"; then
      rollback_config_stage="$(ngp_root mktemp "$(dirname "$CONFIG_FILE")/.sing-box.config.rollback.XXXXXX")"
      ngp_root cp -p "$backup_config" "$rollback_config_stage"
      ngp_root chmod 0600 "$rollback_config_stage"
      ngp_root mv -f "$rollback_config_stage" "$CONFIG_FILE"
    else
      ngp_root rm -f "$CONFIG_FILE"
    fi
    config_replace_started=0
  fi

  if [ "$binary_replace_started" -eq 1 ] && ngp_root test -f "$backup_bin"; then
    rollback_binary_stage="$(ngp_root mktemp "$(dirname "$current_bin")/.sing-box.rollback.XXXXXX")"
    ngp_root cp -p "$backup_bin" "$rollback_binary_stage"
    ngp_root chmod 0755 "$rollback_binary_stage"
    ngp_root mv -f "$rollback_binary_stage" "$current_bin"
    binary_replace_started=0
  fi
}

cleanup_upgrade() {
  rollback_upgrade >/dev/null 2>&1 || true
  if [ -n "$target_stage" ]; then
    ngp_root rm -f "$target_stage" >/dev/null 2>&1 || true
  fi
  if [ -n "$config_stage" ]; then
    ngp_root rm -f "$config_stage" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup_upgrade EXIT
trap 'exit 1' HUP INT TERM

if [ -n "${NGP_MIGRATED_CONFIG_B64:-}" ]; then
  config_candidate="$work_dir/config.json"
  printf '%s' "$NGP_MIGRATED_CONFIG_B64" | ngp_base64_decode > "$config_candidate" \
    || ngp_error "migrated_config_decode_failed"
  chmod 0600 "$config_candidate"
fi

expected_config_sha256="${NGP_EXPECTED_CONFIG_SHA256:-}"
if [ -n "$config_candidate" ] && [ -n "$expected_config_sha256" ]; then
  if ! printf '%s\n' "$expected_config_sha256" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    ngp_error "invalid_expected_config_sha256"
  fi
  ngp_require_command sha256sum coreutils
  if ! ngp_root test -f "$CONFIG_FILE"; then
    ngp_error "config_changed_since_read"
  fi
  current_config_sha256="$(ngp_root sha256sum "$CONFIG_FILE" | awk '{print $1}')"
  if [ "$current_config_sha256" != "$expected_config_sha256" ]; then
    ngp_error "config_changed_since_read"
  fi
fi

release_meta="$work_dir/release.json"
curl -fsSL --connect-timeout 8 --max-time 30 \
  -o "$release_meta" \
  https://api.github.com/repos/SagerNet/sing-box/releases/latest \
  || ngp_error "release_metadata_download_failed"

release_tag="$(sed -n 's/^[[:space:]]*"tag_name": "\([^"]*\)",$/\1/p' "$release_meta" | head -n 1)"
if ! printf '%s\n' "$release_tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  ngp_error "invalid_stable_release_tag"
fi
release_version="${release_tag#v}"

binary_update_needed=1
if [ "$current_version" = "$release_version" ]; then
  binary_update_needed=0
fi

if [ "$binary_update_needed" -eq 0 ] && [ -z "$config_candidate" ]; then
  printf 'NGP_UPGRADE_STATUS=%s\n' "up-to-date"
  printf 'NGP_SINGBOX_VERSION_OLD=%s\n' "$current_version"
  printf 'NGP_SINGBOX_VERSION_NEW=%s\n' "$release_version"
  printf 'NGP_RELEASE_TAG=%s\n' "$release_tag"
  printf 'NGP_MIGRATION_COUNT=%s\n' "0"
  printf 'NGP_SERVICE_ACTIVE=%s\n' "$(ngp_service_active sing-box | tail -n 1)"
  exit 0
fi

candidate_bin="$current_bin"
if [ "$binary_update_needed" -eq 1 ]; then
  ngp_require_command tar tar
  ngp_require_command sha256sum coreutils

  machine_arch="$(uname -m)"
  case "$machine_arch" in
    x86_64|amd64)
      release_arch="amd64"
      ;;
    aarch64|arm64)
      release_arch="arm64"
      ;;
    armv7l|armv7)
      release_arch="armv7"
      ;;
    i386|i486|i586|i686|x86)
      release_arch="386"
      ;;
    riscv64)
      release_arch="riscv64"
      ;;
    loongarch64|loong64)
      release_arch="loong64"
      ;;
    *)
      ngp_error "unsupported_arch_$machine_arch"
      ;;
  esac

  libc_suffix=""
  if [ -f /etc/alpine-release ] || \
    { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
    libc_suffix="-musl"
  fi

  archive_name="sing-box-${release_version}-linux-${release_arch}${libc_suffix}.tar.gz"
  expected_sha256="$(awk -v target="$archive_name" '
    index($0, "\"name\": \"" target "\"") { found = 1; next }
    found && /"digest": "sha256:/ {
      line = $0
      sub(/^.*"digest": "sha256:/, "", line)
      sub(/".*$/, "", line)
      print line
      exit
    }
  ' "$release_meta")"
  if ! printf '%s\n' "$expected_sha256" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    ngp_error "release_digest_missing_$archive_name"
  fi

  archive_path="$work_dir/$archive_name"
  archive_url="https://github.com/SagerNet/sing-box/releases/download/${release_tag}/${archive_name}"
  curl -fL --connect-timeout 8 --max-time 120 -o "$archive_path" "$archive_url" \
    || ngp_error "release_download_failed"
  actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    ngp_error "release_checksum_mismatch"
  fi

  tar -xzf "$archive_path" -C "$work_dir" || ngp_error "release_extract_failed"
  downloaded_bin="$(find "$work_dir" -type f -name sing-box | head -n 1)"
  if [ -z "$downloaded_bin" ] || [ ! -f "$downloaded_bin" ]; then
    ngp_error "release_binary_missing"
  fi
  chmod 0755 "$downloaded_bin"
  downloaded_version="$("$downloaded_bin" version 2>/dev/null | head -n 1 | awk '{print $NF}')"
  if [ "$downloaded_version" != "$release_version" ]; then
    ngp_error "release_version_mismatch"
  fi
  candidate_bin="$downloaded_bin"
fi

config_to_check="$CONFIG_FILE"
if [ -n "$config_candidate" ]; then
  config_to_check="$config_candidate"
fi
if ngp_root test -f "$config_to_check"; then
  check_log="$work_dir/config-check.log"
  if ! ngp_root "$candidate_bin" check -c "$config_to_check" >"$check_log" 2>&1; then
    echo 'NGP_UPGRADE_CHECK_BEGIN'
    cat "$check_log"
    echo 'NGP_UPGRADE_CHECK_END'
    ngp_error "new_version_rejected_migrated_config"
  fi
fi

was_active="$(ngp_service_active sing-box | tail -n 1)"
if [ "$binary_update_needed" -eq 1 ]; then
  ngp_root cp -p "$current_bin" "$backup_bin"
  ngp_root chmod 0755 "$backup_bin"
  target_stage="$(ngp_root mktemp "$(dirname "$current_bin")/.sing-box.nodeget.XXXXXX")"
  ngp_root cp "$candidate_bin" "$target_stage"
  ngp_root chmod 0755 "$target_stage"
  binary_replace_started=1
  if ! ngp_root mv -f "$target_stage" "$current_bin"; then
    ngp_error "binary_commit_failed_rolled_back"
  fi
  target_stage=""
fi

if [ -n "$config_candidate" ]; then
  if ngp_root test -f "$CONFIG_FILE"; then
    ngp_root cp -p "$CONFIG_FILE" "$backup_config"
    ngp_root chmod 0600 "$backup_config"
    config_had_original=1
  fi
  config_stage="$(ngp_root mktemp "$(dirname "$CONFIG_FILE")/.sing-box.config.XXXXXX")"
  ngp_root cp "$config_candidate" "$config_stage"
  ngp_root chmod 0600 "$config_stage"
  config_replace_started=1
  if ! ngp_root mv -f "$config_stage" "$CONFIG_FILE"; then
    ngp_error "config_commit_failed_rolled_back"
  fi
  config_stage=""
fi

if [ "$was_active" = "active" ]; then
  if ! ngp_service_restart sing-box; then
    rollback_upgrade
    ngp_service_restart sing-box >/dev/null 2>&1 || true
    ngp_error "service_restart_failed_upgrade_rolled_back"
  fi
  sleep 1
  if [ "$(ngp_service_active sing-box | tail -n 1)" != "active" ]; then
    rollback_upgrade
    ngp_service_restart sing-box >/dev/null 2>&1 || true
    ngp_error "service_unhealthy_upgrade_rolled_back"
  fi
fi

replace_complete=1
if [ "$binary_update_needed" -eq 1 ]; then
  printf 'NGP_UPGRADE_STATUS=%s\n' "upgraded"
else
  printf 'NGP_UPGRADE_STATUS=%s\n' "migrated"
fi
printf 'NGP_SINGBOX_VERSION_OLD=%s\n' "$current_version"
printf 'NGP_SINGBOX_VERSION_NEW=%s\n' "$release_version"
printf 'NGP_RELEASE_TAG=%s\n' "$release_tag"
printf 'NGP_MIGRATION_COUNT=%s\n' "$migration_count"
if [ "$binary_update_needed" -eq 1 ]; then
  printf 'NGP_BACKUP_BIN=%s\n' "$backup_bin"
fi
if [ -n "$config_candidate" ]; then
  printf 'NGP_BACKUP_CONFIG=%s\n' "$backup_config"
fi
if ngp_root test -f "$CONFIG_FILE" && command -v sha256sum >/dev/null 2>&1; then
  printf 'NGP_CONFIG_SHA256=%s\n' "$(ngp_root sha256sum "$CONFIG_FILE" | awk '{print $1}')"
fi
printf 'NGP_SERVICE_ACTIVE=%s\n' "$(ngp_service_active sing-box | tail -n 1)"
