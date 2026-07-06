import path from "node:path";

import type { SyncPolicy } from "../domain/types.js";
import { effectivePolicy, isIncludedByPolicy } from "../policy/policy.js";
import { agentDir, toPosix } from "../utils/path-utils.js";

const RESOURCE_ARRAY_KEYS = ["packages", "extensions", "skills", "prompts", "themes"];

type JsonObject = Record<string, unknown>;

/**
 * Sanitize settings before storing them in the shared snapshot.
 */
export function sanitizeSettings(settings: unknown, policy?: SyncPolicy): JsonObject {
  if (!isObject(settings)) {
    throw new Error("settings.json must contain a JSON object");
  }

  const sanitized = Object.fromEntries(
    Object.entries(settings).filter(([key]) => key !== "lastChangelogVersion"),
  );

  for (const key of RESOURCE_ARRAY_KEYS) {
    const value = sanitized[key];

    if (Array.isArray(value)) {
      sanitized[key] = value.filter((entry) => isPortableSettingsEntry(entry, policy));
    }
  }

  return sanitized;
}

/**
 * Merge incoming sanitized settings over local settings while preserving local-only entries.
 */
export function mergeSettings(
  localSettings: unknown,
  incomingSettings: unknown,
  policy?: SyncPolicy,
): JsonObject {
  const local = isObject(localSettings) ? localSettings : {};
  const incoming = sanitizeSettings(incomingSettings, policy);
  const merged: JsonObject = { ...local, ...incoming };

  for (const key of RESOURCE_ARRAY_KEYS) {
    const incomingValue = incoming[key];

    if (!Array.isArray(incomingValue)) {
      continue;
    }

    const localValue = local[key];
    const localOnly = Array.isArray(localValue)
      ? localValue.filter((entry) => !isPortableSettingsEntry(entry, policy))
      : [];

    merged[key] = mergeUniqueEntries(incomingValue, localOnly);
  }

  if ("lastChangelogVersion" in local) {
    merged.lastChangelogVersion = local.lastChangelogVersion;
  }

  return merged;
}

/**
 * Return whether a settings entry can be shared across machines.
 */
export function isPortableSettingsEntry(entry: unknown, policy?: SyncPolicy): boolean {
  const source = settingsEntrySource(entry);

  if (source == null || source.trim() === "") {
    return true;
  }

  return isPortableSource(source, policy);
}

/**
 * Extract the source string from a string or object-shaped settings entry.
 */
export function settingsEntrySource(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }

  if (isObject(entry) && typeof entry.source === "string") {
    return entry.source;
  }

  return undefined;
}

function isPortableSource(source: string, policy?: SyncPolicy): boolean {
  const trimmed = source.trim();

  if (isRemotePackageSource(trimmed)) {
    return true;
  }

  if (isLocalOnlySource(trimmed)) {
    return false;
  }

  return isPortableRelativePath(trimmed, policy);
}

function isRemotePackageSource(source: string): boolean {
  return (
    source.startsWith("npm:") ||
    source.startsWith("git:") ||
    source.startsWith("https://") ||
    source.startsWith("http://") ||
    /^git@[^:]+:.+/.test(source) ||
    isBareNpmPackageName(source)
  );
}

function isBareNpmPackageName(source: string): boolean {
  return /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(source);
}

function isLocalOnlySource(source: string): boolean {
  return (
    source.startsWith("~") ||
    source.startsWith("file:") ||
    path.isAbsolute(source) ||
    toPosix(source).startsWith("../") ||
    toPosix(source).includes("/../")
  );
}

function isPortableRelativePath(source: string, policy?: SyncPolicy): boolean {
  const normalized = toPosix(source).replace(/^\.\//, "");

  if (normalized === "" || normalized === ".") {
    return false;
  }

  const root = path.resolve(agentDir());
  const resolved = path.resolve(root, normalized);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return false;
  }

  return isIncludedByPolicy(normalized, effectivePolicy(policy));
}

function mergeUniqueEntries(primary: unknown[], extras: unknown[]): unknown[] {
  const merged = [...primary];
  const seen = new Set(primary.map((entry) => JSON.stringify(entry)));

  for (const entry of extras) {
    const key = JSON.stringify(entry);

    if (!seen.has(key)) {
      merged.push(entry);
      seen.add(key);
    }
  }

  return merged;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
