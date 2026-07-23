import { matchesKey } from "@earendil-works/pi-tui";

import type { SnapshotDiffFile } from "../snapshot/diff.js";
import { type PreparedDiffFile, prepareDiffFile } from "./diff-renderer.js";

export type DiffPane = "tree" | "diff";

export type TreeRow = {
  label: string;
  depth: number;
  fileIndex?: number;
};

type FileState = {
  verticalOffset: number;
  horizontalOffset: number;
  hunkIndex: number;
};

export type ViewerFile = {
  file: SnapshotDiffFile;
  prepared?: PreparedDiffFile;
};

/** UI-independent state and keyboard navigation for the diff viewer. */
export class DiffViewerModel {
  readonly files: ViewerFile[];
  readonly treeRows: TreeRow[];
  focus: DiffPane = "tree";
  selectedFile = 0;
  treeOffset = 0;
  treeViewport = 1;
  diffViewport = 1;
  diffWidth = 1;
  private readonly fileStates: FileState[];

  constructor(files: SnapshotDiffFile[]) {
    this.files = files.map((file) => ({
      file,
      prepared: prepareDiffFile(file),
    }));
    this.treeRows = buildTreeRows(files);
    this.fileStates = files.map(() => ({
      verticalOffset: 0,
      horizontalOffset: 0,
      hunkIndex: 0,
    }));
  }

  get selected(): ViewerFile | undefined {
    return this.files[this.selectedFile];
  }

  get selectedState(): FileState {
    return (
      this.fileStates[this.selectedFile] ?? {
        verticalOffset: 0,
        horizontalOffset: 0,
        hunkIndex: 0,
      }
    );
  }

  refresh(): void {
    for (const viewerFile of this.files) {
      viewerFile.prepared = prepareDiffFile(viewerFile.file);
    }
    this.clampOffsets();
  }

  setDimensions(
    treeViewport: number,
    diffViewport: number,
    diffWidth: number,
  ): void {
    this.treeViewport = Math.max(1, treeViewport);
    this.diffViewport = Math.max(1, diffViewport);
    this.diffWidth = Math.max(1, diffWidth);
    this.clampOffsets();
    this.ensureTreeVisible();
  }

  handleInput(data: string): "close" | undefined {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      return "close";
    }

    if (this.focus === "tree") {
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        this.selectFile(this.selectedFile - 1);
      } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
        this.selectFile(this.selectedFile + 1);
      } else if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
        this.focus = "diff";
      } else if (matchesKey(data, "escape")) {
        return "close";
      }

      return undefined;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "shift+tab")) {
      this.focus = "tree";
    } else if (matchesKey(data, "tab")) {
      this.focus = "tree";
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scroll(-1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scroll(1);
    } else if (matchesKey(data, "pageUp")) {
      this.scroll(-this.diffViewport);
    } else if (matchesKey(data, "pageDown")) {
      this.scroll(this.diffViewport);
    } else if (matchesKey(data, "home") || matchesKey(data, "g")) {
      this.selectedState.verticalOffset = 0;
    } else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
      this.selectedState.verticalOffset = this.maxVerticalOffset();
    } else if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.selectedState.horizontalOffset = Math.max(
        0,
        this.selectedState.horizontalOffset - 4,
      );
    } else if (matchesKey(data, "right") || matchesKey(data, "l")) {
      this.selectedState.horizontalOffset = Math.min(
        this.maxHorizontalOffset(),
        this.selectedState.horizontalOffset + 4,
      );
    } else if (matchesKey(data, "n")) {
      this.jumpHunk(1);
    } else if (matchesKey(data, "shift+n")) {
      this.jumpHunk(-1);
    }

    this.clampOffsets();
    return undefined;
  }

  private selectFile(index: number): void {
    if (this.files.length === 0) {
      return;
    }

    this.selectedFile = Math.max(0, Math.min(this.files.length - 1, index));
    this.ensureTreeVisible();
  }

  private scroll(delta: number): void {
    this.selectedState.verticalOffset = Math.max(
      0,
      Math.min(
        this.maxVerticalOffset(),
        this.selectedState.verticalOffset + delta,
      ),
    );
  }

  private jumpHunk(delta: number): void {
    const starts = this.selected?.prepared?.hunkStarts ?? [];
    if (starts.length === 0) {
      return;
    }

    const next = Math.max(
      0,
      Math.min(starts.length - 1, this.selectedState.hunkIndex + delta),
    );
    this.selectedState.hunkIndex = next;
    this.selectedState.verticalOffset = Math.max(
      0,
      starts[next] - Math.min(2, this.diffViewport - 1),
    );
  }

  private maxVerticalOffset(): number {
    const rowCount = this.selected?.prepared?.rows.length ?? 1;
    return Math.max(0, rowCount - this.diffViewport);
  }

  private maxHorizontalOffset(): number {
    const rows = this.selected?.prepared?.rows ?? [];
    const longest = rows.reduce(
      (width, row) => Math.max(width, row.plainContent.length + 14),
      0,
    );
    return Math.max(0, longest - this.diffWidth);
  }

  private clampOffsets(): void {
    const hunkCount = this.selected?.prepared?.hunkStarts.length ?? 0;
    this.selectedState.hunkIndex = Math.min(
      this.selectedState.hunkIndex,
      Math.max(0, hunkCount - 1),
    );
    this.selectedState.verticalOffset = Math.min(
      this.selectedState.verticalOffset,
      this.maxVerticalOffset(),
    );
    this.selectedState.horizontalOffset = Math.min(
      this.selectedState.horizontalOffset,
      this.maxHorizontalOffset(),
    );
  }

  private ensureTreeVisible(): void {
    const selectedRow = this.treeRows.findIndex(
      (row) => row.fileIndex === this.selectedFile,
    );
    if (selectedRow < 0) {
      return;
    }

    if (selectedRow < this.treeOffset) {
      this.treeOffset = selectedRow;
    } else if (selectedRow >= this.treeOffset + this.treeViewport) {
      this.treeOffset = selectedRow - this.treeViewport + 1;
    }
    this.treeOffset = Math.max(
      0,
      Math.min(
        this.treeOffset,
        Math.max(0, this.treeRows.length - this.treeViewport),
      ),
    );
  }
}

export function buildTreeRows(files: SnapshotDiffFile[]): TreeRow[] {
  const rows: TreeRow[] = [];
  const directories = new Set<string>();

  files.forEach((file, fileIndex) => {
    const parts = file.path.split("/");
    let prefix = "";
    for (const part of parts.slice(0, -1)) {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      if (directories.has(prefix)) {
        continue;
      }
      directories.add(prefix);
      rows.push({ label: part, depth: prefix.split("/").length - 1 });
    }
    rows.push({
      label: parts.at(-1) ?? file.path,
      depth: parts.length - 1,
      fileIndex,
    });
  });

  return rows;
}
