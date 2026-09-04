import { getProtocol } from "./protocols";
import { isManagedNextHopTag } from "./nextHop";

const NODEGET_TAG_PREFIX = "nodeget-";
const MANAGED_DNS_TAG = "nodeget-next-hop-local";
const RANDOM_PORT_MIN = 10000;
const RANDOM_PORT_MAX = 65500;
const UINT32_RANGE = 0x100000000;

export function randomInboundPort() {
  const range = RANDOM_PORT_MAX - RANDOM_PORT_MIN + 1;
  const unbiasedLimit = UINT32_RANGE - (UINT32_RANGE % range);
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= unbiasedLimit);
  return RANDOM_PORT_MIN + (values[0] % range);
}

export function isNodegetTag(tag) {
  return typeof tag === "string" && tag.startsWith(NODEGET_TAG_PREFIX);
}

export function makeInboundTag(protocolId, port) {
  return `${NODEGET_TAG_PREFIX}${protocolId}-${port}`;
}

export function emptyInboundForm() {
  return {
    endpointHost: "",
    endpointPort: randomInboundPort(),
    handshakeHost: "www.amd.com",
    handshakePort: 443,
    transportHost: "www.amd.com",
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
    portJumpRange: "",
    nextHopEnabled: false,
    nextHopUri: "",
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

function isIpLiteral(value) {
  const host = String(value || "").trim();
  if (host.includes(":")) return true;
  const octets = host.split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
}

function addManagedDomainResolvers(outbounds) {
  let needsManagedDns = false;
  const resolvedOutbounds = outbounds.map((outbound) => {
    if (!outbound?.server || isIpLiteral(outbound.server) || outbound.domain_resolver) {
      return outbound;
    }
    needsManagedDns = true;
    return {
      ...outbound,
      domain_resolver: {
        server: MANAGED_DNS_TAG,
        strategy: "prefer_ipv4",
      },
    };
  });
  return { resolvedOutbounds, needsManagedDns };
}

function mergeManagedDns(baseDns, needsManagedDns) {
  const hasBaseDns =
    baseDns && typeof baseDns === "object" && !Array.isArray(baseDns);
  const dns = hasBaseDns ? baseDns : {};
  const baseServers = Array.isArray(dns.servers) ? dns.servers : [];
  const foreignServers = baseServers.filter((server) => server?.tag !== MANAGED_DNS_TAG);

  if (needsManagedDns) {
    return {
      ...dns,
      servers: [
        ...foreignServers,
        { type: "local", tag: MANAGED_DNS_TAG },
      ],
    };
  }

  if (foreignServers.length === baseServers.length) return hasBaseDns ? baseDns : undefined;
  const cleaned = { ...dns };
  if (foreignServers.length) cleaned.servers = foreignServers;
  else delete cleaned.servers;
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function buildTls(protocol, form) {
  if (protocol.tlsMode === "none") return null;
  if (protocol.tlsMode === "reality") {
    return {
      enabled: true,
      server_name: trim(form.handshakeHost),
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
  if (!protocol.transport || protocol.transport === "tcp") {
    return null;
  }
  if (protocol.transport === "quic") return { type: "quic" };
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
    // sing-box keeps the IPv6 wildcard on tcp/udp, which creates a dual-stack listener.
    listen: "::",
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

export function buildSingBoxConfig({
  inbounds,
  foreignInbounds = [],
  baseConfig = null,
  managedOutbounds = [],
  managedRouteRules = [],
}) {
  const hasBaseConfig =
    baseConfig && typeof baseConfig === "object" && !Array.isArray(baseConfig);
  const base = hasBaseConfig
    ? baseConfig
    : {
        log: { level: "info", timestamp: true },
        outbounds: [{ type: "direct", tag: "direct" }],
        route: { final: "direct" },
      };
  const baseOutbounds = Array.isArray(base.outbounds) ? base.outbounds : [];
  const foreignOutbounds = baseOutbounds.filter(
    (outbound) => !isManagedNextHopTag(outbound?.tag),
  );
  const baseRoute =
    base.route && typeof base.route === "object" && !Array.isArray(base.route)
      ? base.route
      : {};
  const staleManagedFinal = isManagedNextHopTag(baseRoute.final);
  const hasDirectOutbound = foreignOutbounds.some((outbound) => outbound?.tag === "direct");
  const needsDirectFallback =
    (managedOutbounds.length > 0 && foreignOutbounds.length === 0) ||
    (staleManagedFinal && !hasDirectOutbound);
  const { resolvedOutbounds, needsManagedDns } = addManagedDomainResolvers(
    managedOutbounds,
  );
  const outbounds = [
    ...(needsDirectFallback ? [{ type: "direct", tag: "direct" }] : []),
    ...foreignOutbounds,
    ...resolvedOutbounds,
  ];
  const dns = mergeManagedDns(base.dns, needsManagedDns);

  const foreignRouteRules = (Array.isArray(baseRoute.rules) ? baseRoute.rules : []).filter(
    (rule) => !isManagedNextHopTag(rule?.outbound),
  );
  const route = {
    ...baseRoute,
    ...(managedRouteRules.length || foreignRouteRules.length || Array.isArray(baseRoute.rules)
      ? { rules: [...managedRouteRules, ...foreignRouteRules] }
      : {}),
    ...((needsDirectFallback && !baseRoute.final) || staleManagedFinal
      ? { final: "direct" }
      : {}),
  };

  const config = {
    ...base,
    inbounds: [...foreignInbounds, ...inbounds],
    ...(outbounds.length || Array.isArray(base.outbounds) ? { outbounds } : {}),
    ...(Object.keys(route).length || base.route ? { route } : {}),
  };
  if (dns) config.dns = dns;
  else delete config.dns;
  return config;
}

export function makeInboundId() {
  return crypto.randomUUID();
}
