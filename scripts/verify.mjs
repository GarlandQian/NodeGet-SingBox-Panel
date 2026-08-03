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
import {
  buildShareUri,
  shadowsocksPasswordBytes,
} from "../src/lib/singbox.js";
import { parseReadStateOutput } from "../src/lib/state.js";

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
  assert.ok(buildShareUri(protocol.id, form, "test"), `missing URI for ${protocol.id}`);

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
