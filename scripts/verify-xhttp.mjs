import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { emptyInboundForm, buildSingBoxInbound } from "../src/lib/inbound.js";
import { getEntryEngine } from "../src/lib/protocols.js";
import { generateLocalRealityKeypair } from "../src/lib/realityKeypair.js";
import { buildShareUri } from "../src/lib/singbox.js";
import { buildClashYamlExport, buildSingboxOutboundsExport } from "../src/lib/exporters.js";
import { buildXrayConfig, buildXrayInbound, XHTTP_PROTOCOL, validateXhttpShareUri } from "../src/lib/xray.js";
import { buildXrayDeployScript, buildXrayControlScript, buildReadStateScript, buildUninstallScript } from "../src/lib/scripts.js";
import { makeMeta, parseReadStateOutput, parseXrayOutput, redactStateOutput } from "../src/lib/state.js";
import { parseNextHopUri } from "../src/lib/nextHop.js";
import { buildEngineDeployment, assertPortAvailable } from "../src/lib/deployment.js";
import { readNodeState } from "../src/lib/nodeget.js";

const form = {
  ...emptyInboundForm(), ...generateLocalRealityKeypair(),
  endpointHost: "2001:db8::8", endpointPort: 23456,
  uuid: "8099ce00-9d8f-4c7b-bf21-4f7c050082a3", shortId: "714aa95fa4fa765a", path: "/nodeget-test",
};
const entry = { id: "xhttp-test", protocolId: XHTTP_PROTOCOL, tag: `nodeget-${XHTTP_PROTOCOL}-${form.endpointPort}`, form };
assert.equal(getEntryEngine(entry), "xray");
assert.equal(getEntryEngine({ protocolId: "vless-reality" }), "singbox");
assert.throws(() => getEntryEngine({ ...entry, engine: "singbox" }), /不匹配/);
assert.throws(() => buildSingBoxInbound(XHTTP_PROTOCOL, form), /不能写入/);
const inbound = buildXrayInbound(XHTTP_PROTOCOL, form);
assert.equal(inbound.listen, "::");
assert.equal(inbound.port, 23456);
assert.equal(inbound.settings.clients[0].flow, undefined);
assert.equal(inbound.settings.decryption, "none");
assert.deepEqual(inbound.streamSettings.xhttpSettings, { path: form.path, mode: "stream-one", host: form.transportHost });
assert.equal(inbound.streamSettings.realitySettings.target, "www.amd.com:443");
assert.throws(() => buildXrayInbound(XHTTP_PROTOCOL, { ...form, nextHopEnabled: true }), /不支持下一跳/);
assert.throws(() => buildXrayInbound(XHTTP_PROTOCOL, { ...form, shortId: "123" }), /Short ID/);
assert.throws(() => buildXrayInbound(XHTTP_PROTOCOL, { ...form, privateKey: "invalid" }), /私钥/);
assert.throws(() => buildXrayInbound(XHTTP_PROTOCOL, { ...form, endpointPort: 23.5 }), /整数/);
const uri = buildShareUri(XHTTP_PROTOCOL, form, "test");
assert.doesNotThrow(() => validateXhttpShareUri(uri));
const url = new URL(uri);
assert.equal(url.searchParams.get("mode"), "stream-one");
assert.equal(url.searchParams.get("alpn"), "h2");
assert.equal(url.searchParams.get("support-x25519mlkem768"), "true");
assert.equal(url.searchParams.has("flow"), false);
assert.ok(uri.includes("@[2001:db8::8]:23456"));
assert.throws(() => parseNextHopUri(uri));
assert.throws(() => validateXhttpShareUri(uri.replace("stream-one", "auto")));
assert.throws(() => buildSingboxOutboundsExport([entry], "test"), /不支持 XHTTP/);
const yaml = buildClashYamlExport([entry], "test");
assert.match(yaml, /network: xhttp/);
assert.match(yaml, /mode: stream-one/);
assert.match(yaml, /- h2/);
assert.match(yaml, /support-x25519mlkem768: true/);
assert.doesNotMatch(yaml, /flow:/);

