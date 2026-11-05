import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { wrapExecuteCommand, validateExecuteRecord, collectSensitiveValues, redactExecutionOutput } from "../src/lib/execution.js";
import { runExecuteTask, deployXrayState, controlXrayService, deployNodeState, controlSingboxService, upgradeSingbox } from "../src/lib/nodeget.js";
import { XRAY_RELEASE } from "../src/lib/xray.js";
import { mockExecuteClient } from "./execute-fixture.mjs";

const options = { pollIntervalMs: 0, timeoutMs: 100 };
const run = (client) => runExecuteTask(client, "test", "test", "true", [], options);
assert.equal((await run(mockExecuteClient("ok"))).output, "ok");
for (const client of [
  mockExecuteClient("NGP_ERROR=xray_config_rejected\n[Process exited with code 1]"),
  mockExecuteClient("[Process exited with code 1]"),
  mockExecuteClient("failed", { code: 23 }),
  mockExecuteClient("ok", { success: false, errorMessage: "task failed" }),
  mockExecuteClient("ok", { structuredExitCode: 1 }),
  mockExecuteClient("ok", { errorMessage: "contradictory transport error" }),
  mockExecuteClient("ok", { transform: () => "ok\n[Process exited with code 0]" }),
  mockExecuteClient("ok", { transform: (output) => output.replace(/NGP_EXEC_[a-f0-9]{32}/g, `NGP_EXEC_${"0".repeat(32)}`) }),
  mockExecuteClient("ok", { transform: (output) => output + "\nunexpected tail" }),
  mockExecuteClient("ok", { transform: (output) => output + "\n" + output }),
  mockExecuteClient("[... Output truncated, 100 bytes omitted ...]"),
  mockExecuteClient("ok", { transform: (output) => output.slice(0, output.indexOf("_END=")) }),
]) await assert.rejects(run(client));

// Real child shells verify exit codes, argument boundaries, and independent EXIT cleanup.
for (const [body, code, expected] of [
  ["trap 'echo child_cleanup' EXIT\nprintf child_output; exit 7", 7, "child_cleanup"],
  ["trap 'echo child_cleanup' EXIT\nprintf child_output; exit 0", 0, "child_cleanup"],
  ["set -e\ntrap 'echo rolled_back' EXIT\nfalse\necho must_not_run", 1, "rolled_back"],
]) {
  const wrapped = wrapExecuteCommand("sh", ["-c", body]);
  const result = spawnSync(wrapped.cmd, wrapped.args, { encoding: "utf8" });
  assert.equal(result.status, code);
  assert.ok(result.stdout.includes(expected));
  assert.ok(result.stdout.indexOf(expected) < result.stdout.indexOf(`NGP_EXEC_${wrapped.id}_END=`));
  assert.ok(!result.stdout.includes("must_not_run"));
  const record = { success: true, task_event_result: { execute: result.stdout } };
  if (code) assert.throws(() => validateExecuteRecord(record, wrapped.id), /退出码/);
  else assert.ok(validateExecuteRecord(record, wrapped.id).output.includes(expected));
}
const quoted = wrapExecuteCommand("printf", ["%s", "single ' quote; $(must-not-execute)\nsecond line"]);
const quotedRun = spawnSync(quoted.cmd, quoted.args, { encoding: "utf8" });
assert.equal(quotedRun.status, 0);
assert.equal(validateExecuteRecord({ success: true, task_event_result: { execute: quotedRun.stdout } }, quoted.id).output,
  "single ' quote; $(must-not-execute)\nsecond line");

