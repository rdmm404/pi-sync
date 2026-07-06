import fs from "node:fs/promises";
import path from "node:path";

import type { Snapshot, SyncPolicy } from "../domain/types.js";
import { effectivePolicy, isIncludedByPolicy } from "../policy/policy.js";
import { mergeSettings } from "../settings/settings.js";
import { agentDir, safeJoin, toPosix } from "../utils/path-utils.js";
import { createSnapshot, decodeBase64Strict, hashBuffer, isDeniedPath } from "./snapshot.js";

/**
 *
 * @param snapshot
 */
export async function applySnapshot(snapshot: Snapshot, policy?: SyncPolicy): Promise<string[]> {
  const root = agentDir();
  const current = await createSnapshot(policy);
  const plan = preflightSnapshotApply(root, snapshot, current, policy);

  const warnings = await preflightSnapshotMutations(root, plan);

  for (const target of plan.deletes) {
    await fs.rm(target, { force: true, recursive: true });
  }

  for (const item of plan.writes) {
    await fs.mkdir(path.dirname(item.target), { recursive: true });

    if (item.relativePath === "settings.json") {
      await writeMergedSettings(item.target, item.content, policy);
    } else {
      await fs.writeFile(item.target, item.content);
    }
  }

  return warnings;
}

/**
 * Build and validate the mutation plan required to apply a snapshot.
 *
 * @param root Local Pi agent config directory.
 * @param snapshot Remote snapshot that should be applied.
 * @param current Current local snapshot used to compute stale deletes.
 */
export function preflightSnapshotApply(
  root: string,
  snapshot: Snapshot,
  current: Snapshot,
  policy?: SyncPolicy,
): { writes: { relativePath: string; target: string; content: Buffer }[]; deletes: string[] } {
  const remotePaths = new Set<string>();
  const effective = effectivePolicy(policy);
  const writes: { relativePath: string; target: string; content: Buffer }[] = [];

  for (const file of snapshot.files) {
    const normalized = validateSnapshotPath(file.path, remotePaths);

    if (isDeniedPath(normalized) || !isIncludedByPolicy(normalized, effective)) {
      continue;
    }

    const content = decodeBase64Strict(file.contentBase64, normalized);

    if (hashBuffer(content) !== file.sha256) {
      throw new Error(`Checksum mismatch in snapshot file: ${normalized}`);
    }

    writes.push({ relativePath: normalized, target: safeJoin(root, normalized), content });
  }

  return { writes, deletes: staleLocalPaths(root, current, remotePaths, policy) };
}

async function preflightSnapshotMutations(
  root: string,
  plan: { deletes: string[]; writes: { target: string; content: Buffer }[] },
): Promise<string[]> {
  const warnings: string[] = [];
  const deletePaths = new Set(plan.deletes);
  const safeDeletes: string[] = [];
  const skippedDeletes = new Set<string>();
  const safeWrites: typeof plan.writes = [];

  for (const target of plan.deletes) {
    const warning = await symlinkMutationWarning(root, target, "delete");

    if (warning == null) {
      safeDeletes.push(target);
    } else {
      warnings.push(warning);
      skippedDeletes.add(target);
      deletePaths.delete(target);
    }
  }

  for (const item of plan.writes) {
    const warning = await symlinkMutationWarning(root, item.target, "write");

    if (warning != null) {
      warnings.push(warning);
      continue;
    }

    if (skippedDeletes.has(item.target)) {
      warnings.push(
        `apply: skipped write requiring unsafe delete ${item.target}`,
      );
      continue;
    }

    await prepareSnapshotWrite(root, item.target, deletePaths);
    safeWrites.push(item);
  }

  plan.deletes.splice(0, plan.deletes.length, ...safeDeletes);
  plan.writes.splice(0, plan.writes.length, ...safeWrites);

  return warnings;
}

