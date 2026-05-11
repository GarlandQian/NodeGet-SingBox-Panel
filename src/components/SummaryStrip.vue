<script setup>
import { computed } from "vue";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const { selectedProtocolLabel, selectedProtocolId, form, isEditing } = useSingboxPanel();

const tag = computed(() =>
  selectedProtocolId.value && form.endpointPort
    ? `nodeget-${selectedProtocolId.value}-${form.endpointPort}`
    : "—",
);
</script>

<template>
  <div class="summary-line">
    <span class="summary-line-label">{{ isEditing ? "编辑入站" : "新建入站" }}</span>
    <span class="summary-line-tag">{{ tag }}</span>
    <span class="summary-line-meta">{{ selectedProtocolLabel }}</span>
  </div>
</template>
