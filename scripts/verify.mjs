import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { migrateSingBoxConfigFor114 } from "../src/lib/configMigration.js";
import { PROTOCOLS } from "../src/lib/protocols.js";
import { generateLocalRealityKeypair } from "../src/lib/realityKeypair.js";
import { readNodeIpAddresses, runExecuteTask } from "../src/lib/nodeget.js";
import { buildControlScript, buildUpgradeScript } from "../src/lib/scripts.js";
import {
  buildShareUri,
  formatHostPort,
  shadowsocksPasswordBytes,
} from "../src/lib/singbox.js";
import { parseReadStateOutput, parseUpgradeOutput } from "../src/lib/state.js";
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

const failedExecuteClient = {
  async rpc(method) {
    if (method === "task_create_task") return { id: 43 };
    if (method === "task_query") {
      return [{
        success: false,
        error_message: "exit status 1",
        task_event_result: { execute: "NGP_ERROR=release_checksum_mismatch" },
      }];
    }
    throw new Error(`unexpected RPC method: ${method}`);
  },
};
await assert.rejects(
  runExecuteTask(failedExecuteClient, "token", "uuid", "false", [], {
    pollIntervalMs: 0,
    timeoutMs: 100,
  }),
  /exit status 1\nNGP_ERROR=release_checksum_mismatch/,
);
assert.equal(formatHostPort("2001:db8::8", 443), "[2001:db8::8]:443");

const startControlScript = buildControlScript("start");
assert.match(startControlScript, /export NGP_ACTION='start'/);
assert.match(
  startControlScript,
  /start\)\n\s+ngp_migrate_legacy_meta\n\s+ngp_service_enable sing-box\n\s+ngp_service_start sing-box/,
);

const upgradeScript = buildUpgradeScript();
const upgradeSyntax = spawnSync("sh", ["-n"], {
  input: upgradeScript,
  encoding: "utf8",
});
assert.equal(upgradeSyntax.status, 0, upgradeSyntax.stderr);
assert.match(
  upgradeScript,
  /https:\/\/api\.github\.com\/repos\/SagerNet\/sing-box\/releases\/latest/,
);
assert.match(upgradeScript, /release_checksum_mismatch/);
assert.match(upgradeScript, /check -c "\$config_to_check"/);
assert.match(upgradeScript, /service_restart_failed_upgrade_rolled_back/);
assert.match(upgradeScript, /rollback_upgrade/);
assert.match(upgradeScript, /NGP_UPGRADE_STATUS/);
const migrationUpgradeScript = buildUpgradeScript({
  config: { log: { level: "warn" } },
  configSha256: "a".repeat(64),
  migrationCount: 1,
});
assert.match(migrationUpgradeScript, /export NGP_MIGRATION_COUNT='1'/);
assert.match(migrationUpgradeScript, /export NGP_MIGRATED_CONFIG_B64='[^']+'/);
assert.match(migrationUpgradeScript, /export NGP_EXPECTED_CONFIG_SHA256='a{64}'/);
assert.deepEqual(
  parseUpgradeOutput([
    "NGP_UPGRADE_STATUS=upgraded",
    "NGP_SINGBOX_VERSION_OLD=1.13.21",
    "NGP_SINGBOX_VERSION_NEW=1.14.0",
    "NGP_RELEASE_TAG=v1.14.0",
    "NGP_BACKUP_BIN=/usr/local/bin/sing-box.nodeget-pre-upgrade.bak",
    "NGP_BACKUP_CONFIG=/etc/sing-box/config.json.nodeget-pre-upgrade.bak",
    "NGP_MIGRATION_COUNT=7",
    `NGP_CONFIG_SHA256=${"b".repeat(64)}`,
    "NGP_SERVICE_ACTIVE=active",
  ].join("\n")),
  {
    status: "upgraded",
    oldVersion: "1.13.21",
    newVersion: "1.14.0",
    releaseTag: "v1.14.0",
    backupBin: "/usr/local/bin/sing-box.nodeget-pre-upgrade.bak",
    backupConfig: "/etc/sing-box/config.json.nodeget-pre-upgrade.bak",
    migrationCount: 7,
    configSha256: "b".repeat(64),
    serviceActive: "active",
  },
);

const legacy114Config = {
  dns: {
    servers: [
      { tag: "local", address: "local" },
      {
        tag: "remote",
        address: "https://dns.example/dns-query",
        address_resolver: "local",
        address_strategy: "prefer_ipv4",
      },
      { tag: "blocked", address: "rcode://refused" },
      { tag: "fakeip", address: "fakeip" },
    ],
    rules: [
      { domain: "blocked.example", server: "blocked" },
      { outbound: "any", server: "local" },
    ],
    fakeip: { enabled: true, inet4_range: "198.18.0.0/15" },
    independent_cache: true,
  },
  outbounds: [
    {
      type: "socks",
      tag: "proxy",
      server: "proxy.example",
      server_port: 1080,
      domain_strategy: "prefer_ipv4",
    },
  ],
  route: { final: "proxy" },
  experimental: { cache_file: { enabled: true, store_rdrc: true } },
};
const legacy114Snapshot = structuredClone(legacy114Config);
const migrated114 = migrateSingBoxConfigFor114(legacy114Config);
assert.deepEqual(legacy114Config, legacy114Snapshot);
assert.ok(migrated114.changes.length >= 7);
assert.deepEqual(migrated114.config.dns.servers, [
  { tag: "local", type: "local" },
  {
    tag: "remote",
    type: "https",
    server: "dns.example",
    path: "/dns-query",
    domain_resolver: { server: "local", strategy: "prefer_ipv4" },
  },
  { tag: "fakeip", type: "fakeip", inet4_range: "198.18.0.0/15" },
]);
assert.deepEqual(migrated114.config.dns.rules, [
  { domain: "blocked.example", action: "predefined", rcode: "REFUSED" },
]);
assert.equal("fakeip" in migrated114.config.dns, false);
assert.equal("independent_cache" in migrated114.config.dns, false);
assert.deepEqual(migrated114.config.route, {
  final: "proxy",
  default_domain_resolver: { server: "local" },
});
assert.deepEqual(migrated114.config.outbounds[0].domain_resolver, {
  server: "local",
  strategy: "prefer_ipv4",
});
assert.equal("domain_strategy" in migrated114.config.outbounds[0], false);
assert.deepEqual(migrated114.config.experimental.cache_file, {
  enabled: true,
  store_dns: true,
});

