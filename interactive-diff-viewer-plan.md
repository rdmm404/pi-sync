# Interactive pi-sync Diff Viewer Plan

## Goal

Replace the current transcript-rendered `/pisync diff` output in interactive Pi with a large, keyboard-driven diff viewer inspired by lazygit.

The viewer will:

- show a changed-file tree and one file diff at a time;
- preview a file immediately as tree selection moves;
- support vertical and horizontal scrolling;
- support next/previous hunk navigation;
- combine Pi's theme-aware syntax highlighting with clear diff-semantic gutters;
- leave only a compact summary in the transcript after closing;
- preserve the existing plain-text fallback outside interactive TUI mode.

Remove `/pisync changes`, because the interactive diff viewer provides the more useful changed-file navigation experience.

## Finalized interaction model

### Initial state

- `/pisync diff [<commit-ish>]` opens a large centered overlay.
- Focus starts in the file tree.
- The first changed file is selected.
- The selected file is previewed immediately in the diff pane.

### File-tree focus

- `j` / `k` or `Down` / `Up`: move to the next or previous changed file.
- Moving selection immediately updates the diff pane; `Enter` is not required to load a file.
- `Enter`: move focus into the diff pane for scrolling.
- `Tab`: move focus into the diff pane.
- `Esc`: close the viewer when the tree already has focus.
- `q` or `Ctrl+C`: close the viewer from either pane.

Directory names are visual structure rather than selectable rows. All directory branches are expanded, so `Enter` retains one clear meaning: enter the selected file's diff pane.

### Diff-pane focus

- `j` / `k` or `Down` / `Up`: scroll vertically by one line.
- `PageDown` / `PageUp`: scroll by one viewport.
- `g` / `G`: jump to the top or bottom.
- `n` / `N`: jump to the next or previous hunk.
- `l` / `h` or `Right` / `Left`: scroll horizontally.
- `Tab` or `Shift+Tab`: return focus to the file tree.
- `Esc`: return focus to the file tree instead of closing the viewer.
- `q` or `Ctrl+C`: close the viewer directly.

The footer will always display context-sensitive key hints for the focused pane.

## UI layout

### Wide terminals

Use a centered overlay occupying approximately 95% of terminal width and 90% of terminal height:

```text
┌ pi-sync diff: remote → local ─────────────────────────────────────┐
│ Files                          │ settings.json          modified   │
│                                │                                    │
│ M settings.json                │  12  "theme": "dark",              │
│ A prompts/review.md            │ -13  "model": "old"                │
│ D themes/legacy.json           │ +13  "model": "new"                │
│                                │                                    │
├────────────────────────────────┴────────────────────────────────────┤
│ Tree: ↑↓ preview • Enter scroll • q close                           │
└──────────────────────────────────────────────────────────────────────┘
```

- Left pane: changed-file tree, status marker, and active selection.
- Right pane: selected path, status, scroll position, hunk position, and visible diff window.
- The focused pane receives an accent border or title treatment.
- File statuses use distinct markers and Pi theme colors:
  - `A` / success for added;
  - `M` / warning for modified;
  - `D` / error for deleted;
  - a binary indicator where applicable.

### Narrow terminals

When side-by-side panes would be unreadable, switch to a stacked layout:

- a short file-tree viewport at the top;
- the selected diff below it;
- the same focus and key behavior;
- no loss of functionality.

Do not wrap diff lines. Preserve code structure and use horizontal scrolling instead.

### Vertical sizing

`Component.render()` receives width but not height, so the viewer will derive available rows from `tui.terminal.rows` and render an explicit viewport. Overlay `maxHeight` will be a safety bound, not the scrolling mechanism. Every state change and terminal resize must clamp viewport offsets before rendering.

## Component architecture

Create a focused UI module rather than keeping the component inside `src/sync.ts`.

Suggested files:

- `src/ui/diff-viewer.ts`
  - overlay entry function;
  - TUI component;
  - input routing;
  - responsive layout composition.
- `src/ui/diff-viewer-model.ts`
  - UI-independent navigation and viewport state;
  - file selection;
  - pane focus;
  - vertical/horizontal offsets;
  - hunk navigation and clamping.
- `src/ui/diff-renderer.ts`
  - syntax-highlighted old/new source preparation;
  - conversion of display diffs into line-level render rows;
  - diff gutters, intra-line emphasis, and hunk index extraction;
  - ANSI-aware viewport slicing.

Keep the model independent of Pi's TUI where practical so navigation can be unit tested without a terminal harness.

### Viewer state

Track at least:

- focused pane: `tree` or `diff`;
- selected file index;
- visited file indexes, if useful for the closing summary;
- tree scroll offset;
- per-file vertical scroll offset;
- per-file horizontal scroll offset;
- hunk start indexes for each text file;
- current hunk index;
- last calculated terminal width and height.

Preserve scroll positions per file so moving away from a file and back does not lose the review position.

### File tree

Build display rows from changed paths:

- split paths into directory segments;
- render shared directory prefixes once;
- indent file leaves;
- keep only file leaves selectable;
- maintain the current file within the visible tree viewport.

