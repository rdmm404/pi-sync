import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Snapshot, SnapshotFile } from "../../src/domain/types.js";
import { createSnapshotDiff } from "../../src/snapshot/diff.js";

function snapshotFile(path: string, content: Buffer): SnapshotFile {
  return {
    path,
    contentBase64: content.toString("base64"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function snapshot(files: SnapshotFile[]): Snapshot {
  return {
    version: 1,
    id: "snapshot",
    createdAt: "2026-01-01T00:00:00.000Z",
    machine: "test",
    files,
  };
}

void test("creates sorted modified, added, and deleted text diffs", () => {
  const local = snapshot([
    snapshotFile("z-last.md", Buffer.from("local\n")),
    snapshotFile("added.md", Buffer.from("new\n")),
    snapshotFile("same.md", Buffer.from("same\n")),
  ]);
  const remote = snapshot([
    snapshotFile("z-last.md", Buffer.from("remote\n")),
    snapshotFile("deleted.md", Buffer.from("gone\n")),
    snapshotFile("same.md", Buffer.from("same\n")),
  ]);

  const result = createSnapshotDiff(local, remote);

  assert.deepEqual(
    result.files.map((file) => [file.path, file.status, file.kind]),
    [
      ["added.md", "added", "text"],
      ["deleted.md", "deleted", "text"],
      ["z-last.md", "modified", "text"],
    ],
  );
  const modified = result.files[2];

  assert.equal(modified.kind, "text");
  assert.match(modified.diff, /remote/);
  assert.match(modified.diff, /local/);
});

void test("identifies binary changes and omits matching files", () => {
  const local = snapshot([
    snapshotFile("binary.dat", Buffer.from([0, 1, 2])),
    snapshotFile("same.txt", Buffer.from("same")),
  ]);
  const remote = snapshot([
    snapshotFile("binary.dat", Buffer.from([0, 1, 3])),
    snapshotFile("same.txt", Buffer.from("same")),
  ]);

  const result = createSnapshotDiff(local, remote, "abc123");

  assert.deepEqual(result.remote, {
    target: "abc123",
    id: "snapshot",
    fileCount: 2,
  });
  assert.deepEqual(result.files, [
    { path: "binary.dat", status: "modified", kind: "binary" },
  ]);
});

void test("returns no files when snapshots match", () => {
  const files = [snapshotFile("settings.json", Buffer.from("{}\n"))];

  assert.deepEqual(
    createSnapshotDiff(snapshot(files), snapshot(files)).files,
    [],
  );
});
