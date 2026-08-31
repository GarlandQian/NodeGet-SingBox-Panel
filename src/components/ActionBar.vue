<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const {
  theme,
  protocol,
  commandRunning,
  commandError,
  loadingState,
  stateReady,
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
const moreButton = ref(null);
const morePopover = ref(null);
const morePopoverStyle = ref({ visibility: "hidden" });

const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;

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
  morePopoverStyle.value = { visibility: "hidden" };
}

async function positionMenu() {
  if (!moreOpen.value) return;
  await nextTick();

  const trigger = moreButton.value;
  const popover = morePopover.value;
  if (!trigger || !popover) return;

  const triggerRect = trigger.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const width = Math.min(
    Math.max(220, triggerRect.width),
    Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2),
  );
  const naturalHeight = popover.scrollHeight;
  const spaceBelow = Math.max(
    0,
    viewportHeight - triggerRect.bottom - MENU_GAP - VIEWPORT_MARGIN,
  );
  const spaceAbove = Math.max(
    0,
    triggerRect.top - MENU_GAP - VIEWPORT_MARGIN,
  );
  const openAbove = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
  const availableHeight = openAbove ? spaceAbove : spaceBelow;
  const renderedHeight = Math.min(naturalHeight, availableHeight);
  const desiredTop = openAbove
    ? triggerRect.top - MENU_GAP - renderedHeight
    : triggerRect.bottom + MENU_GAP;
  const maxTop = Math.max(
    VIEWPORT_MARGIN,
    viewportHeight - VIEWPORT_MARGIN - renderedHeight,
  );
  const top = Math.min(Math.max(VIEWPORT_MARGIN, desiredTop), maxTop);
  const maxLeft = Math.max(
    VIEWPORT_MARGIN,
    viewportWidth - VIEWPORT_MARGIN - width,
  );
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, triggerRect.right - width),
    maxLeft,
  );

  morePopoverStyle.value = {
    visibility: "visible",
    top: `${top}px`,
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${availableHeight}px`,
  };
}

async function toggleMenu() {
  if (moreOpen.value) {
    closeMenu();
    return;
  }
  morePopoverStyle.value = { visibility: "hidden" };
  moreOpen.value = true;
  await positionMenu();
}

function handleViewportChange() {
  if (moreOpen.value) void positionMenu();
}

function handleKeydown(event) {
  if (event.key !== "Escape" || !moreOpen.value) return;
  closeMenu();
  moreButton.value?.focus();
}

function withClose(fn) {
  return (...args) => {
    closeMenu();
    return fn(...args);
  };
}

onMounted(() => {
  window.addEventListener("resize", handleViewportChange);
  window.addEventListener("scroll", handleViewportChange, true);
  window.addEventListener("keydown", handleKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", handleViewportChange);
  window.removeEventListener("scroll", handleViewportChange, true);
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div>
    <div class="actions">
      <button
        v-if="!batchMode"
        class="button primary"
        :disabled="commandRunning || loadingState || !stateReady"
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
        <button
          ref="moreButton"
          class="button"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="moreOpen"
          aria-controls="action-more-menu"
          @click="toggleMenu"
        >
          更多 ▾
        </button>
        <Teleport to="body">
          <template v-if="moreOpen">
            <div class="more-backdrop" @click="closeMenu" />
            <div
              id="action-more-menu"
              ref="morePopover"
              class="more-popover"
              role="menu"
              :data-theme="theme"
              :style="morePopoverStyle"
            >
              <div class="more-group-label">服务</div>
              <button
                class="more-item"
                role="menuitem"
                :disabled="batchMode || commandRunning"
                @click="withClose(() => controlAction('start'))()"
              >
                开机自启并立即启动
              </button>
              <button
                class="more-item"
                role="menuitem"
                :disabled="batchMode || commandRunning"
                @click="withClose(() => controlAction('stop'))()"
              >
                停止
              </button>
              <button
                class="more-item"
                role="menuitem"
                :disabled="batchMode || commandRunning"
                @click="withClose(() => controlAction('restart'))()"
              >
                重启
              </button>
              <div class="more-sep" />
              <div class="more-group-label">表单</div>
              <button
                class="more-item"
                role="menuitem"
                @click="withClose(regenSecret)()"
              >
                {{ secretButtonLabel }}
              </button>
              <template v-if="isEditing && !batchMode">
                <div class="more-sep" />
                <button
                  class="more-item danger"
                  role="menuitem"
                  :disabled="commandRunning"
                  @click="withClose(deleteInbound)()"
                >
                  删除当前入站
                </button>
              </template>
              <div class="more-sep" />
              <button
                class="more-item danger"
                role="menuitem"
                :disabled="batchMode || commandRunning"
                @click="withClose(uninstallAll)()"
              >
                移除面板配置
              </button>
            </div>
          </template>
        </Teleport>
      </div>
    </div>
    <div v-if="commandError" class="empty">{{ commandError }}</div>
  </div>
</template>
