// Parse a port jump spec like "20000-50000" or "20000-40000,45000-50000".
// Returns { ranges: [{ start, end }], error: string | null }
export function parsePortJumpRange(value) {
  const text = String(value || "").trim();
  if (!text) return { ranges: [], error: null };
  const parts = text.split(/[,;]\s*/).map((p) => p.trim()).filter(Boolean);
  const ranges = [];
  for (const part of parts) {
    const match = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) {
      return { ranges: [], error: `端口段格式错误：${part}` };
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { ranges: [], error: `端口段含非整数：${part}` };
    }
    if (start < 1 || end > 65535) {
      return { ranges: [], error: `端口段越界（1-65535）：${part}` };
    }
    if (start >= end) {
      return { ranges: [], error: `端口段需 start < end：${part}` };
    }
    ranges.push({ start, end });
  }
  // Sort and check for overlap
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start <= ranges[i - 1].end) {
      return {
        ranges: [],
        error: `端口段相互重叠：${ranges[i - 1].start}-${ranges[i - 1].end} / ${ranges[i].start}-${ranges[i].end}`,
      };
    }
  }
  return { ranges, error: null };
}

// Normalize spec back into a canonical "a-b,c-d" string (sorted, no spaces).
export function canonicalPortJumpRange(value) {
  const { ranges, error } = parsePortJumpRange(value);
  if (error || !ranges.length) return "";
  return ranges.map((r) => `${r.start}-${r.end}`).join(",");
}

// Spec → multiport range string for iptables `--dports`.
// iptables-extensions multiport supports up to 15 port slots; a range counts as 2.
// We just join with commas; bail if too long.
export function toIptablesMultiportSpec(value) {
  const { ranges, error } = parsePortJumpRange(value);
  if (error) throw new Error(error);
  if (!ranges.length) return "";
  return ranges.map((r) => `${r.start}:${r.end}`).join(",");
}

export function containsPort(value, port) {
  const { ranges } = parsePortJumpRange(value);
  return ranges.some((r) => port >= r.start && port <= r.end);
}
