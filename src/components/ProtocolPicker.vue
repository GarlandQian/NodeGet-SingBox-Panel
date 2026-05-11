<script setup>
import { getProtocol, PROTOCOL_GROUPS } from "@/lib/protocols";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const { selectedProtocolId, isEditing, selectProtocol } = useSingboxPanel();

function onChange(event) {
  selectProtocol(event.target.value);
}
</script>

<template>
  <label class="field protocol-field">
    <span class="field-label">协议</span>
    <select
      :value="selectedProtocolId"
      class="select"
      :disabled="isEditing"
      @change="onChange"
    >
      <optgroup
        v-for="group in PROTOCOL_GROUPS"
        :key="group.label"
        :label="group.label"
      >
        <option
          v-for="id in group.protocols"
          :key="id"
          :value="id"
        >
          {{ getProtocol(id)?.label || id }}
        </option>
      </optgroup>
    </select>
    <div v-if="isEditing" class="field-hint">编辑入站不可改协议（会改 tag）。如需切换，请删除后新建。</div>
  </label>
</template>
