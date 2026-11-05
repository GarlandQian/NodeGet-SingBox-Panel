import { isNodegetTag } from "./inbound";
import { getEntryEngine } from "./protocols";

export const META_VERSION = 2;

export function emptyMeta() {
  return { version: META_VERSION, inbounds: [] };
}

export function makeMeta(inbounds) {
  return { version: META_VERSION, inbounds: inbounds.map((entry) => ({ ...entry, engine: getEntryEngine(entry) })) };
}

function parseScalars(text) {
  const scalars = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^NGP_([A-Z0-9_]+)=(.*)$/);
    if (match) {
      scalars[match[1]] = match[2];
    }
  }
  return scalars;
}

function extractBlock(text, marker) {
  const begin = `NGP_${marker}_BEGIN`;
  const end = `NGP_${marker}_END`;
  const start = text.indexOf(begin);
  if (start < 0) return "";
  const contentStart = start + begin.length;
  const stop = text.indexOf(end, contentStart);
  if (stop < 0) return "";
  return text.slice(contentStart, stop).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function tryParseJson(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseReadStateOutput(rawOutput) {
  const text = String(rawOutput || "");
  const scalars = parseScalars(text);
  const configRaw = extractBlock(text, "CONFIG");
  const metaRaw = extractBlock(text, "META");
  const configCheckRaw = extractBlock(text, "CONFIG_CHECK");
  const processRaw = extractBlock(text, "PROCESS");
  const listenRaw = extractBlock(text, "LISTEN");
  const serviceLogRaw = extractBlock(text, "SERVICE_LOG");
  const config = tryParseJson(configRaw);
  const parsedMeta = tryParseJson(metaRaw);
  const meta = migrateMeta(parsedMeta);
  const xrayConfigRaw = extractBlock(text, "XRAY_CONFIG");
  const xrayMetaRaw = extractBlock(text, "XRAY_META");
  const xrayConfig = tryParseJson(xrayConfigRaw);
  const xrayParsedMeta = tryParseJson(xrayMetaRaw);
  const xrayMeta = migrateMeta(xrayParsedMeta);
  const xrayConfigValid = xrayConfig && typeof xrayConfig === "object" && !Array.isArray(xrayConfig) &&
    ["inbounds", "outbounds"].every((key) => xrayConfig[key] == null || Array.isArray(xrayConfig[key]));
  const xrayMetaValid = xrayParsedMeta && Number(xrayParsedMeta.version) >= 2 && Array.isArray(xrayParsedMeta.inbounds);
  for (const entry of meta.inbounds) {
    if (getEntryEngine(entry) !== "singbox") throw new Error("sing-box 元数据中包含其他内核入站，已停止操作");
  }
  for (const entry of xrayMeta.inbounds) {
    if (getEntryEngine(entry) !== "xray") throw new Error("Xray 元数据中包含其他内核入站，已停止操作");
  }
  const ids = [...meta.inbounds, ...xrayMeta.inbounds].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error("入站元数据存在重复 ID，请修复后重新读取");
  const outputTruncated = /\[\.\.\. Output truncated,/.test(text);
  const configParseError = Boolean(configRaw.trim()) && config == null;
  const metaParseError = Boolean(metaRaw.trim()) && parsedMeta == null;

  const allInbounds = Array.isArray(config?.inbounds) ? config.inbounds : [];
  const managedTags = new Set(
    (meta.inbounds || []).map((entry) => entry.tag).filter(Boolean),
  );
  const foreignInbounds = allInbounds.filter((inbound) => !managedTags.has(inbound?.tag));
  const orphanManagedInbounds = allInbounds.filter(
    (inbound) => !managedTags.has(inbound?.tag) && isNodegetTag(inbound?.tag),
  );

  return {
    raw: text,
    scalars,
    serviceActive: scalars.SERVICE_ACTIVE || "unknown",
    serviceEnabled: scalars.SERVICE_ENABLED || "unknown",
    serviceManager: scalars.SERVICE_MANAGER || "unknown",
    singboxVersion: scalars.SINGBOX_VERSION || "unknown",
    configSha256: scalars.CONFIG_SHA256 || "",
    hostArch: scalars.HOST_ARCH || "",
    hostKernel: scalars.HOST_KERNEL || "",
    configCheckRaw,
    processRaw,
    listenRaw,
    serviceLogRaw,
    outputTruncated,
    configParseError,
    metaParseError,
    configRaw,
    metaRaw,
    config,
    meta,
    xray: {
      version: scalars.XRAY_VERSION || "missing",
      serviceActive: scalars.XRAY_SERVICE_ACTIVE || "unknown",
      serviceEnabled: scalars.XRAY_SERVICE_ENABLED || "unknown",
      configSha256: scalars.XRAY_CONFIG_SHA256 || "",
      metaSha256: scalars.XRAY_META_SHA256 || "",
      config: xrayConfig,
      meta: xrayMeta,
      configParseError: Boolean(xrayConfigRaw.trim()) && !xrayConfigValid,
      metaParseError: Boolean(xrayMetaRaw.trim()) && !xrayMetaValid,
      configCheckRaw: extractBlock(text, "XRAY_CONFIG_CHECK"),
      serviceLogRaw: extractBlock(text, "XRAY_SERVICE_LOG"),
      foreignInbounds: (Array.isArray(xrayConfig?.inbounds) ? xrayConfig.inbounds : []).filter((entry) => !xrayMeta.inbounds.some((managed) => managed.tag === entry.tag)),
    },
    foreignInbounds,
    orphanManagedInbounds,
  };
}

export function redactStateOutput(output) {
  // Persist only known status fields; config checks and service logs can also contain secrets.
  const scalars = parseScalars(output);
  const keys = ["SINGBOX_VERSION", "SERVICE_ACTIVE", "SERVICE_ENABLED", "SERVICE_MANAGER",
    "XRAY_VERSION", "XRAY_SERVICE_ACTIVE", "XRAY_SERVICE_ENABLED", "HOST_ARCH", "HOST_KERNEL"];
  return keys.filter((key) => scalars[key]).map((key) => `NGP_${key}=${scalars[key]}`).join("\n") +
    "\n[原始配置、凭据及服务日志不保存在浏览器历史中]";
}

export function parseXrayOutput(output) {
  const scalars = parseScalars(output);
  return {
    ...parseDeployOutput(output),
    metaSha256: scalars.META_SHA256 || "",
    version: scalars.XRAY_VERSION || "unknown",
    oldVersion: scalars.XRAY_VERSION_OLD || "unknown",
    serviceEnabled: scalars.SERVICE_ENABLED || "unknown",
  };
}

function migrateMeta(parsed) {
  if (parsed && typeof parsed === "object") {
    if (Number(parsed.version) >= 2 && Array.isArray(parsed.inbounds)) {
      return { version: META_VERSION, inbounds: parsed.inbounds };
    }
    if (parsed.protocol_id) {
      const inbound = migrateLegacyMetaEntry(parsed);
      return makeMeta([inbound]);
    }
  }
  return emptyMeta();
}

function migrateLegacyMetaEntry(legacy) {
  return {
    id: crypto.randomUUID(),
    tag: `nodeget-${legacy.protocol_id}-${legacy.endpoint_port || 443}`,
    protocolId: legacy.protocol_id,
    form: {
      endpointHost: legacy.endpoint_host || "",
      endpointPort: Number(legacy.endpoint_port || 443),
      handshakeHost: legacy.handshake_host || "",
      handshakePort: Number(legacy.handshake_port || 443),
      transportHost: legacy.transport_host || "",
      path: legacy.path || "/",
      serviceName: legacy.service_name || "grpc",
      uuid: legacy.uuid || "",
      shortId: legacy.short_id || "",
      method: legacy.method || "2022-blake3-aes-128-gcm",
      password: legacy.password || "",
      alterId: 0,
      username: legacy.username || "nodeget",
      label: "nodeget",
      privateKey: "",
      publicKey: legacy.public_key && legacy.public_key !== "$PUBLIC_KEY" ? legacy.public_key : "",
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function parseDeployOutput(rawOutput) {
  const scalars = parseScalars(rawOutput);
  return {
    serviceActive: scalars.SERVICE_ACTIVE || "unknown",
    serviceManager: scalars.SERVICE_MANAGER || "unknown",
    configFile: scalars.CONFIG_FILE || "",
    metaFile: scalars.META_FILE || "",
    configSha256: scalars.CONFIG_SHA256 || "",
  };
}

export function parseControlOutput(rawOutput) {
  const scalars = parseScalars(rawOutput);
  return {
    serviceActive: scalars.SERVICE_ACTIVE || "unknown",
    serviceEnabled: scalars.SERVICE_ENABLED || "unknown",
    serviceManager: scalars.SERVICE_MANAGER || "unknown",
  };
}

export function parseUpgradeOutput(rawOutput) {
  const scalars = parseScalars(rawOutput);
  return {
    status: scalars.UPGRADE_STATUS || "unknown",
    oldVersion: scalars.SINGBOX_VERSION_OLD || "unknown",
    newVersion: scalars.SINGBOX_VERSION_NEW || "unknown",
    releaseTag: scalars.RELEASE_TAG || "",
    backupBin: scalars.BACKUP_BIN || "",
    backupConfig: scalars.BACKUP_CONFIG || "",
    migrationCount: Number(scalars.MIGRATION_COUNT || 0),
    configSha256: scalars.CONFIG_SHA256 || "",
    serviceActive: scalars.SERVICE_ACTIVE || "unknown",
  };
}