The underlying file order remains deterministic and path-sorted, matching `createSnapshotDiff()`.

## Diff preparation and rendering

### Syntax-aware initial renderer

Pi's native `renderDiff()` does **not** provide syntax highlighting. It gives the entire code portion of each row a diff-semantic foreground color, plus intra-line inverse emphasis for simple one-line replacements. That is useful for the edit tool but does not satisfy this viewer's syntax-highlighting requirement.

Pi separately exports two suitable public APIs:

- `getLanguageFromPath(path)` maps common file extensions to highlighter language identifiers;
- `highlightCode(code, language)` uses Pi's existing `highlight.js`/`cli-highlight` integration and maps tokens onto the active Pi theme's syntax colors.

Use those APIs in the initial implementation; syntax highlighting is not deferred to a later enhancement.

For each text file:

1. Keep the complete old and new text alongside the display diff in the transient `SnapshotDiff` passed to the viewer.
2. Detect the language from the path with `getLanguageFromPath()`.
3. Run `highlightCode()` once over the complete old file and once over the complete new file. Highlighting complete content instead of isolated rows preserves multiline comments, strings, and other grammar state.
4. Parse the raw display diff into rows carrying `kind`, old/new line numbers, plain content, and hunk membership.
5. Map removed rows to highlighted old-file lines, added rows to highlighted new-file lines, and context rows to the corresponding highlighted new-file lines.
6. Render the `+`, `-`, or context marker and line-number gutter with Pi's diff-semantic colors while retaining syntax colors in the code body.
7. For a one-to-one removed/added replacement pair, retain intra-line emphasis by applying inverse styling only to the changed visible ranges without replacing syntax foreground colors.

The resulting row model should resemble:

```ts
type DiffRenderRow = {
  kind: "added" | "removed" | "context" | "gap";
  oldLine?: number;
  newLine?: number;
  plainContent: string;
  highlightedContent: string;
  hunkIndex?: number;
};
```

Extend the text variant of `SnapshotDiffFile` with the old and new source text needed for highlighting. This data remains viewer-local and transient: new transcript entries store only the compact summary, never full source content.

If `getLanguageFromPath()` returns no supported language, `highlightCode()` should fall back to Pi-themed plain code while the diff gutter remains fully functional. A highlighting failure must degrade to unhighlighted text rather than preventing the viewer from opening.

Cache prepared rows per file while the viewer is open. On component invalidation, rebuild syntax-derived content so a live Pi theme change cannot leave stale ANSI colors.

Render only the visible vertical window. Use `sliceByColumn()` from `@earendil-works/pi-tui` for ANSI-safe horizontal scrolling, including rows containing nested syntax and inverse styles. Ensure every composed output row has a visible width no greater than the width passed to `render()`.

### Hunk detection

Derive hunk starts from the raw display diff before applying ANSI styling:

- treat each contiguous changed region as a hunk;
- avoid splitting a removed/added replacement pair into separate hunks;
- use context-gap (`...`) rows and transitions between changed/context regions to identify boundaries;
- store indexes that align with rendered lines.

When jumping to a hunk, place its first changed line near the top of the viewport while retaining a small amount of preceding context where possible.

### Binary files

Binary files remain selectable and immediately previewable. Their diff pane shows:

- path and status;
- a clear `Binary content is not rendered` message;
- no hunk navigation;
- no crash or empty-looking pane.

### Shiki fallback policy

Do not add Shiki in the initial implementation. Pi's `highlightCode()` already provides language-aware, theme-compatible terminal output without introducing another highlighter, grammar bundle, or color-theme mapping.

Keep highlighting behind `src/ui/diff-renderer.ts` so Shiki remains a contained fallback if testing proves Pi's existing highlighter materially inadequate. Before adopting Shiki, document specific failures such as unsupported required languages, incorrect multiline tokenization, or unacceptable highlighting quality. Any Shiki renderer would need explicit light/dark Pi theme integration and should not change viewer navigation or the line-row model.

## Command integration

### Interactive TUI

Replace the current synchronous `AppendDiffEntry` callback with an asynchronous review callback, for example:

```ts
type ReviewDiff = (diff: SnapshotDiff) => Promise<void>;
```

The `/pisync diff` command will:

1. load local and target snapshots as it does today;
2. build `SnapshotDiff`;
3. show the no-diff notification when there are no changed files;
4. await the interactive viewer in TUI mode;
5. append a compact transcript summary after the viewer closes.

The full `SnapshotDiff` used by the viewer remains transient and is not appended to the session.

### Transcript summary and legacy entries

Reuse the `pisync-diff` custom entry type with a compact summary data shape for new entries, such as:

```ts
type SnapshotDiffSummary = {
  target: string;
  changedFiles: number;
};
```

Change the entry renderer so it accepts both:

- legacy entries containing a full `SnapshotDiff`;
- new compact summary entries.

Both render only a concise line, for example:

```text
pi-sync diff viewed: 4 changed files against main
```

This means reloading an older session also collapses previously persisted giant diffs instead of continuing to render them.

### Non-TUI modes

