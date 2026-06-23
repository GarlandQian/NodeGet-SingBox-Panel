import { buildShareUri } from "./singbox";
import { getProtocol } from "./protocols";

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== ""),
  );
}

function buildOutboundTransport(protocol, form) {
  if (!protocol.transport || protocol.transport === "tcp" || protocol.transport === "quic") {
    return null;
  }
  if (protocol.transport === "ws") {
    return compactObject({
      type: "ws",
      path: form.path || "/",
      headers: form.transportHost ? { Host: form.transportHost } : undefined,
    });
  }
  if (protocol.transport === "http") {
    return compactObject({
      type: "http",
      path: form.path || "/",
      host: form.transportHost ? [form.transportHost] : undefined,
    });
  }
  if (protocol.transport === "grpc") {
    return compactObject({
      type: "grpc",
      service_name: form.serviceName || "",
    });
  }
  if (protocol.transport === "httpupgrade") {
    return compactObject({
      type: "httpupgrade",
      path: form.path || "/",
      host: form.transportHost,
    });
  }
  return null;
}

function inboundToClashProxy(inbound, fallbackLabel) {
  const protocol = getProtocol(inbound.protocolId);
  if (!protocol) return null;
  const { form, tag } = inbound;
  const name = `${fallbackLabel}-${tag}`;
  const server = form.endpointHost;
  const port = Number(form.endpointPort);
  if (!server || !port) return null;

  if (protocol.family === "vless") {
    const proxy = compactObject({
      name,
      type: "vless",
      server,
      port,
      uuid: form.uuid,
      udp: true,
      tls: protocol.tlsMode !== "none",
    });
    if (protocol.tlsMode === "reality") {
      proxy.servername = form.handshakeHost;
      proxy["client-fingerprint"] = "chrome";
      if (protocol.transport === "tcp") proxy.flow = "xtls-rprx-vision";
      proxy["reality-opts"] = {
        "public-key": form.publicKey,
        "short-id": form.shortId,
      };
    } else if (protocol.tlsMode === "cert") {
      proxy.servername = form.handshakeHost;
    }
    if (protocol.transport === "tcp") {
      proxy.network = "tcp";
    } else if (protocol.transport === "ws") {
      proxy.network = "ws";
      proxy["ws-opts"] = {
        path: form.path || "/",
        ...(form.transportHost ? { headers: { Host: form.transportHost } } : {}),
      };
    } else if (protocol.transport === "grpc") {
      proxy.network = "grpc";
      proxy["grpc-opts"] = { "grpc-service-name": form.serviceName || "" };
    } else if (protocol.transport === "http") {
      proxy.network = "h2";
      proxy["h2-opts"] = {
        path: form.path || "/",
        host: form.transportHost ? [form.transportHost] : undefined,
      };
    } else if (protocol.transport === "httpupgrade") {
      proxy.network = "httpupgrade";
      proxy["http-opts"] = {
        path: form.path || "/",
        host: form.transportHost,
      };
    }
    return proxy;
  }

  if (protocol.family === "vmess") {
    const proxy = {
      name,
      type: "vmess",
      server,
      port,
      uuid: form.uuid,
      alterId: Number(form.alterId || 0),
      cipher: "auto",
      udp: true,
      tls: protocol.tlsMode === "cert",
    };
    if (protocol.transport === "ws") {
      proxy.network = "ws";
      proxy["ws-opts"] = {
        path: form.path || "/",
        ...(form.transportHost ? { headers: { Host: form.transportHost } } : {}),
      };
    } else if (protocol.transport === "grpc") {
      proxy.network = "grpc";
      proxy["grpc-opts"] = { "grpc-service-name": form.serviceName || "" };
    } else if (protocol.transport === "http") {
      proxy.network = "h2";
    }
    if (protocol.tlsMode === "cert" && form.handshakeHost) proxy.servername = form.handshakeHost;
    return proxy;
  }

  if (protocol.family === "trojan") {
    const proxy = {
      name,
      type: "trojan",
      server,
      port,
      password: form.password,
      udp: true,
      sni: form.handshakeHost,
    };
    if (protocol.transport === "ws") {
      proxy.network = "ws";
      proxy["ws-opts"] = {
        path: form.path || "/",
        ...(form.transportHost ? { headers: { Host: form.transportHost } } : {}),
      };
    } else if (protocol.transport === "grpc") {
      proxy.network = "grpc";
      proxy["grpc-opts"] = { "grpc-service-name": form.serviceName || "" };
    }
    return proxy;
  }

  if (protocol.family === "shadowsocks") {
    return {
      name,
      type: "ss",
      server,
      port,
      cipher: form.method,
      password: form.password,
      udp: true,
    };
  }

  if (protocol.family === "tuic") {
    return {
      name,
      type: "tuic",
      server,
      port,
      uuid: form.uuid,
      password: form.password,
      sni: form.handshakeHost,
      "congestion-controller": form.congestionControl || "cubic",
      "alpn": ["h3"],
    };
  }

  if (protocol.family === "hysteria2") {
    const proxy = {
      name,
      type: "hysteria2",
      server,
      port,
      password: form.password,
      sni: form.handshakeHost,
      alpn: ["h3"],
    };
    if (form.upMbps) proxy.up = `${form.upMbps} Mbps`;
    if (form.downMbps) proxy.down = `${form.downMbps} Mbps`;
    if (form.obfsType && form.obfsPassword) {
      proxy.obfs = form.obfsType;
      proxy["obfs-password"] = form.obfsPassword;
    }
    if (form.portJumpRange) proxy.ports = form.portJumpRange;
    return proxy;
  }

  if (protocol.family === "anytls") {
    return {
      name,
      type: "anytls",
      server,
      port,
      password: form.password,
      sni: form.handshakeHost,
    };
  }

  return null;
}

