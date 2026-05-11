<script setup>
import { computed } from "vue";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const { batchMode, batchProgress, nodeNameMap } = useSingboxPanel();

const summary = computed(() => {
  const total = batchProgress.value.length;
  const ok = batchProgress.value.filter((r) => r.status === "ok").length;
  const failed = batchProgress.value.filter(
    (r) => r.status === "failed" || r.status === "aborted",
  ).length;
  return { total, ok, failed };
});

function statusLabel(status) {
  return {
    pending: "排队",
    reading: "读回",
    deploying: "下发",
    keypair: "生成密钥",
    ok: "成功",
    failed: "失败",
    aborted: "已取消",
  }[status] || status;
}
</script>

<template>
  <section v-if="batchMode && batchProgress.length" class="panel">
    <div class="panel-title-row">
      <p class="section-title">批量进度</p>
      <span class="section-note">
        成功 {{ summary.ok }} / 失败 {{ summary.failed }} / 共 {{ summary.total }}
      </span>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>节点</th>
            <th>UUID</th>
            <th>状态</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in batchProgress" :key="row.uuid">
            <td>{{ nodeNameMap[row.uuid] || row.uuid.slice(0, 8) }}</td>
            <td class="mono">{{ row.uuid }}</td>
            <td>
              <span class="batch-pill" :class="`batch-pill-${row.status}`">
                {{ statusLabel(row.status) }}
              </span>
            </td>
            <td>{{ row.message || "—" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
