const patterns: readonly [RegExp, string][] = [
  [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    "[REDACTED:private_key]",
  ],
  [/\b(?:sk|rk|pk)-(?:live|test)?[-_A-Za-z0-9]{16,}\b/g, "[REDACTED:api_key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:credential]"],
  [
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    "[REDACTED:jwt]",
  ],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED:pii:ssn]"],
  [
    /(?:password|passwd|pwd|api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
    "[REDACTED:credential]",
  ],
];
export function scrubSecrets(value: string): string {
  let output = value;
  for (const [pattern, replacement] of patterns)
    output = output.replace(pattern, replacement);
  return output;
}
export function scrubMetadata(
  value: import("./audit-types.js").JsonValue,
): import("./audit-types.js").JsonValue {
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubMetadata);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubMetadata(entry)]),
    );
  return value;
}
