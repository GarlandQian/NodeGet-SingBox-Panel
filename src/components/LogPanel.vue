<script setup>
import { ref } from "vue";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const { filteredHistory, historyFilter, clearHistory } = useSingboxPanel();

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const FILTERS = [
  ["all", "全部"],
  ["deploy", "部署"],
  ["read", "读回"],
  ["control", "服务"],
  ["reality", "Reality"],
  ["failed", "失败"],
];

const expandedAt = ref(null);

function toggle(at) {
  expandedAt.value = expandedAt.value === at ? null : at;
}
</script>

<template>
  <section class="panel">
    <div class="output">
      <div class="panel-title-row">
        <p class="section-title">日志</p>
        <div class="log-controls">
          <div class="segments compact-segments">
            <button
              v-for="[id, label] in FILTERS"
              :key="id"
              class="segment"
              :class="{ 'is-active': historyFilter === id }"
              @click="historyFilter = id"
            >
              {{ label }}
            </button>
          </div>
          <button class="button small ghost" @click="clearHistory">清空</button>
        </div>
      </div>
      <div v-if="filteredHistory.length" class="log-list">
        <div
          v-for="run in filteredHistory"
          :key="run.at"
          class="log-entry"
          :class="{ 'is-failed': !run.ok }"
        >
          <button class="log-head" @click="toggle(run.at)">
            <span class="log-action">{{ run.action }}</span>
            <span class="log-status">{{ run.ok ? "成功" : "失败" }}</span>
            <span class="log-time">{{ formatTime(run.at) }}</span>
            <span class="log-toggle">{{ expandedAt === run.at ? "▾" : "▸" }}</span>
          </button>
          <pre v-if="expandedAt === run.at" class="output-box log-output">{{ run.output || "（无输出）" }}</pre>
        </div>
      </div>
      <div v-else class="empty">没有匹配的记录。</div>
    </div>
  </section>
</template>
