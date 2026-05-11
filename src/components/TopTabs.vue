<script setup>
import { computed } from "vue";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const { activeTab, inbounds, recentRuns } = useSingboxPanel();

const TABS = computed(() => [
  { id: "inbound", label: "入站", count: inbounds.value.length },
  { id: "reality", label: "Reality" },
  { id: "export", label: "导出 & URL" },
  { id: "logs", label: "日志", count: recentRuns.value.length },
]);
</script>

<template>
  <nav class="top-tabs">
    <button
      v-for="tab in TABS"
      :key="tab.id"
      class="top-tab"
      :class="{ 'is-active': activeTab === tab.id }"
      @click="activeTab = tab.id"
    >
      {{ tab.label }}
      <span v-if="tab.count != null && tab.count > 0" class="top-tab-count">{{ tab.count }}</span>
    </button>
  </nav>
</template>
