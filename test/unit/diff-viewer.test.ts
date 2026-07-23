import assert from "node:assert/strict";
import test from "node:test";

import { generateDiffString, initTheme } from "@earendil-works/pi-coding-agent";

import type { SnapshotDiffFile } from "../../src/snapshot/diff.js";
import { prepareDiffFile } from "../../src/ui/diff-renderer.js";
import {
  buildTreeRows,
  DiffViewerModel,
} from "../../src/ui/diff-viewer-model.js";

initTheme(undefined, false);

function textFile(
  path: string,
  oldText: string,
  newText: string,
): SnapshotDiffFile {
  return {
    path,
    status: "modified",
    kind: "text",
    diff: generateDiffString(oldText, newText).diff,
    oldText,
    newText,
  };
}

void test("builds an expanded path tree with selectable file leaves", () => {
  const rows = buildTreeRows([
    textFile("prompts/review.md", "old\n", "new\n"),
    textFile("prompts/second.md", "old\n", "newer\n"),
    textFile("settings.json", "{}\n", '{"a":1}\n'),
  ]);

  assert.deepEqual(
    rows.map((row) => [row.label, row.depth, row.fileIndex]),
    [
      ["prompts", 0, undefined],
      ["review.md", 1, 0],
      ["second.md", 1, 1],
      ["settings.json", 0, 2],
    ],
  );
});

void test("tree selection previews immediately and escape returns to tree", () => {
  const model = new DiffViewerModel([
    textFile("a.ts", "const a = 1;\n", "const a = 2;\n"),
    textFile("b.ts", "const b = 1;\n", "const b = 2;\n"),
  ]);

  assert.equal(model.focus, "tree");
  assert.equal(model.selected!.file.path, "a.ts");
  model.handleInput("j");
  assert.equal(model.selected!.file.path, "b.ts");
  model.handleInput("\r");
  assert.equal(model.focus, "diff");
  model.handleInput("\u001b");
  assert.equal(model.focus, "tree");
  assert.equal(model.handleInput("\u001b"), "close");
});

void test("scrolls, clamps, and navigates prepared hunks", () => {
  const oldText = Array.from({ length: 20 }, (_, index) => `old ${index}`).join(
    "\n",
  );
  const newText = oldText.replace("old 2", "new 2").replace("old 17", "new 17");
  const file = textFile("src/example.ts", oldText, newText);
  const model = new DiffViewerModel([file]);

  model.setDimensions(4, 2, 40);
  model.handleInput("\r");
  model.handleInput("\u001b[6~");
  assert.equal(model.selectedState.verticalOffset, 2);
  model.handleInput("g");
  assert.equal(model.selectedState.verticalOffset, 0);
  model.handleInput("n");
  assert.equal(model.selectedState.hunkIndex, 1);
  assert.ok(model.selectedState.verticalOffset > 0);
  model.handleInput("N");
  assert.equal(model.selectedState.hunkIndex, 0);
});

void test("highlights supported source and falls back for unknown extensions", () => {
  const highlighted = prepareDiffFile(
    textFile("src/example.ts", "const answer = 1;\n", "const answer = 2;\n"),
  );
  const plain = prepareDiffFile(
    textFile("src/example.unknown", "old\n", "new\n"),
  );

  assert.ok(highlighted);
  assert.equal(highlighted.language, "typescript");
  assert.ok(
    highlighted.rows.some((row) => row.highlightedContent.includes("\u001b[")),
  );
  assert.ok(plain);
  assert.equal(plain.language, undefined);
  assert.ok(plain.rows[0].highlightedContent.includes("old"));
});
