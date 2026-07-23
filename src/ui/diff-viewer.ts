import {
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  sliceByColumn,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { SnapshotDiff, SnapshotDiffFile } from "../snapshot/diff.js";
import { type DiffRenderRow, sliceRenderedRow } from "./diff-renderer.js";
import { DiffViewerModel, type TreeRow } from "./diff-viewer-model.js";

const MIN_WIDE_WIDTH = 90;

/** Open the interactive, transient diff viewer. */
export async function openDiffViewer(
  ctx: ExtensionCommandContext,
  diff: SnapshotDiff,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new DiffViewer(
        tui,
        theme,
        diff.files,
        diff.remote.target ?? diff.remote.id ?? "empty remote",
        () => done(),
      ),
    {
      overlay: true,
      overlayOptions: () => ({
        width: "95%",
        maxHeight: "90%",
        anchor: "center",
        margin: 1,
      }),
    },
  );
}

class DiffViewer implements Component {
  private readonly model: DiffViewerModel;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    files: SnapshotDiffFile[],
    private readonly target: string,
    private readonly close: () => void,
  ) {
    this.model = new DiffViewerModel(files);
  }

  render(width: number): string[] {
    const height = viewerHeight(this.tui.terminal.rows);
    const innerHeight = Math.max(3, height - 2);
    const wide = width >= MIN_WIDE_WIDTH;
    const lines = wide
      ? this.renderWide(width, innerHeight)
      : this.renderNarrow(width, innerHeight);

    return [
      this.frameLine(width, ` pi-sync diff: ${this.targetLabel()} `, "╭", "╮"),
      ...lines,
      this.frameLine(width, this.footerText(), "╰", "╯"),
    ];
  }

  handleInput(data: string): void {
    if (this.model.handleInput(data) === "close") {
      this.close();
      return;
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.model.refresh();
    this.tui.requestRender();
  }

  private renderWide(width: number, height: number): string[] {
    const availableWidth = Math.max(1, width - 3);
    const maxTreeWidth = Math.floor(availableWidth * 0.42);
    const treeContentWidth = this.model.treeRows.reduce(
      (longest, row) => Math.max(longest, row.depth * 2 + row.label.length + 6),
      0,
    );
    const leftWidth = Math.min(
      maxTreeWidth,
      Math.max(20, treeContentWidth + 2),
    );
    const rightWidth = Math.max(1, availableWidth - leftWidth);
    const diffViewport = Math.max(1, height - 1);
    this.model.setDimensions(height, diffViewport, rightWidth);
    const lines: string[] = [];

    for (let index = 0; index < height; index++) {
      const left = this.treeLine(index, leftWidth);
      const right = this.fit(
        this.diffLine(index, rightWidth, diffViewport),
        rightWidth,
      );
      lines.push(`│${left}│${right}│`);
    }

    return lines;
  }

  private renderNarrow(width: number, height: number): string[] {
    const treeHeight = Math.max(
      2,
      Math.min(this.model.treeRows.length, Math.floor(height * 0.25)),
    );
    const diffViewport = Math.max(1, height - treeHeight - 1);
    this.model.setDimensions(treeHeight, diffViewport, width - 2);
    const lines: string[] = [];

    for (let index = 0; index < treeHeight; index++) {
      lines.push(`│${this.fit(this.treeLine(index, width - 2), width - 2)}│`);
    }
    lines.push(
      this.frameLine(width, ` ${this.selectedTitle()} `, "│", "│", " "),
    );
    for (let index = 0; index < diffViewport; index++) {
      lines.push(
        `│${this.fit(this.diffLine(index + 1, width - 2, diffViewport), width - 2)}│`,
      );
    }

    return lines.slice(0, height);
  }

  private treeLine(index: number, width: number): string {
    const row = this.model.treeRows[this.model.treeOffset + index] as
      | TreeRow
      | undefined;
    if (row == null) {
      return " ".repeat(width);
    }

    const isSelected = row.fileIndex === this.model.selectedFile;
    const indent = "  ".repeat(row.depth);
    let content: string;
    if (row.fileIndex == null) {
      content = `${indent}▾ ${row.label}/`;
      content = this.theme.fg("muted", content);
    } else {
      const file = this.model.files[row.fileIndex].file;
      const marker = statusMarker(file);
      content = `${isSelected ? "❯" : " "} ${marker} ${indent}${row.label}`;
      content = this.theme.fg(statusColor(file), content);
    }

    if (isSelected) {
      content = this.theme.bg("selectedBg", content);
    }
    return this.fit(content, width);
  }

  private diffLine(index: number, width: number, _viewport: number): string {
    const selected = this.model.selected;
    if (index === 0) {
      return this.fit(this.selectedTitle(), width);
    }
    if (selected == null) {
      return " ".repeat(width);
    }
    if (selected.file.kind === "binary") {
      return this.fit(
        this.theme.fg("muted", "Binary content is not rendered."),
        width,
      );
    }

    const rowIndex = this.model.selectedState.verticalOffset + index - 1;
    const row = selected.prepared?.rows[rowIndex];
    if (row == null) {
      return " ".repeat(width);
    }

    return this.renderDiffRow(
      row,
      rowIndex,
      selected.prepared?.rows ?? [],
      width,
    );
  }

  private renderDiffRow(
    row: DiffRenderRow,
    rowIndex: number,
    rows: DiffRenderRow[],
    width: number,
  ): string {
    if (row.kind === "gap") {
      return this.fit(this.theme.fg("muted", "        ..."), width);
    }

    const lineNumber = row.kind === "removed" ? row.oldLine : row.newLine;
    const number =
      lineNumber == null ? "  " : String(lineNumber).padStart(5, " ");
    const marker =
      row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
    const gutter = this.theme.fg(
      row.kind === "added"
        ? "toolDiffAdded"
        : row.kind === "removed"
          ? "toolDiffRemoved"
          : "toolDiffContext",
      `${marker}${number} `,
    );
    const next = rows[rowIndex + 1];
    const previous = rows[rowIndex - 1];
    const content = replacementContent(
      row,
      row.kind === "removed" ? next : previous,
      this.theme,
    );
    const styled = `${gutter}${content}`;
    const visible = sliceRenderedRow(
      styled,
      this.model.selectedState.horizontalOffset,
      width,
    );
    const fitted = this.fit(visible, width);
    return row.kind === "added" || row.kind === "removed"
      ? semanticDiffBackground(
          this.theme,
          row.kind === "added" ? "toolDiffAdded" : "toolDiffRemoved",
          fitted,
        )
      : fitted;
  }

  private selectedTitle(): string {
    const selected = this.model.selected?.file;
    if (selected == null) {
      return "No changed files";
    }
    const binary = selected.kind === "binary" ? " • binary" : "";
    return `${statusMarker(selected)} ${selected.path} • ${selected.status}${binary}`;
  }

  private targetLabel(): string {
    const files = `${this.model.files.length} changed file${this.model.files.length === 1 ? "" : "s"}`;
    return `${this.target} → local • ${files}`;
  }

  private footerText(): string {
    return this.model.focus === "tree"
      ? " Tree: ↑↓ preview • Enter/Tab diff • Esc close • q close "
      : " Diff: ↑↓ scroll • PgUp/PgDn page • n/N hunk • h/l scroll • Esc tree • q close ";
  }

  private frameLine(
    width: number,
    content: string,
    left: string,
    right: string,
    fill = "─",
  ): string {
    const inner = Math.max(0, width - 2);
    const visibleContent = truncateToWidth(content, inner, "", false);
    const remaining = Math.max(0, inner - visibleWidth(visibleContent));
    return `${this.theme.fg("border", left)}${visibleContent}${fill.repeat(remaining)}${this.theme.fg("border", right)}`;
  }

  private fit(text: string, width: number): string {
    return truncateToWidth(text, Math.max(0, width), "", true);
  }
}

