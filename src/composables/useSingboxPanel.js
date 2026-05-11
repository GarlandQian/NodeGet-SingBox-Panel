import { computed, reactive, ref, watch } from "vue";
import { buildConnectionDetails, buildShareUri, randomBase64, randomHex } from "@/lib/singbox";
import { getProtocol } from "@/lib/protocols";
import { parseExtensionContext } from "@/lib/context";
import {
  buildSingBoxConfig,
  buildSingBoxInbound,
  emptyInboundForm,
  makeInboundId,
  makeInboundTag,
} from "@/lib/inbound";
import { makeMeta } from "@/lib/state";
import { normalizeRealityDomain, parseRealityTargetOutput } from "@/lib/realityTools";
import {
  controlSingboxService,
  createNodegetClient,
  deployNodeState,
  generateRealityKeypair,
  listNodeNames,
  listNodeUuids,
  readNodeState,
  runRealityScan,
  uninstallSingbox,
} from "@/lib/nodeget";
import {
  buildClashYamlExport,
  buildPlainTextExport,
  buildSingboxOutboundsExport,
  triggerDownload,
} from "@/lib/exporters";
import { useFormValidation } from "./useFormValidation";

const HISTORY_STORAGE_KEY = "nodeget-singbox-panel:runs:v1";
const HISTORY_LIMIT = 50;
const HISTORY_FILTERS = {
  all: () => true,
  deploy: (run) => /(add-inbound|update-inbound|delete-inbound|batch-deploy)/.test(run.action),
  read: (run) => run.action === "read-state",
  control: (run) => ["start", "stop", "restart", "uninstall"].includes(run.action),
  reality: (run) => run.action === "reality-targets",
  failed: (run) => !run.ok,
};

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveHistory(runs) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(runs.slice(0, HISTORY_LIMIT)));
  } catch {
    /* ignore quota errors */
  }
}

const initialContext = parseExtensionContext();
const client = createNodegetClient();

const theme = ref(initialContext.theme === "dark" ? "dark" : "light");
const activeTab = ref("inbound");

const nodes = ref([]);
const nodeNameMap = ref({});
const selectedUuid = ref(initialContext.node || "");
const search = ref("");
const loadingNodes = ref(false);
const nodeError = ref("");

const loadingState = ref(false);
const stateError = ref("");
const serviceActive = ref("unknown");
const serviceEnabled = ref("unknown");
const singboxVersion = ref("");
const inbounds = ref([]);
const foreignInbounds = ref([]);

const selectedInboundId = ref(null);
const selectedProtocolId = ref("vless-reality");
const form = reactive(emptyInboundForm());

const commandRunning = ref(false);
const commandError = ref("");
const recentRuns = ref(loadHistory());
const historyFilter = ref("all");

const batchMode = ref(false);
const batchTargets = ref(new Set());
const batchProgress = ref([]);
const batchRunning = ref(false);

const realityForm = reactive({
  targets: "",
  port: 443,
  threads: 8,
  timeout: 5,
  duration: 60,
  maxResults: 30,
  maxCheckDomains: 30,
});
const realityRunning = ref(false);
const realityError = ref("");
const realityResult = ref(null);

const validation = useFormValidation();

let pendingAbort = null;
function abortInFlight() {
  pendingAbort?.abort?.();
  pendingAbort = null;
}
function newAbortController() {
  abortInFlight();
  const ctrl = new AbortController();
  pendingAbort = ctrl;
  return ctrl;
}

const protocol = computed(() => getProtocol(selectedProtocolId.value));
const isEditing = computed(() => selectedInboundId.value != null);

const currentNodeName = computed(() => {
  const name = nodeNameMap.value[selectedUuid.value];
  if (name) return name;
  if (!selectedUuid.value) return "未选择";
  return selectedUuid.value.slice(0, 8);
});

const filteredNodes = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return nodes.value;
  return nodes.value.filter((node) => {
    const name = (nodeNameMap.value[node] || "").toLowerCase();
    return node.toLowerCase().includes(term) || name.includes(term);
  });
});

const selectedProtocolLabel = computed(() => protocol.value?.label || "未知协议");

const saveButtonLabel = computed(() => (isEditing.value ? "保存修改" : "添加入站"));

