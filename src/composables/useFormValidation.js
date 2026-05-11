import { reactive } from "vue";
import { FIELD_DEFS, getProtocol, getProtocolRequiredFields } from "@/lib/protocols";

const ERROR_REQUIRED = "必填";
const ERROR_NUMBER = "需要数字";

function validateOne(key, value, protocol, required) {
  const def = FIELD_DEFS[key];
  const isRequired = required.has(key);
  if (isRequired && (value == null || value === "" || (typeof value === "string" && !value.trim()))) {
    return ERROR_REQUIRED;
  }
  if (!def) return "";
  if (def.type === "number") {
    if (value === "" || value == null) return isRequired ? ERROR_REQUIRED : "";
    const num = Number(value);
    if (!Number.isFinite(num)) return ERROR_NUMBER;
    if (def.min != null && num < def.min) return `不能小于 ${def.min}`;
    if (def.max != null && num > def.max) return `不能大于 ${def.max}`;
  }
  if (key === "path" && value && !String(value).startsWith("/")) {
    return "需以 / 开头";
  }
  return "";
}

export function useFormValidation() {
  const errors = reactive({});
  const touched = reactive(new Set());

  const requiredKeysFor = (protocolId) => new Set(getProtocolRequiredFields(protocolId));

  const validateField = (form, protocolId, key) => {
    const protocol = getProtocol(protocolId);
    if (!protocol) return true;
    const required = requiredKeysFor(protocolId);
    const message = validateOne(key, form[key], protocol, required);
    if (message) errors[key] = message;
    else delete errors[key];
    return !message;
  };

  const validateAll = (form, protocolId) => {
    const protocol = getProtocol(protocolId);
    if (!protocol) return false;
    const required = requiredKeysFor(protocolId);
    let ok = true;
    for (const key of required) {
      const message = validateOne(key, form[key], protocol, required);
      if (message) {
        errors[key] = message;
        ok = false;
      } else {
        delete errors[key];
      }
    }
    if (!ok) {
      for (const key of required) touched.add(key);
    }
    return ok;
  };

  const markTouched = (key) => {
    touched.add(key);
  };

  const reset = () => {
    for (const key of Object.keys(errors)) delete errors[key];
    touched.clear();
  };

  const isRequired = (protocolId, key) => requiredKeysFor(protocolId).has(key);

  const fieldError = (key) => (touched.has(key) ? errors[key] || "" : "");

  return {
    errors,
    touched,
    validateField,
    validateAll,
    markTouched,
    reset,
    isRequired,
    fieldError,
  };
}
