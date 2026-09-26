const SECRET_NAME_PATTERN = /(API_?KEY|_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i;
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/g;

export const REDACTED = "***";

export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim().length >= 8 && isSecretName(name)) {
      values.add(value.trim());
    }
  }
  return [...values];
}

export function redactText(text: string, secretValues: readonly string[] = collectSecretValues()): string {
  let result = text;
  for (const value of secretValues) {
    if (value.length < 8) continue;
    result = result.split(value).join(REDACTED);
  }
  return result.replace(SECRET_VALUE_PATTERN, REDACTED);
}

export function redactDeep(value: unknown, secretValues: readonly string[] = collectSecretValues()): unknown {
  if (typeof value === "string") return redactText(value, secretValues);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, secretValues));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSecretName(key) && typeof entry === "string" ? REDACTED : redactDeep(entry, secretValues);
    }
    return result;
  }
  return value;
}
