# pi-sync fork improvement plan

## Goal

Build on the fork of `@dbaida/pi-sync` instead of rewriting it from scratch.

Keep the good core primitives from upstream:

- Git-backed staging repo under `.pisync/repo`
- local lock file
- backups before applying remote snapshots
- path validation and checksum validation
- secret scanning
- drift detection
- manual push/pull/sync commands
- auto-pull on session start
- Pi lifecycle integration and resource reload prompt

Then add safer and more flexible behavior around path policy, settings handling, Pi config directory resolution, and symlinks.

## Explicit decisions

### Use a fork, not a rewrite

The fork keeps the existing Git, lock, backup, snapshot, and command model. The desired changes are extensions to the current design rather than a different architecture.

### Profiles are descoped

No first-class named profiles for now.

Work-specific overrides should be handled later, probably through Pi project-local `.pi/settings.json` and/or policy exclusions. Do not design profile layering in this pass.

### Conflict UX is descoped

Do not redesign conflict resolution yet.

For now, keep the existing behavior:

- detect divergence
- show status/diff
- require the user to choose pull, push, force push, or force pull

We want to try the current behavior before adding conflict-resolution UI.

### Backwards compatibility is not a hard constraint

We do not need strict upstream backwards compatibility. If breaking compatibility makes the fork simpler, safer, or cleaner, that is acceptable.

Still, avoid unnecessary breaking changes when they cost nothing.

### Default sync behavior should stay broad

By default, keep syncing the same broad set of paths upstream syncs today, including all global extensions.

The new policy system should add flexibility, not shrink defaults.

### Extension sync should support blacklist and whitelist modes

Default mode should sync all default paths.

Users should be able to:

- blacklist work-only paths, e.g. `extensions/work-only`
- whitelist only selected paths by disabling defaults and listing explicit include paths

Excludes always win over includes.

### Symlinks should warn and skip

Symlinks must not cause a normal sync to fail merely because they exist.

Rules:

- warn about symlinks
- skip symlinks during snapshot/push
- do not follow symlinks
- do not overwrite symlinks on pull/apply
- do not write through symlinked parent directories
- skip deletes that would touch symlinks or symlinked parents
- continue applying other safe changes

This is important because the current Pi setup has many symlinks from dotfiles.

### `PI_CODING_AGENT_DIR` changes are separate config universes

The fork should respect `PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent`.

If `PI_CODING_AGENT_DIR` changes, treat it as a different Pi config universe. Do not auto-migrate.

Reason: the pi-sync config, state, lock, repo clone, and backups all live under the resolved Pi dir. Changing the resolved Pi dir naturally means a different `pi-sync.json` and `.pisync/` tree.

`/pisync doctor` should clearly show the resolved Pi dir so this is obvious.

## Target config shape

Add an optional `policy` object to `pi-sync.json`.

```json
{
  "repository": "git@github.com:you/pi-config.git",
  "branch": "main",
  "autoSync": true,
  "policy": {
    "includeDefaults": true,
    "includePaths": [],
    "excludePaths": [
      "extensions/work-only"
    ]
  }
}
```

### `policy.includeDefaults`

Boolean.

When `true`, include the default upstream-managed paths.

When `false`, only include explicit `includePaths`, subject to `excludePaths`.

Default: `true`.

### `policy.includePaths`

Extra relative paths under the Pi agent dir to sync.

Examples:

```json
"includePaths": [
  "extensions/personal-helper",
  "prompts/my-prompt.md"
]
```

### `policy.excludePaths`

Relative paths under the Pi agent dir to exclude from sync.

Examples:

```json
"excludePaths": [
  "extensions/work-only",
  "prompts/private-work-prompts"
]
```

Excludes win over default includes and explicit includes.

### Path policy rules

All policy paths are relative to the resolved Pi agent dir.

Reject or ignore unsafe policy paths:

- absolute paths
- paths containing `..` traversal
- empty paths
- paths that resolve outside the Pi agent dir

Policy should apply to both snapshot creation and pull/apply deletion behavior.

## Default managed paths

The current upstream defaults are the baseline:

Root files:

- `settings.json`
- `keybindings.json`
- `models.json`
- `AGENTS.md`

Directories:

- `skills/`
- `prompts/`
- `themes/`
- `extensions/`

Keep these as the default policy when `includeDefaults: true`.

Existing denied/sensitive paths should remain denied regardless of policy.

## Settings handling

`settings.json` should no longer be copied blindly as a normal file.

### Snapshot behavior

When creating a snapshot, sanitize `settings.json` before writing it into the sync repo.

At minimum:

- strip `lastChangelogVersion`
- avoid syncing machine-local package entries
- preserve portable package entries

### Pull/apply behavior

When applying an incoming `settings.json`, merge sanitized incoming settings over the local settings instead of blindly replacing the entire file.

The merge should preserve local-only fields and local-only package entries.

### Package/resource handling

Pi package entries can be strings or objects.

