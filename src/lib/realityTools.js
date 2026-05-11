function extractBlock(output, begin, end) {
  const text = String(output || "");
  const start = text.indexOf(begin);
  if (start < 0) return "";
  const contentStart = start + begin.length;
  const stop = text.indexOf(end, contentStart);
  if (stop < 0) return "";
  return text.slice(contentStart, stop).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function stripAnsi(value) {
  return String(value || "").replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function parseScalars(output) {
  const data = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^NGP_REALITY_([A-Z0-9_]+)=(.*)$/);
    if (match) {
      data[match[1].toLowerCase()] = match[2];
    }
  }
  return data;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function parseCandidateCsv(csv) {
  const lines = String(csv || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return [];
  return lines
    .slice(1)
    .map((line) => {
      const [ip, origin, certDomain, certIssuer, geoCode] = parseCsvLine(line);
      return {
        ip: ip || "",
        origin: origin || "",
        certDomain: certDomain || "",
        certIssuer: certIssuer || "",
        geoCode: geoCode || "",
      };
    })
    .filter((item) => item.ip || item.certDomain);
}

export function parseRealityTargetOutput(output) {
  const cleaned = stripAnsi(output);
  const csv = extractBlock(cleaned, "NGP_REALITY_CSV_BEGIN", "NGP_REALITY_CSV_END");
  const checkerOutput = extractBlock(
    cleaned,
    "NGP_REALITY_CHECK_BEGIN",
    "NGP_REALITY_CHECK_END",
  );
  return {
    ...parseScalars(cleaned),
    candidates: parseCandidateCsv(csv),
    csv,
    checkerOutput: checkerOutput.trim(),
  };
}

export function normalizeRealityDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^\*\./, "");
}