const connectionInfo = computed(() => {
  if (!selectedUuid.value || !form.endpointHost) return null;
  const label = nodeNameMap.value[selectedUuid.value] || form.label || "nodeget";
  const uri = buildShareUri(selectedProtocolId.value, form, label);
  return {
    type: selectedProtocolLabel.value,
    uri,
    details: buildConnectionDetails(selectedProtocolId.value, form),
  };
});

const allShareUris = computed(() => {
  const label = nodeNameMap.value[selectedUuid.value] || "nodeget";
  return inbounds.value
    .map((it) => ({ tag: it.tag, uri: buildShareUri(it.protocolId, it.form, label) }))
    .filter((row) => row.uri);
});

function pushRun(action, ok, output, extra = {}) {
  const next = [
    { action, ok, output, at: new Date().toISOString(), ...extra },
    ...recentRuns.value,
  ].slice(0, HISTORY_LIMIT);
  recentRuns.value = next;
  saveHistory(next);
}

function clearHistory() {
  recentRuns.value = [];
  saveHistory([]);
}

const filteredHistory = computed(() => {
  const fn = HISTORY_FILTERS[historyFilter.value] || HISTORY_FILTERS.all;
  return recentRuns.value.filter(fn);
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error) {
  return error instanceof Error && error.name === "AbortError";
}

function requireToken() {
  if (!initialContext.token) throw new Error("缺少 token");
  return initialContext.token;
}

function requireSelectedUuid() {
  const uuid = selectedUuid.value.trim();
  if (!uuid) throw new Error("请先选择节点");
  return uuid;
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`请填写有效的${label}`);
  }
  return port;
}

function selectProtocol(id) {
  selectedProtocolId.value = id;
  validation.reset();
  if (!isEditing.value) {
    if (id === "vless-reality" || id === "vless-http2-reality") {
      form.privateKey = "";
      form.publicKey = "";
      form.shortId = randomHex(8);
    }
  }
}

function selectInbound(id) {
  selectedInboundId.value = id;
  validation.reset();
  if (id == null) {
    Object.assign(form, emptyInboundForm(), {
      uuid: crypto.randomUUID(),
      shortId: randomHex(8),
      password: randomBase64(16),
    });
    selectedProtocolId.value = "vless-reality";
    return;
  }
  const found = inbounds.value.find((it) => it.id === id);
  if (!found) return;
  selectedProtocolId.value = found.protocolId;
  Object.assign(form, emptyInboundForm(), found.form);
}

function regenSecret() {
  const family = protocol.value?.family;
  if (!family) return;
  if (family === "vless" || family === "vmess") {
    form.uuid = crypto.randomUUID();
    if (protocol.value?.tlsMode === "reality") {
      form.shortId = randomHex(8);
      form.privateKey = "";
      form.publicKey = "";
    }
    return;
  }
  if (family === "trojan" || family === "hysteria2" || family === "anytls") {
    form.password = randomBase64(16);
    return;
  }
  if (family === "shadowsocks") {
    form.password = randomBase64(form.method?.includes("256") ? 32 : 16);
    return;
  }
  if (family === "tuic") {
    form.uuid = crypto.randomUUID();
    form.password = randomBase64(16);
    return;
  }
  if (family === "socks") {
    form.username = "nodeget";
    form.password = randomBase64(12);
  }
}

async function refreshNodes() {
  let token;
  try {
    token = requireToken();
  } catch (e) {
    nodeError.value = errorMessage(e);
    return;
  }
  loadingNodes.value = true;
  nodeError.value = "";
  try {
    const uuids = await listNodeUuids(client, token);
    nodes.value = uuids;
    nodeNameMap.value = await listNodeNames(client, token, uuids);
    if (!uuids.includes(selectedUuid.value) && uuids.length > 0) {
      selectedUuid.value = uuids[0];
    }
  } catch (e) {
    nodeError.value = errorMessage(e);
  } finally {
    loadingNodes.value = false;
  }
}

