import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SECRET_PATTERNS, VERSION } from "../domain/constants.js";
import type { Snapshot, SnapshotFile, SyncPolicy } from "../domain/types.js";
import { effectivePolicy, isIncludedByPolicy } from "../policy/policy.js";
import { sanitizeSettings } from "../settings/settings.js";
import { agentDir, posixJoin, safeJoin, toPosix } from "../utils/path-utils.js";

/**
 * Create a snapshot from the local Pi agent configuration.
 */
export async function createSnapshot(policy?: SyncPolicy): Promise<Snapshot> {
  const warnings: string[] = [];
  const files = await collectFiles(agentDir(), policy, warnings);

  return {
    version: VERSION,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
    files,
    warnings,
  };
}

/**
 * Check whether a relative Pi config path should be excluded from sync.
 *
 * @param relativePath Relative path under the Pi agent config directory.
 */
export function isDeniedPath(relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  const base = path.posix.basename(normalized).toLowerCase();

  return (
    normalized.includes("/node_modules/") ||
    normalized.includes("/.git/") ||
    normalized.includes("/.pisync/") ||
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".env") ||
    base.includes("secret") ||
    base.includes("token") ||
    base === "pi-sync.json"
  );
}

/**
 * Scan a snapshot for common secret patterns before allowing upload.
 *
 * @param snapshot Snapshot to inspect.
 */
export function scanSnapshot(snapshot: Snapshot): string[] {
  const findings: string[] = [];

  for (const file of snapshot.files) {
    const content = Buffer.from(file.contentBase64, "base64");

    if (content.includes(0)) {
      continue;
    }

    if (
      SECRET_PATTERNS.some((pattern) => pattern.test(content.toString("utf8")))
    ) {
      findings.push(file.path);
    }
  }

  return findings;
}

/**
 * Write snapshot files into a target directory.
 *
 * @param snapshot Snapshot to write.
 * @param root Target root directory.
 */
export async function materializeSnapshot(
  snapshot: Snapshot,
  root: string,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });

  for (const file of snapshot.files) {
    await materializeFile(root, file);
  }
}

/**
 * Decode base64 snapshot content after validating its shape.
 *
 * @param value Base64 content string.
 * @param filePath File path used in error messages.
 */
export function decodeBase64Strict(value: string, filePath: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid base64 content in snapshot file: ${filePath}`);
  }

  return Buffer.from(value, "base64");
}

/**
 * Hash a buffer with SHA-256.
 *
 * @param value Buffer to hash.
 */
export function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Hash a snapshot file list by path and hash.
 *
 * @param files Snapshot files to summarize.
 */
export function hashFiles(files: SnapshotFile[]): string {
  return hashBuffer(
    Buffer.from(JSON.stringify(files.map((file) => [file.path, file.sha256]))),
  );
}

/**
 * Convert a snapshot to a path-to-hash map.
 *
 * @param snapshot Snapshot to convert.
 */
export function fileHashMap(snapshot: Snapshot): Record<string, string> {
  return Object.fromEntries(
    snapshot.files.map((file) => [file.path, file.sha256]),
  );
}

async function collectFiles(
  root: string,
  policy: SyncPolicy | undefined,
  warnings: string[],
): Promise<SnapshotFile[]> {
  const results: SnapshotFile[] = [];
  const effective = effectivePolicy(policy);

  for (const managedPath of effective.included) {
    if (isDeniedPath(managedPath.path)) {
      continue;
    }

    const absolutePath = safeJoin(root, managedPath.path);

    try {
      const stat = await fs.lstat(absolutePath);

      if (stat.isSymbolicLink()) {
        warnings.push(`snapshot: skipped symlink ${managedPath.path}`);
      } else if (stat.isDirectory()) {
        await collectDirectory(results, root, managedPath.path, effective, warnings);
      } else if (stat.isFile()) {
        await addFile(results, root, managedPath.path, policy);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return [...new Map(results.map((file) => [file.path, file])).values()].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
}

async function collectDirectory(
  results: SnapshotFile[],
  root: string,
  relativeDirectory: string,
  policy: ReturnType<typeof effectivePolicy>,
  warnings: string[],
): Promise<void> {
  const absoluteDirectory = path.join(root, relativeDirectory);

  for (const entry of await fs.readdir(absoluteDirectory, {
    withFileTypes: true,
  })) {
    const relativePath = posixJoin(relativeDirectory, entry.name);

    if (isDeniedPath(relativePath) || !isIncludedByPolicy(relativePath, policy)) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      warnings.push(`snapshot: skipped symlink ${relativePath}`);
    } else if (entry.isDirectory()) {
      await collectDirectory(results, root, relativePath, policy, warnings);
    } else if (entry.isFile()) {
      await addFile(results, root, relativePath, policy.policy);
    }
  }
}

async function addFile(
  results: SnapshotFile[],
  root: string,
  relativePath: string,
  policy?: SyncPolicy,
): Promise<void> {
  if (isDeniedPath(relativePath)) {
    return;
  }

  const content = await readSnapshotContent(root, relativePath, policy);

  results.push({
    path: relativePath,
    contentBase64: content.toString("base64"),
    sha256: hashBuffer(content),
  });
}

async function readSnapshotContent(
  root: string,
  relativePath: string,
  policy?: SyncPolicy,
): Promise<Buffer> {
  const raw = await fs.readFile(safeJoin(root, relativePath));

  if (relativePath !== "settings.json") {
    return raw;
  }

  return Buffer.from(
    `${JSON.stringify(sanitizeSettings(JSON.parse(raw.toString("utf8")), policy), null, "\t")}\n`,
  );
}

async function materializeFile(
  root: string,
  file: SnapshotFile,
): Promise<void> {
  const target = safeJoin(root, file.path);
  const content = decodeBase64Strict(file.contentBase64, file.path);

  if (hashBuffer(content) !== file.sha256) {
    throw new Error(`Checksum mismatch in snapshot file: ${file.path}`);
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

function snapshotId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
