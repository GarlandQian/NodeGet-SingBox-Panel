<script setup>
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const {
  search,
  loadingNodes,
  nodeError,
  selectedUuid,
  filteredNodes,
  nodeNameMap,
  refreshNodes,
  singboxVersion,
  serviceActive,
  batchMode,
  isBatchTarget,
  toggleBatchTarget,
  batchTargets,
  clearBatchTargets,
} = useSingboxPanel();

function onNodeClick(uuid) {
  if (batchMode.value) {
    toggleBatchTarget(uuid);
    return;
  }
  selectedUuid.value = uuid;
}

function displayName(uuid) {
  return nodeNameMap.value[uuid] || `${uuid.slice(0, 8)}…`;
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-search">
      <input
        v-model="search"
        class="input small"
        type="search"
        placeholder="搜索节点名或 UUID"
      />
      <button
        class="icon-button"
        :disabled="loadingNodes"
        :title="loadingNodes ? '刷新中' : '刷新节点'"
        @click="refreshNodes"
      >
        <span class="icon" :class="{ spinning: loadingNodes }">↻</span>
      </button>
    </div>

    <div v-if="batchMode" class="batch-banner">
      <span>已选 {{ batchTargets.size }} 个目标</span>
      <button
        class="button small ghost"
        :disabled="!batchTargets.size"
        @click="clearBatchTargets"
      >
        清空
      </button>
    </div>

    <div class="node-list">
      <button
        v-for="uuid in filteredNodes"
        :key="uuid"
        class="node-item"
        :class="{
          'is-active': !batchMode && uuid === selectedUuid,
          'is-batch': batchMode && isBatchTarget(uuid),
        }"
        :title="uuid"
        @click="onNodeClick(uuid)"
      >
        <span
          v-if="batchMode"
          class="checkbox"
          :class="{ 'is-checked': isBatchTarget(uuid) }"
          aria-hidden="true"
        />
        <div class="node-text">
          <span class="node-name">{{ displayName(uuid) }}</span>
          <div
            v-if="!batchMode && uuid === selectedUuid"
            class="node-status"
          >
            <span class="node-status-meta">
              {{ singboxVersion && singboxVersion !== "missing" ? `sing-box ${singboxVersion}` : "sing-box 未装" }}
            </span>
            <span
              class="node-status-badge"
              :class="`status-${serviceActive}`"
            >
              {{ serviceActive }}
            </span>
          </div>
        </div>
      </button>
      <div v-if="!loadingNodes && !filteredNodes.length" class="empty">
        没有可见节点，或者搜索条件太窄。
      </div>
      <div v-if="nodeError" class="empty">{{ nodeError }}</div>
    </div>
  </aside>
</template>
