import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { generateDiffString } from "@earendil-works/pi-coding-agent";

import { NO_DIFF_MESSAGE } from "../domain/constants.js";
import type { Snapshot, SnapshotFile } from "../domain/types.js";
import {
  decodeBase64Strict,
  hashBuffer,
  materializeSnapshot,
} from "./snapshot.js";

const execFileAsync = promisify(execFile);

export type SnapshotDiffFile =
  | {
      path: string;
      status: "added" | "modified" | "deleted";
      kind: "text";
      diff: string;
    }
  | {
      path: string;
      status: "added" | "modified" | "deleted";
      kind: "binary";
    };

export type SnapshotDiff = {
  remote: {
    target?: string;
    id?: string;
    fileCount: number;
  };
  local: {
    fileCount: number;
  };
  files: SnapshotDiffFile[];
};

/**
 * Create a display-oriented diff between local and remote snapshots.
 *
 * The comparison is remote-to-local so additions and removals have the same
 * meaning as the existing Git diff output.
 */
export function createSnapshotDiff(
  local: Snapshot,
  remote: Snapshot | undefined,
  target?: string,
): SnapshotDiff {
  const localFiles = indexFiles(local);
  const remoteFiles = indexFiles(remote);
  const paths = [
    ...new Set([...localFiles.keys(), ...remoteFiles.keys()]),
  ].sort((left, right) => left.localeCompare(right));
  const files: SnapshotDiffFile[] = [];

  for (const filePath of paths) {
    const localFile = localFiles.get(filePath);
    const remoteFile = remoteFiles.get(filePath);

    if (localFile?.sha256 != null && localFile.sha256 === remoteFile?.sha256) {
      continue;
    }

    const status =
      remoteFile == null ? "added" : localFile == null ? "deleted" : "modified";

    if (isBinary(localFile) || isBinary(remoteFile)) {
      files.push({ path: filePath, status, kind: "binary" });

      continue;
    }

    const oldText = snapshotText(remoteFile);
    const newText = snapshotText(localFile);
    const result = generateDiffString(oldText, newText);

    files.push({ path: filePath, status, kind: "text", diff: result.diff });
  }

  return {
    remote: {
      ...(target == null ? {} : { target }),
      ...(remote == null ? {} : { id: remote.id }),
      fileCount: remote?.files.length ?? 0,
    },
    local: { fileCount: local.files.length },
    files,
  };
}

/**
 * Format a textual Git diff between local and remote snapshots.
 *
 * @param local Local Pi config snapshot.
 * @param remote Remote Git snapshot, or undefined when remote is empty.
 */
export async function formatGitTextDiff(
  local: Snapshot,
  remote: Snapshot | undefined,
): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-diff-"));
  const localRoot = path.join(tempRoot, "local");
  const remoteRoot = path.join(tempRoot, "remote");

  try {
    await materializeSnapshot(local, localRoot);
    await materializeRemoteSnapshot(remote, remoteRoot);

    const diffOutput = await gitNoIndexDiff(tempRoot, remoteRoot, localRoot);

    if (diffOutput.trim().length === 0) {
      return NO_DIFF_MESSAGE;
    }

    return [diffHeader(local, remote), diffOutput.trimEnd()].join("\n");
  } finally {
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
}

function indexFiles(snapshot: Snapshot | undefined): Map<string, SnapshotFile> {
  return new Map(snapshot?.files.map((file) => [file.path, file]) ?? []);
}

function snapshotBuffer(file: SnapshotFile): Buffer {
  const content = decodeBase64Strict(file.contentBase64, file.path);

  if (hashBuffer(content) !== file.sha256) {
    throw new Error(`Checksum mismatch in snapshot file: ${file.path}`);
  }

  return content;
}

function snapshotText(file: SnapshotFile | undefined): string {
  return file == null ? "" : snapshotBuffer(file).toString("utf8");
}

function isBinary(file: SnapshotFile | undefined): boolean {
  return file != null && snapshotBuffer(file).includes(0);
}

async function materializeRemoteSnapshot(
  remote: Snapshot | undefined,
  remoteRoot: string,
): Promise<void> {
  if (remote != null) {
    await materializeSnapshot(remote, remoteRoot);
  } else {
    await fs.mkdir(remoteRoot, { recursive: true });
  }
}

async function gitNoIndexDiff(
  cwd: string,
  remoteRoot: string,
  localRoot: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "diff",
        "--no-index",
        "--src-prefix=remote/",
        "--dst-prefix=local/",
        path.relative(cwd, remoteRoot),
        path.relative(cwd, localRoot),
      ],
      { cwd, maxBuffer: 20 * 1024 * 1024 },
    );

    return stdout;
  } catch (error) {
    const diffError = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };

    if (diffError.code === 1) {
      return diffError.stdout ?? "";
    }

    throw new Error(
      `git diff --no-index failed: ${diffError.stderr ?? diffError.message}`,
    );
  }
}

function diffHeader(local: Snapshot, remote: Snapshot | undefined): string {
  return [
    `remote: ${remote != null ? `${remote.id} (${remote.files.length} files)` : "empty"}`,
    `local: ${local.files.length} files`,
    "",
  ].join("\n");
}
