import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  buildSingBoxConfig,
  buildSingBoxInbound,
  emptyInboundForm,
} from "../src/lib/inbound.js";
import {
  buildClashYamlExport,
  buildSingboxOutboundsExport,
} from "../src/lib/exporters.js";
import { PROTOCOLS } from "../src/lib/protocols.js";
import { generateLocalRealityKeypair } from "../src/lib/realityKeypair.js";
import { readNodeIpAddresses, runExecuteTask } from "../src/lib/nodeget.js";
import { buildControlScript } from "../src/lib/scripts.js";
import {
  buildShareUri,
  formatHostPort,
  shadowsocksPasswordBytes,
} from "../src/lib/singbox.js";
import { parseReadStateOutput } from "../src/lib/state.js";
import {
  buildManagedNextHops,
  describeNextHopUri,
  isManagedNextHopTag,
  parseNextHopUri,
} from "../src/lib/nextHop.js";

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(normalized + "=".repeat((4 - normalized.length % 4) % 4), "base64");
}

function makeForm(protocol, index = 0) {
  const pair = generateLocalRealityKeypair();
  return {
    ...emptyInboundForm(),
    endpointHost: "203.0.113.10",
    endpointPort: 20000 + index,
    handshakeHost: "www.example.com",
    handshakePort: 443,
    transportHost: "www.example.com",
    path: "/nodeget",
    serviceName: "nodeget-grpc",
    uuid: "8099ce00-9d8f-4c7b-bf21-4f7c050082a3",
    shortId: "714aa95fa4fa765a",
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    password: "MDEyMzQ1Njc4OWFiY2RlZg==",
    username: "nodeget",
    portJumpRange: protocol.id === "hysteria2" ? "30000-30100" : "",
  };
}

function mockTaskClient(taskEventResult) {
  const calls = [];
  return {
    calls,
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === "task_create_task") return { id: 42 };
      if (method === "task_query") {
        return [{ success: true, task_event_result: taskEventResult }];
      }
      throw new Error(`unexpected RPC method: ${method}`);
    },
  };
}

for (let index = 0; index < 512; index += 1) {
  const blankForm = emptyInboundForm();
  assert.ok(blankForm.endpointPort >= 10000 && blankForm.endpointPort <= 65500);
  assert.equal(Number.isInteger(blankForm.endpointPort), true);
  assert.equal(blankForm.handshakeHost, "www.amd.com");
  assert.equal(blankForm.transportHost, "www.amd.com");
}

const ipTaskClient = mockTaskClient({ ip: ["198.51.100.8", "2001:db8::8"] });
const nodeAddresses = await readNodeIpAddresses(ipTaskClient, "token", "uuid", {
  pollIntervalMs: 0,
  timeoutMs: 100,
});
assert.deepEqual(nodeAddresses, { ipv4: "198.51.100.8", ipv6: "2001:db8::8" });
assert.equal(ipTaskClient.calls[0].params.task_type, "ip");
assert.deepEqual(ipTaskClient.calls[1].params.task_data_query.condition, [
  { task_id: 42 },
  { type: "ip" },
]);

const executeTaskClient = mockTaskClient({ execute: "ok\n" });
const executeResult = await runExecuteTask(executeTaskClient, "token", "uuid", "true", [], {
  pollIntervalMs: 0,
  timeoutMs: 100,
});
assert.equal(executeResult.output, "ok");
assert.equal(formatHostPort("2001:db8::8", 443), "[2001:db8::8]:443");

const startControlScript = buildControlScript("start");
assert.match(startControlScript, /export NGP_ACTION='start'/);
assert.match(
  startControlScript,
  /start\)\n\s+ngp_migrate_legacy_meta\n\s+ngp_service_enable sing-box\n\s+ngp_service_start sing-box/,
);

for (let index = 0; index < 20; index += 1) {
  const pair = generateLocalRealityKeypair();
  const privateBytes = decodeBase64Url(pair.privateKey);
  const privateDer = Buffer.concat([
    Buffer.from("302e020100300506032b656e04220420", "hex"),
    privateBytes,
  ]);
  const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const publicBytes = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  assert.deepEqual(publicBytes, decodeBase64Url(pair.publicKey));
}

