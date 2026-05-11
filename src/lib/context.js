export function parseExtensionContext() {
  const rawHash = typeof location !== "undefined" ? location.hash : "";
  const trimmed = rawHash.replace(/^#\??/, "");
  const search = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
  const params = new URLSearchParams(search);
  return {
    token: params.get("token") || "",
    node: params.get("node") || "",
    theme: params.get("theme") || "light",
  };
}

export function resolveWsOrigin() {
  const override = import.meta.env.VITE_WS_ORIGIN?.trim();
  if (override) return override;
  const protocol = typeof location !== "undefined" ? location.protocol : "https:";
  const host = typeof location !== "undefined" ? location.host : "localhost";
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}`;
}
