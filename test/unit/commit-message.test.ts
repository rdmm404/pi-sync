import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCommitMessage } from "../../src/git/commit-message.js";

void test("normalizes a model commit subject to one line", () => {
  assert.equal(
    normalizeCommitMessage(
      'Commit subject: "Update synced settings"\nMore detail',
    ),
    "Update synced settings",
  );
});

void test("returns undefined for an empty model response", () => {
  assert.equal(normalizeCommitMessage("```\n```"), undefined);
});

void test("bounds long commit subjects", () => {
  const result = normalizeCommitMessage("a".repeat(200));

  if (result == null) {
    throw new Error("Expected a normalized commit message");
  }

  assert.equal(result.length, 120);
  assert.equal(result.endsWith("…"), true);
});
