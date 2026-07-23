import {
  type ExtensionAPI,
  type ExtensionContext,
  renderDiff,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

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
import { errorMessage } from "./utils/json-utils.js";

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

  pi.registerEntryRenderer<SnapshotDiff>(
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

      const box = new Box(1, 1);
      const target = data.remote.target ?? data.remote.id ?? "empty remote";

      box.addChild(
        new Text(theme.fg("accent", theme.bold("pi-sync diff")), 0, 0),
      );
      box.addChild(
        new Text(`target: ${target} (${data.remote.fileCount} files)`, 0, 0),
      );
      box.addChild(new Text(`local: ${data.local.fileCount} files`, 0, 0));
      box.addChild(new Text(`changed files: ${data.files.length}`, 0, 0));

      for (const file of data.files) {
        const statusColor =
          file.status === "added"
            ? "success"
            : file.status === "deleted"
              ? "error"
              : "warning";
        const label = `${file.status} ${file.path}${file.kind === "binary" ? " (binary)" : ""}`;

        box.addChild(
          new Text(theme.fg(statusColor, theme.bold(label)), 0, 1),
        );

        if (file.kind === "binary") {
          box.addChild(
            new Text(
              theme.fg("muted", "Binary content is not rendered."),
              0,
              0,
            ),
          );
        } else {
          box.addChild(
            new Text(renderDiff(file.diff, { filePath: file.path }), 0, 0),
          );
        }
      }

      return box;
    },
  );

  pi.registerCommand("pisync", {
    description: "Sync Pi settings through a Git repository",
    getArgumentCompletions: completePisyncArguments,
    handler: async (args, ctx) => {
      await handleCommand(args, ctx, (diff) => {
        if (ctx.mode === "tui") {
          pi.appendEntry<SnapshotDiff>("pisync-diff", diff);
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
