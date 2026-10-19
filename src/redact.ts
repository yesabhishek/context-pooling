// Secret redaction shared by the CLI, MCP server, and web UI. Keep this module free of Node imports.

const TOKEN_RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[redacted-private-key]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-aws-key]"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/g, "[redacted-token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[redacted-token]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[redacted-token]"],
  [/\bsk-(?:proj-|ant-[a-z]+\d*-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, "[redacted-token]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[redacted-token]"],
  [/\bwhsec_[A-Za-z0-9+/=]{20,}/g, "[redacted-token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted-token]"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "[redacted-token]"],
  [/\bnpm_[A-Za-z0-9]{36}/g, "[redacted-token]"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "[redacted-token]"],
  [/\bpypi-[A-Za-z0-9_-]{50,}/g, "[redacted-token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{20,}=*/g, "$1 [redacted]"]
];

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s/@]+)@/gi;

const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*?(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|client[_-]?secret|database[_-]?url|dsn)(?:[_.-][A-Za-z0-9]+)*)\b(["']?\s*[:=]\s*["'`]?)([^\s"'`,;)}\]]+)/gi;

const NOT_A_LITERAL =
  /^(?:\$|process\.env|import\.meta|os\.environ|env\b|<|\{|\[redacted|null$|undefined$|true$|false$|none$|string$|number$|boolean$|any$|unknown$|await$|new$|this\b|typeof$|x{3,}|\*{3,}|\.{3})/i;

const HIGH_ENTROPY = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

export function redactSecrets(text: string): string {
  if (!text) return text;
  let next = text;
  for (const [pattern, replacement] of TOKEN_RULES) next = next.replace(pattern, replacement);
  next = next.replace(URL_CREDENTIALS, "$1$2:[redacted]@");
  next = next.replace(ASSIGNMENT, (match, key: string, separator: string, value: string) => {
    if (value.length < 4 || value.includes("(") || NOT_A_LITERAL.test(value)) return match;
    return `${key}${separator}[redacted]`;
  });
  return next.replace(HIGH_ENTROPY, (token) => (looksLikeSecret(token) ? "[redacted-secret]" : token));
}

export function hasRedactions(text: string): boolean {
  return /\[redacted(?:-[a-z-]+)?\]/.test(text);
}

/** Recursively redact every string in a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = redactDeep(item);
    return result as T;
  }
  return value;
}

/** Files whose contents should never be copied into a handoff, even redacted. */
export function isSensitivePath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() || path;
  if (/^\.env\.(?:example|sample|template|defaults)$/i.test(name)) return false;
  return (
    /^\.env(?:\..+)?$/i.test(name) ||
    /^(?:\.npmrc|\.pypirc|\.netrc|\.pgpass|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(name) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name)
  );
}

function looksLikeSecret(token: string): boolean {
  const bare = token.replace(/[-_=]/g, "");
  if (/^[0-9a-f]+$/i.test(bare)) return false;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return false;
  if (token.split("/").length > 3) return false;
  return shannonEntropy(token) >= 4.5;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
