import { existsSync, readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";

export interface LoadedEnvFile {
  envFile: string;
  found: boolean;
  keysApplied: string[];
  keysAlreadySet: string[];
}

export interface LoadEnvFileResult extends LoadedEnvFile {
  error?: string;
}

/**
 * Loads a dotenv file into process.env without touching variables that are
 * already set. Real process environment variables therefore always win over
 * values in the file. Variable names are reported, never values.
 */
export function loadEnvFile(envFile: string): LoadEnvFileResult {
  if (!existsSync(envFile)) {
    return { envFile, found: false, keysApplied: [], keysAlreadySet: [] };
  }

  let parsed: Record<string, string>;
  try {
    parsed = parseDotenv(readFileSync(envFile, "utf8"));
  } catch (error) {
    return {
      envFile,
      found: true,
      keysApplied: [],
      keysAlreadySet: [],
      error: error instanceof Error ? error.message : "Unable to parse the environment file"
    };
  }

  const keysApplied: string[] = [];
  const keysAlreadySet: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!name) continue;
    if (process.env[name] === undefined) {
      process.env[name] = value;
      keysApplied.push(name);
    } else {
      keysAlreadySet.push(name);
    }
  }

  return { envFile, found: true, keysApplied, keysAlreadySet };
}
