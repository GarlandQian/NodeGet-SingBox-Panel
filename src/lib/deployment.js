import { getEntryEngine } from "./protocols";
import { buildSingBoxConfig, buildSingBoxInbound } from "./inbound";
import { buildManagedNextHops } from "./nextHop";
import { buildXrayConfig } from "./xray";
import { makeMeta } from "./state";

export function buildEngineDeployment(engine, nextInbounds, state) {
  if (!["singbox", "xray"].includes(engine)) throw new Error("未知部署内核");
  const entries = nextInbounds.filter((entry) => getEntryEngine(entry) === engine);
  const meta = makeMeta(entries);
  if (engine === "xray") {
    return {
      engine, meta, nextInbounds,
      config: buildXrayConfig(entries, state.xray?.config, state.xray?.meta?.inbounds || []),
      configSha256: state.xray?.configSha256,
      metaSha256: state.xray?.metaSha256,
    };
  }
  const { outbounds, routeRules } = buildManagedNextHops(entries);
  return {
    engine, meta, nextInbounds,
    config: buildSingBoxConfig({
      inbounds: entries.map((entry) => buildSingBoxInbound(entry.protocolId, entry.form)),
      foreignInbounds: state.foreignInbounds || [],
      baseConfig: state.config,
      managedOutbounds: outbounds,
      managedRouteRules: routeRules,
    }),
  };
}

function matchesPort(value, port) {
  return String(value ?? "").split(",").some((part) => {
    const range = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    return range && port >= Number(range[1]) && port <= Number(range[2] || range[1]);
  });
}

export function assertPortAvailable({ entries, foreign = [], port, tag, ignoreId = null }) {
  for (const entry of entries) {
    if (ignoreId != null && entry.id === ignoreId) continue;
    if (matchesPort(entry.form.endpointPort, port)) throw new Error(`端口 ${port} 已被入站 ${entry.tag} 占用`);
    if (entry.tag === tag) throw new Error(`入站 tag 冲突：${tag}`);
  }
  if (foreign.some((entry) => matchesPort(entry.listen_port ?? entry.port, port))) {
    throw new Error(`端口 ${port} 已被非面板入站占用`);
  }
}
