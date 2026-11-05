import { getEntryEngine } from "./protocols";
import { makeInboundTag } from "./inbound";
import { formatHostPort } from "./singbox";

export const XRAY_RELEASE = "v26.10.21";
export const MIHOMO_BASELINE = "v1.19.33";
export const XHTTP_PROTOCOL = "vless-xhttp-reality";

export function validateXhttpForm(form) {
  const port = Number(form.endpointPort);
  const handshakePort = Number(form.handshakePort);
  if (![port, handshakePort].every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
    throw new Error("XHTTP 端口和 SNI 端口必须是 1–65535 的整数");
  }
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(form.uuid).trim())) {
    throw new Error("XHTTP UUID 格式无效");
  }
  if (!/^(?:[0-9a-f]{2}){1,8}$/i.test(String(form.shortId).trim())) {
    throw new Error("XHTTP Short ID 必须为 2–16 位偶数长度十六进制");
  }
  if (!String(form.path || "").startsWith("/")) throw new Error("XHTTP 路径需以 / 开头");
  if (!form.handshakeHost || /[\s/:]/.test(form.handshakeHost)) throw new Error("XHTTP SNI 必须是有效域名");
  if (form.nextHopEnabled) throw new Error("首版 XHTTP 仅支持本机直出，不支持下一跳节点");
}

export function buildXrayInbound(protocolId, form) {
  if (protocolId !== XHTTP_PROTOCOL) throw new Error("Xray 首版仅支持 VLESS + XHTTP + REALITY");
  validateXhttpForm(form);
  if (!/^[A-Za-z0-9_-]{43}$/.test(form.privateKey || "")) throw new Error("XHTTP 缺少有效的 Reality 私钥");
  return {
    tag: makeInboundTag(protocolId, Number(form.endpointPort)),
    listen: "::",
    port: Number(form.endpointPort),
    protocol: "vless",
    settings: {
      clients: [{ id: form.uuid.trim() }],
      decryption: "none",
    },
    streamSettings: {
      network: "xhttp",
      security: "reality",
      realitySettings: {
        show: false,
        target: formatHostPort(form.handshakeHost.trim(), Number(form.handshakePort)),
        xver: 0,
        serverNames: [form.handshakeHost.trim()],
        privateKey: form.privateKey,
        shortIds: [form.shortId.trim()],
      },
      xhttpSettings: {
        path: form.path.trim(),
        mode: "stream-one",
        ...(form.transportHost?.trim() ? { host: form.transportHost.trim() } : {}),
      },
    },
  };
}

export function buildXrayConfig(entries, base = null, previousEntries = []) {
  const previousTags = new Set(previousEntries.map((entry) => entry.tag));
  const tags = entries.map((entry) => entry.tag);
  const directTag = "nodeget-xray-direct";
  return {
    log: { loglevel: "warning" },
    dns: { servers: ["localhost"], queryStrategy: "UseIP" },
    ...(base || {}),
    inbounds: [...(base?.inbounds || []).filter((entry) => !previousTags.has(entry.tag)), ...entries.map((entry) => {
      if (getEntryEngine(entry) !== "xray") throw new Error("不能将 sing-box 入站写入 Xray 配置");
      const inbound = buildXrayInbound(entry.protocolId, entry.form);
      if (inbound.tag !== entry.tag) throw new Error("XHTTP 元数据 tag 与端口不一致，请重新读取并修复");
      return inbound;
    })],
    outbounds: [
      ...(base?.outbounds || []).filter((entry) => entry.tag !== directTag),
      { tag: directTag, protocol: "freedom", settings: {}, streamSettings: { sockopt: { domainStrategy: "UseIPv4v6" } } },
    ],
    routing: {
      ...(base?.routing || {}),
      rules: [
        ...(tags.length ? [{ type: "field", inboundTag: tags, outboundTag: directTag }] : []),
        ...(base?.routing?.rules || []).filter((rule) => rule.outboundTag !== directTag),
      ],
    },
  };
}

// Sharing XHTTP is supported independently of the sing-box next-hop URI parser.
export function validateXhttpShareUri(uri) {
  const url = new URL(uri);
  const p = url.searchParams;
  if (url.protocol !== "vless:" || !url.hostname || !url.port ||
      p.get("type") !== "xhttp" || p.get("security") !== "reality" ||
      p.get("mode") !== "stream-one" || p.get("alpn") !== "h2" ||
      p.get("support-x25519mlkem768") !== "true" ||
      p.has("flow") || !/^[A-Za-z0-9_-]{43}$/.test(p.get("pbk") || "")) {
    throw new Error("XHTTP 分享 URI 参数不完整或不受支持");
  }
  validateXhttpForm({
    endpointPort: url.port, handshakePort: 443, uuid: decodeURIComponent(url.username),
    shortId: p.get("sid"), handshakeHost: p.get("sni"), path: p.get("path"),
  });
}
