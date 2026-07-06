# pi-sync implementation tasks

This is the step-by-step task list for implementing `plan.md`.

## 0. Baseline checks

- [ ] Run the current validation commands and record the baseline.
  - [ ] `npm install` if dependencies are missing
  - [ ] `npm run typecheck`
  - [ ] `npm run lint` if available
  - [ ] `npm run build` if available
- [ ] Inspect current package scripts in `package.json`.
- [ ] Confirm the fork remote setup.
  - [ ] `origin` should point at `rdmm404/pi-sync`
  - [ ] `upstream` should point at `dmytrobaida/pi-sync`

## 1. Add `PI_CODING_AGENT_DIR` support

Files likely involved:

- `src/utils/path-utils.ts`
- any callers of `agentDir()`
- `src/state/*`
- `src/config/config.ts`
- `src/git/store.ts`

Tasks:

- [ ] Update `agentDir()` to return `process.env.PI_CODING_AGENT_DIR` when set.
- [ ] Fall back to the current `~/.pi/agent` default when the env var is unset.
- [ ] Resolve the path to an absolute path.
- [ ] Ensure config path, state path, repo path, backup path, and lock path are all derived from `agentDir()`.
- [ ] Do not auto-migrate when `PI_CODING_AGENT_DIR` changes.
- [ ] Add or update doctor/status messaging later to make the resolved dir visible.
- [ ] Run typecheck/build.

Acceptance:

- [ ] With no env var, paths still resolve under `~/.pi/agent`.
- [ ] With `PI_CODING_AGENT_DIR=/tmp/pi-agent-test`, all pi-sync local state paths resolve under `/tmp/pi-agent-test`.

## 2. Add sync policy types and defaults

Files likely involved:

- `src/domain/types.ts`
- `src/domain/constants.ts`
- `src/config/config.ts`
- possibly new `src/policy/*`

Tasks:

- [ ] Add `SyncPolicy` type:
  - [ ] `includeDefaults?: boolean`
  - [ ] `includePaths?: string[]`
  - [ ] `excludePaths?: string[]`
- [ ] Add `policy?: SyncPolicy` to `SyncConfig`.
- [ ] Keep current default root files and dirs as the default managed paths:
  - [ ] `settings.json`
  - [ ] `keybindings.json`
  - [ ] `models.json`
  - [ ] `AGENTS.md`
  - [ ] `skills/`
  - [ ] `prompts/`
  - [ ] `themes/`
  - [ ] `extensions/`
- [ ] Implement policy normalization:
  - [ ] default `includeDefaults` to `true`
  - [ ] default `includePaths` to `[]`
  - [ ] default `excludePaths` to `[]`
- [ ] Implement path validation:
  - [ ] reject/ignore absolute paths
  - [ ] reject/ignore empty paths
  - [ ] reject/ignore `..` traversal
  - [ ] normalize to POSIX-style relative paths
  - [ ] ensure resolved paths stay inside `agentDir()`
- [ ] Implement effective policy calculation:
  - [ ] default paths if `includeDefaults: true`
  - [ ] plus `includePaths`
  - [ ] minus `excludePaths`
  - [ ] excludes win over includes
- [ ] Keep existing hard-denied sensitive paths denied regardless of policy.
- [ ] Run typecheck/build.

Acceptance:

- [ ] Missing policy behaves like upstream defaults.
- [ ] `includeDefaults: false` syncs only explicit include paths.
- [ ] `excludePaths` excludes a path even if it is part of defaults.
- [ ] Unsafe paths cannot escape the Pi dir.

## 3. Make snapshot creation policy-driven

Files likely involved:

- `src/snapshot/snapshot.ts`
- `src/domain/constants.ts`
- new policy helper module if added

Tasks:

- [ ] Change snapshot creation to accept or load the effective policy.
- [ ] Replace direct use of fixed `TOP_LEVEL_FILES` / `TOP_LEVEL_DIRS` with effective managed paths.
- [ ] For each managed path:
  - [ ] skip if denied/sensitive
  - [ ] skip if excluded by policy
  - [ ] include file if it exists and is a regular file
  - [ ] recursively include directory contents if it exists and is a real directory
- [ ] Ensure default behavior still includes all upstream default files/dirs.
- [ ] Ensure `extensions/` still syncs by default.
- [ ] Ensure `extensions/work-only` can be excluded while other extensions still sync.
- [ ] Add warning collection for skipped paths where useful.
- [ ] Run typecheck/build.

Acceptance:

- [ ] Snapshot with default policy matches current broad behavior, except for planned settings sanitization and symlink warnings once implemented.
- [ ] Snapshot with `excludePaths: ["extensions/work-only"]` omits that subtree.
- [ ] Snapshot with `includeDefaults: false` includes only explicit include paths.

