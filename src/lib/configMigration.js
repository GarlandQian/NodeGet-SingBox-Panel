const MIGRATION_DNS_TAG_BASE = "nodeget-migration-local";
const DOMAIN_STRATEGIES = new Set([
  "prefer_ipv4",
  "prefer_ipv6",
  "ipv4_only",
  "ipv6_only",
]);
const LEGACY_OUTBOUND_RULE_FIELDS = new Set([
  "action",
  "client_subnet",
  "disable_cache",
  "outbound",
  "rewrite_ttl",
  "server",
  "strategy",
]);
const RCODE_MAP = {
  success: "NOERROR",
  format_error: "FORMERR",
  server_failure: "SERVFAIL",
  name_error: "NXDOMAIN",
  not_implemented: "NOTIMP",
  refused: "REFUSED",
};

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeHostname(hostname) {
  const value = String(hostname || "");
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function ensureDns(config) {
  if (!isObject(config.dns)) config.dns = {};
  if (!Array.isArray(config.dns.servers)) config.dns.servers = [];
  return config.dns;
}

function ensureLocalResolver(config, changes) {
  const dns = ensureDns(config);
  const existingLocal = dns.servers.find(
    (server) =>
      (server?.type === "local" || server?.address === "local") &&
      typeof server.tag === "string" &&
      server.tag,
  );
  if (existingLocal) return existingLocal.tag;

  const tags = new Set(dns.servers.map((server) => server?.tag).filter(Boolean));
  let tag = MIGRATION_DNS_TAG_BASE;
  let suffix = 2;
  while (tags.has(tag)) {
    tag = `${MIGRATION_DNS_TAG_BASE}-${suffix}`;
    suffix += 1;
  }
  dns.servers.push({ type: "local", tag });
  changes.push(`添加本地域名解析器 ${tag}`);
  return tag;
}

function resolverWithStrategy(config, currentResolver, strategy, changes) {
  if (!DOMAIN_STRATEGIES.has(strategy)) {
    throw new Error(`无法自动迁移未知的域名策略：${strategy}`);
  }
  if (typeof currentResolver === "string" && currentResolver) {
    return { server: currentResolver, strategy };
  }
  if (isObject(currentResolver)) {
    if (currentResolver.strategy && currentResolver.strategy !== strategy) {
      throw new Error("无法自动合并冲突的 domain_resolver.strategy");
    }
    return { ...currentResolver, strategy };
  }
  return { server: ensureLocalResolver(config, changes), strategy };
}

function parseLegacyDnsAddress(address) {
  const value = String(address || "").trim();
  if (!value) throw new Error("无法自动迁移缺少 address 的旧 DNS 服务器");
  if (value === "local") return { type: "local" };
  if (value === "fakeip") return { type: "fakeip" };

  const rcodeMatch = value.match(/^rcode:\/\/([^/?#]+)$/i);
  if (rcodeMatch) {
    const rcode = RCODE_MAP[rcodeMatch[1].toLowerCase()];
    if (!rcode) throw new Error(`无法自动迁移 DNS RCode：${rcodeMatch[1]}`);
    return { rcode };
  }

  const dhcpMatch = value.match(/^dhcp:\/\/([^/?#]+)$/i);
  if (dhcpMatch) {
    return dhcpMatch[1] === "auto"
      ? { type: "dhcp" }
      : { type: "dhcp", interface: decodeURIComponent(dhcpMatch[1]) };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `udp://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`无法自动迁移旧 DNS 地址：${value}`);
  }
  const type = url.protocol.slice(0, -1).toLowerCase();
  if (!["tcp", "udp", "tls", "https", "quic", "h3"].includes(type)) {
    throw new Error(`无法自动迁移旧 DNS 类型：${type}`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`旧 DNS 地址包含无法等价迁移的认证或片段：${value}`);
  }
  const server = normalizeHostname(url.hostname);
  if (!server) throw new Error(`无法自动迁移旧 DNS 地址：${value}`);
  const migrated = { type, server };
  if (url.port) migrated.server_port = Number(url.port);
  if ((type === "https" || type === "h3") && (url.pathname !== "/" || url.search)) {
    migrated.path = `${url.pathname}${url.search}`;
  }
  return migrated;
}

function isDefaultServer(dns, originalServers, server) {
  if (server.tag && dns.final) return dns.final === server.tag;
  return !dns.final && originalServers[0] === server;
}

function moveLegacyServerOption(dns, originalServers, server, field, value) {
  let applied = false;
  if (isDefaultServer(dns, originalServers, server)) {
    if (dns[field] != null && !sameJson(dns[field], value)) {
      throw new Error(`默认 DNS 服务器的 ${field} 与 dns.${field} 冲突，无法自动迁移`);
    }
    if (dns[field] == null) dns[field] = value;
    applied = true;
  }
  if (server.tag && Array.isArray(dns.rules)) {
    for (const rule of dns.rules) {
      if (!isObject(rule) || rule.server !== server.tag) continue;
      if (rule[field] == null) rule[field] = value;
      applied = true;
    }
  }
  return applied;
}

function migrateRcodeRules(dns, originalServers, rcodeServers, changes) {
  if (!rcodeServers.length) return;
  if (!Array.isArray(dns.rules)) dns.rules = [];

  for (const { source, rcode } of rcodeServers) {
    let matchedRule = false;
    if (source.tag) {
      for (const rule of dns.rules) {
        if (!isObject(rule) || rule.server !== source.tag) continue;
        if (rule.action && rule.action !== "route") {
          throw new Error(`DNS 规则 ${source.tag} 已有非 route 动作，无法自动迁移 RCode`);
        }
        delete rule.server;
        delete rule.strategy;
        rule.action = "predefined";
        rule.rcode = rcode;
        matchedRule = true;
      }
    }
    if (isDefaultServer(dns, originalServers, source)) {
      dns.rules.push({ action: "predefined", rcode });
      if (dns.final === source.tag) delete dns.final;
      matchedRule = true;
    }
    if (!matchedRule) {
      throw new Error(`DNS RCode 服务器 ${source.tag || "(无 tag)"} 未被规则引用，无法确定迁移位置`);
    }
    changes.push(`迁移 DNS RCode ${source.tag || "默认规则"}`);
  }
}

function migrateLegacyDnsServers(config, changes) {
  if (!isObject(config.dns) || !Array.isArray(config.dns.servers)) return;
  const dns = config.dns;
  const originalServers = dns.servers;
  const migratedServers = [];
  const rcodeServers = [];
  let fakeipMigrated = false;

  for (const source of originalServers) {
    if (!isObject(source) || source.type || !("address" in source)) {
      migratedServers.push(source);
      continue;
    }

    const {
      address,
      address_resolver: addressResolver,
      address_strategy: addressStrategy,
      strategy,
      client_subnet: clientSubnet,
      ...rest
    } = source;
    const parsed = parseLegacyDnsAddress(address);
    if (parsed.rcode) {
      rcodeServers.push({ source, rcode: parsed.rcode });
      continue;
    }

    const migrated = { ...rest, ...parsed };
    if (parsed.type === "fakeip" && isObject(dns.fakeip)) {
      const { enabled: _enabled, ...fakeipOptions } = dns.fakeip;
      Object.assign(migrated, fakeipOptions);
      fakeipMigrated = true;
    }
    if (addressResolver || addressStrategy) {
      const resolver = addressResolver || ensureLocalResolver(config, changes);
      migrated.domain_resolver = addressStrategy
        ? resolverWithStrategy(config, resolver, addressStrategy, changes)
        : resolver;
    }
    if (strategy != null) {
      moveLegacyServerOption(dns, originalServers, source, "strategy", strategy);
    }
    if (clientSubnet != null) {
      moveLegacyServerOption(dns, originalServers, source, "client_subnet", clientSubnet);
    }
    migratedServers.push(migrated);
    changes.push(`迁移旧 DNS 服务器 ${source.tag || address}`);
  }

  dns.servers = migratedServers;
  if (fakeipMigrated) delete dns.fakeip;
  migrateRcodeRules(dns, originalServers, rcodeServers, changes);
}

function resolverFromLegacyRule(rule) {
  if (!rule.server) throw new Error("旧 outbound DNS 规则缺少 server，无法自动迁移");
  const resolver = { server: rule.server };
  for (const field of ["strategy", "disable_cache", "rewrite_ttl", "client_subnet"]) {
    if (rule[field] != null) resolver[field] = rule[field];
  }
  return resolver;
}

function assignResolver(target, resolver, label) {
  if (target.domain_resolver && !sameJson(target.domain_resolver, resolver)) {
    throw new Error(`${label} 已有不同的 domain_resolver，无法自动覆盖`);
  }
  target.domain_resolver = resolver;
}

function migrateOutboundDnsRules(config, changes) {
  const dns = config.dns;
  if (!isObject(dns) || !Array.isArray(dns.rules)) return;
  const retainedRules = [];

  for (const rule of dns.rules) {
    if (!isObject(rule) || !("outbound" in rule)) {
      retainedRules.push(rule);
      continue;
    }
    const unsupported = Object.keys(rule).filter(
      (field) => !LEGACY_OUTBOUND_RULE_FIELDS.has(field),
    );
    if (unsupported.length || (rule.action && rule.action !== "route")) {
      throw new Error(
        `旧 outbound DNS 规则包含条件或动作（${unsupported.join("、") || rule.action}），无法等价自动迁移`,
      );
    }

    const resolver = resolverFromLegacyRule(rule);
    const outboundValues = Array.isArray(rule.outbound) ? rule.outbound : [rule.outbound];
    if (outboundValues.includes("any")) {
      if (!isObject(config.route)) config.route = {};
      if (
        config.route.default_domain_resolver &&
        !sameJson(config.route.default_domain_resolver, resolver)
      ) {
        throw new Error("route.default_domain_resolver 已存在不同配置，无法自动覆盖");
      }
      config.route.default_domain_resolver = resolver;
      changes.push("迁移全局 outbound DNS 规则");
      continue;
    }

    let matched = 0;
    for (const collection of [config.outbounds, config.endpoints]) {
      for (const target of Array.isArray(collection) ? collection : []) {
        if (!isObject(target) || !outboundValues.includes(target.tag)) continue;
        assignResolver(target, resolver, `出站 ${target.tag}`);
        matched += 1;
      }
    }
    if (!matched) {
      throw new Error(`旧 outbound DNS 规则引用了不存在的出站：${outboundValues.join("、")}`);
    }
    changes.push(`迁移出站域名解析规则 ${outboundValues.join("、")}`);
  }

  dns.rules = retainedRules;
}

function migrateDialStrategy(config, target, label, changes) {
  if (!isObject(target) || !("domain_strategy" in target)) return;
  target.domain_resolver = resolverWithStrategy(
    config,
    target.domain_resolver,
    target.domain_strategy,
    changes,
  );
  delete target.domain_strategy;
  changes.push(`迁移 ${label} 的 domain_strategy`);
}

function migrateDialStrategies(config, changes) {
  for (const [collectionName, collection] of [
    ["出站", config.outbounds],
    ["端点", config.endpoints],
  ]) {
    for (const [index, target] of (Array.isArray(collection) ? collection : []).entries()) {
      migrateDialStrategy(config, target, `${collectionName} ${target?.tag || index + 1}`, changes);
    }
  }
  migrateDialStrategy(config, config.ntp, "NTP", changes);
  for (const [index, server] of (Array.isArray(config.dns?.servers)
    ? config.dns.servers
    : []).entries()) {
    migrateDialStrategy(config, server, `DNS 服务器 ${server?.tag || index + 1}`, changes);
  }
  for (const [index, inbound] of (Array.isArray(config.inbounds)
    ? config.inbounds
    : []).entries()) {
    migrateDialStrategy(
      config,
      inbound?.tls?.reality?.handshake,
      `入站 ${inbound?.tag || index + 1} Reality 握手`,
      changes,
    );
  }
}

function migrateDeprecatedCacheOptions(config, changes) {
  if (isObject(config.dns) && "independent_cache" in config.dns) {
    delete config.dns.independent_cache;
    changes.push("移除 independent_cache");
  }
  const cacheFile = config.experimental?.cache_file;
  if (isObject(cacheFile) && "store_rdrc" in cacheFile) {
    if (cacheFile.store_rdrc === true) cacheFile.store_dns = true;
    delete cacheFile.store_rdrc;
    changes.push("迁移 store_rdrc 为 store_dns");
  }
}

export function migrateSingBoxConfigFor114(input) {
  if (input == null) return { config: null, changes: [] };
  if (!isObject(input)) throw new Error("节点 sing-box 配置不是 JSON 对象，无法自动迁移");

  const config = cloneJson(input);
  const changes = [];
  migrateLegacyDnsServers(config, changes);
  migrateOutboundDnsRules(config, changes);
  migrateDialStrategies(config, changes);
  migrateDeprecatedCacheOptions(config, changes);
  return { config, changes: [...new Set(changes)] };
}
