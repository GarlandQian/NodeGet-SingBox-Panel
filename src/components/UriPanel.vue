<script setup>
import { ref } from "vue";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const { connectionInfo, allShareUris, copyAllUris, downloadExport, inbounds } =
  useSingboxPanel();

const exportOpen = ref(false);

function exportAs(format) {
  exportOpen.value = false;
  downloadExport(format);
}
</script>

<template>
  <section class="panel">
    <div class="panel-grid">
      <div class="preview">
        <p class="section-title">URL 信息</p>
        <div v-if="connectionInfo" class="status-grid">
          <div v-for="item in connectionInfo.details" :key="item[0]" class="status-card">
            <div class="status-title">{{ item[0] }}</div>
            <div class="status-value">{{ item[1] }}</div>
          </div>
        </div>
        <div v-else class="empty">先填写域名 / IP 和节点，再生成 URL。</div>
      </div>

      <div class="output">
        <div class="panel-title-row">
          <p class="section-title">URL</p>
          <div class="export-row">
            <button
              class="button small"
              :disabled="!allShareUris.length"
              @click="copyAllUris"
            >
              复制全部 ({{ allShareUris.length }})
            </button>
            <div class="export-menu">
              <button
                class="button small"
                :disabled="!inbounds.length"
                @click="exportOpen = !exportOpen"
              >
                导出 ▾
              </button>
              <div v-if="exportOpen" class="export-popover">
                <button class="export-item" @click="exportAs('txt')">URI 列表 (.txt)</button>
                <button class="export-item" @click="exportAs('clash')">
                  Mihomo / Clash Meta (.yaml)
                </button>
                <button class="export-item" @click="exportAs('singbox')">
                  sing-box outbound (.json)
                </button>
              </div>
            </div>
          </div>
        </div>
        <pre class="output-box compact">{{ connectionInfo?.uri || "等待填写完成后自动生成" }}</pre>
      </div>
    </div>
  </section>
</template>