function replacementContent(
  row: DiffRenderRow,
  pair: DiffRenderRow | undefined,
  theme: Theme,
): string {
  if (
    pair == null ||
    (row.kind !== "removed" && row.kind !== "added") ||
    (row.kind === "removed" && pair.kind !== "added") ||
    (row.kind === "added" && pair.kind !== "removed")
  ) {
    return row.highlightedContent;
  }

  const left = row.kind === "removed" ? row : pair;
  const right = row.kind === "added" ? row : pair;
  const prefix = commonPrefix(left.plainContent, right.plainContent);
  const suffix = commonSuffix(left.plainContent, right.plainContent, prefix);
  const contentLength = row.plainContent.length;
  const changedLength = Math.max(0, contentLength - prefix - suffix);
  if (changedLength === 0) {
    return row.highlightedContent;
  }

  const styled = row.highlightedContent;
  const before = sliceByColumn(styled, 0, prefix, true);
  const changed = sliceByColumn(styled, prefix, changedLength, true);
  const after = sliceByColumn(
    styled,
    prefix + changedLength,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  return `${before}${theme.inverse(changed)}${after}`;
}

function commonPrefix(left: string, right: string): number {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  ) {
    index++;
  }
  return index;
}

function commonSuffix(left: string, right: string, prefix: number): number {
  let index = 0;
  while (
    index < left.length - prefix &&
    index < right.length - prefix &&
    left[left.length - index - 1] === right[right.length - index - 1]
  ) {
    index++;
  }
  return index;
}

function viewerHeight(rows: number): number {
  return Math.max(6, Math.min(Math.max(6, rows - 2), Math.floor(rows * 0.9)));
}

function semanticDiffBackground(
  theme: Theme,
  color: "toolDiffAdded" | "toolDiffRemoved",
  text: string,
): string {
  const foreground = theme.getFgAnsi(color);
  const escape = String.fromCharCode(27);
  const rgb = new RegExp(`${escape}\\[38;2;(\\d+);(\\d+);(\\d+)m`).exec(
    foreground,
  );

  if (rgb != null) {
    const [, red, green, blue] = rgb;
    const background = `\u001b[48;2;${toneColor(Number(red))};${toneColor(Number(green))};${toneColor(Number(blue))}m`;
    return `${background}${text}\u001b[49m`;
  }

  const background = foreground.replace("[38;", "[48;");
  if (background !== foreground) {
    return `${background}${text}\u001b[49m`;
  }

  return `\u001b[2m${theme.fg(color, stripAnsi(text))}\u001b[22m`;
}

function toneColor(value: number): number {
  const neutral = 24;
  return Math.round(neutral + (value - neutral) * 0.32);
}

function stripAnsi(text: string): string {
  const escape = String.fromCharCode(27);
  return text.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");
}

function statusMarker(file: SnapshotDiffFile): string {
  return file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M";
}

function statusColor(file: SnapshotDiffFile): "success" | "error" | "warning" {
  return file.status === "added"
    ? "success"
    : file.status === "deleted"
      ? "error"
      : "warning";
}
