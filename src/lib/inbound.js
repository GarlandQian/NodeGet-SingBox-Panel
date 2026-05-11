import { getProtocol } from "./protocols";

const NODEGET_TAG_PREFIX = "nodeget-";

export function isNodegetTag(tag) {
  return typeof tag === "string" && tag.startsWith(NODEGET_TAG_PREFIX);
}

export function makeInboundTag(protocolId, port) {
  return `${NODEGET_TAG_PREFIX}${protocolId}-${port}`;
}

export function emptyInboundForm() {
  return {
    endpointHost: "",
    endpointPort: 443,
    handshakeHost: "www.cloudflare.com",
    handshakePort: 443,
    transportHost: "www.cloudflare.com",
    path: "/",
    serviceName: "grpc",
    uuid: "",
    shortId: "",
    method: "2022-blake3-aes-128-gcm",
    password: "",
    alterId: 0,
    certPath: "/etc/sing-box/fullchain.pem",
    keyPath: "/etc/sing-box/privkey.pem",
    upMbps: 0,
    downMbps: 0,
    obfsType: "",
    obfsPassword: "",
    congestionControl: "cubic",
    username: "nodeget",
    label: "nodeget",
    privateKey: "",
    publicKey: "",
  };
}

function trim(value) {
  return typeof value === "string" ? value.trim() : value;
}

function withDefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== ""),
  );
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildTls(protocol, form) {
  if (protocol.tlsMode === "none") return null;
  if (protocol.tlsMode === "reality") {
    return {
      enabled: true,
      reality: {
        enabled: true,
        handshake: {
          server: trim(form.handshakeHost),
          server_port: Number(form.handshakePort),
        },
        private_key: form.privateKey,
        short_id: [trim(form.shortId)],
      },
    };
  }
  return {
    enabled: true,
    certificate_path: trim(form.certPath),
    key_path: trim(form.keyPath),
  };
}

function buildTransport(protocol, form) {
  if (!protocol.transport || protocol.transport === "tcp" || protocol.transport === "quic") {
    return null;
  }
  if (protocol.transport === "ws") {
    return withDefined({
      type: "ws",
      path: trim(form.path),
      headers: form.transportHost ? { Host: trim(form.transportHost) } : undefined,
    });
  }
  if (protocol.transport === "http") {
    return withDefined({
      type: "http",
      path: trim(form.path),
      host: form.transportHost ? [trim(form.transportHost)] : undefined,
    });
  }
  if (protocol.transport === "grpc") {
    return withDefined({
      type: "grpc",
      service_name: trim(form.serviceName),
    });
  }
  if (protocol.transport === "httpupgrade") {
    return withDefined({
      type: "httpupgrade",
      path: trim(form.path),
      host: trim(form.transportHost),
    });
  }
  return null;
}

function attachTlsAndTransport(inbound, protocol, form) {
  const tls = buildTls(protocol, form);
  const transport = buildTransport(protocol, form);
  if (tls) inbound.tls = tls;
  if (transport) inbound.transport = transport;
  return inbound;
}

export function buildSingBoxInbound(protocolId, form) {
  const protocol = getProtocol(protocolId);
  if (!protocol) throw new Error(`未知协议：${protocolId}`);

  const port = Number(form.endpointPort);
  const tag = makeInboundTag(protocol.id, port);
  const base = {
    type: protocol.family,
    tag,
    listen: "0.0.0.0",
    listen_port: port,
  };

  if (protocol.family === "vless") {
    const inbound = {
      ...base,
      users: [
        withDefined({
          name: trim(form.label) || "nodeget",
          uuid: trim(form.uuid),
          flow:
            protocol.tlsMode === "reality" && protocol.transport === "tcp"
              ? "xtls-rprx-vision"
              : undefined,
        }),
      ],
    };
    return attachTlsAndTransport(inbound, protocol, form);
  }

  if (protocol.family === "vmess") {
    const inbound = {
      ...base,
      users: [
        {
          name: trim(form.label) || "nodeget",
          uuid: trim(form.uuid),
          alterId: Number(form.alterId || 0),
        },
      ],
    };
    return attachTlsAndTransport(inbound, protocol, form);
  }

  if (protocol.family === "trojan") {
    const inbound = {
      ...base,
      users: [{ name: trim(form.label) || "nodeget", password: trim(form.password) }],
    };
    return attachTlsAndTransport(inbound, protocol, form);
  }

  if (protocol.family === "shadowsocks") {
    return {
      ...base,
      network: "tcp",
      method: form.method,
      password: trim(form.password),
      multiplex: { enabled: true },
    };
  }

  if (protocol.family === "tuic") {
    return {
      ...base,
      users: [
        {
          name: trim(form.label) || "nodeget",
          uuid: trim(form.uuid),
          password: trim(form.password),
        },
      ],
      congestion_control: form.congestionControl || "cubic",
      tls: buildTls(protocol, form),
    };
  }

  if (protocol.family === "hysteria2") {
    const inbound = {
      ...base,
      users: [{ name: trim(form.label) || "nodeget", password: trim(form.password) }],
      tls: buildTls(protocol, form),
    };
    const upMbps = numberOrNull(form.upMbps);
    const downMbps = numberOrNull(form.downMbps);
    if (upMbps && upMbps > 0) inbound.up_mbps = upMbps;
    if (downMbps && downMbps > 0) inbound.down_mbps = downMbps;
    if (form.obfsType && form.obfsPassword) {
      inbound.obfs = { type: form.obfsType, password: trim(form.obfsPassword) };
    }
    return inbound;
  }

  if (protocol.family === "anytls") {
    return {
      ...base,
      users: [{ name: trim(form.label) || "nodeget", password: trim(form.password) }],
      tls: buildTls(protocol, form),
    };
  }

  if (protocol.family === "socks") {
    const inbound = { ...base };
    if (form.username || form.password) {
      inbound.users = [
        withDefined({ username: trim(form.username), password: trim(form.password) }),
      ];
    }
    return inbound;
  }

  throw new Error(`不支持的协议：${protocol.id}`);
}

export function buildSingBoxConfig({ inbounds, foreignInbounds = [] }) {
  return {
    log: { level: "info", timestamp: true },
    inbounds: [...foreignInbounds, ...inbounds],
    outbounds: [{ type: "direct", tag: "direct" }],
    route: { final: "direct" },
  };
}

export function makeInboundId() {
  return crypto.randomUUID();
}
