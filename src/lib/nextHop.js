const MANAGED_NEXT_HOP_PREFIX = "nodeget-next-hop-";

const TYPE_LABELS = {
  anytls: "AnyTLS",
  http: "HTTP",
  hysteria2: "Hysteria2",
  shadowsocks: "Shadowsocks",
  socks: "SOCKS5",
  trojan: "Trojan",
  tuic: "TUIC",
  vless: "VLESS",
  vmess: "VMess",
};

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== ""),
  );
}

function decodeComponent(value, label) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    throw new Error(`${label}包含无效的 URL 编码`);
  }
}

function decodeBase64Utf8(value, label) {
  try {
    const decodedValue = decodeComponent(String(value || "").trim(), label)
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const padded = decodedValue + "=".repeat((4 - decodedValue.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof Error && error.message.includes("URL 编码")) throw error;
    throw new Error(`${label}不是有效的 Base64`);
  }
}

function parseUrl(rawUri, label) {
  try {
    return new URL(rawUri);
  } catch {
    throw new Error(`${label}格式无效`);
  }
}

function normalizeHostname(hostname) {
  const value = String(hostname || "").trim();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function parsePort(value, label, fallback = null) {
  if ((value == null || value === "") && fallback != null) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}缺少有效端口`);
  }
  return port;
}

function parseServer(url, label, fallbackPort = null) {
  const server = normalizeHostname(url.hostname);
  if (!server) throw new Error(`${label}缺少服务器地址`);
  return { server, server_port: parsePort(url.port, label, fallbackPort) };
}

function parseOptionalPositiveNumber(value, label) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(label + "需要大于 0");
  }
  return number;
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanParam(params, ...keys) {
  for (const key of keys) {
    if (!params.has(key)) continue;
    const value = String(params.get(key) || "").toLowerCase();
    return value === "1" || value === "true" || value === "yes";
  }
  return false;
}

function firstParam(params, ...keys) {
  for (const key of keys) {
    const value = params.get(key);
    if (value != null && value !== "") return value;
  }
  return "";
}

function assertKnownParams(params, allowed) {
  const unsupported = [...new Set([...params.keys()].filter((key) => !allowed.has(key)))];
  if (unsupported.length) {
    throw new Error(`暂不支持 URI 参数：${unsupported.join("、")}`);
  }
}

function buildTls(url, { reality = false } = {}) {
  const params = url.searchParams;
  const serverName = firstParam(params, "sni", "peer") || normalizeHostname(url.hostname);
  const tls = {
    enabled: true,
    server_name: serverName,
  };
  const alpn = splitList(params.get("alpn"));
  if (alpn.length) tls.alpn = alpn;
  if (booleanParam(params, "allowInsecure", "allow_insecure", "insecure")) {
    tls.insecure = true;
  }
  const fingerprint = params.get("fp");
  if (fingerprint && fingerprint !== "none") {
    tls.utls = { enabled: true, fingerprint };
  }
  if (reality) {
    const publicKey = firstParam(params, "pbk", "publicKey");
    if (!publicKey) throw new Error("Reality URI 缺少公钥 pbk");
    tls.reality = {
      enabled: true,
      public_key: publicKey,
      short_id: firstParam(params, "sid", "shortId"),
    };
  }
  return tls;
}

function buildTransport(params, { allowQuic = false } = {}) {
  const rawType = String(params.get("type") || "tcp").toLowerCase();
  const type = rawType === "websocket" ? "ws" : rawType === "h2" ? "http" : rawType;
  if (type === "tcp" || type === "raw") {
    const headerType = params.get("headerType");
    if (headerType && headerType !== "none") {
      throw new Error(`暂不支持 TCP headerType=${headerType}`);
    }
    return null;
  }
  if (type === "quic") {
    if (!allowQuic) throw new Error("该协议暂不支持 QUIC 传输");
    return { type: "quic" };
  }
  if (type === "ws") {
    return compactObject({
      type: "ws",
      path: params.get("path") || "/",
      headers: params.get("host") ? { Host: params.get("host") } : undefined,
    });
  }
  if (type === "http") {
    return compactObject({
      type: "http",
      path: params.get("path") || "/",
      host: params.get("host") ? [params.get("host")] : undefined,
    });
  }
  if (type === "grpc") {
    return compactObject({
      type: "grpc",
      service_name: firstParam(params, "serviceName", "service_name"),
    });
  }
  if (type === "httpupgrade") {
    return compactObject({
      type: "httpupgrade",
      path: params.get("path") || "/",
      host: params.get("host") || undefined,
    });
  }
  throw new Error(`暂不支持传输类型：${rawType}`);
}

const VLESS_PARAMS = new Set([
  "allowInsecure", "allow_insecure", "alpn", "encryption", "flow", "fp",
  "headerType", "host", "insecure", "packetEncoding", "path", "pbk",
  "peer", "publicKey", "security", "serviceName", "service_name", "sid",
  "shortId", "sni", "spx", "type",
]);

function parseVless(rawUri, tag) {
  const url = parseUrl(rawUri, "VLESS URI");
  assertKnownParams(url.searchParams, VLESS_PARAMS);
  const uuid = decodeComponent(url.username, "VLESS UUID");
  if (!uuid) throw new Error("VLESS URI 缺少 UUID");
  const encryption = url.searchParams.get("encryption");
  if (encryption && encryption !== "none") {
    throw new Error(`暂不支持 VLESS encryption=${encryption}`);
  }
  const flow = url.searchParams.get("flow");
  if (flow && flow !== "xtls-rprx-vision") {
    throw new Error(`暂不支持 VLESS flow=${flow}`);
  }
  const security = String(url.searchParams.get("security") || "none").toLowerCase();
  if (!new Set(["none", "tls", "reality"]).has(security)) {
    throw new Error(`暂不支持 VLESS security=${security}`);
  }
  const transport = buildTransport(url.searchParams);
  const packetEncoding = url.searchParams.get("packetEncoding");
  return {
    type: "vless",
    tag,
    ...parseServer(url, "VLESS URI"),
    uuid,
    ...(flow ? { flow } : {}),
    ...(packetEncoding ? { packet_encoding: packetEncoding } : {}),
    ...(transport ? { transport } : {}),
    ...(security === "tls" ? { tls: buildTls(url) } : {}),
    ...(security === "reality" ? { tls: buildTls(url, { reality: true }) } : {}),
  };
}

const TROJAN_PARAMS = new Set([
  "allowInsecure", "allow_insecure", "alpn", "fp", "headerType", "host",
  "insecure", "path", "peer", "security", "serviceName", "service_name",
  "sni", "type",
]);

function parseTrojan(rawUri, tag) {
  const url = parseUrl(rawUri, "Trojan URI");
  assertKnownParams(url.searchParams, TROJAN_PARAMS);
  const password = decodeComponent(url.username, "Trojan 密码");
  if (!password) throw new Error("Trojan URI 缺少密码");
  const security = String(url.searchParams.get("security") || "tls").toLowerCase();
  if (security !== "tls") throw new Error(`暂不支持 Trojan security=${security}`);
  const transport = buildTransport(url.searchParams);
  return {
    type: "trojan",
    tag,
    ...parseServer(url, "Trojan URI"),
    password,
    ...(transport ? { transport } : {}),
    tls: buildTls(url),
  };
}

function vmessTransport(payload) {
  const params = new URLSearchParams();
  params.set("type", payload.net || "tcp");
  if (payload.host) params.set("host", payload.host);
  if (payload.net === "grpc") {
    params.set("serviceName", payload.path || payload.serviceName || "");
  } else if (payload.path) {
    params.set("path", payload.path);
  }
  if (payload.type) params.set("headerType", payload.type);
  return buildTransport(params, { allowQuic: true });
}

function parseVmess(rawUri, tag) {
  const encoded = rawUri.slice(rawUri.indexOf("://") + 3).split("#", 1)[0];
  let payload;
  try {
    payload = JSON.parse(decodeBase64Utf8(encoded, "VMess URI"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("VMess URI 中的 JSON 无效");
    throw error;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VMess URI 内容无效");
  }
  const server = normalizeHostname(payload.add);
  if (!server) throw new Error("VMess URI 缺少服务器地址");
  const uuid = String(payload.id || "").trim();
  if (!uuid) throw new Error("VMess URI 缺少 UUID");
  const transport = vmessTransport(payload);
  const tlsMode = String(payload.tls || "").toLowerCase();
  if (tlsMode && tlsMode !== "tls" && tlsMode !== "none") {
    throw new Error(`暂不支持 VMess TLS 类型：${tlsMode}`);
  }
  const alterId = Number(payload.aid || 0);
  if (!Number.isInteger(alterId) || alterId < 0 || alterId > 65535) {
    throw new Error("VMess URI 的 Alter ID 无效");
  }
  const outbound = {
    type: "vmess",
    tag,
    server,
    server_port: parsePort(payload.port, "VMess URI"),
    uuid,
    alter_id: alterId,
    security: payload.scy || "auto",
    ...(transport ? { transport } : {}),
  };
  if (tlsMode === "tls") {
    outbound.tls = compactObject({
      enabled: true,
      server_name: payload.sni || payload.host || server,
      insecure: payload.allowInsecure === true || payload.allowInsecure === "1" || undefined,
      utls: payload.fp ? { enabled: true, fingerprint: payload.fp } : undefined,
      alpn: Array.isArray(payload.alpn) ? payload.alpn : splitList(payload.alpn),
    });
    if (!outbound.tls.alpn?.length) delete outbound.tls.alpn;
  }
  return outbound;
}

function splitCredentials(value, label) {
  const separator = value.indexOf(":");
  if (separator <= 0) throw new Error(`${label}缺少加密方法或密码`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function parseShadowsocks(rawUri, tag) {
  const withoutScheme = rawUri.slice(rawUri.indexOf("://") + 3);
  const withoutFragment = withoutScheme.split("#", 1)[0];
  const [authority, query = ""] = withoutFragment.split("?", 2);
  const params = new URLSearchParams(query);
  if ([...params.keys()].length) {
    if (params.has("plugin")) throw new Error("暂不支持 Shadowsocks plugin");
    assertKnownParams(params, new Set());
  }

  let credentials;
  let serverAuthority;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const userInfo = authority.slice(0, at);
    serverAuthority = authority.slice(at + 1);
    const decodedUserInfo = decodeComponent(userInfo, "Shadowsocks 凭据");
    credentials = decodedUserInfo.includes(":")
      ? decodedUserInfo
      : decodeBase64Utf8(decodedUserInfo, "Shadowsocks 凭据");
  } else {
    const decoded = decodeBase64Utf8(authority, "Shadowsocks URI");
    const decodedAt = decoded.lastIndexOf("@");
    if (decodedAt < 0) throw new Error("Shadowsocks URI 缺少服务器地址");
    credentials = decoded.slice(0, decodedAt);
    serverAuthority = decoded.slice(decodedAt + 1);
  }

  const [method, password] = splitCredentials(credentials, "Shadowsocks URI");
  if (!password) throw new Error("Shadowsocks URI 缺少密码");
  const serverUrl = parseUrl(`ss://unused@${serverAuthority}`, "Shadowsocks URI");
  return {
    type: "shadowsocks",
    tag,
    ...parseServer(serverUrl, "Shadowsocks URI"),
    method,
    password,
  };
}

function parseSocks(rawUri, tag) {
  const url = parseUrl(rawUri.replace(/^socks:\/\//i, "socks5://"), "SOCKS5 URI");
  assertKnownParams(url.searchParams, new Set());
  return compactObject({
    type: "socks",
    tag,
    ...parseServer(url, "SOCKS5 URI"),
    version: "5",
    username: url.username ? decodeComponent(url.username, "SOCKS5 用户名") : undefined,
    password: url.password ? decodeComponent(url.password, "SOCKS5 密码") : undefined,
  });
}

function parseHttp(rawUri, tag) {
  const url = parseUrl(rawUri, "HTTP 代理 URI");
  assertKnownParams(url.searchParams, new Set());
  const secure = url.protocol.toLowerCase() === "https:";
  return compactObject({
    type: "http",
    tag,
    ...parseServer(url, "HTTP 代理 URI", secure ? 443 : 80),
    username: url.username ? decodeComponent(url.username, "HTTP 代理用户名") : undefined,
    password: url.password ? decodeComponent(url.password, "HTTP 代理密码") : undefined,
    tls: secure ? { enabled: true, server_name: normalizeHostname(url.hostname) } : undefined,
  });
}

const TUIC_PARAMS = new Set([
  "allowInsecure", "allow_insecure", "alpn", "congestion-controller",
  "congestion_control", "insecure", "peer", "sni", "udp_relay_mode",
  "zero_rtt_handshake",
]);

function parseTuic(rawUri, tag) {
  const url = parseUrl(rawUri, "TUIC URI");
  assertKnownParams(url.searchParams, TUIC_PARAMS);
  const uuid = decodeComponent(url.username, "TUIC UUID");
  const password = decodeComponent(url.password, "TUIC 密码");
  if (!uuid || !password) throw new Error("TUIC URI 缺少 UUID 或密码");
  return {
    type: "tuic",
    tag,
    ...parseServer(url, "TUIC URI"),
    uuid,
    password,
    congestion_control: firstParam(
      url.searchParams,
      "congestion_control",
      "congestion-controller",
    ) || "cubic",
    ...(url.searchParams.get("udp_relay_mode")
      ? { udp_relay_mode: url.searchParams.get("udp_relay_mode") }
      : {}),
    ...(url.searchParams.has("zero_rtt_handshake")
      ? {
          zero_rtt_handshake: booleanParam(
            url.searchParams,
            "zero_rtt_handshake",
          ),
        }
      : {}),
    tls: buildTls(url),
  };
}

const HYSTERIA2_PARAMS = new Set([
  "allowInsecure", "allow_insecure", "alpn", "downmbps", "insecure", "mport",
  "obfs", "obfs-password", "peer", "sni", "upmbps",
]);

function normalizeServerPortRange(value) {
  const singlePort = String(value).match(/^(\d+)$/);
  if (singlePort) return String(parsePort(singlePort[1], "Hysteria2 mport"));
  const range = String(value).match(/^(\d+)[:-](\d+)$/);
  if (!range) throw new Error("Hysteria2 mport 格式无效");
  const start = parsePort(range[1], "Hysteria2 mport");
  const end = parsePort(range[2], "Hysteria2 mport");
  if (start > end) throw new Error("Hysteria2 mport 起始端口不能大于结束端口");
  return start + ":" + end;
}

function parseHysteria2(rawUri, tag) {
  const url = parseUrl(rawUri.replace(/^hy2:\/\//i, "hysteria2://"), "Hysteria2 URI");
  assertKnownParams(url.searchParams, HYSTERIA2_PARAMS);
  const password = decodeComponent(url.username, "Hysteria2 密码");
  if (!password) throw new Error("Hysteria2 URI 缺少密码");
  const serverPorts = splitList(url.searchParams.get("mport")).map(
    normalizeServerPortRange,
  );
  const server = normalizeHostname(url.hostname);
  if (!server) throw new Error("Hysteria2 URI 缺少服务器地址");
  const outbound = {
    type: "hysteria2",
    tag,
    server,
    ...(serverPorts.length
      ? { server_ports: serverPorts }
      : { server_port: parsePort(url.port, "Hysteria2 URI") }),
    password,
    tls: buildTls(url),
  };
  const upMbps = parseOptionalPositiveNumber(
    url.searchParams.get("upmbps"),
    "Hysteria2 upmbps",
  );
  const downMbps = parseOptionalPositiveNumber(
    url.searchParams.get("downmbps"),
    "Hysteria2 downmbps",
  );
  if (upMbps != null) outbound.up_mbps = upMbps;
  if (downMbps != null) outbound.down_mbps = downMbps;
  const obfsType = url.searchParams.get("obfs");
  const obfsPassword = url.searchParams.get("obfs-password");
  if (obfsType || obfsPassword) {
    if (!obfsType || !obfsPassword) throw new Error("Hysteria2 obfs 参数不完整");
    outbound.obfs = { type: obfsType, password: obfsPassword };
  }
  return outbound;
}

const ANYTLS_PARAMS = new Set([
  "allowInsecure", "allow_insecure", "alpn", "insecure", "peer", "sni",
]);

function parseAnyTls(rawUri, tag) {
  const url = parseUrl(rawUri, "AnyTLS URI");
  assertKnownParams(url.searchParams, ANYTLS_PARAMS);
  const password = decodeComponent(url.username, "AnyTLS 密码");
  if (!password) throw new Error("AnyTLS URI 缺少密码");
  return {
    type: "anytls",
    tag,
    ...parseServer(url, "AnyTLS URI"),
    password,
    tls: buildTls(url),
  };
}

function normalizedScheme(rawUri) {
  const match = String(rawUri || "").trim().match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return match ? match[1].toLowerCase() : "";
}

export function makeManagedNextHopTag(inboundTag) {
  const suffix = String(inboundTag || "")
    .replace(/^nodeget-/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!suffix) throw new Error("无法为下一跳节点生成 tag");
  return `${MANAGED_NEXT_HOP_PREFIX}${suffix}`;
}

export function isManagedNextHopTag(tag) {
  return typeof tag === "string" && tag.startsWith(MANAGED_NEXT_HOP_PREFIX);
}

export function parseNextHopUri(rawUri, tag = "nodeget-next-hop-preview") {
  const uri = String(rawUri || "").trim();
  if (!uri) throw new Error("请填写下一跳节点 URI");
  const scheme = normalizedScheme(uri);
  if (!scheme) throw new Error("下一跳节点需要完整 URI，例如 socks5://host:port");
  if (scheme === "socks" || scheme === "socks5" || scheme === "socks5h") {
    return parseSocks(uri.replace(/^socks5h:\/\//i, "socks5://"), tag);
  }
  if (scheme === "http" || scheme === "https") return parseHttp(uri, tag);
  if (scheme === "ss") return parseShadowsocks(uri, tag);
  if (scheme === "vless") return parseVless(uri, tag);
  if (scheme === "vmess") return parseVmess(uri, tag);
  if (scheme === "trojan") return parseTrojan(uri, tag);
  if (scheme === "tuic") return parseTuic(uri, tag);
  if (scheme === "hy2" || scheme === "hysteria2") return parseHysteria2(uri, tag);
  if (scheme === "anytls") return parseAnyTls(uri, tag);
  throw new Error(`暂不支持下一跳协议：${scheme}`);
}

function formatEndpoint(outbound) {
  const host = String(outbound.server || "");
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  const port = outbound.server_port || outbound.server_ports?.join(",");
  return port ? `${formattedHost}:${port}` : formattedHost;
}

export function describeNextHopUri(rawUri) {
  const outbound = parseNextHopUri(rawUri);
  return {
    type: outbound.type,
    label: TYPE_LABELS[outbound.type] || outbound.type,
    endpoint: formatEndpoint(outbound),
  };
}

export function buildManagedNextHops(entries) {
  const outbounds = [];
  const routeRules = [];
  for (const entry of entries || []) {
    if (entry?.form?.nextHopEnabled !== true) continue;
    const tag = makeManagedNextHopTag(entry.tag);
    let outbound;
    try {
      outbound = parseNextHopUri(entry.form.nextHopUri, tag);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`入站 ${entry.tag} 的下一跳节点：${message}`);
    }
    outbounds.push(outbound);
    routeRules.push({
      inbound: [entry.tag],
      action: "route",
      outbound: tag,
    });
  }
  return { outbounds, routeRules };
}
