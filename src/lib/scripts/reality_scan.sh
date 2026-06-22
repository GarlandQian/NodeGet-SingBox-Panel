SCAN_PORT="${NGP_REALITY_PORT:-443}"
SCAN_THREADS="${NGP_REALITY_THREADS:-8}"
TLS_TIMEOUT="${NGP_REALITY_TIMEOUT:-5}"
SCAN_DURATION="${NGP_REALITY_DURATION:-60}"
MAX_RESULTS="${NGP_REALITY_MAX_RESULTS:-30}"
MAX_CHECK_DOMAINS="${NGP_REALITY_MAX_CHECK:-30}"
TARGETS_B64="${NGP_REALITY_TARGETS_B64:-}"

if [ -z "$TARGETS_B64" ]; then
  echo "NGP_REALITY_ERROR=missing_targets"
  exit 1
fi

if [ -n "${XDG_CACHE_HOME:-}" ]; then
  CACHE_BASE="$XDG_CACHE_HOME"
elif [ -n "${HOME:-}" ]; then
  CACHE_BASE="$HOME/.cache"
else
  CACHE_BASE="/tmp"
fi

TOOL_DIR="$CACHE_BASE/nodeget-singbox-panel/reality-tools"
WORK_DIR="$(mktemp -d)"
REALITL="$TOOL_DIR/RealiTLScanner"
CHECKER="$TOOL_DIR/reality-checker"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

require_command() {
  cmd="$1"
  pkg="${2:-$1}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    ngp_try_install_package "$pkg" || true
  fi
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "NGP_REALITY_ERROR=missing_$cmd"
    exit 1
  fi
}

download_file() {
  require_command curl curl
  curl -fL --retry 3 --connect-timeout 10 -o "$2.tmp" "$1"
  mv "$2.tmp" "$2"
}

extract_zip() {
  zip_file="$1"
  dest_dir="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$zip_file" -d "$dest_dir"
    return
  fi
  ngp_try_install_package unzip || true
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$zip_file" -d "$dest_dir"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$zip_file" "$dest_dir" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
PY
    return
  fi
  echo "NGP_REALITY_ERROR=missing_unzip_or_python3"
  exit 1
}

ensure_reali_tls_scanner() {
  if [ -x "$REALITL" ]; then
    return
  fi
  mkdir -p "$TOOL_DIR"
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)
      download_file "https://github.com/XTLS/RealiTLScanner/releases/latest/download/RealiTLScanner-linux-64" "$REALITL"
      chmod +x "$REALITL"
      ;;
    *)
      if command -v go >/dev/null 2>&1; then
        GOBIN="$TOOL_DIR" go install github.com/XTLS/RealiTLScanner@latest
        chmod +x "$REALITL"
      else
        echo "NGP_REALITY_ERROR=unsupported_reali_tls_scanner_arch_$arch"
        exit 1
      fi
      ;;
  esac
}

ensure_reality_checker() {
  if [ -x "$CHECKER" ]; then
    return
  fi
  mkdir -p "$TOOL_DIR"
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)
      asset="reality-checker-linux-amd64.zip"
      ;;
    aarch64|arm64)
      asset="reality-checker-linux-arm64.zip"
      ;;
    *)
      echo "NGP_REALITY_ERROR=unsupported_reality_checker_arch_$arch"
      exit 1
      ;;
  esac
  zip_path="$WORK_DIR/$asset"
  extract_dir="$WORK_DIR/reality-checker"
  mkdir -p "$extract_dir"
  download_file "https://github.com/V2RaySSR/RealityChecker/releases/latest/download/$asset" "$zip_path"
  extract_zip "$zip_path" "$extract_dir"
  found="$(find "$extract_dir" -type f -name 'reality-checker' | head -n 1)"
  if [ -z "$found" ]; then
    echo "NGP_REALITY_ERROR=reality_checker_binary_missing"
    exit 1
  fi
  cp "$found" "$CHECKER"
  chmod +x "$CHECKER"
}

require_command timeout coreutils
ensure_reali_tls_scanner
ensure_reality_checker

target_file="$WORK_DIR/targets.txt"
scan_csv="$WORK_DIR/reality-scan.csv"
display_csv="$WORK_DIR/reality-display.csv"
check_csv="$WORK_DIR/reality-check.csv"
scan_log="$WORK_DIR/reality-scan.log"
check_log="$WORK_DIR/reality-check.log"

printf '%s' "$TARGETS_B64" | base64 -d \
  | awk '{$1=$1}; NF && $0 !~ /^#/ {print}' > "$target_file"
if [ ! -s "$target_file" ]; then
  echo "NGP_REALITY_ERROR=empty_targets"
  exit 1
fi

printf 'NGP_REALITY_TOOL_DIR=%s\n' "$TOOL_DIR"
printf 'NGP_REALITY_TARGET_COUNT=%s\n' "$(wc -l < "$target_file" | tr -d ' ')"

scan_exit=0
timeout "$SCAN_DURATION"s "$REALITL" \
  -in "$target_file" \
  -port "$SCAN_PORT" \
  -thread "$SCAN_THREADS" \
  -timeout "$TLS_TIMEOUT" \
  -out "$scan_csv" > "$scan_log" 2>&1 || scan_exit=$?

if [ ! -f "$scan_csv" ]; then
  printf 'IP,ORIGIN,CERT_DOMAIN,CERT_ISSUER,GEO_CODE\n' > "$scan_csv"
fi

candidate_count="$(tail -n +2 "$scan_csv" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
awk -v max="$MAX_RESULTS" 'NR == 1 || NR <= max + 1 { print }' "$scan_csv" > "$display_csv"
awk -v max="$MAX_CHECK_DOMAINS" 'NR == 1 || NR <= max + 1 { print }' "$scan_csv" > "$check_csv"

printf 'NGP_REALITY_SCAN_EXIT=%s\n' "$scan_exit"
printf 'NGP_REALITY_SCAN_COUNT=%s\n' "$candidate_count"
printf 'NGP_REALITY_SCAN_PORT=%s\n' "$SCAN_PORT"

echo 'NGP_REALITY_SCAN_LOG_BEGIN'
tail -n 80 "$scan_log" || true
echo 'NGP_REALITY_SCAN_LOG_END'

echo 'NGP_REALITY_CSV_BEGIN'
cat "$display_csv"
echo 'NGP_REALITY_CSV_END'

if [ "$candidate_count" -eq 0 ]; then
  printf 'NGP_REALITY_CHECK_EXIT=%s\n' "skipped"
  echo 'NGP_REALITY_CHECK_BEGIN'
  echo 'no candidates'
  echo 'NGP_REALITY_CHECK_END'
  exit 0
fi

checker_exit=0
"$CHECKER" csv "$check_csv" > "$check_log" 2>&1 || checker_exit=$?
printf 'NGP_REALITY_CHECK_EXIT=%s\n' "$checker_exit"
printf 'NGP_REALITY_CHECKED_DOMAINS=%s\n' "$(tail -n +2 "$check_csv" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

echo 'NGP_REALITY_CHECK_BEGIN'
tail -n 180 "$check_log" || true
echo 'NGP_REALITY_CHECK_END'