async function refreshState() {
  if (!selectedUuid.value) return;
  let token;
  try {
    token = requireToken();
  } catch (e) {
    stateError.value = errorMessage(e);
    return;
  }
  const ctrl = newAbortController();
  loadingState.value = true;
  stateError.value = "";
  try {
    const state = await readNodeState(client, token, selectedUuid.value, {
      signal: ctrl.signal,
    });
    serviceActive.value = state.serviceActive;
    serviceEnabled.value = state.serviceEnabled;
    singboxVersion.value = state.singboxVersion;
    foreignInbounds.value = state.foreignInbounds;
    inbounds.value = state.meta.inbounds || [];
    if (
      selectedInboundId.value != null &&
      !inbounds.value.find((it) => it.id === selectedInboundId.value)
    ) {
      selectInbound(null);
    }
    pushRun("read-state", true, state.rawOutput);
  } catch (e) {
    if (isAbort(e)) return;
    stateError.value = errorMessage(e);
    pushRun("read-state", false, errorMessage(e));
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    loadingState.value = false;
  }
}

function buildInboundEntry({ id, protocolId, formSnapshot }) {
  const port = parsePort(formSnapshot.endpointPort, "端口");
  return {
    id: id || makeInboundId(),
    tag: makeInboundTag(protocolId, port),
    protocolId,
    form: { ...formSnapshot, endpointPort: port },
    createdAt: id ? undefined : Date.now(),
    updatedAt: Date.now(),
  };
}

function detectPortConflict(targetTag, port) {
  for (const existing of inbounds.value) {
    if (existing.id === selectedInboundId.value) continue;
    if (existing.form.endpointPort === port) {
      throw new Error(`端口 ${port} 已被入站 ${existing.tag} 占用`);
    }
    if (existing.tag === targetTag) {
      throw new Error(`入站 tag 冲突：${targetTag}`);
    }
  }
}

async function ensureRealityKeypair(token, uuid, ctrl) {
  if (protocol.value?.tlsMode !== "reality") return;
  if (form.privateKey && form.publicKey) return;
  const result = await generateRealityKeypair(client, token, uuid, {
    signal: ctrl.signal,
  });
  if (!result.privateKey || !result.publicKey) {
    throw new Error("生成 Reality 密钥失败");
  }
  form.privateKey = result.privateKey;
  form.publicKey = result.publicKey;
}

function buildPayload({ replaceId = null, dropId = null } = {}) {
  let next;
  if (replaceId != null) {
    const port = parsePort(form.endpointPort, "端口");
    const tag = makeInboundTag(selectedProtocolId.value, port);
    next = inbounds.value.map((it) =>
      it.id === replaceId
        ? buildInboundEntry({
            id: replaceId,
            protocolId: selectedProtocolId.value,
            formSnapshot: { ...form },
          })
        : it,
    );
    detectPortConflict(tag, port);
  } else if (dropId != null) {
    next = inbounds.value.filter((it) => it.id !== dropId);
  } else {
    const port = parsePort(form.endpointPort, "端口");
    const tag = makeInboundTag(selectedProtocolId.value, port);
    detectPortConflict(tag, port);
    next = [
      ...inbounds.value,
      buildInboundEntry({
        protocolId: selectedProtocolId.value,
        formSnapshot: { ...form },
      }),
    ];
  }

  const sbInbounds = next.map((it) => buildSingBoxInbound(it.protocolId, it.form));
  const config = buildSingBoxConfig({
    inbounds: sbInbounds,
    foreignInbounds: foreignInbounds.value,
  });
  const meta = makeMeta(next);
  return { config, meta, nextInbounds: next };
}

async function saveInbound() {
  commandError.value = "";
  let token;
  let uuid;
  try {
    token = requireToken();
    uuid = requireSelectedUuid();
  } catch (e) {
    commandError.value = errorMessage(e);
    return;
  }
  if (!validation.validateAll(form, selectedProtocolId.value)) {
    commandError.value = "请修正表单错误";
    return;
  }

  const ctrl = newAbortController();
  commandRunning.value = true;
  try {
    await ensureRealityKeypair(token, uuid, ctrl);
    const replaceId = isEditing.value ? selectedInboundId.value : null;
    const { config, meta, nextInbounds } = buildPayload({ replaceId });
    const result = await deployNodeState(
      client,
      token,
      uuid,
      { config, meta },
      { signal: ctrl.signal },
    );
    inbounds.value = nextInbounds;
    serviceActive.value = result.serviceActive;
    if (!isEditing.value) {
      const newest = nextInbounds[nextInbounds.length - 1];
      if (newest) selectedInboundId.value = newest.id;
    }
    pushRun(isEditing.value ? "update-inbound" : "add-inbound", true, result.rawOutput);
  } catch (e) {
    if (isAbort(e)) return;
    commandError.value = errorMessage(e);
    pushRun(
      isEditing.value ? "update-inbound" : "add-inbound",
      false,
      errorMessage(e),
    );
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    commandRunning.value = false;
  }
}