assert.throws(
  () => migrateSingBoxConfigFor114({
    dns: {
      servers: [{ tag: "local", address: "local" }],
      rules: [{ outbound: "any", domain: "example.com", server: "local" }],
    },
  }),
  /包含条件或动作.*无法等价自动迁移/,
);
const modern114Config = {
  dns: { servers: [{ type: "local", tag: "local" }] },
  outbounds: [{ type: "direct", tag: "direct", domain_resolver: "local" }],
  route: { final: "direct" },
};
const modern114 = migrateSingBoxConfigFor114(modern114Config);
assert.deepEqual(modern114, { config: modern114Config, changes: [] });
assert.notEqual(modern114.config, modern114Config);

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

const domainNextHopEntry = {
  ...nextHopEntry,
  tag: "nodeget-socks-domain",
  form: {
    ...nextHopEntry.form,
    nextHopUri: "socks5://proxy-user:secret@proxy.example:1080",
  },
};
const domainNextHops = buildManagedNextHops([domainNextHopEntry]);
const domainNextHopConfig = buildSingBoxConfig({
  baseConfig: {
    dns: {
      servers: [{ type: "udp", tag: "existing-dns", server: "1.1.1.1" }],
    },
    outbounds: [{ type: "direct", tag: "direct" }],
    route: { final: "direct" },
  },
  inbounds: [{ type: "socks", tag: domainNextHopEntry.tag }],
  managedOutbounds: domainNextHops.outbounds,
  managedRouteRules: domainNextHops.routeRules,
});
assert.deepEqual(domainNextHopConfig.dns.servers, [
  { type: "udp", tag: "existing-dns", server: "1.1.1.1" },
  { type: "local", tag: "nodeget-next-hop-local" },
]);
assert.deepEqual(
  domainNextHopConfig.outbounds.at(-1).domain_resolver,
  { server: "nodeget-next-hop-local", strategy: "prefer_ipv4" },
);
assert.equal("domain_resolver" in nextHopFallbackConfig.outbounds.at(-1), false);

const domainNextHopRemovedConfig = buildSingBoxConfig({
  baseConfig: domainNextHopConfig,
  inbounds: [],
});
assert.deepEqual(domainNextHopRemovedConfig.dns.servers, [
  { type: "udp", tag: "existing-dns", server: "1.1.1.1" },
]);
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

const shadowsocks2022Protocol = PROTOCOLS.find((item) => item.id === "shadowsocks");
const shadowsocks2022Form = makeForm(shadowsocks2022Protocol);
shadowsocks2022Form.password = "MDEy+MzQvNTY:Nzg@OWFiY2RlZg==";
const shadowsocks2022Uri = buildShareUri(
  shadowsocks2022Protocol.id,
  shadowsocks2022Form,
  "SS 2022",
);
assert.match(
  shadowsocks2022Uri,
  /^ss:\/\/2022-blake3-aes-128-gcm:MDEy%2BMzQvNTY%3ANzg%40OWFiY2RlZg%3D%3D@/,
);
const parsedShadowsocks2022 = parseNextHopUri(shadowsocks2022Uri);
assert.equal(parsedShadowsocks2022.method, shadowsocks2022Form.method);
assert.equal(parsedShadowsocks2022.password, shadowsocks2022Form.password);

const legacyShadowsocksForm = {
  ...shadowsocks2022Form,
  method: "aes-128-gcm",
  password: "legacy-secret",
};
const generatedLegacyShadowsocksUri = buildShareUri(
  shadowsocks2022Protocol.id,
  legacyShadowsocksForm,
  "Legacy SS",
);
const generatedLegacyUserInfo = generatedLegacyShadowsocksUri
  .slice("ss://".length)
  .split("@", 1)[0];
assert.doesNotMatch(generatedLegacyUserInfo, /[+/=]/);
const parsedGeneratedLegacyShadowsocks = parseNextHopUri(generatedLegacyShadowsocksUri);
assert.equal(parsedGeneratedLegacyShadowsocks.method, legacyShadowsocksForm.method);
assert.equal(parsedGeneratedLegacyShadowsocks.password, legacyShadowsocksForm.password);
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
  `NGP_CONFIG_SHA256=${"c".repeat(64)}`,
  "NGP_CONFIG_BEGIN",
  JSON.stringify(baseConfig),
  "NGP_CONFIG_END",
  "NGP_META_BEGIN",
  JSON.stringify({ version: 2, inbounds: [] }),
  "NGP_META_END",
].join("\n");
const state = parseReadStateOutput(stateOutput);
assert.equal(state.configSha256, "c".repeat(64));
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
