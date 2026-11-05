import { computed, reactive, ref, watch } from "vue";
import {
  buildConnectionDetails,
  buildShareUri,
  randomBase64,
  randomHex,
  shadowsocksPasswordBytes,
} from "@/lib/singbox";
import { getProtocol, getProtocolEngine, getEntryEngine } from "@/lib/protocols";
import { parseExtensionContext } from "@/lib/context";
import {
  emptyInboundForm,
  makeInboundId,
  makeInboundTag,
} from "@/lib/inbound";
import { redactStateOutput } from "@/lib/state";
import { validateXhttpForm, validateXhttpShareUri, XRAY_RELEASE } from "@/lib/xray";
import { parseNextHopUri } from "@/lib/nextHop";
import { buildEngineDeployment, assertPortAvailable } from "@/lib/deployment";
import { migrateSingBoxConfigFor114 } from "@/lib/configMigration";
import { normalizeRealityDomain, parseRealityTargetOutput } from "@/lib/realityTools";
import { generateLocalRealityKeypair } from "@/lib/realityKeypair";
import { canonicalPortJumpRange, parsePortJumpRange, toIptablesMultiportSpec } from "@/lib/portJump";
import {
  applyPortJump,
  controlSingboxService,
  createNodegetClient,
  deployNodeState,
  deployXrayState,
  controlXrayService,
  listNodeNames,
  listNodeUuids,
  readNodeIpAddresses,
  readNodeState,
  removePortJumpUnits,
  runRealityScan,
  uninstallSingbox,
  upgradeSingbox,
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
  control: (run) => ["start", "stop", "restart", "upgrade", "uninstall"].includes(run.action),
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
const nodeAddressMap = ref({});
const selectedUuid = ref(initialContext.node || "");
const search = ref("");
const loadingNodes = ref(false);
const nodeError = ref("");

const loadingState = ref(false);
const stateReady = ref(false);
const stateError = ref("");
const serviceActive = ref("unknown");
const serviceEnabled = ref("unknown");
const singboxVersion = ref("");
const inbounds = ref([]);
const foreignInbounds = ref([]);
const baseConfig = ref(null);
const baseConfigSha256 = ref("");
const xrayState = ref(null);
const xrayForeignInbounds = computed(() => xrayState.value?.foreignInbounds || []);

const selectedInboundId = ref(null);
const selectedProtocolId = ref("vless-reality");
const form = reactive(emptyInboundForm());

const commandRunning = ref(false);
const commandError = ref("");
const notification = ref(null);
const confirmation = ref(null);
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
let notificationTimer = null;
let notificationSequence = 0;
let confirmationResolver = null;
let confirmationSequence = 0;

function dismissNotification() {
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = null;
  notification.value = null;
}

function showNotification(message, tone = "success", duration = 3000) {
  const normalized = String(message || "").trim();
  if (!normalized) return;
  if (notificationTimer) clearTimeout(notificationTimer);
  const id = ++notificationSequence;
  notification.value = { id, message: normalized, tone };
  notificationTimer = setTimeout(() => {
    if (notification.value?.id === id) notification.value = null;
    notificationTimer = null;
  }, duration);
}

function reportCommandFailure(message) {
  commandError.value = message;
  showNotification(message, "error", 4500);
}

function requestConfirmation(options) {
  if (confirmationResolver) confirmationResolver(false);
  return new Promise((resolve) => {
    confirmationResolver = resolve;
    confirmation.value = {
      id: ++confirmationSequence,
      title: String(options?.title || "确认操作"),
      message: String(options?.message || ""),
      confirmLabel: String(options?.confirmLabel || "确认"),
      danger: options?.danger === true,
    };
  });
}

function resolveConfirmation(confirmed = false) {
  const resolve = confirmationResolver;
  confirmationResolver = null;
  confirmation.value = null;
  resolve?.(Boolean(confirmed));
}

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
const serviceEngine = computed(() => getProtocolEngine(selectedProtocolId.value));
const serviceLabel = computed(() => serviceEngine.value === "xray" ? "Xray" : "sing-box");

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
  showNotification("操作日志已清空");
}

const filteredHistory = computed(() => {
  const fn = HISTORY_FILTERS[historyFilter.value] || HISTORY_FILTERS.all;
  return recentRuns.value.filter(fn);
});

function errorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("xray_rollback_failed")) return "Xray 自动回滚失败，请检查节点上的 .bak 备份并人工恢复";
  const errors = {
    xray_operation_locked: "Xray 正在被其他操作占用，请稍后重新读取状态；异常退出的残留锁需人工核对后处理",
    xray_config_changed_since_read: "Xray 配置已被其他操作修改，请重新读取状态",
    xray_meta_changed_since_read: "Xray 元数据已被其他操作修改，请重新读取状态",
    xray_unmanaged_paths: "检测到非面板管理的 Xray 路径，已停止以避免覆盖",
    xray_symlink_refused: "Xray 路径包含符号链接，已停止以避免覆盖其他文件",
    xray_service_not_owned: "nodeget-xray 服务已被其他程序占用，未覆盖现有服务",
    xray_version_not_baseline: `Xray 版本不在已验证基线 ${XRAY_RELEASE}，请先明确更新到兼容基线`,
    xray_release_checksum_mismatch: "Xray 发布包 SHA-256 校验失败，未替换现有版本",
    xray_release_digest_missing: "Xray 官方资产缺少有效 SHA-256 摘要，已停止安装",
    xray_release_metadata_failed: "无法读取 Xray 官方发布信息，请检查节点网络",
    xray_release_download_failed: "下载 Xray 官方发布包失败，请检查节点网络",
    xray_config_rejected: "配置未通过 Xray 检查，未替换现有配置",
    xray_commit_hash_mismatch: "部署后摘要与候选文件不一致，已尝试回滚，请重新读取状态",
    xray_restart_failed_rolled_back: "Xray 重启失败，已尝试回滚，请重新读取状态",
    xray_unhealthy_rolled_back: "Xray 启动后状态异常，已尝试回滚，请重新读取状态",
    xray_rollback_failed: "Xray 自动回滚失败，请检查节点上的 .bak 备份并人工恢复",
    xray_unsupported_arch: "当前节点架构不受 Xray 官方发布包支持",
    xray_unsupported_service_manager: "Xray 首版需要 systemd 或 OpenRC 服务管理器",
    xray_config_missing: "尚无 Xray 配置，请先添加 XHTTP 入站",
    xray_service_start_failed: "Xray 启动/重启后状态异常，请重新读取节点状态和检查服务日志",
  };
  const friendly = Object.entries(errors).find(([code]) => raw.includes(code))?.[1];
  return friendly && raw.includes("xray_config_rejected") ? `${friendly}\n${raw}` : friendly || raw;
}

function upgradeErrorMessage(error) {
  const raw = errorMessage(error);
  const knownErrors = [
    ["missing_sing-box", "节点尚未安装 sing-box，请先添加入站完成安装"],
    ["unsupported_arch_", "节点 CPU 架构不受官方发布包支持"],
    ["release_metadata_download_failed", "无法读取 sing-box 官方稳定版信息"],
    ["invalid_stable_release_tag", "官方最新版本标签不是稳定版格式，已停止升级"],
    ["release_digest_missing_", "官方发布资产缺少 SHA-256 摘要，已停止升级"],
    ["release_download_failed", "下载 sing-box 官方发布包失败"],
    ["release_checksum_mismatch", "发布包 SHA-256 校验失败，未替换现有版本"],
    ["release_extract_failed", "解压 sing-box 官方发布包失败"],
    ["release_binary_missing", "官方发布包中未找到 sing-box 二进制文件"],
    ["release_version_mismatch", "下载文件的版本与官方版本标签不一致"],
    ["migrated_config_decode_failed", "自动迁移后的配置传输失败，未修改节点"],
    ["config_changed_since_read", "节点配置在读取后已发生变化，请重新读取状态再升级"],
    ["new_version_rejected_migrated_config", "自动迁移后的配置未通过新版本检查，未修改现有版本或配置；详情见操作日志"],
    ["binary_commit_failed_rolled_back", "写入新版本失败，已恢复原版本和配置"],
    ["config_commit_failed_rolled_back", "写入迁移配置失败，已恢复原版本和配置"],
    ["service_restart_failed_upgrade_rolled_back", "升级后重启失败，已恢复原版本和配置"],
    ["service_unhealthy_upgrade_rolled_back", "升级后服务状态异常，已恢复原版本和配置"],
  ];
  return knownErrors.find(([code]) => raw.includes(code))?.[1] || raw;
}