async function deleteInbound() {
  commandError.value = "";
  if (selectedInboundId.value == null) {
    commandError.value = "没有选中的入站";
    return;
  }
  let token;
  let uuid;
  try {
    token = requireToken();
    uuid = requireSelectedUuid();
  } catch (e) {
    commandError.value = errorMessage(e);
    return;
  }
  const dropId = selectedInboundId.value;
  const ctrl = newAbortController();
  commandRunning.value = true;
  try {
    const { config, meta, nextInbounds } = buildPayload({ dropId });
    const result = await deployNodeState(
      client,
      token,
      uuid,
      { config, meta },
      { signal: ctrl.signal },
    );
    inbounds.value = nextInbounds;
    serviceActive.value = result.serviceActive;
    selectInbound(null);
    pushRun("delete-inbound", true, result.rawOutput);
  } catch (e) {
    if (isAbort(e)) return;
    commandError.value = errorMessage(e);
    pushRun("delete-inbound", false, errorMessage(e));
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    commandRunning.value = false;
  }
}

async function controlAction(action) {
  commandError.value = "";
  let token;
  let uuid;
  try {
    token = requireToken();
    uuid = requireSelectedUuid();
  } catch (e) {
    commandError.value = errorMessage(e);
    return;
  }
  const ctrl = newAbortController();
  commandRunning.value = true;
  try {
    const result = await controlSingboxService(client, token, uuid, action, {
      signal: ctrl.signal,
    });
    serviceActive.value = result.serviceActive;
    serviceEnabled.value = result.serviceEnabled;
    pushRun(action, true, result.rawOutput);
  } catch (e) {
    if (isAbort(e)) return;
    commandError.value = errorMessage(e);
    pushRun(action, false, errorMessage(e));
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    commandRunning.value = false;
  }
}

async function uninstallAll() {
  if (typeof window !== "undefined" && !window.confirm("确认从该节点完全卸载 sing-box 配置？此操作不可撤销。")) return;
  commandError.value = "";
  let token;
  let uuid;
  try {
    token = requireToken();
    uuid = requireSelectedUuid();
  } catch (e) {
    commandError.value = errorMessage(e);
    return;
  }
  const ctrl = newAbortController();
  commandRunning.value = true;
  try {
    const result = await uninstallSingbox(client, token, uuid, { signal: ctrl.signal });
    inbounds.value = [];
    foreignInbounds.value = [];
    serviceActive.value = "inactive";
    selectInbound(null);
    pushRun("uninstall", true, result.rawOutput);
  } catch (e) {
    if (isAbort(e)) return;
    commandError.value = errorMessage(e);
    pushRun("uninstall", false, errorMessage(e));
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    commandRunning.value = false;
  }
}

async function runRealityScanAction() {
  realityRunning.value = true;
  realityError.value = "";
  let token;
  let uuid;
  try {
    if (!realityForm.targets.trim()) throw new Error("请填写要筛选的目标");
    token = requireToken();
    uuid = requireSelectedUuid();
  } catch (e) {
    realityError.value = errorMessage(e);
    realityRunning.value = false;
    return;
  }
  const ctrl = newAbortController();
  try {
    const result = await runRealityScan(client, token, uuid, realityForm, {
      signal: ctrl.signal,
    });
    realityResult.value = parseRealityTargetOutput(result.rawOutput);
    pushRun("reality-targets", true, result.rawOutput);
  } catch (e) {
    if (isAbort(e)) return;
    realityError.value = errorMessage(e);
    pushRun("reality-targets", false, errorMessage(e));
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    realityRunning.value = false;
  }
}

function applyRealityCandidate(candidate) {
  const domain = normalizeRealityDomain(candidate.certDomain || candidate.origin);
  if (candidate.ip) form.endpointHost = candidate.ip;
  if (domain) {
    form.handshakeHost = domain;
    form.transportHost = domain;
  }
  form.endpointPort = Number(realityForm.port || form.endpointPort || 443);
  form.handshakePort = 443;
  if (protocol.value?.tlsMode !== "reality") {
    selectedProtocolId.value = "vless-reality";
  }
}

