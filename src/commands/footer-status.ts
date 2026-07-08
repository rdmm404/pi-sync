import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { STATUS_KEY } from "../domain/constants.js";
import type { Snapshot, SyncState } from "../domain/types.js";
import { fileHashMap } from "../snapshot/snapshot.js";
import { changedPathCount, comparableStateHashes } from "../state/state.js";
import { syncInputs } from "./context.js";

export type SyncDrift = {
  local: number;
  remote: number;
};

/**
 * Update the pi-sync footer status with local and remote change counts.
 *
 * @param ctx Pi context with UI status access.
 */
export async function refreshSyncFooter(
  ctx: ExtensionCommandContext | ExtensionContext,
): Promise<void> {
  const { local, remote, state } = await syncInputs();

  setSyncFooter(ctx, local, remote, state);
}

/**
 * Render already-loaded sync inputs into the pi-sync footer status.
 *
 * @param ctx Pi context with UI status access.
 * @param local Current local snapshot.
 * @param remote Current remote snapshot, if any.
 * @param state Last persisted sync state.
 */
export function setSyncFooter(
  ctx: ExtensionCommandContext | ExtensionContext,
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncState,
): void {
  ctx.ui.setStatus(
    STATUS_KEY,
    formatStyledSyncFooter(ctx, local, remote, state),
  );
}

/**
 * Format local and remote change counts for the footer.
 *
 * @param local Current local snapshot.
 * @param remote Current remote snapshot, if any.
 * @param state Last persisted sync state.
 */
export function formatSyncFooter(
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncState,
): string {
  const drift = syncDrift(local, remote, state);

  return formatCompactSyncStatus(drift);
}

function formatCompactSyncStatus(drift: SyncDrift): string {
  if (drift.local === 0 && drift.remote === 0) {
    return "✓";
  }

  const parts: string[] = [];

  if (drift.local > 0) {
    parts.push(`↑${drift.local}`);
  }
  if (drift.remote > 0) {
    parts.push(`↓${drift.remote}`);
  }

  return parts.join(" ");
}

function formatStyledSyncFooter(
  ctx: ExtensionCommandContext | ExtensionContext,
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncState,
): string {
  const drift = syncDrift(local, remote, state);

  if (drift.local === 0 && drift.remote === 0) {
    return ctx.ui.theme.fg("success", "✓");
  }

  const parts: string[] = [];

  if (drift.local > 0) {
    parts.push(ctx.ui.theme.fg("error", `↑${drift.local}`));
  }
  if (drift.remote > 0) {
    parts.push(ctx.ui.theme.fg("success", `↓${drift.remote}`));
  }

  return parts.join(" ");
}

/**
 * Count local and remote drift against the last synced state.
 *
 * @param local Current local snapshot.
 * @param remote Current remote snapshot, if any.
 * @param state Last persisted sync state.
 */
export function syncDrift(
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncState,
): SyncDrift {
  const stateHashes = comparableStateHashes(local, remote, state);

  return {
    local: changedPathCount(fileHashMap(local), stateHashes),
    remote: changedPathCount(
      remote != null ? fileHashMap(remote) : {},
      stateHashes,
    ),
  };
}