Keep current behavior unchanged:

- RPC, print, and JSON-compatible command paths do not open the custom viewer;
- `/pisync diff` continues to return the textual `git diff --no-index` representation where applicable;
- no TUI-only summary entry is appended.

## Remove `/pisync changes`

Remove the subcommand completely rather than retaining an alias.

Update:

- `src/commands/commands.ts`
  - remove the `changes` switch branch;
  - remove the `changes()` command implementation;
  - retain shared helpers still used by verbose status.
- `src/commands/args.ts`
  - remove `changes` from usage text.
- `src/commands/completions.ts`
  - remove the `changes` completion item;
  - keep `changes` as a search keyword for `status` or `diff` where useful.
- `README.md`
  - remove the quick-start invocation;
  - remove the command-table row;
  - describe the interactive file-tree viewer and navigation keys.
- Tests
  - ensure `changes` is no longer advertised;
  - ensure invoking it follows the standard unknown-command path.

Do not remove the changed-path calculations used by `/pisync status --verbose` or footer drift reporting.

## Testing strategy

### Unit tests: viewer model

Cover:

- initial selection and tree focus;
- immediate preview when selection moves;
- `Enter` moving tree focus into the diff pane;
- `Esc` returning diff focus to the tree;
- `Esc` closing only when already in the tree;
- `q` and `Ctrl+C` closing from either pane;
- vertical line, page, top, and bottom scrolling;
- horizontal scrolling and boundary clamping;
- next/previous hunk navigation;
- hunk navigation wrapping or boundary behavior, whichever is selected during implementation;
- per-file scroll-position preservation;
- tree viewport tracking the selected file;
- empty, single-file, binary, added, modified, and deleted cases.

### Unit tests: rendering

Cover:

- deterministic path-tree rows and indentation;
- wide side-by-side layout;
- narrow stacked layout;
- status markers and selected/focused styling;
- visible line width never exceeding the requested width;
- viewport output never exceeding the calculated height;
- ANSI-safe horizontal slicing;
- binary placeholder rendering;
- hunk indexes aligning with rendered line indexes;
- language detection for representative synced formats such as TypeScript, JSON, YAML, and Markdown;
- full-file old/new highlighting preserving multiline syntax state;
- removed rows sourcing old-file tokens and added/context rows sourcing new-file tokens;
- syntax-colored code remaining intact beside diff-colored gutters;
- intra-line inverse emphasis coexisting with syntax foreground colors;
- unsupported-language and highlighter-error fallback behavior;
- invalidation rebuilding theme-derived cached content.

### Command tests

Cover:

- TUI mode awaits the viewer callback and does not emit raw text;
- no-diff behavior does not open the viewer;
- optional historical commit target still works;
- missing commit-ish still reports the existing error;
- non-TUI modes retain textual diff output;
- `/pisync changes` is unknown;
- usage and completion no longer list `changes`;
- legacy and new `pisync-diff` entry data both render compactly.

### Manual acceptance checks

Run the local extension with:

```bash
cd /home/rdmm123/ai/pi-sync
pi -e .
```

Verify `/pisync diff` with:

- one changed file;
- several files in nested directories;
- a file longer than the viewport;
- long lines requiring horizontal scroll;
- several separated hunks;
- added and deleted files;
- syntax-highlighted TypeScript, JSON, YAML, and Markdown changes;
- multiline comments or strings spanning displayed diff rows;
- an unknown file extension to confirm graceful plain-text fallback;
- a binary file;
- no changes;
- a historical commit-ish;
- terminal resizing while the viewer is open;
- both Pi dark and light themes.

Also verify that old transcript diff entries become compact after `/reload`.

## Validation commands

Run before considering the implementation complete:

```bash
corepack yarn typecheck
corepack yarn lint
corepack yarn format:check
corepack yarn test:unit
corepack yarn test:integration
git diff --check
```

## Acceptance criteria

- `/pisync diff` opens a responsive interactive viewer in TUI mode.
- The viewer shows a file tree and only one file diff at a time.
- Moving tree selection immediately previews the highlighted file.
- `Enter` focuses the diff pane.
- `Esc` from the diff pane returns to the tree; `Esc` from the tree closes.
- Vertical scrolling works for long files.
- Horizontal scrolling works without wrapping or corrupting ANSI styles.
- Next/previous hunk navigation works reliably.
- Supported text files display Pi-theme-compatible syntax highlighting from the initial implementation.
- Diff status remains obvious through colored gutters without replacing syntax token colors.
- Highlighting preserves multiline grammar state by processing complete old/new source content.
- Unsupported languages and highlighting errors fall back safely to plain themed text.
- Binary changes have a clear placeholder.
- Closing the viewer leaves only a compact transcript summary.
- Previously stored full diff entries render as compact summaries after reload.
- Non-TUI textual diff behavior remains compatible.
- `/pisync changes` is removed from implementation, help, completions, documentation, and tests.
- Pi's existing `highlightCode()` and `getLanguageFromPath()` APIs are used initially; no Shiki dependency is added unless that evaluated implementation has documented shortcomings.