for (const [index, protocol] of PROTOCOLS.entries()) {
  const form = makeForm(protocol, index);
  const generatedInbound = buildSingBoxInbound(protocol.id, form);
  assert.equal(generatedInbound.tag, `nodeget-${protocol.id}-${form.endpointPort}`);
  assert.equal(generatedInbound.listen, "::", `missing dual-stack listen for ${protocol.id}`);
  const shareUri = buildShareUri(protocol.id, form, "test");
  assert.ok(shareUri, `missing URI for ${protocol.id}`);
  if (protocol.id === "socks") assert.match(shareUri, /^socks5:\/\//);
  const parsedNextHop = parseNextHopUri(
    shareUri,
    "nodeget-next-hop-test-" + index,
  );
  assert.equal(
    parsedNextHop.type,
    protocol.family,
    "next-hop URI parsing mismatch for " + protocol.id,
  );
  assert.equal(parsedNextHop.server, form.endpointHost);
  assert.equal(parsedNextHop.tag, "nodeget-next-hop-test-" + index);

  const entry = {
    id: String(index),
    tag: `nodeget-${protocol.id}`,
    protocolId: protocol.id,
    form,
  };
  const singboxExport = JSON.parse(buildSingboxOutboundsExport([entry], "test"));
  assert.equal(singboxExport.outbounds.length, 1, `missing sing-box export for ${protocol.id}`);
  assert.match(buildClashYamlExport([entry], "test"), new RegExp(entry.tag));
}

const ipv6RealityProtocol = PROTOCOLS.find((item) => item.id === "vless-reality");
const ipv6RealityForm = makeForm(ipv6RealityProtocol);
ipv6RealityForm.endpointHost = "2001:db8::8";
assert.ok(
  buildShareUri(ipv6RealityProtocol.id, ipv6RealityForm, "ipv6")
    .includes("@[2001:db8::8]:"),
);

const baseConfig = {
  dns: { servers: [{ tag: "local", address: "local" }] },
  outbounds: [{ type: "block", tag: "blocked" }],
  route: { final: "blocked" },
  experimental: { cache_file: { enabled: true } },
  inbounds: [{ type: "mixed", tag: "foreign" }],
};
const mergedConfig = buildSingBoxConfig({
  baseConfig,
  foreignInbounds: baseConfig.inbounds,
  inbounds: [{ type: "vless", tag: "managed" }],
});
assert.deepEqual(mergedConfig.dns, baseConfig.dns);
assert.deepEqual(mergedConfig.outbounds, baseConfig.outbounds);
assert.deepEqual(mergedConfig.route, baseConfig.route);
assert.deepEqual(mergedConfig.experimental, baseConfig.experimental);
assert.deepEqual(mergedConfig.inbounds.map((item) => item.tag), ["foreign", "managed"]);

const nextHopSecret = "do-not-leak-this-password";
const nextHopEntry = {
  id: "managed-next-hop",
  tag: "nodeget-socks-1080",
  protocolId: "socks",
  form: {
    ...emptyInboundForm(),
    endpointHost: "198.51.100.9",
    endpointPort: 1080,
    nextHopEnabled: true,
    nextHopUri:
      "socks5://proxy-user:" + nextHopSecret + "@[2001:db8::20]:1081",
  },
};
const managedNextHops = buildManagedNextHops([nextHopEntry]);
assert.equal(managedNextHops.outbounds.length, 1);
assert.equal(managedNextHops.outbounds[0].server, "2001:db8::20");
assert.equal(managedNextHops.outbounds[0].password, nextHopSecret);
assert.equal(managedNextHops.routeRules[0].inbound[0], nextHopEntry.tag);
assert.equal(managedNextHops.routeRules[0].action, "route");
assert.ok(isManagedNextHopTag(managedNextHops.outbounds[0].tag));
assert.doesNotMatch(managedNextHops.outbounds[0].tag, /do-not-leak/);
assert.deepEqual(describeNextHopUri(nextHopEntry.form.nextHopUri), {
  type: "socks",
  label: "SOCKS5",
  endpoint: "[2001:db8::20]:1081",
});

const nextHopBaseConfig = {
  inbounds: [{ type: "mixed", tag: "foreign" }],
  outbounds: [
    { type: "block", tag: "blocked" },
    {
      type: "socks",
      tag: "nodeget-next-hop-stale",
      server: "192.0.2.1",
      server_port: 1,
    },
  ],
  route: {
    rules: [
      { inbound: ["foreign"], action: "route", outbound: "blocked" },
      {
        inbound: ["nodeget-old"],
        action: "route",
        outbound: "nodeget-next-hop-stale",
      },
    ],
    final: "nodeget-next-hop-stale",
  },
};
const nextHopMergedConfig = buildSingBoxConfig({
  baseConfig: nextHopBaseConfig,
  foreignInbounds: nextHopBaseConfig.inbounds,
  inbounds: [{ type: "socks", tag: nextHopEntry.tag }],
  managedOutbounds: managedNextHops.outbounds,
  managedRouteRules: managedNextHops.routeRules,
});
assert.deepEqual(
  nextHopMergedConfig.outbounds.map((outbound) => outbound.tag),
  ["direct", "blocked", managedNextHops.outbounds[0].tag],
);
assert.deepEqual(nextHopMergedConfig.route.rules, [
  managedNextHops.routeRules[0],
  nextHopBaseConfig.route.rules[0],
]);
assert.equal(nextHopMergedConfig.route.final, "direct");

const nextHopRemovedConfig = buildSingBoxConfig({
  baseConfig: nextHopMergedConfig,
  foreignInbounds: nextHopBaseConfig.inbounds,
  inbounds: [],
});
assert.deepEqual(nextHopRemovedConfig.outbounds, [
  { type: "direct", tag: "direct" },
  { type: "block", tag: "blocked" },
]);
assert.deepEqual(nextHopRemovedConfig.route.rules, [nextHopBaseConfig.route.rules[0]]);
assert.equal(nextHopRemovedConfig.route.final, "direct");

const nextHopFallbackConfig = buildSingBoxConfig({
  baseConfig: {},
  inbounds: [{ type: "socks", tag: nextHopEntry.tag }],
  managedOutbounds: managedNextHops.outbounds,
  managedRouteRules: managedNextHops.routeRules,
});
assert.equal(nextHopFallbackConfig.outbounds[0].tag, "direct");
assert.equal(nextHopFallbackConfig.route.final, "direct");
assert.throws(
  () => parseNextHopUri("socks5://127.0.0.1:1080?unsupported=1"),
  /暂不支持 URI 参数：unsupported/,
);
const httpNextHop = parseNextHopUri(
  "http://proxy-user:p%40ss@proxy.example:3128",
);
assert.equal(httpNextHop.type, "http");
assert.equal(httpNextHop.username, "proxy-user");
assert.equal(httpNextHop.password, "p@ss");
assert.equal(httpNextHop.server_port, 3128);
const httpsNextHop = parseNextHopUri("https://proxy.example");
assert.equal(httpsNextHop.server_port, 443);
assert.equal(httpsNextHop.tls.enabled, true);
const legacyShadowsocksUri =
  "ss://" + Buffer.from("aes-128-gcm:secret@203.0.113.20:8388").toString("base64");
const legacyShadowsocks = parseNextHopUri(legacyShadowsocksUri);
assert.equal(legacyShadowsocks.type, "shadowsocks");
assert.equal(legacyShadowsocks.method, "aes-128-gcm");
assert.equal(legacyShadowsocks.password, "secret");
assert.equal(legacyShadowsocks.server, "203.0.113.20");
const packetEncodingVless = parseNextHopUri(
  "vless://8099ce00-9d8f-4c7b-bf21-4f7c050082a3@203.0.113.20:443" +
    "?encryption=none&type=tcp&packetEncoding=xudp",
);
assert.equal(packetEncodingVless.packet_encoding, "xudp");
const advancedTuic = parseNextHopUri(
  "tuic://8099ce00-9d8f-4c7b-bf21-4f7c050082a3:secret@203.0.113.20:443" +
    "?sni=example.com&udp_relay_mode=native&zero_rtt_handshake=1",
);
assert.equal(advancedTuic.udp_relay_mode, "native");
assert.equal(advancedTuic.zero_rtt_handshake, true);
const invalidVmessPayload = Buffer.from(
  JSON.stringify({
    add: "203.0.113.20",
    port: "443",
    id: "8099ce00-9d8f-4c7b-bf21-4f7c050082a3",
    aid: "invalid",
  }),
).toString("base64");
assert.throws(
  () => parseNextHopUri("vmess://" + invalidVmessPayload),
  /Alter ID 无效/,
);
assert.throws(
  () => parseNextHopUri("hy2://secret@203.0.113.20:443?mport=50000-40000"),
  /起始端口不能大于结束端口/,
);
assert.throws(
  () => parseNextHopUri("hy2://secret@203.0.113.20:443?upmbps=fast"),
  /upmbps需要大于 0/,
);

const stateOutput = [
  "NGP_CONFIG_BEGIN",
  JSON.stringify(baseConfig),
  "NGP_CONFIG_END",
  "NGP_META_BEGIN",
  JSON.stringify({ version: 2, inbounds: [] }),
  "NGP_META_END",
].join("\n");
const state = parseReadStateOutput(stateOutput);
assert.equal(state.foreignInbounds.length, 1);
assert.equal(state.configParseError, false);
assert.equal(state.metaParseError, false);
assert.equal(
  parseReadStateOutput(`${stateOutput}\n[... Output truncated, 20 bytes omitted ...]`)
    .outputTruncated,
  true,
);

const vmessProtocol = PROTOCOLS.find((item) => item.id === "vmess-ws");
const vmessForm = makeForm(vmessProtocol);
const vmessPayload = JSON.parse(
  Buffer.from(buildShareUri(vmessProtocol.id, vmessForm).slice("vmess://".length), "base64")
    .toString("utf8"),
);
assert.equal(vmessPayload.path, "/nodeget");

const trojanProtocol = PROTOCOLS.find((item) => item.id === "trojan-ws-tls");
const trojanUri = new URL(buildShareUri(trojanProtocol.id, makeForm(trojanProtocol)));
assert.equal(trojanUri.searchParams.get("type"), "ws");
assert.equal(trojanUri.searchParams.get("path"), "/nodeget");

const vmessQuic = PROTOCOLS.find((item) => item.id === "vmess-quic");
const vmessQuicInbound = buildSingBoxInbound(vmessQuic.id, makeForm(vmessQuic));
assert.equal(vmessQuicInbound.transport.type, "quic");
assert.equal(vmessQuicInbound.tls.enabled, true);

assert.equal(shadowsocksPasswordBytes("2022-blake3-aes-128-gcm"), 16);
assert.equal(shadowsocksPasswordBytes("2022-blake3-aes-256-gcm"), 32);
assert.equal(shadowsocksPasswordBytes("2022-blake3-chacha20-poly1305"), 32);

const hysteriaProtocol = PROTOCOLS.find((item) => item.id === "hysteria2");
const hysteriaEntry = {
  id: "hysteria2",
  tag: "nodeget-hysteria2",
  protocolId: hysteriaProtocol.id,
  form: makeForm(hysteriaProtocol),
};
const hysteriaOutbound = JSON.parse(
  buildSingboxOutboundsExport([hysteriaEntry], "test"),
).outbounds[0];
assert.deepEqual(hysteriaOutbound.server_ports, ["30000:30100"]);
assert.equal("server_port" in hysteriaOutbound, false);

console.log(`verified ${PROTOCOLS.length} protocols and deployment safety invariants`);
