<script setup>
import { getProtocol } from "@/lib/protocols";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const {
  inbounds,
  foreignInbounds,
  selectedInboundId,
  selectedUuid,
  loadingState,
  stateError,
  batchMode,
  batchTargets,
  selectInbound,
  refreshState,
  toggleBatchMode,
} = useSingboxPanel();

function protocolLabel(id) {
  return getProtocol(id)?.label || id;
}

function endpointLabel(entry) {
  const host = entry.form.endpointHost?.trim() || "未填写";
  const port = entry.form.endpointPort;
  return { host, port };
}
</script>

<template>
  <div class="inbound-bar">
    <div class="inbound-bar-head">
      <p class="section-title">入站</p>
      <div class="inbound-bar-actions">
        <button
          class="button small"
          :class="{ 'is-active': batchMode }"
          @click="toggleBatchMode"
        >
          {{ batchMode ? `批量模式（${batchTargets.size}）` : "批量模式" }}
        </button>
        <button
          class="button small"
          :disabled="!selectedUuid || loadingState"
          @click="refreshState"
        >
          {{ loadingState ? "读取中..." : "重新读取" }}
        </button>
        <button
          class="button small primary"
          :disabled="!selectedUuid"
          @click="selectInbound(null)"
        >
          + 新建入站
        </button>
      </div>
    </div>
    <div class="inbound-list">
      <button
        v-for="entry in inbounds"
        :key="entry.id"
        class="inbound-chip"
        :class="{ 'is-active': entry.id === selectedInboundId }"
        :disabled="batchMode"
        :title="entry.tag"
        @click="selectInbound(entry.id)"
      >
        <div class="inbound-chip-protocol">{{ protocolLabel(entry.protocolId) }}</div>
        <div class="inbound-chip-endpoint">
          <span class="inbound-chip-host">{{ endpointLabel(entry).host }}</span>
          <span class="inbound-chip-port">:{{ endpointLabel(entry).port }}</span>
        </div>
      </button>
      <div v-if="!inbounds.length && !loadingState" class="empty inbound-empty">
        还没有 nodeget 入站。点 "+ 新建入站" 创建第一个。
      </div>
    </div>
    <div v-if="foreignInbounds.length" class="inbound-foreign">
      检测到 {{ foreignInbounds.length }} 个非 nodeget 管理的入站，将原样保留。
    </div>
    <div v-if="stateError" class="empty">{{ stateError }}</div>
  </div>
</template>
