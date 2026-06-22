import { resolveWsOrigin } from "./context";
import { WebSocketRPCClient } from "./wsRpcClient";
import {
  buildControlScript,
  buildDeployScript,
  buildGenerateRealityKeypairScript,
  buildPortJumpApplyScript,
  buildPortJumpRemoveScript,
  buildReadStateScript,
  buildRealityScanScript,
  buildUninstallScript,
} from "./scripts";
import {
  parseControlOutput,
  parseDeployOutput,
  parseReadStateOutput,
  parseRpcKeypair,
} from "./state";

export function createNodegetClient() {
  return new WebSocketRPCClient(resolveWsOrigin());
}

export async function listNodeUuids(client, token) {
  const result = await client.rpc("nodeget-server_list_all_agent_uuid", { token });
  return Array.isArray(result?.uuids) ? result.uuids : [];
}

export async function listNodeNames(client, token, uuids) {
  if (!uuids.length) return {};
  const rows = await client.rpc("kv_get_multi_value", {
    token,
    namespace_key: uuids.map((uuid) => ({ namespace: uuid, key: "metadata_name" })),
  });
  const map = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.namespace && row?.key === "metadata_name" && row.value) {
      map[row.namespace] = String(row.value);
    }
  }
  return map;
}

function stripTruncation(output) {
  return String(output || "")
    .split("\n")
    .filter((line) => !line.includes("Output truncated"))
    .join("\n")
    .trim();
}

class AbortError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortError";
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new AbortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    signal?.addEventListener?.("abort", onAbort);
  });
}

export async function runExecuteTask(
  client,
  token,
  targetUuid,
  command,
  args = [],
  { timeoutMs = 240000, pollIntervalMs = 1200, signal } = {},
) {
  if (signal?.aborted) throw new AbortError();

  const created = await client.rpc(
    "task_create_task",
    {
      token,
      target_uuid: targetUuid,
      task_type: { execute: { cmd: command, args } },
    },
    15000,
  );
  const taskId = created?.id;
  if (taskId == null) throw new Error("task_create_task: missing id");

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs, signal);
    const rows = await client.rpc(
      "task_query",
      {
        token,
        task_data_query: { condition: [{ task_id: taskId }, { type: "execute" }] },
      },
      15000,
    );
    const record = Array.isArray(rows) ? rows[0] : null;
    if (!record) continue;
    if (record.success === true) {
      return {
        taskId,
        record,
        output: stripTruncation(record.task_event_result?.execute),
      };
    }
    if (record.success === false) {
      throw new Error(record.error_message || `execute failed: ${command}`);
    }
  }
  throw new Error(`execute timeout: ${command}`);
}

async function runShell(client, token, uuid, script, options = {}) {
  return runExecuteTask(client, token, uuid, "sh", ["-c", script], options);
}

export async function readNodeState(client, token, uuid, options = {}) {
  const result = await runShell(client, token, uuid, buildReadStateScript(), {
    timeoutMs: 60000,
    ...options,
  });
  return { ...parseReadStateOutput(result.output), rawOutput: result.output };
}

export async function deployNodeState(client, token, uuid, payload, options = {}) {
  const result = await runShell(client, token, uuid, buildDeployScript(payload), {
    timeoutMs: 360000,
    ...options,
  });
  return { ...parseDeployOutput(result.output), rawOutput: result.output };
}

export async function controlSingboxService(client, token, uuid, action, options = {}) {
  const result = await runShell(client, token, uuid, buildControlScript(action), {
    timeoutMs: 120000,
    ...options,
  });
  return { ...parseControlOutput(result.output), rawOutput: result.output };
}

export async function uninstallSingbox(client, token, uuid, options = {}) {
  const result = await runShell(client, token, uuid, buildUninstallScript(), {
    timeoutMs: 120000,
    ...options,
  });
  return { rawOutput: result.output };
}

export async function generateRealityKeypair(client, token, uuid, options = {}) {
  const result = await runShell(client, token, uuid, buildGenerateRealityKeypairScript(), {
    timeoutMs: 60000,
    ...options,
  });
  return { ...parseRpcKeypair(result.output), rawOutput: result.output };
}

export async function runRealityScan(client, token, uuid, params, options = {}) {
  const script = buildRealityScanScript(params);
  const timeoutBase = Math.max(180000, Number(params?.duration || 60) * 1000 + 180000);
  const result = await runShell(client, token, uuid, script, {
    timeoutMs: options.timeoutMs ?? timeoutBase,
    ...options,
  });
  return { rawOutput: result.output };
}

export async function applyPortJump(client, token, uuid, payload, options = {}) {
  const result = await runShell(client, token, uuid, buildPortJumpApplyScript(payload), {
    timeoutMs: 60000,
    ...options,
  });
  return { rawOutput: result.output };
}

export async function removePortJumpUnits(client, token, uuid, serviceNames, options = {}) {
  if (!serviceNames.length) return { rawOutput: "" };
  const result = await runShell(
    client,
    token,
    uuid,
    buildPortJumpRemoveScript(serviceNames),
    { timeoutMs: 60000, ...options },
  );
  return { rawOutput: result.output };
}
