<script setup>
import { computed, ref } from "vue";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const {
  protocol,
  commandRunning,
  commandError,
  isEditing,
  saveButtonLabel,
  connectionInfo,
  batchMode,
  batchTargets,
  batchRunning,
  saveInbound,
  controlAction,
  regenSecret,
  copyUri,
  deleteInbound,
  uninstallAll,
  batchDeploy,
} = useSingboxPanel();

const moreOpen = ref(false);

const secretButtonLabel = computed(() => {
  const family = protocol.value?.family;
  if (!family) return "更新密钥";
  if (family === "vless" || family === "vmess") return "更新 UUID";
  if (family === "tuic") return "更新 UUID / 密码";
  if (family === "socks") return "更新用户信息";
  return "更新密码";
});

function closeMenu() {
  moreOpen.value = false;
}

function withClose(fn) {
  return (...args) => {
    closeMenu();
    return fn(...args);
  };
}
</script>

<template>
  <div>
    <div class="actions">
      <button
        v-if="!batchMode"
        class="button primary"
        :disabled="commandRunning"
        @click="saveInbound"
      >
        {{ commandRunning ? "执行中..." : saveButtonLabel }}
      </button>
      <button
        v-else
        class="button primary"
        :disabled="batchRunning || !batchTargets.size"
        @click="batchDeploy"
      >
        {{ batchRunning ? "推送中..." : `推送到 ${batchTargets.size} 个节点` }}
      </button>

      <button class="button" :disabled="!connectionInfo?.uri" @click="copyUri">复制 URL</button>

      <div class="more-menu">
        <button class="button" @click="moreOpen = !moreOpen">更多 ▾</button>
        <template v-if="moreOpen">
          <div class="more-backdrop" @click="closeMenu" />
          <div class="more-popover">
            <div class="more-group-label">服务</div>
            <button class="more-item" :disabled="batchMode || commandRunning" @click="withClose(() => controlAction('start'))()">启动</button>
            <button class="more-item" :disabled="batchMode || commandRunning" @click="withClose(() => controlAction('stop'))()">停止</button>
            <button class="more-item" :disabled="batchMode || commandRunning" @click="withClose(() => controlAction('restart'))()">重启</button>
            <div class="more-sep" />
            <div class="more-group-label">表单</div>
            <button class="more-item" @click="withClose(regenSecret)()">{{ secretButtonLabel }}</button>
            <template v-if="isEditing && !batchMode">
              <div class="more-sep" />
              <button
                class="more-item danger"
                :disabled="commandRunning"
                @click="withClose(deleteInbound)()"
              >
                删除当前入站
              </button>
            </template>
            <div class="more-sep" />
            <button
              class="more-item danger"
              :disabled="batchMode || commandRunning"
              @click="withClose(uninstallAll)()"
            >
              完全卸载 sing-box
            </button>
          </div>
        </template>
      </div>
    </div>
    <div v-if="commandError" class="empty">{{ commandError }}</div>
  </div>
</template>
