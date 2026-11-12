import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import dgram from "node:dgram";
import { once } from "node:events";
import { emptyInboundForm } from "../src/lib/inbound.js";
import { generateLocalRealityKeypair } from "../src/lib/realityKeypair.js";
import { buildXrayConfig, XHTTP_PROTOCOL, XRAY_RELEASE, MIHOMO_BASELINE } from "../src/lib/xray.js";
import { buildClashYamlExport } from "../src/lib/exporters.js";
import { buildShareUri } from "../src/lib/singbox.js";

const [xrayArg, mihomoArg] = process.argv.slice(2);
if (!xrayArg || !mihomoArg) throw new Error("Usage: bun scripts/verify-xhttp-live.mjs /path/to/xray /path/to/mihomo");
const xrayBin = realpathSync(xrayArg);
const mihomoBin = realpathSync(mihomoArg);
const taskDir = mkdtempSync(join(tmpdir(), "nodeget-xhttp-live-"));
const children = new Set();
const servers = new Set();
const relaySockets = new Set();
const concurrentRequests = 12;
let childLogs = "";

function checked(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

function launch(binary, args) {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { childLogs = (childLogs + chunk.toString()).slice(-16000); });
  }
  return child;
}

async function listen(server, host = "127.0.0.1") {
  servers.add(server);
  server.listen(0, host);
  await once(server, "listening");
  return server.address().port;
}

async function freePort(host = "127.0.0.1") {
  const server = net.createServer();
  const port = await listen(server, host);
  await new Promise((resolve) => server.close(resolve));
  servers.delete(server);
  return port;
}

async function waitPort(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`core exited early (${child.exitCode})`);
    const ready = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.setTimeout(200);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("core listener startup timed out");
}

function proxyGet(proxyPort, targetPort, requestPath = "/through-xhttp") {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1", port: proxyPort,
      path: `http://127.0.0.1:${targetPort}${requestPath}`,
      headers: { Host: `127.0.0.1:${targetPort}`, Connection: "close" },
      timeout: 15000,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (data) => { body += data; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("proxy HTTP timed out")));
  });
}

async function proxyUdp(proxyPort, targetPort) {
  const control = net.connect({ host: "127.0.0.1", port: proxyPort });
  control.setTimeout(15000, () => control.destroy(new Error("SOCKS control timed out")));
  const socket = dgram.createSocket("udp4");
  try {
    await once(control, "connect");
    const greeting = once(control, "data");
    control.write(Buffer.from([5, 1, 0]));
    assert.equal((await greeting)[0][1], 0);
    const associate = once(control, "data");
    control.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
    const reply = (await associate)[0];
    assert.equal(reply[1], 0);
    const udpPort = reply.readUInt16BE(reply.length - 2);
    socket.bind(0, "127.0.0.1");
    await once(socket, "listening");
    const payload = Buffer.from("nodeget-xhttp-udp-ok");
    const header = Buffer.from([0, 0, 0, 1, 127, 0, 0, 1, targetPort >> 8, targetPort & 255]);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("proxy UDP timed out")), 15000);
      socket.once("message", (message) => { clearTimeout(timer); resolve(message); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    socket.send(Buffer.concat([header, payload]), udpPort, "127.0.0.1");
    const message = await response;
    assert.equal(message.subarray(message.length - payload.length).toString(), payload.toString());
  } finally {
    control.destroy();
    try { socket.close(); } catch { /* not bound */ }
  }
}