function copyTextFallback(text) {
  if (typeof document === "undefined" || !document.body) {
    throw new Error("clipboard_unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  textarea.style.fontSize = "16px";

  const selection = document.getSelection?.();
  const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const activeElement = document.activeElement;

  document.body.appendChild(textarea);
  try {
    try {
      textarea.focus({ preventScroll: true });
    } catch {
      textarea.focus();
    }
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (!document.execCommand?.("copy")) {
      throw new Error("copy_command_failed");
    }
  } finally {
    textarea.remove();
    if (selection && selectedRange) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }
    try {
      activeElement?.focus?.({ preventScroll: true });
    } catch {
      activeElement?.focus?.();
    }
  }
}

async function copyText(text) {
  let clipboardError = null;
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard?.writeText &&
    (typeof window === "undefined" || window.isSecureContext !== false)
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  try {
    copyTextFallback(text);
  } catch (fallbackError) {
    throw clipboardError || fallbackError;
  }
}

function validateGeneratedUri(uri) {
  try {
    if (new URL(uri).searchParams.get("type") === "xhttp") {
      validateXhttpShareUri(uri);
      return;
    }
    parseNextHopUri(uri, "nodeget-copy-validation");
  } catch (error) {
    throw new Error(`生成的 URI 无效：${errorMessage(error)}`);
  }
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
  if (getProtocolEngine(id) === "xray") {
    form.nextHopEnabled = false;
    form.nextHopUri = "";
  }
  validation.reset();
  if (!isEditing.value) {
    if (getProtocol(id)?.tlsMode === "reality") {
      form.privateKey = "";
      form.publicKey = "";
      form.shortId = randomHex(8);
    }
  }
}

async function resolveNodeAddress(token, uuid, options = {}) {
  const cached = nodeAddressMap.value[uuid];
  if (cached) return cached;
  const { ipv4, ipv6 } = await readNodeIpAddresses(client, token, uuid, options);
  const address = ipv4 || ipv6;
  if (!address) throw new Error("节点未返回可用的 IPv4 或 IPv6");
  nodeAddressMap.value = { ...nodeAddressMap.value, [uuid]: address };
  return address;
}

function selectInbound(id) {
  selectedInboundId.value = id;
  validation.reset();
  if (id == null) {
    Object.assign(form, emptyInboundForm(), {
      endpointHost: nodeAddressMap.value[selectedUuid.value] || "",
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
    showNotification(
      protocol.value?.tlsMode === "reality" ? "UUID 和 Reality 参数已更新" : "UUID 已更新",
    );
    return;
  }
  if (family === "trojan" || family === "hysteria2" || family === "anytls") {
    form.password = randomBase64(16);
    showNotification("密码已更新");
    return;
  }
  if (family === "shadowsocks") {
    form.password = randomBase64(shadowsocksPasswordBytes(form.method));
    showNotification("密码已更新");
    return;
  }
  if (family === "tuic") {
    form.uuid = crypto.randomUUID();
    form.password = randomBase64(16);
    showNotification("UUID 和密码已更新");
    return;
  }
  if (family === "socks") {
    form.username = "nodeget";
    form.password = randomBase64(12);
    showNotification("SOCKS 用户信息已更新");
  }
}

async function refreshNodes(options = {}) {
  const feedback = options?.feedback === true;
  let token;
  try {
    token = requireToken();
  } catch (e) {
    nodeError.value = errorMessage(e);
    if (feedback) showNotification(nodeError.value, "error", 4500);
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
    if (feedback) showNotification(`节点列表已刷新，共 ${uuids.length} 个节点`);
  } catch (e) {
    nodeError.value = errorMessage(e);
    if (feedback) showNotification(`刷新失败：${nodeError.value}`, "error", 4500);
  } finally {
    loadingNodes.value = false;
  }
}

async function refreshState(options = {}) {
  const feedback = options?.feedback === true;
  if (!selectedUuid.value) {
    if (feedback) showNotification("请先选择节点", "error", 4500);
    return;
  }
  let token;
  try {
    token = requireToken();
  } catch (e) {
    stateError.value = errorMessage(e);
    if (feedback) showNotification(stateError.value, "error", 4500);
    return;
  }
  const uuid = selectedUuid.value;
  const ctrl = newAbortController();
  loadingState.value = true;
  stateReady.value = false;
  stateError.value = "";
  try {
    const state = await readNodeState(client, token, uuid, {
      signal: ctrl.signal,
    });
    serviceActive.value = state.serviceActive;
    serviceEnabled.value = state.serviceEnabled;
    singboxVersion.value = state.singboxVersion;
    baseConfig.value = state.config;
    baseConfigSha256.value = state.configSha256;
    xrayState.value = state.xray;
    foreignInbounds.value = state.foreignInbounds;
    inbounds.value = [...(state.meta.inbounds || []), ...(state.xray.meta.inbounds || [])];
    stateReady.value = true;
    if (
      selectedInboundId.value != null &&
      !inbounds.value.find((it) => it.id === selectedInboundId.value)
    ) {
      selectInbound(null);
    }

    let appliedAddress = "";
    let addressError = "";
    if (selectedInboundId.value == null && !String(form.endpointHost || "").trim()) {
      try {
        const address = await resolveNodeAddress(token, uuid, { signal: ctrl.signal });
        if (
          selectedUuid.value === uuid &&
          selectedInboundId.value == null &&
          !String(form.endpointHost || "").trim()
        ) {
          form.endpointHost = address;
          validation.validateField(form, selectedProtocolId.value, "endpointHost");
          appliedAddress = address;
        }
      } catch (e) {
        if (isAbort(e)) return;
        addressError = errorMessage(e);
      }
    }

    pushRun("read-state", true, redactStateOutput(state.rawOutput));
    if (appliedAddress) {
      showNotification(`已自动填入节点 IP：${appliedAddress}`);
    } else if (
      addressError &&
      selectedUuid.value === uuid &&
      selectedInboundId.value == null &&
      !String(form.endpointHost || "").trim()
    ) {
      showNotification(`未能自动获取节点 IP，请手动填写：${addressError}`, "warning", 5000);
    } else if (feedback) {
      showNotification("节点状态已重新读取");
    }
  } catch (e) {
    if (isAbort(e)) return;
    stateReady.value = false;
    stateError.value = errorMessage(e);
    pushRun("read-state", false, errorMessage(e));
    if (feedback) showNotification(`读取失败：${stateError.value}`, "error", 4500);
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
    engine: getProtocolEngine(protocolId),
    form: { ...formSnapshot, endpointPort: port },
    createdAt: id ? inbounds.value.find((entry) => entry.id === id)?.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
}

function detectPortConflict(targetTag, port) {
  assertPortAvailable({ entries: inbounds.value, foreign: [...foreignInbounds.value, ...xrayForeignInbounds.value],
    port, tag: targetTag, ignoreId: selectedInboundId.value });
}

function portJumpServiceName(tag) {
  return `nodeget-singbox-portjump-${tag.replace(/^nodeget-/, "")}`;
}

function inboundNeedsPortJump(entry) {
  return entry?.protocolId === "hysteria2" && Boolean(entry?.form?.portJumpRange);
}

function validatePortJumpForm(formSnapshot, protocolId, port) {
  if (protocolId !== "hysteria2") return null;
  const raw = formSnapshot.portJumpRange;
  if (!raw || !String(raw).trim()) return null;
  const { ranges, error } = parsePortJumpRange(raw);
  if (error) throw new Error(`端口跳跃：${error}`);
  for (const r of ranges) {
    if (port >= r.start && port <= r.end) {
      throw new Error(`端口跳跃段 ${r.start}-${r.end} 覆盖了入站端口 ${port}`);
    }
  }
  return canonicalPortJumpRange(raw);
}

function validateNextHopForm(formSnapshot, protocolId = selectedProtocolId.value) {
  if (getProtocolEngine(protocolId) === "xray") {
    validateXhttpForm(formSnapshot);
    return;
  }
  if (formSnapshot.nextHopEnabled !== true) return;
  parseNextHopUri(formSnapshot.nextHopUri);
}

function deploymentSnapshot() {
  return { config: baseConfig.value, foreignInbounds: foreignInbounds.value, xray: xrayState.value };
}

async function syncPortJump(token, uuid, ctrl, before, after) {
  const beforeNames = new Map(
    before
      .filter(inboundNeedsPortJump)
      .map((it) => [portJumpServiceName(it.tag), it.form.portJumpRange]),
  );
  const afterNames = new Map(
    after
      .filter(inboundNeedsPortJump)
      .map((it) => [
        portJumpServiceName(it.tag),
        { range: it.form.portJumpRange, port: it.form.endpointPort },
      ]),
  );

  const toRemove = [...beforeNames.keys()].filter((name) => {
    const next = afterNames.get(name);
    return !next || next.range !== beforeNames.get(name);
  });
  if (toRemove.length) {
    await removePortJumpUnits(client, token, uuid, toRemove, { signal: ctrl.signal });
  }

  for (const [name, payload] of afterNames.entries()) {
    if (beforeNames.get(name) === payload.range) continue;
    await applyPortJump(
      client,
      token,
      uuid,
      {
        serviceName: name,
        targetPort: payload.port,
        multiportSpec: toIptablesMultiportSpec(payload.range),
      },
      { signal: ctrl.signal },
    );
  }
}

async function ensureRealityKeypair() {
  if (protocol.value?.tlsMode !== "reality") return;
  if (form.privateKey && form.publicKey) return;
  const result = generateLocalRealityKeypair();
  if (!result.privateKey || !result.publicKey) {
    throw new Error("生成 Reality 密钥失败");
  }
  form.privateKey = result.privateKey;
  form.publicKey = result.publicKey;
}

function buildPayload({ replaceId = null, dropId = null } = {}) {
  const oldEntry = inbounds.value.find((entry) => entry.id === (dropId ?? replaceId));
  const engine = dropId != null ? getEntryEngine(oldEntry) : serviceEngine.value;
  if (replaceId != null && oldEntry?.protocolId !== selectedProtocolId.value) {
    throw new Error("编辑入站不可更换协议或内核，请删除后新建");
  }
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

  return buildEngineDeployment(engine, next, deploymentSnapshot());
}

async function persistPayload(token, uuid, ctrl, payload) {
  if (payload.engine === "xray") {
    return deployXrayState(client, token, uuid, payload, { signal: ctrl.signal });
  }
  return deployNodeState(client, token, uuid, payload, { signal: ctrl.signal });
}

function applyDeployResult(payload, result) {
  if (payload.engine === "xray") {
    xrayState.value = {
      ...xrayState.value, config: payload.config, meta: payload.meta,
      configSha256: result.configSha256, metaSha256: result.metaSha256,
      serviceActive: result.serviceActive, serviceEnabled: result.serviceEnabled, version: result.version,
    };
  } else {
    baseConfig.value = payload.config;
    baseConfigSha256.value = result.configSha256;
    serviceActive.value = result.serviceActive;
  }
  inbounds.value = payload.nextInbounds;
}

async function saveInbound() {
  commandError.value = "";
  if (!stateReady.value) {
    reportCommandFailure("请先成功读取节点状态，避免覆盖现有配置");
    return;
  }
  let token;
  let uuid;
  try {
    token = requireToken();
    uuid = requireSelectedUuid();
  } catch (e) {
    reportCommandFailure(errorMessage(e));
    return;
  }
  if (!validation.validateAll(form, selectedProtocolId.value)) {
    reportCommandFailure("请修正表单错误");
    return;
  }

  let portPort;
  try {
    portPort = parsePort(form.endpointPort, "端口");
    const normalized = validatePortJumpForm(form, selectedProtocolId.value, portPort);
    if (normalized != null) form.portJumpRange = normalized;
    validateNextHopForm(form);
  } catch (e) {
    reportCommandFailure(errorMessage(e));
    return;
  }

  const action = isEditing.value ? "update-inbound" : "add-inbound";
  const before = inbounds.value.slice();
  const ctrl = newAbortController();
  commandRunning.value = true;
  try {
    await ensureRealityKeypair();
    const replaceId = isEditing.value ? selectedInboundId.value : null;
    const payload = buildPayload({ replaceId });
    const result = await persistPayload(token, uuid, ctrl, payload);
    applyDeployResult(payload, result);
    await syncPortJump(token, uuid, ctrl, before, payload.nextInbounds);
    if (!isEditing.value) {
      const newest = payload.nextInbounds[payload.nextInbounds.length - 1];
      if (newest) selectedInboundId.value = newest.id;
    }
    pushRun(action, true, result.rawOutput);
    const nextHopSuffix = form.nextHopEnabled ? "，已启用下一跳节点" : "";
    showNotification(
      `${action === "update-inbound" ? "入站修改已保存" : "入站已添加"}${nextHopSuffix}`,
    );
  } catch (e) {
    stateReady.value = false;
    if (isAbort(e)) return;
    reportCommandFailure(errorMessage(e));
    pushRun(action, false, errorMessage(e));
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    commandRunning.value = false;
  }
}

async function deleteInbound() {
  commandError.value = "";
  if (!stateReady.value) {
    reportCommandFailure("请先成功读取节点状态，避免覆盖现有配置");
    return;
  }
  if (selectedInboundId.value == null) {
    reportCommandFailure("没有选中的入站");
    return;
  }
  let token;
  let uuid;
  try {
    token = requireToken();
    uuid = requireSelectedUuid();
  } catch (e) {
    reportCommandFailure(errorMessage(e));
    return;
  }
  const dropId = selectedInboundId.value;
  const before = inbounds.value.slice();
  const ctrl = newAbortController();
  commandRunning.value = true;
  try {
    const payload = buildPayload({ dropId });
    const result = await persistPayload(token, uuid, ctrl, payload);
    applyDeployResult(payload, result);
    await syncPortJump(token, uuid, ctrl, before, payload.nextInbounds);
    selectInbound(null);
    pushRun("delete-inbound", true, result.rawOutput);
    showNotification("入站已删除");
  } catch (e) {
    stateReady.value = false;
    if (isAbort(e)) return;
    reportCommandFailure(errorMessage(e));
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
    reportCommandFailure(errorMessage(e));
    return;
  }
  const ctrl = newAbortController();
  commandRunning.value = true;
  try {
    const engine = serviceEngine.value;
    const result = await (engine === "xray" ? controlXrayService : controlSingboxService)(client, token, uuid, action, {
      signal: ctrl.signal,
    });
    if (engine === "xray") {
      xrayState.value = { ...xrayState.value, serviceActive: result.serviceActive, serviceEnabled: result.serviceEnabled };
    } else {
      serviceActive.value = result.serviceActive;
      serviceEnabled.value = result.serviceEnabled;
    }
    pushRun(action, true, result.rawOutput, { engine });
    const successMessages = {
      start: "服务已设为开机自启并立即启动",
      stop: "服务已停止",
      restart: "服务已重启",
    };
    showNotification(`${engine === "xray" ? "Xray" : "sing-box"}：${successMessages[action] || "服务操作已完成"}`);
  } catch (e) {
    stateReady.value = false;
    if (isAbort(e)) return;
    reportCommandFailure(errorMessage(e));
    pushRun(action, false, errorMessage(e));
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    commandRunning.value = false;
  }
}

async function upgradeSingboxAction() {
  commandError.value = "";
  if (!stateReady.value) {
    reportCommandFailure("请先成功读取节点状态，再执行升级和配置迁移");
    return;
  }

  let migration;
  try {
    migration = migrateSingBoxConfigFor114(baseConfig.value);
  } catch (e) {
    reportCommandFailure(`无法自动迁移配置：${errorMessage(e)}`);
    return;
  }
  const migrationNotice = migration.changes.length
    ? `\n\n检测到 ${migration.changes.length} 项旧配置，将先自动迁移并使用新版本校验。`
    : "\n\n未检测到需要自动迁移的旧配置。";
  const confirmed = await requestConfirmation({
    title: "升级 sing-box",
    message:
      "确认将当前节点升级到 sing-box 官方最新稳定版？" +
      migrationNotice +
      "\n\n升级或迁移失败时会自动保留或恢复旧版本和旧配置。",
    confirmLabel: "确认升级",
  });
  if (!confirmed) {
    showNotification("已取消 sing-box 升级", "info");
    return;
  }

  let token;
  let uuid;
  try {
    token = requireToken();
    uuid = requireSelectedUuid();
  } catch (e) {
    reportCommandFailure(errorMessage(e));
    return;
  }

  const ctrl = newAbortController();
  commandRunning.value = true;
  showNotification("正在检查并升级 sing-box...", "info", 6000);
  try {
    const result = await upgradeSingbox(
      client,
      token,
      uuid,
      {
        config: migration.changes.length ? migration.config : null,
        configSha256: migration.changes.length ? baseConfigSha256.value : "",
        migrationCount: migration.changes.length,
      },
      { signal: ctrl.signal },
    );
    serviceActive.value = result.serviceActive;
    singboxVersion.value = result.newVersion;
    if (migration.changes.length) {
      baseConfig.value = migration.config;
      baseConfigSha256.value = result.configSha256;
    }
    pushRun("upgrade", true, result.rawOutput, {
      oldVersion: result.oldVersion,
      newVersion: result.newVersion,
      migrations: migration.changes,
    });
    const versionMessage = result.status === "up-to-date"
      ? `sing-box 已是最新稳定版 ${result.newVersion}`
      : result.oldVersion === result.newVersion
        ? `sing-box ${result.newVersion} 配置迁移完成`
        : `sing-box 已从 ${result.oldVersion} 升级到 ${result.newVersion}`;
    const migrationMessage = result.migrationCount
      ? `，已迁移 ${result.migrationCount} 项旧配置`
      : "";
    showNotification(`${versionMessage}${migrationMessage}`, "success", 6000);
  } catch (e) {
    stateReady.value = false;
    if (isAbort(e)) return;
    const rawMessage = errorMessage(e);
    reportCommandFailure(`升级失败：${upgradeErrorMessage(e)}`);
    pushRun("upgrade", false, rawMessage);
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    commandRunning.value = false;
  }
}

async function upgradeXrayAction() {
  commandError.value = "";
  if (!stateReady.value || !xrayState.value?.config) {
    reportCommandFailure("请先读取状态，并添加 XHTTP 入站完成 Xray 安装");
    return;
  }
  const confirmed = await requestConfirmation({
    title: "更新 Xray 兼容基线",
    message: `确认将面板专属 Xray 更新/修复为 ${XRAY_RELEASE}？不会跟随 latest，也不会操作其他 Xray 或 sing-box。下载、校验或重启失败时回滚。`,
    confirmLabel: "确认更新",
  });
  if (!confirmed) return;
  const ctrl = newAbortController();
  commandRunning.value = true;
  showNotification("正在下载、校验并更新 Xray…", "info", 6000);
  try {
    const result = await deployXrayState(client, requireToken(), requireSelectedUuid(), {
      upgrade: true,
      configSha256: xrayState.value.configSha256,
      metaSha256: xrayState.value.metaSha256,
    }, { signal: ctrl.signal });
    xrayState.value = { ...xrayState.value, ...result };
    pushRun("upgrade", true, result.rawOutput, { engine: "xray" });
    showNotification(`Xray 已更新至兼容基线 ${result.version}`);
  } catch (e) {
    stateReady.value = false;
    if (isAbort(e)) return;
    reportCommandFailure(`Xray 更新失败，请重新读取状态：${errorMessage(e)}`);
    pushRun("upgrade", false, errorMessage(e), { engine: "xray" });
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    commandRunning.value = false;
  }
}

async function uninstallAll() {
  commandError.value = "";
  if (!stateReady.value) {
    reportCommandFailure("请先成功读取节点状态，避免覆盖现有配置");
    return;
  }
  const confirmed = await requestConfirmation({
    title: "移除面板配置",
    message: "确认移除两个内核中面板管理的入站、下一跳和端口跳跃？其他配置、程序和服务将保留；按内核分别执行，若部分失败需重新读取状态。",
    confirmLabel: "确认移除",
    danger: true,
  });
  if (!confirmed) {
    showNotification("已取消移除面板配置", "info");
    return;
  }
  let token;
  let uuid;
  try {
    token = requireToken();
    uuid = requireSelectedUuid();
  } catch (e) {
    reportCommandFailure(errorMessage(e));
    return;
  }
  const ctrl = newAbortController();
  commandRunning.value = true;
  try {
    const outputs = [];
    for (const engine of ["singbox", "xray"]) {
      const before = inbounds.value.slice();
      const managed = before.filter((entry) => getEntryEngine(entry) === engine);
      if (!managed.length) continue;
      const payload = buildEngineDeployment(engine,
        before.filter((entry) => getEntryEngine(entry) !== engine), deploymentSnapshot());
      const result = await persistPayload(token, uuid, ctrl, payload);
      applyDeployResult(payload, result);
      await syncPortJump(token, uuid, ctrl, before, payload.nextInbounds);
      outputs.push(result.rawOutput);
    }
    const result = await uninstallSingbox(client, token, uuid, { signal: ctrl.signal });
    inbounds.value = [];
    selectInbound(null);
    pushRun("uninstall", true, [...outputs, result.rawOutput].filter(Boolean).join("\n"));
    showNotification("面板配置已移除");
  } catch (e) {
    stateReady.value = false;
    if (isAbort(e)) return;
    reportCommandFailure(errorMessage(e));
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
    showNotification(realityError.value, "error", 4500);
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
    const candidateCount = realityResult.value?.candidates?.length || 0;
    showNotification(
      `筛选完成，找到 ${candidateCount} 个候选`,
      candidateCount ? "success" : "info",
    );
  } catch (e) {
    if (isAbort(e)) return;
    realityError.value = errorMessage(e);
    showNotification(realityError.value, "error", 4500);
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
  form.handshakePort = Number(realityForm.port || form.handshakePort || 443);
  if (protocol.value?.tlsMode !== "reality") {
    selectedProtocolId.value = "vless-reality";
  }
  showNotification("候选已填入入站表单");
}

async function copyUri() {
  if (!connectionInfo.value?.uri) {
    reportCommandFailure("当前没有可复制的 URI");
    return;
  }
  try {
    validateGeneratedUri(connectionInfo.value.uri);
    await copyText(connectionInfo.value.uri);
    commandError.value = "";
    showNotification("URI 已复制");
  } catch (e) {
    reportCommandFailure(`复制失败：${errorMessage(e)}`);
  }
}

async function copyAllUris() {
  if (!allShareUris.value.length) {
    reportCommandFailure("当前没有可复制的 URI");
    return;
  }
  try {
    for (const row of allShareUris.value) validateGeneratedUri(row.uri);
    const text = allShareUris.value.map((row) => row.uri).join("\n");
    await copyText(text);
    commandError.value = "";
    showNotification(`已复制 ${allShareUris.value.length} 条 URI`);
  } catch (e) {
    reportCommandFailure(`复制失败：${errorMessage(e)}`);
  }
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
  const engine = getProtocolEngine(protocolId);
  const existing = [...(state.meta?.inbounds || []), ...(state.xray?.meta?.inbounds || [])];
  const foreign = [...(state.foreignInbounds || []), ...(state.xray?.foreignInbounds || [])];
  const sameIndex = existing.findIndex((it) => it.tag === tag);
  assertPortAvailable({ entries: existing, foreign, port, tag, ignoreId: sameIndex >= 0 ? existing[sameIndex].id : null });
  let next;
  if (sameIndex >= 0) {
    next = existing.slice();
    next[sameIndex] = {
      ...existing[sameIndex],
      protocolId,
      engine,
      tag,
      form: { ...formSnapshot, endpointPort: port },
      updatedAt: Date.now(),
    };
  } else {
    next = [
      ...existing,
      {
        id: makeInboundId(),
        tag,
        protocolId,
        engine,
        form: { ...formSnapshot, endpointPort: port },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
  }
  return buildEngineDeployment(engine, next, state);
}

async function batchDeploy() {
  commandError.value = "";
  if (!batchTargets.value.size) {
    reportCommandFailure("请先选择至少一个目标节点");
    return;
  }
  if (!validation.validateAll(form, selectedProtocolId.value)) {
    reportCommandFailure("请修正表单错误");
    return;
  }
  try {
    validateNextHopForm(form);
  } catch (e) {
    reportCommandFailure(errorMessage(e));
    return;
  }

  let token;
  try {
    token = requireToken();
  } catch (e) {
    reportCommandFailure(errorMessage(e));
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
      const result = generateLocalRealityKeypair();
      if (!result.privateKey || !result.publicKey) throw new Error("生成 Reality 密钥失败");
      form.privateKey = result.privateKey;
      form.publicKey = result.publicKey;
    }

    const snapshot = { ...form };
    const protocolId = selectedProtocolId.value;

    try {
      const port = parsePort(snapshot.endpointPort, "端口");
      const normalized = validatePortJumpForm(snapshot, protocolId, port);
      if (normalized != null) snapshot.portJumpRange = normalized;
    } catch (e) {
      reportCommandFailure(errorMessage(e));
      batchRunning.value = false;
      if (pendingAbort === ctrl) pendingAbort = null;
      return;
    }

    for (let i = 0; i < targets.length; i++) {
      const uuid = targets[i];
      batchProgress.value = batchProgress.value.map((row, idx) =>
        idx === i ? { ...row, status: "reading" } : row,
      );
      try {
        const state = await readNodeState(client, token, uuid, { signal: ctrl.signal });
        const beforeRemote = [...(state.meta?.inbounds || []), ...(state.xray?.meta?.inbounds || [])];
        const payload = mergeInboundIntoState(
          snapshot,
          protocolId,
          state,
        );
        batchProgress.value = batchProgress.value.map((row, idx) =>
          idx === i ? { ...row, status: "deploying" } : row,
        );
        const deploy = payload.engine === "xray" ? deployXrayState : deployNodeState;
        const r = await deploy(
          client,
          token,
          uuid,
          payload,
          { signal: ctrl.signal },
        );
        await syncPortJump(token, uuid, ctrl, beforeRemote, payload.nextInbounds);
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
    const failedCount = targets.length - okCount;
    const tone = failedCount === 0 ? "success" : okCount === 0 ? "error" : "warning";
    showNotification(
      `批量推送完成：成功 ${okCount}，失败 ${failedCount}`,
      tone,
      failedCount ? 4500 : 3000,
    );
    if (targets.includes(selectedUuid.value)) await refreshState();
  } catch (e) {
    if (isAbort(e)) return;
    reportCommandFailure(errorMessage(e));
    pushRun("batch-deploy", false, errorMessage(e));
  } finally {
    if (pendingAbort === ctrl) pendingAbort = null;
    batchRunning.value = false;
  }
}

function downloadExport(formatId) {
  const label = nodeNameMap.value[selectedUuid.value] || "nodeget";
  const inboundList = inbounds.value;
  if (!inboundList.length) {
    reportCommandFailure("当前没有可导出的入站");
    return;
  }
  try {
    let filename;
    if (formatId === "txt") {
      filename = `${label}-uris.txt`;
      triggerDownload(filename, buildPlainTextExport(inboundList, label));
    } else if (formatId === "clash") {
      filename = `${label}-clash.yaml`;
      const yaml = buildClashYamlExport(inboundList, label);
      triggerDownload(filename, yaml, "application/yaml");
    } else if (formatId === "singbox") {
      filename = `${label}-singbox-outbounds.json`;
      const json = buildSingboxOutboundsExport(inboundList, label);
      triggerDownload(filename, json, "application/json");
    } else {
      throw new Error(`未知导出格式：${formatId}`);
    }
    commandError.value = "";
    showNotification(`已导出 ${filename}`);
  } catch (e) {
    reportCommandFailure(`导出失败：${errorMessage(e)}`);
  }
}

function watchNode() {
  watch(selectedUuid, () => {
    stateReady.value = false;
    baseConfig.value = null;
    baseConfigSha256.value = "";
    xrayState.value = null;
    singboxVersion.value = "";
    serviceActive.value = "unknown";
    serviceEnabled.value = "unknown";
    foreignInbounds.value = [];
    inbounds.value = [];
    selectInbound(null);
    refreshState();
  });
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
    stateReady,
    stateError,
    serviceActive,
    serviceEnabled,
    singboxVersion,
    xrayState,
    xrayForeignInbounds,
    serviceEngine,
    serviceLabel,
    inbounds,
    foreignInbounds,
    selectedInboundId,
    selectedProtocolId,
    form,
    commandRunning,
    commandError,
    notification,
    confirmation,
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
    upgradeSingboxAction,
    upgradeXrayAction,
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
    dismissNotification,
    resolveConfirmation,
    abortInFlight,
    // lifecycle helpers
    watchNode,
    attachWindowListeners,
    closeClient: () => client.close(),
  };
}
