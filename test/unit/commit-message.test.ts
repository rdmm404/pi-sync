import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  generateCommitMessage,
  normalizeCommitMessage,
} from "../../src/git/commit-message.js";

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

type FakeResponse = {
  content: { type: string; text?: string }[];
  stopReason: string;
  errorMessage?: string;
};

function createContext(
  respond: (call: {
    model: unknown;
    context: unknown;
    options: unknown;
  }) => FakeResponse,
) {
  const calls: { model: unknown; context: unknown; options: unknown }[] = [];
  const model = { provider: "custom", id: "m1", api: "custom-vertex-claude" };
  const signal = new AbortController().signal;
  const ctx = {
    model,
    signal,
    modelRegistry: {
      find: () => model,
      streamSimple: (m: unknown, context: unknown, options: unknown) => {
        const call = { model: m, context, options };
        calls.push(call);
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          result: async () => respond(call),
        };
      },
    },
  } as unknown as ExtensionContext;

  return { ctx, calls, model, signal };
}

void test("generates a message through the model registry", async () => {
  const { ctx, calls, model, signal } = createContext(() => ({
    content: [{ type: "text", text: '"Update settings"\nextra' }],
    stopReason: "stop",
  }));

  const result = await generateCommitMessage(ctx, undefined, "diff --git a b");

  assert.deepEqual(result, { message: "Update settings" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.model, model);
  assert.deepEqual(calls[0]?.options, { maxTokens: 120, signal });
});

void test("returns a warning when the model reports an error", async () => {
  const { ctx } = createContext(() => ({
    content: [],
    stopReason: "error",
    errorMessage: "boom",
  }));

  const result = await generateCommitMessage(ctx, "custom/m1", "diff");

  assert.equal(result.message, undefined);
  assert.match(result.warning ?? "", /boom/u);
});

void test("returns a warning when the registry throws", async () => {
  const { ctx } = createContext(() => {
    throw new Error("No API provider registered");
  });

  const result = await generateCommitMessage(ctx, undefined, "diff");

  assert.match(result.warning ?? "", /No API provider registered/u);
});

void test("returns a warning for an empty response", async () => {
  const { ctx } = createContext(() => ({ content: [], stopReason: "stop" }));

  const result = await generateCommitMessage(ctx, undefined, "diff");

  assert.match(result.warning ?? "", /empty response/u);
});
