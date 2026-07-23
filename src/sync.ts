import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { isEnabled } from "./commands/args.js";
import { handleCommand } from "./commands/commands.js";
import { completePisyncArguments } from "./commands/completions.js";
import { refreshSyncFooter } from "./commands/footer-status.js";
import { SyncOperations } from "./commands/operations.js";
import {
  isMissingConfigError,
  loadConfig,
  loadPartialConfig,
} from "./config/config.js";
import { AUTO_SYNC_OPTIONS, STATUS_KEY } from "./domain/constants.js";
import type { SnapshotDiff } from "./snapshot/diff.js";
import { ensureStateDir, withLock } from "./state/lock.js";
import { openDiffViewer } from "./ui/diff-viewer.js";
import { errorMessage } from "./utils/json-utils.js";

type SnapshotDiffSummary = {
  target: string;
  changedFiles: number;
};

export { isEnabled, parseOptions, splitArgs } from "./commands/args.js";
export { preflightSnapshotApply } from "./snapshot/apply.js";
export { isDeniedPath, scanSnapshot } from "./snapshot/snapshot.js";
export { posixJoin, safeJoin } from "./utils/path-utils.js";

/**
 * Register the Git-backed Pi settings sync extension.
 *
 * @param pi Pi extension API used to register commands and lifecycle hooks.
 */
export default function sync(pi: ExtensionAPI): void {
  const warningState = { autoSyncWarningShown: false };

  pi.registerEntryRenderer<SnapshotDiff | SnapshotDiffSummary>(
    "pisync-diff",
    (entry, _options, theme) => {
      const data = entry.data;

      if (data == null) {
        return new Text(
          theme.fg("error", "pi-sync diff data is missing."),
          1,
          0,
        );
      }

      const summary =
        "files" in data
          ? {
              target: data.remote.target ?? data.remote.id ?? "empty remote",
              changedFiles: data.files.length,
            }
          : data;

      return new Text(
        theme.fg(
          "accent",
          theme.bold(
            `pi-sync diff viewed: ${summary.changedFiles} changed file${summary.changedFiles === 1 ? "" : "s"} against ${summary.target}`,
          ),
        ),
        1,
        0,
      );
    },
  );

  pi.registerCommand("pisync", {
    description: "Sync Pi settings through a Git repository",
    getArgumentCompletions: completePisyncArguments,
    handler: async (args, ctx) => {
      await handleCommand(args, ctx, async (diff) => {
        if (ctx.mode === "tui") {
          await openDiffViewer(ctx, diff);
          const target = diff.remote.target ?? diff.remote.id ?? "empty remote";
          pi.appendEntry<SnapshotDiffSummary>("pisync-diff", {
            target,
            changedFiles: diff.files.length,
          });
        }
      });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "checking"));
    startAutoSyncInBackground(ctx, warningState);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

function startAutoSyncInBackground(
  ctx: ExtensionContext,
  warningState: { autoSyncWarningShown: boolean },
): void {
  setTimeout(() => {
    void autoSync(ctx, warningState);
  }, 0);
}

async function autoSync(
  ctx: ExtensionContext,
  warningState: { autoSyncWarningShown: boolean },
): Promise<void> {
  try {
    const partial = await loadPartialConfig();

    await ensureStateDir();
    await loadConfig();

    if (!isEnabled(partial.autoSync ?? process.env.PI_SYNC_AUTO_SYNC, true)) {
      await withLock("status", async () => {
        await refreshSyncFooter(ctx);
      });

      return;
    }

    await withLock("auto-sync", async () => {
      await new SyncOperations(ctx, AUTO_SYNC_OPTIONS, {
        notifyAutoSyncWarnings: !warningState.autoSyncWarningShown,
      }).autoSync();
    });
    warningState.autoSyncWarningShown = true;
  } catch (error) {
    if (isMissingConfigError(error)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);

      return;
    }

    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.notify(
      `pi-sync auto sync skipped: ${errorMessage(error)}`,
      "warning",
    );
  }
}