try {
  assert.ok(checked(xrayBin, ["version"]).includes(XRAY_RELEASE.slice(1)), "unexpected Xray baseline");
  assert.ok(checked(mihomoBin, ["-v"]).includes(MIHOMO_BASELINE), "unexpected Mihomo baseline");
  checked("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=example.test",
    "-keyout", join(taskDir, "key.pem"), "-out", join(taskDir, "cert.pem")]);
  const target = http2.createSecureServer({
    key: readFileSync(join(taskDir, "key.pem")), cert: readFileSync(join(taskDir, "cert.pem")),
    minVersion: "TLSv1.3", allowHTTP1: true,
  });
  target.on("request", (_request, response) => { response.end("local TLS target"); });
  const targetPort = await listen(target);
  const pendingRequests = new Map();
  const destination = http.createServer((request, response) => {
    if (!request.url.startsWith("/mux/")) {
      response.end("nodeget-xhttp-tcp-ok");
      return;
    }
    const id = request.url.slice("/mux/".length);
    pendingRequests.set(id, response);
    // Hold every response until all requests arrive, proving concurrent streams rather than sequential reuse.
    if (pendingRequests.size === concurrentRequests) {
      for (const [key, pending] of pendingRequests) pending.end(`nodeget-xhttp-mux-${key}`);
      pendingRequests.clear();
    }
  });
  const destinationPort = await listen(destination);
  const udpEcho = dgram.createSocket("udp4");
  udpEcho.on("message", (message, remote) => udpEcho.send(message, remote.port, remote.address));
  udpEcho.bind(0, "127.0.0.1");
  await once(udpEcho, "listening");
  servers.add(udpEcho);
  const port = await freePort("::");
  const form = {
    ...emptyInboundForm(), ...generateLocalRealityKeypair(), endpointPort: port,
    uuid: crypto.randomUUID(), shortId: "714aa95fa4fa765a", handshakeHost: "example.test", transportHost: "example.test", path: "/nodeget-live",
  };
  const entry = { id: "live", protocolId: XHTTP_PROTOCOL, tag: `nodeget-${XHTTP_PROTOCOL}-${port}`, form };
  const config = buildXrayConfig([entry]);
  if (process.env.NGP_SMOKE_DEBUG) config.log = { loglevel: "debug" };
  // Bind both address families to loopback while retaining the generated transport settings.
  config.inbounds[0].listen = "127.0.0.1";
  config.inbounds.push({ ...structuredClone(config.inbounds[0]), listen: "::1", tag: `${entry.tag}-ipv6` });
  config.routing.rules[0].inboundTag.push(`${entry.tag}-ipv6`);
  // Only replace the handshake target with our local TLS fixture, not the protocol settings.
  for (const inbound of config.inbounds) inbound.streamSettings.realitySettings.target = `127.0.0.1:${targetPort}`;
  // The release blocks loopback proxy destinations by default. Allow only our fixture here.
  config.outbounds[0].settings.finalRules = [{ action: "allow", ip: ["127.0.0.1/32", "::1/128"] }];
  const configPath = join(taskDir, "xray.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  checked(xrayBin, ["run", "-test", "-config", configPath]);
  const xray = launch(xrayBin, ["run", "-config", configPath]);
  await waitPort(port, xray);
  for (const host of ["127.0.0.1", "::1"]) {
    let tcpConnections = 0;
    // Observe encrypted client-to-Xray connections without changing HTTP/2 or REALITY traffic.
    const relay = net.createServer((socket) => {
      tcpConnections += 1;
      const upstream = net.connect({ host, port });
      for (const connection of [socket, upstream]) {
        relaySockets.add(connection);
        connection.once("close", () => relaySockets.delete(connection));
      }
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const relayPort = await listen(relay, host);
    for (const format of ["yaml", "uri"]) {
      const connectionsBefore = tcpConnections;
      const clientPort = await freePort();
      const clientDir = join(taskDir, `client-${clientPort}`);
      mkdirSync(clientDir);
      const label = "smoke";
      const clientForm = { ...form, endpointHost: host, endpointPort: relayPort };
      const providerFile = join(clientDir, "uris.txt");
      writeFileSync(providerFile, buildShareUri(XHTTP_PROTOCOL, clientForm, `${label}-${entry.tag}`), { mode: 0o600 });
      const proxyConfig = format === "yaml"
        ? buildClashYamlExport([{ ...entry, form: clientForm }], label)
        : `proxy-providers:\n  local:\n    type: file\n    path: ${JSON.stringify(providerFile)}\nproxy-groups:\n  - name: uri-test\n    type: select\n    use:\n      - local\n`;
      const targetProxy = format === "yaml" ? `${label}-${entry.tag}` : "uri-test";
      const yaml = proxyConfig +
        `mixed-port: ${clientPort}\nallow-lan: false\nbind-address: 127.0.0.1\nmode: rule\nlog-level: ${process.env.NGP_SMOKE_DEBUG ? "debug" : "warning"}\nrules:\n  - "MATCH,${targetProxy}"\n`;
      const clientPath = join(taskDir, `mihomo-${clientPort}.yaml`);
      writeFileSync(clientPath, yaml, { mode: 0o600 });
      checked(mihomoBin, ["-t", "-d", clientDir, "-f", clientPath]);
      const mihomo = launch(mihomoBin, ["-d", clientDir, "-f", clientPath]);
      await waitPort(clientPort, mihomo);
      // Establish the pool sequentially: net/http may race extra dials before a new H2 connection is ready.
      for (let warmup = 0; warmup < 3; warmup += 1) {
        assert.deepEqual(await proxyGet(clientPort, destinationPort), { status: 200, body: "nodeget-xhttp-tcp-ok" });
      }
      const connectionsAfterWarmup = tcpConnections;
      const responses = await Promise.all(Array.from({ length: concurrentRequests }, (_, id) =>
        proxyGet(clientPort, destinationPort, `/mux/${id}`)));
      for (const [id, response] of responses.entries()) {
        assert.deepEqual(response, { status: 200, body: `nodeget-xhttp-mux-${id}` });
      }
      await proxyUdp(clientPort, udpEcho.address().port);
      const usedConnections = tcpConnections - connectionsBefore;
      assert.equal(tcpConnections, connectionsAfterWarmup,
        `${host} ${format}: concurrent requests opened TCP connections instead of reusing the established pool`);
      assert.ok(usedConnections > 0 && usedConnections <= 3,
        `${host} ${format}: ${concurrentRequests} concurrent requests used ${usedConnections} TCP connections; XMUX was not preserved`);
      mihomo.kill("SIGTERM");
      await once(mihomo, "exit");
      children.delete(mihomo);
      console.log(`verified real Mihomo -> XHTTP/REALITY -> Xray: ${host}, ${format}, HTTP/2 stream-one, TCP + UDP, ${concurrentRequests} concurrent streams / ${usedConnections} TCP connections`);
    }
  }
} catch (error) {
  // Generated fixture keys are never printed; core logs contain only paths and diagnostics.
  console.error(childLogs);
  throw error;
} finally {
  for (const child of children) {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode == null) child.kill("SIGKILL");
    }
  }
  for (const socket of relaySockets) socket.destroy();
  for (const server of servers) {
    try { server.close(); } catch { /* already closed */ }
  }
  rmSync(taskDir, { recursive: true, force: true });
}