const config = buildXrayConfig([entry]);
assert.equal(config.outbounds[0].streamSettings.sockopt.domainStrategy, "UseIPv4v6");
const foreign = { tag: "foreign", protocol: "socks", port: 6789 };
const existing = {
  ...config, inbounds: [...config.inbounds, foreign],
  api: { tag: "api" },
  routing: { domainStrategy: "AsIs", rules: [...config.routing.rules, { type: "field", domain: ["full:example.com"], outboundTag: "foreign-out" }] },
  outbounds: [...config.outbounds, { tag: "foreign-out", protocol: "blackhole" }],
};
const untouched = JSON.stringify(existing);
const removed = buildXrayConfig([], existing, [entry]);
assert.deepEqual(removed.inbounds, [foreign]);
assert.deepEqual(removed.api, existing.api);
assert.equal(removed.routing.rules.length, 1);
assert.ok(removed.outbounds.some((outbound) => outbound.tag === "foreign-out"));
assert.equal(JSON.stringify(existing), untouched);
const editedTag = `nodeget-${XHTTP_PROTOCOL}-23457`;
const edited = buildXrayConfig([{ ...entry, tag: editedTag, form: { ...form, endpointPort: 23457 } }], existing, [entry]);
assert.equal(edited.inbounds.length, 2);
assert.equal(edited.inbounds[1].port, 23457);
assert.equal(edited.routing.rules[0].inboundTag[0], editedTag);

const stateOutput = [
  "NGP_XRAY_VERSION=26.10.21", "NGP_XRAY_SERVICE_ACTIVE=active", "NGP_XRAY_SERVICE_ENABLED=enabled",
  `NGP_XRAY_CONFIG_SHA256=${"a".repeat(64)}`, `NGP_XRAY_META_SHA256=${"b".repeat(64)}`,
  "NGP_XRAY_CONFIG_BEGIN", JSON.stringify(existing), "NGP_XRAY_CONFIG_END",
  "NGP_XRAY_META_BEGIN", JSON.stringify(makeMeta([entry])), "NGP_XRAY_META_END",
].join("\n");
const state = parseReadStateOutput(stateOutput);
assert.equal(state.xray.meta.inbounds[0].engine, "xray");
assert.deepEqual(state.xray.foreignInbounds, [foreign]);
assert.equal(state.xray.serviceActive, "active");
assert.ok(!redactStateOutput(stateOutput).includes(form.privateKey));
assert.ok(!redactStateOutput(`${stateOutput}\nNGP_XRAY_CONFIG_CHECK_BEGIN\ninvalid privateKey: ${form.privateKey}\nNGP_XRAY_CONFIG_CHECK_END`).includes(form.privateKey));
assert.equal(state.meta.inbounds.length, 0);
assert.equal(parseReadStateOutput(stateOutput.replace(JSON.stringify(existing), "[]")).xray.configParseError, true);
assert.equal(parseReadStateOutput(stateOutput.replace(JSON.stringify(makeMeta([entry])), "{}")).xray.metaParseError, true);
assert.throws(() => parseReadStateOutput(stateOutput.replace('"engine":"xray"', '"engine":"singbox"')), /不匹配/);
assert.deepEqual(parseXrayOutput("NGP_XRAY_VERSION=26.10.21\nNGP_SERVICE_ACTIVE=active").version, "26.10.21");
assert.doesNotMatch(buildUninstallScript().split("ngp_root rm -f /etc/nodeget-singbox-panel")[1] || "", /rm -rf \/etc\/nodeget-singbox-panel/);

for (const script of [
  buildXrayDeployScript({ config, meta: makeMeta([entry]), configSha256: "absent", metaSha256: "absent" }),
  buildXrayDeployScript({ upgrade: true, configSha256: "a".repeat(64), metaSha256: "b".repeat(64) }),
  buildXrayControlScript("restart"), buildReadStateScript(),
]) {
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
}
assert.throws(() => buildXrayDeployScript({ config, meta: makeMeta([entry]) }), /先读取/);
assert.throws(() => buildXrayControlScript("invalid"));
const fakeStateClient = (success, output) => ({
  async rpc(method) {
    if (method === "task_create_task") return { id: 1 };
    return [{ success, error_message: success ? "" : "exit status 1", task_event_result: { execute: output } }];
  },
});
await assert.rejects(readNodeState(fakeStateClient(true, stateOutput), "test", "test", { pollIntervalMs: 0, timeoutMs: 100 }), /状态读回不完整/);
const readBack = await readNodeState(fakeStateClient(true, `${stateOutput}\nNGP_XRAY_STATE_COMPLETE=1`), "test", "test", { pollIntervalMs: 0, timeoutMs: 100 });
assert.equal(readBack.xray.meta.inbounds[0].form.privateKey, form.privateKey);
await assert.rejects(readNodeState(fakeStateClient(false, `${stateOutput}\nNGP_ERROR=xray_operation_locked`), "test", "test", { pollIntervalMs: 0, timeoutMs: 100 }), (error) => {
  assert.ok(!error.message.includes(form.privateKey));
  assert.ok(error.message.includes("xray_operation_locked"));
  return true;
});

