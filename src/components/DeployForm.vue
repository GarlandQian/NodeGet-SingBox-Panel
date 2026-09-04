<script setup>
import { computed } from "vue";
import { getProtocolFields } from "@/lib/protocols";
import { describeNextHopUri } from "@/lib/nextHop";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const { protocol, selectedProtocolId, form, validation, regenSecret } = useSingboxPanel();

const fields = computed(() => getProtocolFields(selectedProtocolId.value));
const extraFields = computed(() =>
  fields.value.filter(
    (field) =>
      !["endpointHost", "endpointPort", "handshakeHost", "handshakePort"].includes(
        field.key,
      ),
  ),
);

const nextHopPreview = computed(() => {
  if (!form.nextHopEnabled) return null;
  if (!String(form.nextHopUri || "").trim()) {
    return { error: "请填写下一跳节点 URI" };
  }
  try {
    return describeNextHopUri(form.nextHopUri);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

function onChange(key, event) {
  if (key === "method") {
    form.method = event?.target?.value || form.method;
    regenSecret();
  }
  validation.markTouched(key);
  validation.validateField(form, selectedProtocolId.value, key);
}
function onBlur(key) {
  validation.markTouched(key);
  validation.validateField(form, selectedProtocolId.value, key);
}
function isRequired(key) {
  return validation.isRequired(selectedProtocolId.value, key);
}
function fieldError(key) {
  return validation.fieldError(key);
}
</script>

<template>
  <div class="form-body">
    <div class="panel-grid">
      <label class="field">
        <span class="field-label">
          域名 / IP
          <span v-if="isRequired('endpointHost')" class="required-star">*</span>
        </span>
        <input
          v-model="form.endpointHost"
          class="input"
          :class="{ 'has-error': fieldError('endpointHost') }"
          type="text"
          placeholder="example.com / 1.2.3.4 / 2001:db8::1"
          @input="onChange('endpointHost')"
          @blur="onBlur('endpointHost')"
        />
        <div v-if="fieldError('endpointHost')" class="field-error">
          {{ fieldError('endpointHost') }}
        </div>
      </label>

      <label class="field">
        <span class="field-label">
          端口
          <span v-if="isRequired('endpointPort')" class="required-star">*</span>
        </span>
        <input
          v-model.number="form.endpointPort"
          class="input"
          :class="{ 'has-error': fieldError('endpointPort') }"
          type="number"
          min="1"
          max="65535"
          @input="onChange('endpointPort')"
          @blur="onBlur('endpointPort')"
        />
        <div v-if="fieldError('endpointPort')" class="field-error">
          {{ fieldError('endpointPort') }}
        </div>
      </label>
    </div>

    <div v-if="protocol?.tlsMode !== 'none'" class="panel-grid">
      <label class="field">
        <span class="field-label">
          SNI / 域名
          <span v-if="isRequired('handshakeHost')" class="required-star">*</span>
        </span>
        <input
          v-model="form.handshakeHost"
          class="input"
          :class="{ 'has-error': fieldError('handshakeHost') }"
          type="text"
          placeholder="www.amd.com"
          @input="onChange('handshakeHost')"
          @blur="onBlur('handshakeHost')"
        />
        <div v-if="fieldError('handshakeHost')" class="field-error">
          {{ fieldError('handshakeHost') }}
        </div>
      </label>
      <label v-if="protocol?.tlsMode === 'reality'" class="field">
        <span class="field-label">
          SNI 端口
          <span v-if="isRequired('handshakePort')" class="required-star">*</span>
        </span>
        <input
          v-model.number="form.handshakePort"
          class="input"
          :class="{ 'has-error': fieldError('handshakePort') }"
          type="number"
          min="1"
          max="65535"
          @input="onChange('handshakePort')"
          @blur="onBlur('handshakePort')"
        />
        <div v-if="fieldError('handshakePort')" class="field-error">
          {{ fieldError('handshakePort') }}
        </div>
      </label>
    </div>

    <div class="panel-grid">
      <label v-for="field in extraFields" :key="field.key" class="field">
        <span class="field-label">
          {{ field.label }}
          <span v-if="isRequired(field.key)" class="required-star">*</span>
        </span>
        <input
          v-if="field.type === 'text' || field.type === 'number'"
          v-model="form[field.key]"
          class="input"
          :class="{ 'has-error': fieldError(field.key) }"
          :type="field.type"
          :min="field.min"
          :max="field.max"
          :placeholder="field.placeholder"
          @input="onChange(field.key)"
          @blur="onBlur(field.key)"
        />
        <select
          v-else-if="field.type === 'select'"
          v-model="form[field.key]"
          class="select"
          :class="{ 'has-error': fieldError(field.key) }"
          @change="onChange(field.key, $event)"
          @blur="onBlur(field.key)"
        >
          <option v-for="option in field.options" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <div v-if="fieldError(field.key)" class="field-error">
          {{ fieldError(field.key) }}
        </div>
      </label>
    </div>

    <section class="next-hop-section">
      <label class="next-hop-toggle">
        <input v-model="form.nextHopEnabled" type="checkbox" />
        <span class="next-hop-switch" aria-hidden="true" />
        <span class="next-hop-toggle-label">通过下一跳节点出站</span>
        <span class="next-hop-mode">{{ form.nextHopEnabled ? "下一跳" : "直连" }}</span>
      </label>

      <label v-if="form.nextHopEnabled" class="field next-hop-uri-field">
        <span class="field-label">下一跳节点 URI</span>
        <textarea
          v-model="form.nextHopUri"
          class="textarea next-hop-uri-input"
          :class="{ 'has-error': nextHopPreview?.error }"
          rows="3"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="socks5://user:password@host:port"
        />
        <div v-if="nextHopPreview?.error" class="field-error">
          {{ nextHopPreview.error }}
        </div>
        <div v-else-if="nextHopPreview" class="next-hop-preview">
          <span class="next-hop-preview-dot" aria-hidden="true" />
          <span>{{ nextHopPreview.label }}</span>
          <span class="next-hop-preview-endpoint">{{ nextHopPreview.endpoint }}</span>
        </div>
      </label>
    </section>

    <slot name="actions" />
  </div>
</template>
