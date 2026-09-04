<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

defineProps({
  theme: { type: String, default: "light" },
  title: { type: String, required: true },
  message: { type: String, default: "" },
  confirmLabel: { type: String, default: "确认" },
  danger: { type: Boolean, default: false },
});

const emit = defineEmits(["confirm", "cancel"]);
const dialog = ref(null);
const confirmButton = ref(null);

function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("cancel");
    return;
  }
  if (event.key !== "Tab") return;
  const buttons = [...(dialog.value?.querySelectorAll("button") || [])];
  if (!buttons.length) return;
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  await nextTick();
  confirmButton.value?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div class="confirm-backdrop" :data-theme="theme" @click.self="emit('cancel')">
      <section
        ref="dialog"
        class="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
      >
        <h2 id="confirm-dialog-title" class="confirm-title">{{ title }}</h2>
        <p id="confirm-dialog-message" class="confirm-message">{{ message }}</p>
        <div class="confirm-actions">
          <button class="button ghost" type="button" @click="emit('cancel')">取消</button>
          <button
            ref="confirmButton"
            class="button"
            :class="danger ? 'danger' : 'primary'"
            type="button"
            @click="emit('confirm')"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.42);
}

.confirm-dialog {
  width: min(440px, 100%);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 20px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24);
}

.confirm-title {
  margin: 0;
  font-size: 16px;
  line-height: 1.3;
  letter-spacing: 0;
}

.confirm-message {
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

@media (max-width: 480px) {
  .confirm-dialog {
    padding: 16px;
  }

  .confirm-actions .button {
    flex: 1;
  }
}
</style>