const digest = "a".repeat(64);
const metaDigest = "b".repeat(64);
const outputFor = (operation, overrides = {}, missing = []) => {
  const values = {
    SERVICE_ACTIVE: "active", SERVICE_ENABLED: "enabled", SERVICE_MANAGER: "systemd",
    CONFIG_SHA256: digest, META_SHA256: metaDigest, XRAY_VERSION: XRAY_RELEASE.slice(1),
    CONFIG_FILE: "/etc/nodeget-singbox-panel/xray/config.json", META_FILE: "/etc/nodeget-singbox-panel/xray/nodeget.json",
    XRAY_EXPECTED_CONFIG_SHA256: digest, XRAY_EXPECTED_META_SHA256: metaDigest,
    XRAY_PREVIOUS_SERVICE_ACTIVE: "active", XRAY_PREVIOUS_SERVICE_ENABLED: "enabled", XRAY_VERSION_OLD: XRAY_RELEASE.slice(1),
    XRAY_OPERATION: operation, XRAY_OPERATION_COMPLETE: "1", ...overrides,
  };
  return Object.entries(values).filter(([key]) => !missing.includes(key)).map(([key, value]) => `NGP_${key}=${value}`).join("\n");
};
const payload = { config: { inbounds: [] }, meta: { version: 2, inbounds: [] }, configSha256: "absent", metaSha256: "absent" };
const deploy = (body, executionOptions) => deployXrayState(mockExecuteClient(body, executionOptions), "test", "test", payload, options);
assert.equal((await deploy(outputFor("deploy"))).configSha256, digest);
for (const body of [
  "", outputFor("deploy", {}, ["SERVICE_ACTIVE"]), outputFor("deploy", {}, ["META_SHA256"]),
  outputFor("deploy", {}, ["XRAY_OPERATION_COMPLETE"]), outputFor("deploy", { XRAY_VERSION: "0.0.0" }),
  outputFor("deploy", { SERVICE_ACTIVE: "inactive" }), outputFor("deploy", { SERVICE_ENABLED: "disabled" }),
  outputFor("deploy", { CONFIG_SHA256: "invalid" }), outputFor("deploy", { META_SHA256: digest }),
  outputFor("control-stop"), `${outputFor("deploy")}\nNGP_SERVICE_ACTIVE=active`,
]) {
  let applied = false;
  await assert.rejects(async () => { await deploy(body); applied = true; });
  assert.equal(applied, false);
}
await assert.rejects(deploy(outputFor("deploy"), { code: 1 }));
await assert.rejects(deploy(`${outputFor("deploy")}\nNGP_ERROR=xray_rollback_failed`));
const stoppedUpgrade = outputFor("upgrade", { SERVICE_ACTIVE: "inactive", XRAY_PREVIOUS_SERVICE_ACTIVE: "inactive", SERVICE_ENABLED: "disabled", XRAY_PREVIOUS_SERVICE_ENABLED: "disabled" });
assert.equal((await deployXrayState(mockExecuteClient(stoppedUpgrade), "test", "test", { ...payload, upgrade: true }, options)).serviceActive, "inactive");
await assert.rejects(deployXrayState(mockExecuteClient(outputFor("upgrade", { SERVICE_ACTIVE: "inactive" })), "test", "test", { ...payload, upgrade: true }, options));
for (const action of ["start", "restart", "stop"]) {
  const body = outputFor(`control-${action}`, { SERVICE_ACTIVE: action === "stop" ? "inactive" : "active" });
  assert.equal((await controlXrayService(mockExecuteClient(body), "test", "test", action, options)).serviceActive, action === "stop" ? "inactive" : "active");
  await assert.rejects(controlXrayService(mockExecuteClient(outputFor(`control-${action}`, { SERVICE_ACTIVE: action === "stop" ? "active" : "inactive" })), "test", "test", action, options));
}

const fixtureSecret = "local-fixture-confidential-value";
const fixtureKey = "private" + "Key";
const secrets = collectSensitiveValues({ form: { [fixtureKey]: fixtureSecret } });
assert.equal(secrets.includes(fixtureSecret), true);
const failureOutput = `Failed to get format of /etc/nodeget-singbox-panel/xray/config.stage\ninvalid ${fixtureKey}: ${fixtureSecret}\nNGP_ERROR=xray_config_rejected`;
await assert.rejects(deployXrayState(mockExecuteClient(failureOutput), "test", "test", { ...payload, meta: { form: { [fixtureKey]: fixtureSecret } } }, options), (error) => {
  assert.ok(error.message.includes("Failed to get format"));
  assert.ok(error.message.includes("xray_config_rejected"));
  assert.ok(!error.message.includes(fixtureSecret));
  return true;
});
for (const text of [
  `NGP_XRAY_CONFIG_BEGIN\n${JSON.stringify({ [fixtureKey]: fixtureSecret })}\nNGP_XRAY_CONFIG_END`,
  `NGP_META_BEGIN\n${JSON.stringify({ [fixtureKey]: fixtureSecret })}`,
  failureOutput,
]) assert.ok(!redactExecutionOutput(text, secrets).includes(fixtureSecret));

await assert.rejects(deployNodeState(mockExecuteClient(""), "test", "test", payload, options));
await assert.rejects(controlSingboxService(mockExecuteClient(""), "test", "test", "stop", options));
await assert.rejects(upgradeSingbox(mockExecuteClient(""), "test", "test", {}, options));
console.log("verified execution receipts, process failures, operation postconditions and diagnostic redaction");