const singboxEntry = { id: "singbox-test", protocolId: "socks", tag: "nodeget-socks-1088", form: { ...emptyInboundForm(), endpointPort: 1088 } };
const singboxForeign = { type: "mixed", tag: "foreign-singbox", listen_port: 9999 };
const mixedState = { ...state,
  config: { inbounds: [singboxForeign], outbounds: [{ type: "direct", tag: "user-direct" }], route: { final: "user-direct" } },
  meta: makeMeta([singboxEntry]), foreignInbounds: [singboxForeign],
};
const mixedBefore = JSON.stringify(mixedState);
const singboxPayload = buildEngineDeployment("singbox", [singboxEntry, entry], mixedState);
assert.deepEqual(singboxPayload.meta.inbounds.map((row) => row.id), [singboxEntry.id]);
assert.deepEqual(singboxPayload.config.inbounds.map((row) => row.tag), [singboxForeign.tag, singboxEntry.tag]);
assert.deepEqual(singboxPayload.config.outbounds, mixedState.config.outbounds);
assert.equal(singboxPayload.config.route.final, "user-direct");
const xrayPayload = buildEngineDeployment("xray", [singboxEntry, entry], mixedState);
assert.deepEqual(xrayPayload.meta.inbounds.map((row) => row.id), [entry.id]);
assert.equal(xrayPayload.config.inbounds.length, 2);
assert.equal(xrayPayload.configSha256, "a".repeat(64));
assert.equal(buildEngineDeployment("singbox", [entry], mixedState).meta.inbounds.length, 0);
assert.equal(buildEngineDeployment("xray", [singboxEntry], mixedState).meta.inbounds.length, 0);
assert.equal(JSON.stringify(mixedState), mixedBefore);
assert.throws(() => assertPortAvailable({ entries: [singboxEntry, entry], port: form.endpointPort }), /已被入站/);
assert.doesNotThrow(() => assertPortAvailable({ entries: [entry], port: form.endpointPort, ignoreId: entry.id }));
assert.throws(() => assertPortAvailable({ entries: [], foreign: [{ port: "10000-10010,20000" }], port: 10005 }), /非面板/);
assert.throws(() => assertPortAvailable({ entries: [], foreign: [{ listen_port: 20000 }], port: 20000 }), /非面板/);

