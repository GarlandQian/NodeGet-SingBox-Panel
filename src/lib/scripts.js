import preludeScript from "./scripts/_prelude.sh?raw";
import readStateScript from "./scripts/read_state.sh?raw";
import deployScript from "./scripts/deploy.sh?raw";
import controlScript from "./scripts/control.sh?raw";
import uninstallScript from "./scripts/uninstall.sh?raw";
import generateRealityKeypairScript from "./scripts/generate_reality_keypair.sh?raw";
import realityScanScript from "./scripts/reality_scan.sh?raw";
import portjumpApplyScript from "./scripts/portjump_apply.sh?raw";
import portjumpRemoveScript from "./scripts/portjump_remove.sh?raw";

function shellQuote(value) {
  return `'${String(value ?? "").replaceAll("'", `'\\''`)}'`;
}

export function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export function jsonToBase64(value) {
  return utf8ToBase64(JSON.stringify(value));
}

function envExports(env) {
  return Object.entries(env || {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
}

function assemble(env, body) {
  const header = envExports(env);
  return `${preludeScript}\n${header ? header + "\n" : ""}${body}`;
}

export function buildReadStateScript() {
  return assemble({}, readStateScript);
}

export function buildDeployScript({ config, meta }) {
  return assemble(
    {
      NGP_CONFIG_B64: jsonToBase64(config),
      NGP_META_B64: jsonToBase64(meta),
    },
    deployScript,
  );
}

export function buildControlScript(action) {
  return assemble({ NGP_ACTION: action }, controlScript);
}

export function buildUninstallScript() {
  return assemble({}, uninstallScript);
}

export function buildGenerateRealityKeypairScript() {
  return assemble({}, generateRealityKeypairScript);
}

export function buildRealityScanScript({
  targets,
  port = 443,
  threads = 8,
  timeout = 5,
  duration = 60,
  maxResults = 30,
  maxCheckDomains = 30,
}) {
  return assemble(
    {
      NGP_REALITY_TARGETS_B64: utf8ToBase64(targets || ""),
      NGP_REALITY_PORT: clampInt(port, 443, 1, 65535),
      NGP_REALITY_THREADS: clampInt(threads, 8, 1, 256),
      NGP_REALITY_TIMEOUT: clampInt(timeout, 5, 1, 60),
      NGP_REALITY_DURATION: clampInt(duration, 60, 5, 1800),
      NGP_REALITY_MAX_RESULTS: clampInt(maxResults, 30, 1, 200),
      NGP_REALITY_MAX_CHECK: clampInt(maxCheckDomains, 30, 1, 100),
    },
    realityScanScript,
  );
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return String(Math.min(Math.max(parsed, min), max));
}

export function buildPortJumpApplyScript({ serviceName, targetPort, multiportSpec }) {
  return assemble(
    {
      NGP_PORTJUMP_SERVICE: serviceName,
      NGP_PORTJUMP_TARGET: String(targetPort),
      NGP_PORTJUMP_RANGE: multiportSpec,
    },
    portjumpApplyScript,
  );
}

export function buildPortJumpRemoveScript(serviceNames) {
  return assemble(
    { NGP_PORTJUMP_SERVICES: serviceNames.join(" ") },
    portjumpRemoveScript,
  );
}
