import { resolveWsOrigin } from "./context";
import { WebSocketRPCClient } from "./wsRpcClient";
import {
  buildControlScript,
  buildDeployScript,
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

async function runAgentTask(
  client,
  token,
  targetUuid,
  taskType,
  resultType,
  { timeoutMs = 240000, pollIntervalMs = 1200, signal, errorLabel = resultType } = {},
) {
  if (signal?.aborted) throw new AbortError();

  const created = await client.rpc(
    "task_create_task",
    {
      token,
      target_uuid: targetUuid,
      task_type: taskType,
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
        task_data_query: { condition: [{ task_id: taskId }, { type: resultType }] },
      },
      15000,
    );
    const record = Array.isArray(rows) ? rows[0] : null;
    if (!record) continue;
    if (record.success === true) {
      return { taskId, record };
    }
    if (record.success === false) {
      throw new Error(record.error_message || `${resultType} failed: ${errorLabel}`);
    }
  }
  throw new Error(`${resultType} timeout: ${errorLabel}`);
}

export async function runExecuteTask(
  client,
  token,
  targetUuid,
  command,
  args = [],
  options = {},
) {
  const result = await runAgentTask(
    client,
    token,
    targetUuid,
    { execute: { cmd: command, args } },
    "execute",
    { ...options, errorLabel: command },
  );
  return {
    ...result,
    output: String(result.record.task_event_result?.execute || "").trim(),
  };
}

export async function readNodeIpAddresses(client, token, uuid, options = {}) {
  const result = await runAgentTask(client, token, uuid, "ip", "ip", {
    timeoutMs: 30000,
    ...options,
    errorLabel: "node IP",
  });
  const addresses = result.record.task_event_result?.ip;
  const normalize = (value) => (typeof value === "string" ? value.trim() : "");
  return {
    ipv4: normalize(Array.isArray(addresses) ? addresses[0] : ""),
    ipv6: normalize(Array.isArray(addresses) ? addresses[1] : ""),
  };
}

async function runShell(client, token, uuid, script, options = {}) {
  return runExecuteTask(client, token, uuid, "sh", ["-c", script], options);
}

export async function readNodeState(client, token, uuid, options = {}) {
  const result = await runShell(client, token, uuid, buildReadStateScript(), {
    timeoutMs: 60000,
    ...options,
  });
  const state = parseReadStateOutput(result.output);
  if (state.outputTruncated) {
    throw new Error("节点状态输出被 NodeGet 截断，已停止操作以避免覆盖现有配置");
  }
  if (state.configParseError) {
    throw new Error("节点 sing-box 配置读回不完整或 JSON 无效，已停止操作");
  }
  if (state.metaParseError) {
    throw new Error("NodeGet sing-box 元数据读回不完整或 JSON 无效，已停止操作");
  }
  return { ...state, rawOutput: result.output };
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
