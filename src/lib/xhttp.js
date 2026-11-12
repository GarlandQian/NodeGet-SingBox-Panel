// Match the Xray baseline's connection pool and lifetime using options supported by both cores.
// Mihomo documents h-max-request-times as inaccurate, so use the lifetime bound instead.
export const XHTTP_XMUX = Object.freeze({
  maxConnections: 3,
  hMaxReusableSecs: "1800-3000",
});

export const MIHOMO_XHTTP_REUSE_SETTINGS = Object.freeze({
  "max-connections": String(XHTTP_XMUX.maxConnections),
  "h-max-reusable-secs": XHTTP_XMUX.hMaxReusableSecs,
});
