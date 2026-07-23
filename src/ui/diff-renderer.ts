import {
  getLanguageFromPath,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import { sliceByColumn } from "@earendil-works/pi-tui";

import type { SnapshotDiffFile } from "../snapshot/diff.js";

export type DiffRenderRow = {
  kind: "added" | "removed" | "context" | "gap";
  oldLine?: number;
  newLine?: number;
  plainContent: string;
  highlightedContent: string;
  hunkIndex?: number;
};

export type PreparedDiffFile = {
  rows: DiffRenderRow[];
  hunkStarts: number[];
  language?: string;
};

const DIFF_LINE = /^([+\- ])(\s*\d*) (.*)$/;

/** Prepare one display diff with syntax-highlighted source lines. */
export function prepareDiffFile(
  file: SnapshotDiffFile,
): PreparedDiffFile | undefined {
  if (file.kind !== "text") {
    return undefined;
  }

  const language = getLanguageFromPath(file.path);
  const oldLines = highlightedLines(file.oldText, language);
  const newLines = highlightedLines(file.newText, language);
  const rows: DiffRenderRow[] = [];
  const hunkStarts: number[] = [];
  let hunkIndex = -1;
  let hunkOpen = false;

  for (const rawLine of file.diff.split("\n")) {
    if (/^ \s+\.\.\.$/.test(rawLine)) {
      rows.push({
        kind: "gap",
        plainContent: "...",
        highlightedContent: "...",
      });
      hunkOpen = false;
      continue;
    }

    const parsed = parseDiffLine(rawLine);

    if (parsed == null) {
      rows.push({
        kind: "context",
        plainContent: rawLine,
        highlightedContent: rawLine,
      });
      continue;
    }

    if (parsed.content === "..." && parsed.prefix === " ") {
      rows.push({
        kind: "gap",
        plainContent: "...",
        highlightedContent: "...",
      });
      hunkOpen = false;
      continue;
    }

    const changed = parsed.prefix === "+" || parsed.prefix === "-";
    if (changed && !hunkOpen) {
      hunkIndex++;
      hunkStarts.push(rows.length);
      hunkOpen = true;
    }
    const lineNumber = parsed.lineNumber;
    const isRemoved = parsed.prefix === "-";
    const highlightedContent = isRemoved
      ? lineAt(oldLines, lineNumber, parsed.content)
      : lineAt(newLines, lineNumber, parsed.content);

    rows.push({
      kind: isRemoved ? "removed" : parsed.prefix === "+" ? "added" : "context",
      ...(isRemoved ? { oldLine: lineNumber } : { newLine: lineNumber }),
      plainContent: parsed.content,
      highlightedContent,
      ...(hunkIndex >= 0 ? { hunkIndex } : {}),
    });
  }

  return { rows, hunkStarts, ...(language == null ? {} : { language }) };
}

/** ANSI-safe horizontal viewport for a prepared row. */
export function sliceRenderedRow(
  row: string,
  horizontalOffset: number,
  width: number,
): string {
  return sliceByColumn(row, horizontalOffset, Math.max(0, width), true);
}

function parseDiffLine(
  line: string,
):
  | { prefix: "+" | "-" | " "; lineNumber: number; content: string }
  | undefined {
  const match = DIFF_LINE.exec(line);
  if (match == null) {
    return undefined;
  }

  const lineNumber = Number.parseInt(match[2].trim(), 10);
  if (!Number.isFinite(lineNumber)) {
    return undefined;
  }

  return {
    prefix: match[1] as "+" | "-" | " ",
    lineNumber,
    content: replaceTabs(match[3]),
  };
}

function highlightedLines(
  text: string,
  language: string | undefined,
): string[] {
  const normalized = replaceTabs(text);
  try {
    const result = highlightCode(normalized, language);
    return result.length > 0 ? result : normalized.split("\n");
  } catch {
    try {
      return highlightCode(normalized);
    } catch {
      return normalized.split("\n");
    }
  }
}

function lineAt(lines: string[], lineNumber: number, fallback: string): string {
  return lines[lineNumber - 1] ?? fallback;
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}