## 4. Add symlink warn-and-skip during snapshot

Files likely involved:

- `src/snapshot/snapshot.ts`
- maybe `src/domain/types.ts` for warning metadata
- command notification paths in `src/commands/operations.ts`

Tasks:

- [ ] Detect `Dirent.isSymbolicLink()` explicitly during collection.
- [ ] Do not call `stat` to follow symlinks.
- [ ] Warn and skip symlinked files.
- [ ] Warn and skip symlinked directories.
- [ ] Decide how warnings are surfaced:
  - [ ] command notification
  - [ ] doctor output
  - [ ] snapshot warning metadata, if useful
- [ ] Keep sync moving when symlinks are encountered.
- [ ] Run typecheck/build.

Acceptance:

- [ ] Symlinked managed file is skipped with a warning.
- [ ] Symlinked managed directory is skipped with a warning.
- [ ] Snapshot does not include the symlink target contents.
- [ ] Push does not fail merely because symlinks exist.

## 5. Add settings sanitizer for snapshot

Files likely involved:

- `src/snapshot/snapshot.ts`
- new `src/settings/*` or `src/snapshot/settings.ts`
- `src/utils/json-utils.ts`

Tasks:

- [ ] Special-case `settings.json` during snapshot collection.
- [ ] Parse JSON safely.
- [ ] Strip runtime/machine-local keys:
  - [ ] `lastChangelogVersion`
- [ ] Classify package/resource references.
- [ ] Preserve portable package entries:
  - [ ] npm package names
  - [ ] `npm:` specs
  - [ ] `git:` specs
  - [ ] HTTPS Git URLs
  - [ ] SSH Git URLs
- [ ] Preserve portable relative local entries only when:
  - [ ] they resolve inside the Pi dir
  - [ ] they point at a path included by policy
- [ ] Strip machine-local package/resource entries from synced snapshot:
  - [ ] absolute paths
  - [ ] `~` paths
  - [ ] `../outside-pi` style paths
  - [ ] `file:` local paths
- [ ] Preserve object-shaped package entries when their `source` is portable.
- [ ] Preserve filters/metadata on object-shaped package entries.
- [ ] Write sanitized settings content into the snapshot instead of raw `settings.json`.
- [ ] Run typecheck/build.

Acceptance:

- [ ] Synced `settings.json` never contains `lastChangelogVersion`.
- [ ] Portable npm/git package entries remain.
- [ ] Local filesystem package entries are omitted from the synced snapshot.
- [ ] Relative paths under included Pi-dir paths remain.

## 6. Merge settings on apply

Files likely involved:

- `src/snapshot/apply.ts`
- settings helper from previous step
- `src/utils/json-utils.ts`

Tasks:

- [ ] Special-case incoming `settings.json` during apply.
- [ ] Read existing local `settings.json` if present.
- [ ] Sanitize incoming settings before merge.
- [ ] Merge incoming settings over local settings.
- [ ] Preserve local-only runtime keys where appropriate.
- [ ] Preserve local-only package/resource entries.
- [ ] Avoid reintroducing `lastChangelogVersion` from remote.
- [ ] Preserve formatting reasonably, or write stable pretty JSON.
- [ ] Run typecheck/build.

Acceptance:

- [ ] Pull updates normal synced settings.
- [ ] Pull does not delete local-only package entries.
- [ ] Pull does not write remote `lastChangelogVersion`.
- [ ] Pull handles missing local `settings.json` gracefully.

## 7. Make apply and stale deletes policy-aware

Files likely involved:

- `src/snapshot/apply.ts`
- `src/snapshot/diff.ts`
- policy helper module

Tasks:

- [ ] Pass effective policy into apply.
- [ ] Only write incoming files that are managed by policy.
- [ ] Only delete stale local files that are managed by policy.
- [ ] Never delete excluded paths.
- [ ] Never modify excluded paths.
- [ ] Ensure hard-denied paths are never written/deleted.
- [ ] Ensure parent directory cleanup does not remove excluded directories.
- [ ] Run typecheck/build.

Acceptance:

- [ ] Pull does not delete `extensions/work-only` when it is excluded.
- [ ] Pull still updates other managed extension files.
- [ ] Pull with `includeDefaults: false` does not touch default paths unless explicitly included.

## 8. Add symlink warn-and-skip during apply

Files likely involved:

- `src/snapshot/apply.ts`
- maybe path utilities

Tasks:

- [ ] Detect if target path is a symlink before write/delete.
- [ ] Detect if any parent path is a symlink before write/delete.
- [ ] Skip writes involving symlink targets or symlinked parents.
- [ ] Skip deletes involving symlink targets or symlinked parents.
- [ ] Do not follow symlinks.
- [ ] Surface warnings to the user.
- [ ] Continue applying other safe files.
- [ ] Run typecheck/build.