// Exercise the real transaction body in isolated temp paths with fake services/binaries.
const taskDir = mkdtempSync(join(tmpdir(), "nodeget-xhttp-verify-"));
const sha = (file) => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "absent";
const fakeBinary = (version) => `#!/bin/sh\nif [ "$1" = version ]; then echo 'Xray ${version}'; exit; fi\nif grep -q 'reject-test-config' "$4"; then exit 1; fi\nexit 0\n`;
try {
  const root = join(taskDir, "config");
  const bin = join(taskDir, "bin", "xray");
  const cfg = join(root, "config.json");
  const meta = join(root, "nodeget.json");
  const active = join(taskDir, "active");
  const failRestart = join(taskDir, "fail-restart");
  const newBin = join(taskDir, "new-xray");
  const unitFile = join(taskDir, "nodeget-xray.service");
  const initFile = join(taskDir, "nodeget-xray.init");
  writeFileSync(newBin, fakeBinary("26.10.21"), { mode: 0o700 });
  const helpers = `
ngp_root() { "$@"; }
ngp_error() { echo "NGP_ERROR=$1"; exit 1; }
ngp_require_command() { :; }
sha256sum() { shasum -a 256 "$@"; }
ngp_base64_decode() { base64 -d; }
ngp_service_active() { if [ -f '${active}' ]; then echo active; else echo inactive; fi; }
ngp_service_enabled() { echo enabled; }
ngp_service_manager() { echo systemd; }
ngp_service_reload() { :; }
systemctl() { [ "$1" = cat ] && [ -f '${unitFile}' ] && cat '${unitFile}'; }
ngp_service_enable() { :; }
ngp_service_disable() { :; }
ngp_service_stop() { rm -f '${active}'; }
ngp_service_restart() {
  if [ -f '${failRestart}' ]; then rm -f '${failRestart}'; return 1; fi
  touch '${active}'
}
ngp_write_root_file() { mkdir -p "$(dirname "$2")"; cp "$1" "$2"; chmod "$3" "$2"; }
`;
  const run = (payload, downloadFailure = false, realManager = null) => {
    const script = buildXrayDeployScript({ config, meta: makeMeta([entry]), configSha256: sha(cfg), metaSha256: sha(meta), ...payload });
    const isolated = script.slice(script.indexOf("export NGP_XRAY_RELEASE="))
      .replaceAll("/etc/nodeget-singbox-panel/xray", root)
      .replaceAll("/etc/nodeget-singbox-panel", taskDir)
      .replaceAll("/usr/local/lib/nodeget-singbox-panel/xray", bin)
      .replaceAll("/usr/local/lib/nodeget-singbox-panel", join(taskDir, "bin"))
      .replaceAll("/etc/systemd/system/nodeget-xray.service", unitFile)
      .replaceAll("/etc/init.d/nodeget-xray", initFile)
      .replace("ngp_require_command sha256sum coreutils\nngp_xray_prepare", `
ngp_xray_download() { ${downloadFailure ? "ngp_error xray_release_checksum_mismatch" : `cp '${newBin}' "$xray_work/xray"`}; }
${realManager ? "" : "ngp_xray_ensure_service() { :; }"}
ngp_require_command sha256sum coreutils
ngp_xray_prepare`);
    const serviceHelpers = realManager ? helpers.replace("ngp_service_manager() { echo systemd; }", `ngp_service_manager() { echo ${realManager}; }`) : helpers;
    return spawnSync("sh", ["-c", `set -eu\n${serviceHelpers}\n${isolated}`], { encoding: "utf8" });
  };
  const initial = run({});
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  assert.deepEqual(JSON.parse(readFileSync(cfg, "utf8")), config);
  assert.ok(existsSync(bin));
  assert.equal(statSync(cfg).mode & 0o777, 0o600);
  assert.equal(statSync(meta).mode & 0o777, 0o600);
  assert.equal(existsSync(join(root, ".lock")), false);
  const before = [readFileSync(cfg, "utf8"), readFileSync(meta, "utf8"), readFileSync(bin, "utf8")];
  const stale = run({ configSha256: "0".repeat(64) });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout, /xray_config_changed_since_read/);
  mkdirSync(join(root, ".lock"));
  const locked = run({});
  assert.notEqual(locked.status, 0);
  assert.match(locked.stdout, /xray_operation_locked/);
  assert.ok(existsSync(join(root, ".lock")));
  rmSync(join(root, ".lock"), { recursive: true });
  const failedDownload = run({ upgrade: true }, true);
  assert.notEqual(failedDownload.status, 0);
  assert.match(failedDownload.stdout, /checksum_mismatch/);
  const invalid = run({ config: { ...config, test: "reject-test-config" } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /xray_config_rejected/);
  writeFileSync(failRestart, "1");
  const rollback = run({ config: { ...config, log: { loglevel: "info" } } });
  assert.notEqual(rollback.status, 0);
  assert.match(rollback.stdout, /xray_restart_failed_rolled_back/);
  assert.deepEqual([readFileSync(cfg, "utf8"), readFileSync(meta, "utf8"), readFileSync(bin, "utf8")], before);
  assert.ok(existsSync(active));
  assert.equal(existsSync(join(root, ".lock")), false);
  const victim = join(taskDir, "unrelated-file");
  writeFileSync(victim, "do-not-overwrite");
  rmSync(`${cfg}.bak`);
  symlinkSync(victim, `${cfg}.bak`);
  const symlinkedBackup = run({});
  assert.notEqual(symlinkedBackup.status, 0);
  assert.match(symlinkedBackup.stdout, /xray_symlink_refused/);
  assert.equal(readFileSync(victim, "utf8"), "do-not-overwrite");
  rmSync(`${cfg}.bak`);
  const updated = run({ upgrade: true });
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  writeFileSync(unitFile, "foreign-service");
  const foreignService = run({}, false, "systemd");
  assert.notEqual(foreignService.status, 0);
  assert.match(foreignService.stdout, /xray_service_not_owned/);
  assert.equal(readFileSync(unitFile, "utf8"), "foreign-service");
  rmSync(unitFile);
  symlinkSync(victim, unitFile);
  const symlinkService = run({}, false, "systemd");
  assert.notEqual(symlinkService.status, 0);
  assert.equal(readFileSync(victim, "utf8"), "do-not-overwrite");
  rmSync(unitFile);
  const systemdDeploy = run({}, false, "systemd");
  assert.equal(systemdDeploy.status, 0, systemdDeploy.stdout + systemdDeploy.stderr);
  assert.ok(readFileSync(unitFile, "utf8").includes(`ExecStart=${bin} run -config ${cfg}`));
  assert.ok(!readFileSync(unitFile, "utf8").includes("sing-box"));
  const openrcDeploy = run({}, false, "openrc");
  assert.equal(openrcDeploy.status, 0, openrcDeploy.stdout + openrcDeploy.stderr);
  const initSyntax = spawnSync("sh", ["-n", initFile], { encoding: "utf8" });
  assert.equal(initSyntax.status, 0, initSyntax.stderr);
  assert.equal(statSync(initFile).mode & 0o777, 0o755);
  assert.ok(readFileSync(initFile, "utf8").includes(`command="${bin}"`));
} finally {
  rmSync(taskDir, { recursive: true, force: true });
}
console.log("verified XHTTP config, sharing, engine isolation, revision checks and rollback");
