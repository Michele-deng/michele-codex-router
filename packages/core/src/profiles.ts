import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ProfileValidationError } from "./errors.js";
import type { CapabilityProfile, ModelTier, RuntimeCapability } from "./types.js";

const tiers = new Set<ModelTier>(["low", "medium", "high", "frontier"]);

export function validateProfile(value: unknown): CapabilityProfile {
  if (!value || typeof value !== "object") {
    throw new ProfileValidationError("Profile must be an object");
  }

  const profile = value as Partial<CapabilityProfile>;
  const staticCapability = profile.static;
  if (typeof profile.modelId !== "string" || profile.modelId.length === 0) {
    throw new ProfileValidationError("Profile modelId must be a non-empty string");
  }
  if (
    profile.providerId !== undefined &&
    (typeof profile.providerId !== "string" || profile.providerId.length === 0)
  ) {
    throw new ProfileValidationError("Profile providerId must be a non-empty string when present");
  }
  if (typeof profile.profileVersion !== "string" || profile.profileVersion.length === 0) {
    throw new ProfileValidationError("Profile profileVersion must be a non-empty string");
  }
  if (typeof profile.updatedAt !== "string" || Number.isNaN(Date.parse(profile.updatedAt))) {
    throw new ProfileValidationError("Profile updatedAt must be an ISO date string");
  }
  if (!staticCapability || typeof staticCapability !== "object") {
    throw new ProfileValidationError("Profile static capability is required");
  }
  if (!tiers.has(staticCapability.tier)) {
    throw new ProfileValidationError(`Unsupported model tier: ${String(staticCapability.tier)}`);
  }
  if (!Number.isInteger(staticCapability.contextLimit) || staticCapability.contextLimit <= 0) {
    throw new ProfileValidationError("contextLimit must be a positive integer");
  }
  if (typeof staticCapability.supportsTools !== "boolean") {
    throw new ProfileValidationError("supportsTools must be boolean");
  }
  if (!Array.isArray(staticCapability.strengths) || !Array.isArray(staticCapability.constraints)) {
    throw new ProfileValidationError("strengths and constraints must be arrays");
  }

  return {
    ...(profile.providerId ? { providerId: profile.providerId } : {}),
    modelId: profile.modelId,
    profileVersion: profile.profileVersion,
    updatedAt: profile.updatedAt,
    static: {
      tier: staticCapability.tier,
      contextLimit: staticCapability.contextLimit,
      ...(typeof staticCapability.inputPrice === "number" ? { inputPrice: staticCapability.inputPrice } : {}),
      ...(typeof staticCapability.outputPrice === "number" ? { outputPrice: staticCapability.outputPrice } : {}),
      supportsTools: staticCapability.supportsTools,
      strengths: [...staticCapability.strengths],
      constraints: [...staticCapability.constraints]
    },
    ...(profile.runtime ? { runtime: validateRuntime(profile.runtime) } : {}),
    ...(profile.calibration ? { calibration: profile.calibration } : {})
  };
}

function validateRuntime(runtime: RuntimeCapability): RuntimeCapability {
  if (typeof runtime.available !== "boolean") {
    throw new ProfileValidationError("runtime.available must be boolean");
  }
  return { ...runtime };
}

export async function loadProfileDirectory(directory: string): Promise<CapabilityProfile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const profiles: CapabilityProfile[] = [];
  for (const file of files) {
    const contents = await readFile(path.join(directory, file), "utf8");
    try {
      profiles.push(validateProfile(JSON.parse(contents)));
    } catch (error) {
      if (error instanceof ProfileValidationError) {
        throw new ProfileValidationError(`${file}: ${error.message}`);
      }
      throw error;
    }
  }
  return profiles;
}

export function applyRuntimeSnapshot(
  profile: CapabilityProfile,
  runtime: RuntimeCapability
): CapabilityProfile {
  return { ...profile, runtime: { ...runtime } };
}

export function rankProfiles(profiles: CapabilityProfile[]): CapabilityProfile[] {
  const tierRank: Record<ModelTier, number> = { low: 0, medium: 1, high: 2, frontier: 3 };
  return [...profiles].sort((left, right) => {
    const calibratedLeft = left.calibration?.taskSuccessRate ?? 0.5;
    const calibratedRight = right.calibration?.taskSuccessRate ?? 0.5;
    return (
      tierRank[right.static.tier] - tierRank[left.static.tier] ||
      calibratedRight - calibratedLeft ||
      (right.calibration?.sampleCount ?? 0) - (left.calibration?.sampleCount ?? 0)
    );
  });
}