We need to distinguish actual files under synced directories from pointers in settings.

#### Synced extension files

Example:

```text
extensions/my-ext.ts
```

These are actual files. If `extensions/` is included by policy and the file is not excluded, pi-sync copies the file directly.

No package install is needed. After reload, Pi loads the local file from disk.

#### Portable package sources

Examples:

```json
"packages": [
  "npm:foo",
  "git:github.com/user/repo",
  "https://github.com/user/repo.git",
  "git@github.com:user/repo.git"
]
```

These should stay in synced `settings.json`.

If Machine A adds a portable npm/git package and Machine B pulls it, Machine B's settings update first. On Pi reload or restart, Pi resolves packages and should install/load missing npm/git packages unless offline mode is enabled or installation fails.

#### Portable relative local paths

Examples:

```json
"packages": ["./extensions/foo"]
```

```json
"extensions": ["extensions/foo.ts"]
```

Relative paths can be portable if they resolve inside the Pi agent dir and point at files/directories that are included by policy.

These should be allowed because the target content can be synced by pi-sync.

#### Machine-local paths

Examples:

```text
/Users/you/dev/ext
~/dev/ext
../outside-pi
file:/Users/you/dev/ext
```

These should not be committed to synced settings.

On pull, preserve these local entries on the machine where they already exist.

## Apply and deletion safety

Pull/apply must be policy-aware.

Critical rule: excluded paths must never be deleted or modified just because they are missing from the remote snapshot.

Example:

```json
"excludePaths": ["extensions/work-only"]
```

If the remote snapshot lacks `extensions/work-only`, pull must leave the local `extensions/work-only` tree alone.

Apply should only modify/delete paths that are managed by the effective policy and safe under symlink checks.

## Doctor/status improvements

`/pisync doctor` should show:

- resolved Pi dir
- config path
- state dir
- repo dir
- backup dir
- lock path
- repository URL and branch
- policy summary
- effective included paths
- effective excluded paths
- symlink warnings found under managed paths
- whether `settings.json` contains stripped runtime keys such as `lastChangelogVersion`
- whether `settings.json` contains local-only package/resource references

Status/diff output can remain mostly unchanged for now, but should avoid implying excluded paths are drift.

## Small correctness cleanup

Fix the checkout missing-argument issue:

- `/pisync checkout` without a target should fail clearly
- current code checks `target === ""` even though target can be `undefined`

## Implementation phases

1. Config dir support
   - make `agentDir()` respect `PI_CODING_AGENT_DIR`
   - verify config, state, repo, lock, and backup paths all move together

2. Policy model and validation
   - add `policy.includeDefaults`, `policy.includePaths`, `policy.excludePaths`
   - validate paths are safe and relative
   - compute effective managed paths

3. Policy-driven snapshot and apply
   - replace fixed snapshot constants with effective policy
   - make stale deletes policy-aware
   - keep denied/sensitive paths blocked regardless of policy

4. Settings sanitizer and merge
   - strip runtime keys on snapshot
   - classify package/resource references
   - sync portable package entries
   - preserve local-only package entries on pull
   - merge incoming settings over local settings

5. Symlink warn-and-skip
   - explicitly detect symlinks during snapshot
   - warn and skip rather than silently ignoring
   - skip apply writes/deletes involving symlinks or symlinked parents
   - never follow symlinks

6. Doctor and small correctness
   - improve `/pisync doctor`
   - surface resolved paths and policy
   - surface symlink/settings/package warnings
   - fix checkout argument validation

7. Personal migration runbook
   - migrate the current Pi setup from dotfile symlinks into real files/directories managed by pi-sync
   - configure excludes for work-only pieces
   - verify sync across machines

## Risks

### Policy-aware deletion

This is the highest-risk area.

If implemented incorrectly, pull could delete local excluded paths. Deletion should be conservative.

### Symlink apply behavior

Symlink handling must be consistent across write and delete paths.

The fork should skip unsafe paths and continue, not follow links.

### Settings merge semantics

Settings merge should preserve local machine state and local package paths while still applying remote user preferences.

### Package auto-install expectations

Remote npm/git package entries are installed by Pi's package resolution during reload/startup, not directly by pi-sync itself. pi-sync should update settings and prompt/reload; Pi performs the package install.

### Migration from dotfiles

The current dotfiles setup uses symlinks. Because the fork will skip symlinks, migration needs a deliberate step to replace selected symlinks with real files/directories before expecting pi-sync to manage them.

## Done criteria

- `PI_CODING_AGENT_DIR` is respected
- `/pisync doctor` clearly shows the resolved Pi dir
- policy can exclude `extensions/work-only` while still syncing other extensions
- policy can whitelist only selected paths when `includeDefaults: false`
- `lastChangelogVersion` does not enter synced settings
- portable package entries sync
- local-only package entries are preserved locally
- symlinked files/directories are reported and skipped
- pull does not overwrite or delete symlinks
- pull does not delete excluded paths
- existing Git/lock/backup flow still works
