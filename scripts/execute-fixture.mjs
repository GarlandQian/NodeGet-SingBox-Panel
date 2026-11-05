export function frameExecuteOutput(execute, output, code = 0) {
  const id = execute.args[1].match(/NGP_EXEC_([a-f0-9]{32})_BEGIN/)?.[1];
  if (!id) throw new Error("missing execution receipt in fixture request");
  return `NGP_EXEC_${id}_BEGIN\n${output}\nNGP_EXEC_${id}_END=${code}\n[Process exited with code ${code}]`;
}

export function mockExecuteClient(output, { success = true, code = 0, errorMessage = null, transform = (value) => value, structuredExitCode } = {}) {
  let execute;
  const calls = [];
  return {
    calls,
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === "task_create_task") {
        execute = params.task_type.execute;
        return { id: 101 };
      }
      if (method === "task_query") {
        const body = typeof output === "function" ? output(execute) : output;
        return [{ success, error_message: errorMessage,
          ...(structuredExitCode != null ? { exit_code: structuredExitCode } : {}),
          task_event_result: { execute: transform(frameExecuteOutput(execute, body, code)) } }];
      }
      throw new Error(`unexpected RPC method: ${method}`);
    },
  };
}
