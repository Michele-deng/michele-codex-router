const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", ""]);

export function optionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

export function parseInteger(
  value: string | undefined,
  fallback: number,
  bounds: { min?: number; max?: number } = {}
): number {
  const candidate = optionalString(value);
  if (candidate === undefined) return fallback;
  if (!/^-?\d+$/.test(candidate)) return fallback;
  const parsed = Number.parseInt(candidate, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (bounds.min !== undefined && parsed < bounds.min) return fallback;
  if (bounds.max !== undefined && parsed > bounds.max) return fallback;
  return parsed;
}

export function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  const candidate = optionalString(value)?.toLowerCase();
  if (candidate === undefined) return fallback;
  const match = allowed.find((entry) => entry.toLowerCase() === candidate);
  return match ?? fallback;
}

export function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  const candidate = optionalString(value);
  if (candidate === undefined) return [...fallback];
  const entries = candidate
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : [...fallback];
}
