import path from "node:path";

import { TOP_LEVEL_DIRS, TOP_LEVEL_FILES } from "../domain/constants.js";
import type { NormalizedSyncPolicy, SyncPolicy } from "../domain/types.js";
import { agentDir, toPosix, trimSlashes } from "../utils/path-utils.js";

export type PolicyPathKind = "file" | "directory" | "unknown";

export type ManagedPath = {
  path: string;
  kind: PolicyPathKind;
};

export type EffectivePolicy = {
  policy: NormalizedSyncPolicy;
  included: ManagedPath[];
  excluded: string[];
};

/**
 * Normalize user policy config and validate all policy paths.
 */
export function normalizePolicy(policy: unknown): NormalizedSyncPolicy {
  if (policy == null) {
    return {
      includeDefaults: true,
      includePaths: [],
      excludePaths: [],
      stripSettingsKeys: [],
    };
  }

  if (!isPlainObject(policy)) {
    throw new Error("Invalid policy: expected an object");
  }

  const includeDefaults = policy.includeDefaults;

  if (includeDefaults != null && typeof includeDefaults !== "boolean") {
    throw new Error("Invalid policy includeDefaults: expected a boolean");
  }

  return {
    includeDefaults: includeDefaults ?? true,
    includePaths: normalizePolicyPathList(policy.includePaths ?? [], "includePaths"),
    excludePaths: normalizePolicyPathList(policy.excludePaths ?? [], "excludePaths"),
    stripSettingsKeys: normalizeSettingsKeyList(
      policy.stripSettingsKeys ?? [],
      "stripSettingsKeys",
    ),
  };
}

/**
 * Compute the concrete managed paths after applying defaults, includes, and excludes.
 */
export function effectivePolicy(policy: SyncPolicy | undefined): EffectivePolicy {
  const normalized = normalizePolicy(policy);
  const included = new Map<string, ManagedPath>();

  if (normalized.includeDefaults) {
    for (const file of TOP_LEVEL_FILES) {
      included.set(file, { path: file, kind: "file" });
    }

    for (const directory of TOP_LEVEL_DIRS) {
      included.set(directory, { path: directory, kind: "directory" });
    }
  }

  for (const includePath of normalized.includePaths) {
    included.set(includePath, { path: includePath, kind: "unknown" });
  }

  for (const includePath of [...included.keys()]) {
    if (isExcluded(includePath, normalized.excludePaths)) {
      included.delete(includePath);
    }
  }

  return {
    policy: normalized,
    included: [...included.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    excluded: normalized.excludePaths,
  };
}

/**
 * Check whether a relative path is included by the effective policy.
 */
export function isIncludedByPolicy(relativePath: string, policy: EffectivePolicy): boolean {
  const normalized = normalizeRelativePath(relativePath, "path");

  if (isExcluded(normalized, policy.excluded)) {
    return false;
  }

  return policy.included.some((entry) => pathMatches(entry.path, normalized));
}

/**
 * Check whether a relative path is excluded by policy.
 */
export function isExcluded(relativePath: string, excludePaths: string[]): boolean {
  const normalized = normalizeRelativePath(relativePath, "path");

  return excludePaths.some((excludePath) => pathMatches(excludePath, normalized));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePolicyPathList(paths: unknown, field: string): string[] {
  if (!Array.isArray(paths)) {
    throw new Error(`Invalid policy ${field}: expected an array of paths`);
  }

  const normalized = new Set<string>();

  for (const value of paths) {
    if (typeof value !== "string") {
      throw new Error(`Invalid policy ${field}: expected string paths`);
    }

    normalized.add(normalizeRelativePath(value, field));
  }

  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeSettingsKeyList(keys: unknown, field: string): string[] {
  if (!Array.isArray(keys)) {
    throw new Error(`Invalid policy ${field}: expected an array of setting keys`);
  }

  const normalized = new Set<string>();

  for (const value of keys) {
    if (typeof value !== "string") {
      throw new Error(`Invalid policy ${field}: expected string setting keys`);
    }

    const trimmed = value.trim();

    if (trimmed === "") {
      throw new Error(`Invalid policy ${field}: empty setting key`);
    }

    normalized.add(trimmed);
  }

  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(value: string, field: string): string {
  const raw = value.trim();
  const posixRaw = toPosix(raw);

  if (raw === "") {
    throw new Error(`Invalid policy ${field}: empty path`);
  }

  if (path.posix.isAbsolute(posixRaw)) {
    throw new Error(`Invalid policy ${field}: absolute path ${value}`);
  }

  const rawParts = trimSlashes(posixRaw).split("/");

  if (rawParts.includes("..")) {
    throw new Error(`Invalid policy ${field}: unsafe path ${value}`);
  }

  const normalized = trimSlashes(path.posix.normalize(posixRaw));

  if (normalized === "" || normalized === ".") {
    throw new Error(`Invalid policy ${field}: unsafe path ${value}`);
  }

  const resolvedRoot = path.resolve(agentDir());
  const resolvedTarget = path.resolve(resolvedRoot, normalized);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Invalid policy ${field}: path escapes Pi dir ${value}`);
  }

  return normalized;
}

function pathMatches(policyPath: string, candidatePath: string): boolean {
  return candidatePath === policyPath || candidatePath.startsWith(`${policyPath}/`);
}
