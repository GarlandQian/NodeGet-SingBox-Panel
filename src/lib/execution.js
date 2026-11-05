const PROCESS_EXIT = /^\[Process exited with code (-?\d+)\]$/;
const TRUNCATED = /\[(?:\.\.\.\s*)?Output truncated[,\]]/i;

export function wrapExecuteCommand(command, args = [], id = crypto.randomUUID().replaceAll("-", "")) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("无效的执行回执标识");
  const begin = `NGP_EXEC_${id}_BEGIN`;
  const end = `NGP_EXEC_${id}_END`;
  // The child owns its EXIT trap. Its cleanup/rollback finishes before the parent emits a receipt.
  const script = `set +e\nprintf '\\n${begin}\\n'\n( "$@" ) 2>&1\nngp_exec_status=$?\nprintf '\\n${end}=%s\\n' "$ngp_exec_status"\nexit "$ngp_exec_status"`;
  return { id, cmd: "sh", args: ["-c", script, "nodeget-execute", command, ...args] };
}

export function collectSensitiveValues(value) {
  const values = new Set();
  const visit = (item, key = "") => {
    if (typeof item === "string") {
      if (item && /private.?key|public.?key|api.?key|authorization|passw[o]rd|secret|token|cookie|uuid|short.?id|nextHopUri/i.test(key)) values.add(item);
      if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(item)) values.add(item);
    } else if (Array.isArray(item)) {
      item.forEach((child) => visit(child, key));
    } else if (item && typeof item === "object") {
      Object.entries(item).forEach(([name, child]) => visit(child, name));
    }
  };
  visit(value);
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactExecutionOutput(output, sensitiveValues = []) {
  let text = String(output || "").replace(/NGP_(?:XRAY_)?(?:CONFIG|META)_BEGIN[\s\S]*?(?:NGP_(?:XRAY_)?(?:CONFIG|META)_END|$)/g, "[原始配置已隐藏]");
  for (const secret of sensitiveValues) {
    if (secret) text = text.split(secret).join("[凭据已隐藏]");
  }
  return text.split(/\r?\n/).filter((line) => !/^NGP_EXEC_[a-f0-9]{32}_/.test(line))
    .map((line) => {
      if (/private.?key|api.?key|authorization|passw[o]rd|secret|token|cookie|auth.?key|NGP_\w+_B64/i.test(line) || /^\s*["'{}\[\]]/.test(line)) {
        return "[敏感或原始数据行已隐藏]";
      }
      return line.replace(/\b[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\b/gi, "[UUID已隐藏]")
        .replace(/\b[A-Za-z0-9_-]{43,}\b/g, "[长凭据已隐藏]")
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, "[URI已隐藏]");
    }).filter(Boolean).slice(-40).join("\n").slice(0, 6000);
}

export function validateExecuteRecord(record, id, { sensitiveValues = [] } = {}) {
  const raw = record.task_event_result?.execute;
  const output = typeof raw === "string" ? raw.replaceAll("\r\n", "\n").trim() : "";
  const fail = (reason) => {
    const codes = [...new Set(output.match(/^NGP_ERROR=[A-Za-z0-9_-]+$/gm) || [])].map((code) => redactExecutionOutput(code, sensitiveValues));
    const detail = redactExecutionOutput([record.error_message, output].filter(Boolean).join("\n"), sensitiveValues);
    throw new Error([reason, ...codes, detail].filter(Boolean).join("\n"));
  };
  if (record.success !== true) fail("节点任务回传失败");
  if (String(record.error_message || "").trim()) fail("节点任务同时返回了错误信息，无法确认成功");
  if (typeof raw !== "string") fail("节点未返回有效的执行输出，请重新读取状态");
  if (TRUNCATED.test(output)) fail("执行输出被截断，无法确认操作完成，请重新读取状态");
  if (/^NGP_ERROR=/m.test(output)) fail("节点脚本报告失败，请重新读取状态");
  if (record.exit_code != null && (!Number.isInteger(record.exit_code) || record.exit_code !== 0)) {
    fail("节点报告子进程非零或无效退出码");
  }
  const lines = output.split("\n");
  for (const line of lines) {
    const footer = line.trim().match(PROCESS_EXIT);
    if (footer && Number(footer[1]) !== 0) fail(`命令退出码 ${footer[1]}，操作未成功`);
  }
  const begin = `NGP_EXEC_${id}_BEGIN`;
  const end = `NGP_EXEC_${id}_END=`;
  const starts = lines.flatMap((line, index) => line === begin ? [index] : []);
  const ends = lines.flatMap((line, index) => line.startsWith(end) ? [index] : []);
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) fail("执行回执缺失、重复或不属于本次请求，请重新读取状态");
  const code = lines[ends[0]].slice(end.length);
  if (code !== "0") fail(`命令退出码 ${/^\d+$/.test(code) ? code : "无效"}，操作未成功`);
  if (lines.slice(ends[0] + 1).some((line) => line.trim() && !PROCESS_EXIT.test(line.trim()))) {
    fail("执行回执后出现异常输出，无法确认操作完成");
  }
  return { output: lines.slice(starts[0] + 1, ends[0]).join("\n").trim(), exitCode: 0 };
}