function yamlScalar(value) {
  if (value == null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  if (text === "" || /[:#\[\]{},&*?|<>=!%@`"\\\n]/.test(text) || /^\s|\s$/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function emitYaml(value, indent = 0) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          const body = emitYaml(item, indent + 1).replace(
            new RegExp(`^ {${(indent + 1) * 2}}`),
            "",
          );
          return `${pad}- ${body}`;
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return "{}";
    return entries
      .map(([key, v]) => {
        if (v && typeof v === "object") {
          return `${pad}${key}:\n${emitYaml(v, indent + 1)}`;
        }
        return `${pad}${key}: ${yamlScalar(v)}`;
      })
      .join("\n");
  }
  return yamlScalar(value);
}

export function buildPlainTextExport(inbounds, label) {
  return inbounds
    .map((inbound) => buildShareUri(inbound.protocolId, inbound.form, `${label}-${inbound.tag}`))
    .filter(Boolean)
    .join("\n");
}

export function buildClashYamlExport(inbounds, label) {
  const proxies = inbounds.map((it) => inboundToClashProxy(it, label)).filter(Boolean);
  if (!proxies.length) return "";
  const yaml = emitYaml({ proxies }, 0);
  return `${yaml}\n`;
}

export function buildSingboxOutboundsExport(inbounds, label) {
  const outbounds = inbounds.map((inbound) => {
    const protocol = getProtocol(inbound.protocolId);
    if (!protocol) return null;
    const { form, tag } = inbound;
    const transport = buildOutboundTransport(protocol, form);
    const base = {
      type: protocol.family,
      tag: `${label}-${tag}`,
      server: form.endpointHost,
      server_port: Number(form.endpointPort),
      ...(transport ? { transport } : {}),
    };
    if (protocol.family === "vless") {
      const out = { ...base, uuid: form.uuid };
      if (protocol.tlsMode === "reality") {
        out.tls = {
          enabled: true,
          server_name: form.handshakeHost,
          utls: { enabled: true, fingerprint: "chrome" },
          reality: { enabled: true, public_key: form.publicKey, short_id: form.shortId },
        };
        if (protocol.transport === "tcp") out.flow = "xtls-rprx-vision";
      } else if (protocol.tlsMode === "cert") {
        out.tls = { enabled: true, server_name: form.handshakeHost };
      }
      return out;
    }
    if (protocol.family === "vmess") {
      return {
        ...base,
        uuid: form.uuid,
        alter_id: Number(form.alterId || 0),
        security: "auto",
        ...(protocol.tlsMode === "cert"
          ? { tls: { enabled: true, server_name: form.handshakeHost } }
          : {}),
      };
    }
    if (protocol.family === "trojan") {
      return {
        ...base,
        password: form.password,
        tls: { enabled: true, server_name: form.handshakeHost },
      };
    }
    if (protocol.family === "shadowsocks") {
      return { ...base, method: form.method, password: form.password };
    }
    if (protocol.family === "tuic") {
      return {
        ...base,
        uuid: form.uuid,
        password: form.password,
        congestion_control: form.congestionControl || "cubic",
        tls: { enabled: true, server_name: form.handshakeHost, alpn: ["h3"] },
      };
    }
    if (protocol.family === "hysteria2") {
      const out = {
        ...base,
        password: form.password,
        tls: { enabled: true, server_name: form.handshakeHost, alpn: ["h3"] },
      };
      if (form.upMbps) out.up_mbps = Number(form.upMbps);
      if (form.downMbps) out.down_mbps = Number(form.downMbps);
      if (form.obfsType && form.obfsPassword) {
        out.obfs = { type: form.obfsType, password: form.obfsPassword };
      }
      return out;
    }
    if (protocol.family === "anytls") {
      return {
        ...base,
        password: form.password,
        tls: { enabled: true, server_name: form.handshakeHost },
      };
    }
    return null;
  }).filter(Boolean);
  return JSON.stringify({ outbounds }, null, 2) + "\n";
}

export function triggerDownload(filename, contents, mime = "text/plain") {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