function validateSnapshotPath(
  pathValue: string,
  seenPaths: Set<string>,
): string {
  const raw = toPosix(pathValue);
  const rawParts = raw.split("/");
  const normalized = toPosix(path.posix.normalize(raw));

  if (
    normalized === "" ||
    normalized === "." ||
    rawParts.includes("..") ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe path in snapshot: ${pathValue}`);
  }

  if (seenPaths.has(normalized)) {
    throw new Error(`Duplicate path in snapshot: ${normalized}`);
  }

  seenPaths.add(normalized);

  return normalized;
}

function staleLocalPaths(
  root: string,
  current: Snapshot,
  remotePaths: Set<string>,
  policy?: SyncPolicy,
): string[] {
  const effective = effectivePolicy(policy);
  const deletePaths = new Set<string>();

  for (const file of current.files) {
    const normalized = toPosix(file.path);

    if (!isIncludedByPolicy(normalized, effective)) {
      continue;
    }

    if (!remotePaths.has(normalized)) {
      deletePaths.add(safeJoin(root, normalized));
    }

    for (const remotePath of remotePaths) {
      if (isIncludedByPolicy(remotePath, effective) && normalized.startsWith(`${remotePath}/`)) {
        deletePaths.add(safeJoin(root, remotePath));
      }
    }
  }

  return [...deletePaths];
}

async function writeMergedSettings(
  target: string,
  incomingContent: Buffer,
  policy?: SyncPolicy,
): Promise<void> {
  let localSettings: unknown = {};

  try {
    localSettings = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const incomingSettings: unknown = JSON.parse(incomingContent.toString("utf8"));
  const merged = mergeSettings(localSettings, incomingSettings, policy);

  await fs.writeFile(target, `${JSON.stringify(merged, null, "\t")}\n`);
}

async function symlinkMutationWarning(
  root: string,
  target: string,
  action: "delete" | "write",
): Promise<string | undefined> {
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, path.resolve(target));
  let current = rootPath;

  safeJoin(root, relative);

  const parts = relative.split(path.sep).filter((item) => item !== "");

  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);

    try {
      const stat = await fs.lstat(current);

      if (stat.isSymbolicLink()) {
        const symlinkType = index === parts.length - 1 ? "target" : "parent";

        return `apply: skipped ${action} through symlink ${symlinkType} ${current}`;
      }

      if (action === "delete" && index === parts.length - 1 && stat.isDirectory()) {
        const nestedSymlink = await findNestedSymlink(current);

        if (nestedSymlink != null) {
          return `apply: skipped delete containing symlink ${nestedSymlink}`;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  return undefined;
}

async function findNestedSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      return child;
    }

    if (entry.isDirectory()) {
      const nested = await findNestedSymlink(child);

      if (nested != null) {
        return nested;
      }
    }
  }

  return undefined;
}

async function prepareSnapshotWrite(
  root: string,
  target: string,
  deletePaths: Set<string>,
): Promise<void> {
  await ensureSafeDirectory(root, path.dirname(target));

  try {
    const stat = await fs.lstat(target);

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to overwrite symlink during snapshot apply: ${target}`,
      );
    }

    if (stat.isDirectory() && !deletePaths.has(target)) {
      throw new Error(
        `Refusing to overwrite directory during snapshot apply: ${target}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function ensureSafeDirectory(
  root: string,
  directory: string,
): Promise<void> {
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, path.resolve(directory));
  let current = rootPath;

  safeJoin(root, relative);

  for (const part of relative.split(path.sep).filter((item) => item !== "")) {
    current = path.join(current, part);
    await ensureDirectorySegment(current);
  }
}

async function ensureDirectorySegment(current: string): Promise<void> {
  try {
    const stat = await fs.lstat(current);

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to follow symlink during snapshot apply: ${current}`,
      );
    }

    if (!stat.isDirectory()) {
      throw new Error(`Snapshot path parent is not a directory: ${current}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await fs.mkdir(current);
  }
}