Acceptance:

- [ ] Pull does not overwrite a symlink.
- [ ] Pull does not write through a symlinked parent directory.
- [ ] Pull does not delete a symlink.
- [ ] Pull completes other safe changes.

## 9. Improve `/pisync doctor`

Files likely involved:

- command handling in `src/commands/*`
- path/config/state helpers
- policy helper module
- settings helper module

Tasks:

- [ ] Show resolved Pi dir.
- [ ] Show config path.
- [ ] Show state dir.
- [ ] Show repo dir.
- [ ] Show backup dir.
- [ ] Show lock path.
- [ ] Show repository URL and branch.
- [ ] Show normalized policy.
- [ ] Show effective included paths.
- [ ] Show effective excluded paths.
- [ ] Show symlink warnings under managed paths.
- [ ] Show whether `settings.json` contains `lastChangelogVersion`.
- [ ] Show whether `settings.json` contains local-only package/resource references.
- [ ] Keep output concise enough for Pi UI.
- [ ] Run typecheck/build.

Acceptance:

- [ ] Doctor makes the active config universe obvious.
- [ ] Doctor makes policy decisions understandable.
- [ ] Doctor helps before migrating off dotfile symlinks.

## 10. Fix checkout argument validation

Files likely involved:

- `src/commands/operations.ts`
- `src/commands/args.ts`
- maybe `src/commands/commands.ts`

Tasks:

- [ ] Find `/pisync checkout` target parsing.
- [ ] Treat `undefined`, `null`, and empty string as missing target.
- [ ] Return a clear usage error for missing target.
- [ ] Run typecheck/build.

Acceptance:

- [ ] `/pisync checkout` without an argument fails clearly.
- [ ] `/pisync checkout <commit-ish>` still works.

## 11. Update docs

Files likely involved:

- `README.md`
- `plan.md`
- maybe examples in README

Tasks:

- [ ] Document `PI_CODING_AGENT_DIR` behavior.
- [ ] Document that changing `PI_CODING_AGENT_DIR` means a separate pi-sync config universe.
- [ ] Document policy config.
- [ ] Document default paths.
- [ ] Document include/exclude examples.
- [ ] Document symlink warn-and-skip behavior.
- [ ] Document settings sanitization and merge behavior.
- [ ] Document package/resource handling.
- [ ] Document that pi-sync updates settings; Pi installs remote npm/git packages during reload/startup.
- [ ] Document descoped items:
  - [ ] no profiles yet
  - [ ] no new conflict UX yet

Acceptance:

- [ ] A user can configure blacklist-style extension exclusion from README alone.
- [ ] A user understands what happens to symlinks.
- [ ] A user understands which package paths are portable.

## 12. Manual migration runbook for current setup

Purpose: move the current Pi setup from dotfile symlinks into pi-sync-managed real files/directories.

Tasks:

- [ ] Run doctor to inspect current resolved Pi dir and symlink warnings.
- [ ] List symlinks under the Pi agent dir.
- [ ] Decide which symlinked paths should become pi-sync-managed real files/directories.
- [ ] Decide which symlinked paths should remain local-only and be excluded.
- [ ] For managed paths:
  - [ ] replace symlink with real file/directory content
  - [ ] ensure the path is included by policy
- [ ] For local-only paths:
  - [ ] leave symlink/local setup alone if desired
  - [ ] add path to `policy.excludePaths`
- [ ] Configure work-only extension exclusions, e.g. `extensions/work-only`.
- [ ] Run `/pisync diff`.
- [ ] Run `/pisync push` from the source machine.
- [ ] On another machine, run `/pisync pull`.
- [ ] Accept reload prompt or restart Pi.
- [ ] Verify extensions, themes, prompts, skills, and settings load correctly.
- [ ] Verify excluded work-only paths remain untouched.

Acceptance:

- [ ] Personal/global Pi setup syncs across machines.
- [ ] Work-only global custom extensions do not get tracked if excluded.
- [ ] Dotfile symlinks no longer block or break sync.

## 13. Final validation

- [ ] Run typecheck/build/lint.
- [ ] Run a manual push/pull loop with a temporary `PI_CODING_AGENT_DIR`.
- [ ] Validate default policy behavior.
- [ ] Validate blacklist behavior.
- [ ] Validate whitelist behavior.
- [ ] Validate settings sanitizer.
- [ ] Validate settings merge.
- [ ] Validate symlink snapshot skip.
- [ ] Validate symlink apply skip.
- [ ] Validate excluded paths are not deleted.
- [ ] Validate remote npm/git package settings behavior after reload/restart.
- [ ] Commit changes in logical chunks.
