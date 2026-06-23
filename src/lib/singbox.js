import { getProtocol } from "./protocols";

export function randomHex(byteLength = 8) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomBase64(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export function formatHostPort(host, port) {
  const normalizedHost = String(host || "").trim();
  const normalizedPort = String(port || "").trim();
  if (!normalizedHost) return "";
  if (normalizedHost.includes(":") && !normalizedHost.startsWith("[")) {
    return `[${normalizedHost}]:${normalizedPort}`;
  }
  return `${normalizedHost}:${normalizedPort}`;
}

function trim(value) {
  return typeof value === "string" ? value.trim() : value;
}

function cleanForm(form) {
  const cleaned = {};
  for (const [key, value] of Object.entries(form || {})) {
    cleaned[key] = trim(value);
  }
  return cleaned;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function shareHost(form) {
  return form.handshakeHost || form.endpointHost || "";
}

function appendTransportParams(params, protocol, form) {
  if (!protocol.transport || protocol.transport === "tcp") return;
  if (protocol.transport === "ws" || protocol.transport === "http" || protocol.transport === "httpupgrade") {
    params.set("path", form.path || "/");
    if (form.transportHost) params.set("host", form.transportHost);
    return;
  }
  if (protocol.transport === "grpc") {
    params.set("serviceName", form.serviceName || "");
  }
}

function buildVlessUri(protocol, form, label) {
  const params = new URLSearchParams();
  params.set("encryption", "none");
  if (protocol.tlsMode === "reality") {
    if (protocol.transport === "tcp") params.set("flow", "xtls-rprx-vision");
    params.set("security", "reality");
    params.set("sni", shareHost(form));
    params.set("fp", "chrome");
    params.set("pbk", form.publicKey || "");
    params.set("sid", form.shortId);
    if (protocol.transport === "tcp") params.set("spx", "/");
  } else if (protocol.tlsMode === "cert") {
    params.set("security", "tls");
    params.set("sni", shareHost(form));
  }
  params.set("type", protocol.transport === "tcp" ? "tcp" : protocol.transport);
  if (protocol.transport === "tcp") params.set("headerType", "none");
  appendTransportParams(params, protocol, form);
  return `vless://${form.uuid}@${formatHostPort(form.endpointHost, form.endpointPort)}?${params.toString()}#${encodeURIComponent(label)}`;
}

function buildVmessUri(protocol, form, label) {
  const payload = {
    v: "2",
    ps: label,
    add: form.endpointHost,
    port: String(form.endpointPort),
    id: form.uuid,
    aid: String(form.alterId || 0),
    scy: "auto",
    net: protocol.transport === "tcp" ? "tcp" : protocol.transport,
    type: "none",
    host: form.transportHost || "",
    path: form.serviceName || form.path || "",
    tls: protocol.tlsMode === "cert" ? "tls" : "",
    sni: protocol.tlsMode === "cert" ? shareHost(form) : "",
  };
  return `vmess://${base64Utf8(JSON.stringify(payload))}`;
}

function buildTrojanUri(protocol, form, label) {
  const params = new URLSearchParams();
  if (protocol.tlsMode === "cert") {
    params.set("security", "tls");
    params.set("sni", shareHost(form));
  }
  appendTransportParams(params, protocol, form);
  return `trojan://${encodeURIComponent(form.password)}@${formatHostPort(form.endpointHost, form.endpointPort)}?${params.toString()}#${encodeURIComponent(label)}`;
}

function buildShadowsocksUri(form, label) {
  const encoded = base64Utf8(`${form.method}:${form.password}`);
  return `ss://${encoded}@${formatHostPort(form.endpointHost, form.endpointPort)}#${encodeURIComponent(label)}`;
}

function buildTuicUri(form, label) {
  const params = new URLSearchParams({ congestion_control: form.congestionControl || "cubic" });
  if (shareHost(form)) params.set("sni", shareHost(form));
  params.set("alpn", "h3");
  return `tuic://${form.uuid}:${encodeURIComponent(form.password)}@${formatHostPort(form.endpointHost, form.endpointPort)}?${params.toString()}#${encodeURIComponent(label)}`;
}

function buildHysteria2Uri(form, label) {
  const params = new URLSearchParams();
  if (shareHost(form)) params.set("sni", shareHost(form));
  params.set("alpn", "h3");
  if (form.upMbps) params.set("upmbps", String(form.upMbps));
  if (form.downMbps) params.set("downmbps", String(form.downMbps));
  if (form.obfsType && form.obfsPassword) {
    params.set("obfs", form.obfsType);
    params.set("obfs-password", form.obfsPassword);
  }
  if (form.portJumpRange) {
    params.set("mport", form.portJumpRange);
  }
  return `hy2://${encodeURIComponent(form.password)}@${formatHostPort(form.endpointHost, form.endpointPort)}?${params.toString()}#${encodeURIComponent(label)}`;
}

function buildAnyTlsUri(form, label) {
  const params = new URLSearchParams();
  if (shareHost(form)) params.set("sni", shareHost(form));
  return `anytls://${encodeURIComponent(form.password)}@${formatHostPort(form.endpointHost, form.endpointPort)}?${params.toString()}#${encodeURIComponent(label)}`;
}

function buildSocksUri(form, label) {
  const userInfo = form.username || form.password
    ? `${encodeURIComponent(form.username || "")}:${encodeURIComponent(form.password || "")}@`
    : "";
  return `socks://${userInfo}${formatHostPort(form.endpointHost, form.endpointPort)}#${encodeURIComponent(label)}`;
}

export function buildShareUri(protocolId, form, label = "nodeget") {
  const cleaned = cleanForm(form);
  const protocol = getProtocol(protocolId);
  if (!protocol) return "";
  if (protocol.tlsMode === "reality" && !cleaned.publicKey) return "";
  if (protocol.family === "vless") return buildVlessUri(protocol, cleaned, label);
  if (protocol.family === "vmess") return buildVmessUri(protocol, cleaned, label);
  if (protocol.family === "trojan") return buildTrojanUri(protocol, cleaned, label);
  if (protocol.family === "shadowsocks") return buildShadowsocksUri(cleaned, label);
  if (protocol.family === "tuic") return buildTuicUri(cleaned, label);
  if (protocol.family === "hysteria2") return buildHysteria2Uri(cleaned, label);
  if (protocol.family === "anytls") return buildAnyTlsUri(cleaned, label);
  if (protocol.family === "socks") return buildSocksUri(cleaned, label);
  return "";
}

export function buildConnectionDetails(protocolId, form) {
  const cleaned = cleanForm(form);
  const protocol = getProtocol(protocolId);
  if (!protocol) return [];
  const details = [
    ["协议", protocol.label],
    ["地址", cleaned.endpointHost],
    ["端口", String(cleaned.endpointPort || "")],
  ];
  if (protocol.family === "vless" || protocol.family === "vmess") {
    if (cleaned.uuid) details.push(["UUID", cleaned.uuid]);
  }
  if (protocol.family === "vmess" && cleaned.alterId !== "" && cleaned.alterId != null) {
    details.push(["Alter ID", String(cleaned.alterId)]);
  }
  if (protocol.family === "shadowsocks") {
    if (cleaned.method) details.push(["Method", cleaned.method]);
    if (cleaned.password) details.push(["Password", cleaned.password]);
  }
  if (protocol.family === "trojan" || protocol.family === "hysteria2" || protocol.family === "anytls") {
    if (cleaned.password) details.push(["Password", cleaned.password]);
  }
  if (protocol.family === "tuic") {
    if (cleaned.uuid) details.push(["UUID", cleaned.uuid]);
    if (cleaned.password) details.push(["Password", cleaned.password]);
    if (cleaned.congestionControl) details.push(["CC", cleaned.congestionControl]);
  }
  if (protocol.family === "socks") {
    if (cleaned.username) details.push(["Username", cleaned.username]);
    if (cleaned.password) details.push(["Password", cleaned.password]);
  }
  if (protocol.tlsMode === "cert" || protocol.tlsMode === "reality") {
    if (cleaned.handshakeHost) details.push(["SNI", cleaned.handshakeHost]);
  }
  if (cleaned.publicKey) details.push(["Public Key", cleaned.publicKey]);
  if (protocol.tlsMode === "reality" && cleaned.shortId) details.push(["Short ID", cleaned.shortId]);
  if (protocol.transport && protocol.transport !== "tcp" && cleaned.path) details.push(["Path", cleaned.path]);
  if (protocol.transport === "grpc" && cleaned.serviceName) details.push(["Service Name", cleaned.serviceName]);
  if ((protocol.transport === "ws" || protocol.transport === "http" || protocol.transport === "httpupgrade") && cleaned.transportHost) {
    details.push(["Host", cleaned.transportHost]);
  }
  if (protocol.family === "hysteria2") {
    if (cleaned.upMbps) details.push(["Up Mbps", String(cleaned.upMbps)]);
    if (cleaned.downMbps) details.push(["Down Mbps", String(cleaned.downMbps)]);
    if (cleaned.obfsType) details.push(["Obfs", cleaned.obfsType]);
    if (cleaned.portJumpRange) details.push(["端口跳跃", cleaned.portJumpRange]);
  }
  return details;
}