async function copyUri() {
  if (!connectionInfo.value?.uri) return;
  await navigator.clipboard.writeText(connectionInfo.value.uri);
}

async function copyAllUris() {
  if (!allShareUris.value.length) return;
  const text = allShareUris.value.map((row) => row.uri).join("\n");
  await navigator.clipboard.writeText(text);
}

function toggleBatchMode() {
  batchMode.value = !batchMode.value;
  if (!batchMode.value) {
    batchTargets.value = new Set();
    batchProgress.value = [];
  } else {
    if (selectedUuid.value) batchTargets.value = new Set([selectedUuid.value]);
  }
}

function toggleBatchTarget(uuid) {
  const next = new Set(batchTargets.value);
  if (next.has(uuid)) next.delete(uuid);
  else next.add(uuid);
  batchTargets.value = next;
}

function clearBatchTargets() {
  batchTargets.value = new Set();
}

function isBatchTarget(uuid) {
  return batchTargets.value.has(uuid);
}

function mergeInboundIntoState(formSnapshot, protocolId, state) {
  const port = parsePort(formSnapshot.endpointPort, "端口");
  const tag = makeInboundTag(protocolId, port);
  const existing = state.meta?.inbounds || [];
  const sameIndex = existing.findIndex((it) => it.tag === tag);
  let next;
  if (sameIndex >= 0) {
    next = existing.slice();
    next[sameIndex] = {
      ...existing[sameIndex],
      protocolId,
      tag,
      form: { ...formSnapshot, endpointPort: port },
      updatedAt: Date.now(),
    };
  } else {
    const conflict = existing.find((it) => it.form.endpointPort === port);
    if (conflict) throw new Error(`端口 ${port} 已被入站 ${conflict.tag} 占用`);
    next = [
      ...existing,
      {
        id: makeInboundId(),
        tag,
        protocolId,
        form: { ...formSnapshot, endpointPort: port },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
  }
  const sbInbounds = next.map((it) => buildSingBoxInbound(it.protocolId, it.form));
  const config = buildSingBoxConfig({
    inbounds: sbInbounds,
    foreignInbounds: state.foreignInbounds || [],
  });
  const meta = makeMeta(next);
  return { config, meta };
}

async function batchDeploy() {
  commandError.value = "";
  if (!batchTargets.value.size) {
    commandError.value = "请先选择至少一个目标节点";
    return;
  }
  if (!validation.validateAll(form, selectedProtocolId.value)) {
    commandError.value = "请修正表单错误";
    return;
  }

  let token;
  try {
    token = requireToken();
  } catch (e) {
    commandError.value = errorMessage(e);
    return;
  }

  const targets = [...batchTargets.value];
  const ctrl = newAbortController();
  batchRunning.value = true;
  batchProgress.value = targets.map((uuid) => ({ uuid, status: "pending", message: "" }));

  try {
    if (protocol.value?.tlsMode === "reality" && (!form.privateKey || !form.publicKey)) {
      batchProgress.value = batchProgress.value.map((row, idx) =>
        idx === 0 ? { ...row, status: "keypair" } : row,
      );
      const keypairFrom = targets[0];
      const result = await generateRealityKeypair(client, token, keypairFrom, {
        signal: ctrl.signal,
      });
      if (!result.privateKey || !result.publicKey) throw new Error("生成 Reality 密钥失败");
      form.privateKey = result.privateKey;
      form.publicKey = result.publicKey;
    }

    const snapshot = { ...form };
    const protocolId = selectedProtocolId.value;

    for (let i = 0; i < targets.length; i++) {
      const uuid = targets[i];
      batchProgress.value = batchProgress.value.map((row, idx) =>
        idx === i ? { ...row, status: "reading" } : row,
      );
      try {
        const state = await readNodeState(client, token, uuid, { signal: ctrl.signal });
        const { config, meta } = mergeInboundIntoState(snapshot, protocolId, state);
        batchProgress.value = batchProgress.value.map((row, idx) =>
          idx === i ? { ...row, status: "deploying" } : row,
        );
        const r = await deployNodeState(
          client,
          token,
          uuid,
          { config, meta },
          { signal: ctrl.signal },
        );
        batchProgress.value = batchProgress.value.map((row, idx) =>
          idx === i ? { uuid, status: "ok", message: r.serviceActive } : row,
        );
      } catch (e) {
        if (isAbort(e)) {
          batchProgress.value = batchProgress.value.map((row, idx) =>
            idx >= i ? { uuid: row.uuid, status: "aborted", message: errorMessage(e) } : row,
          );
          return;
        }
        batchProgress.value = batchProgress.value.map((row, idx) =>
          idx === i ? { uuid, status: "failed", message: errorMessage(e) } : row,
        );
      }
    }

    const okCount = batchProgress.value.filter((row) => row.status === "ok").length;
    pushRun(
      "batch-deploy",
      okCount === targets.length,
      `${okCount}/${targets.length} succeeded\n${batchProgress.value
        .map((row) => `${row.uuid} ${row.status} ${row.message}`)
        .join("\n")}`,
    );
    if (targets.includes(selectedUuid.value)) await refreshState();
  } catch (e) {
    if (isAbort(e)) return;
    commandError.value = errorMessage(e);
    pushRun("batch-deploy", false, errorMessage(e));
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    batchRunning.value = false;
  }
}

function downloadExport(formatId) {
  const label = nodeNameMap.value[selectedUuid.value] || "nodeget";
  const inboundList = inbounds.value;
  if (!inboundList.length) return;
  if (formatId === "txt") {
    triggerDownload(`${label}-uris.txt`, buildPlainTextExport(inboundList, label));
    return;
  }
  if (formatId === "clash") {
    const yaml = buildClashYamlExport(inboundList, label);
    triggerDownload(`${label}-clash.yaml`, yaml, "application/yaml");
    return;
  }
  if (formatId === "singbox") {
    const json = buildSingboxOutboundsExport(inboundList, label);
    triggerDownload(`${label}-singbox-outbounds.json`, json, "application/json");
  }
}

function watchNode() {
  watch(selectedUuid, () => {
    selectInbound(null);
    refreshState();
  });
  watch(
    () => form.method,
    () => {
      if (protocol.value?.family === "shadowsocks") {
        form.password = randomBase64(form.method?.includes("256") ? 32 : 16);
      }
    },
  );
}

function attachWindowListeners() {
  const onMessage = (event) => {
    const data = event?.data;
    if (data?.type === "theme-change" && (data.theme === "dark" || data.theme === "light")) {
      theme.value = data.theme;
    }
  };
  const onHashChange = () => {
    const updated = parseExtensionContext();
    theme.value = updated.theme === "dark" ? "dark" : "light";
  };
  window.addEventListener("message", onMessage);
  window.addEventListener("hashchange", onHashChange);
  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("hashchange", onHashChange);
  };
}

export function useSingboxPanel() {
  return {
    // state
    theme,
    activeTab,
    nodes,
    nodeNameMap,
    selectedUuid,
    search,
    loadingNodes,
    nodeError,
    loadingState,
    stateError,
    serviceActive,
    serviceEnabled,
    singboxVersion,
    inbounds,
    foreignInbounds,
    selectedInboundId,
    selectedProtocolId,
    form,
    commandRunning,
    commandError,
    recentRuns,
    historyFilter,
    filteredHistory,
    batchMode,
    batchTargets,
    batchProgress,
    batchRunning,
    realityForm,
    realityRunning,
    realityError,
    realityResult,
    // computeds
    protocol,
    isEditing,
    currentNodeName,
    filteredNodes,
    selectedProtocolLabel,
    saveButtonLabel,
    connectionInfo,
    allShareUris,
    // validation
    validation,
    // actions
    selectProtocol,
    selectInbound,
    regenSecret,
    refreshNodes,
    refreshState,
    saveInbound,
    deleteInbound,
    controlAction,
    uninstallAll,
    runRealityScanAction,
    applyRealityCandidate,
    copyUri,
    copyAllUris,
    toggleBatchMode,
    toggleBatchTarget,
    clearBatchTargets,
    isBatchTarget,
    batchDeploy,
    downloadExport,
    clearHistory,
    abortInFlight,
    // lifecycle helpers
    watchNode,
    attachWindowListeners,
    closeClient: () => client.close(),
  };
}
