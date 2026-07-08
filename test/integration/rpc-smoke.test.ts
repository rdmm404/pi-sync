import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

type Fixture = {
  root: string;
  laptopPiDir: string;
  desktopPiDir: string;
  remote: string;
  remoteWorktree: string;
};

type PendingRequest = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

class RpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private stderr = "";
  private readonly lines: string[] = [];

  constructor(private readonly piDir: string) {
    this.child = spawn("pi", ["--mode", "rpc", "-e", repoRoot], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: piDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on("exit", (code) => {
      const error = new Error(
        `pi RPC for ${this.piDir} exited with ${code ?? "signal"}: ${this.stderr}\n${this.lines.join("\n")}`,
      );

      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  async prompt(message: string): Promise<void> {
    await this.request({ type: "prompt", message });
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("RPC client closing"));
    }
    this.pending.clear();

    this.child.kill();
  }

  private async request(payload: Record<string, unknown>): Promise<void> {
    const id = randomUUID();
    const message = { id, ...payload };

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out waiting for RPC response ${JSON.stringify(payload)}\n${this.lines.slice(-100).join("\n")}`,
          ),
        );
      }, 90_000);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;

    for (;;) {
      const newline = this.buffer.indexOf("\n");

      if (newline === -1) {
        return;
      }

      const line = this.buffer.slice(0, newline).trimEnd();
      this.buffer = this.buffer.slice(newline + 1);

      if (line === "") {
        continue;
      }

      this.lines.push(line);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let event: Record<string, unknown>;

    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (event.type === "extension_ui_request" && event.method === "confirm") {
      this.child.stdin.write(
        `${JSON.stringify({
          type: "extension_ui_response",
          id: event.id,
          confirmed: true,
        })}\n`,
      );

      return;
    }

    if (event.type === "extension_error") {
      const error = new Error(String(event.error ?? "extension error"));

      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();

      return;
    }

    if (event.type !== "response" || typeof event.id !== "string") {
      return;
    }

    const pending = this.pending.get(event.id);

    if (pending == null) {
      return;
    }

    this.pending.delete(event.id);
    clearTimeout(pending.timer);

    if (event.success === true) {
      pending.resolve();
    } else {
      pending.reject(new Error(String(event.error ?? "RPC request failed")));
    }
  }
}

function commandExists(command: string): boolean {
  try {
    execFileSync("/usr/bin/env", ["bash", "-lc", `command -v ${command}`], {
      stdio: "ignore",
    });

    return true;
  } catch {
    return false;
  }
}

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);

    return true;
  } catch {
    return false;
  }
}

async function assertFile(filePath: string): Promise<void> {
  assert.equal(await pathExists(filePath), true, `missing file: ${filePath}`);
}

async function assertNoPath(filePath: string): Promise<void> {
  assert.equal(await pathExists(filePath), false, `unexpected path exists: ${filePath}`);
}

async function assertContains(filePath: string, text: string): Promise<void> {
  assert.match(await readFile(filePath, "utf8"), new RegExp(escapeRegExp(text)));
}

async function assertNotContains(filePath: string, text: string): Promise<void> {
  if (!(await pathExists(filePath))) {
    return;
  }

  assert.doesNotMatch(await readFile(filePath, "utf8"), new RegExp(escapeRegExp(text)));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeConfig(directory: string, remote: string, excludePaths: string[]): Promise<void> {
  await writeJson(path.join(directory, "pi-sync.json"), {
    repository: remote,
    branch: "main",
    autoSync: false,
    policy: {
      includeDefaults: true,
      includePaths: [],
      excludePaths,
    },
  });
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-sync-rpc-smoke-"));
  const laptopPiDir = path.join(root, "laptop-pi-dir");
  const desktopPiDir = path.join(root, "desktop-pi-dir");
  const remote = path.join(root, "remote.git");
  const remoteWorktree = path.join(root, "remote-worktree");

  await mkdir(laptopPiDir, { recursive: true });
  await mkdir(desktopPiDir, { recursive: true });
  git(["init", "--bare", remote]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);
  await writeConfig(laptopPiDir, remote, ["extensions/work-only.ts"]);
  await writeConfig(desktopPiDir, remote, ["extensions/work-only.ts"]);

  return { root, laptopPiDir, desktopPiDir, remote, remoteWorktree };
}

const hasPi = commandExists("pi");

test("pi-sync RPC smoke flow", { skip: hasPi ? false : "pi CLI not found" }, async (t) => {
  const fixture = await createFixture();
  const laptop = new RpcClient(fixture.laptopPiDir);
  const desktop = new RpcClient(fixture.desktopPiDir);

  t.after(async () => {
    await laptop.close();
    await desktop.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  await t.test("laptop push sanitizes settings and respects policy excludes", async () => {
    await mkdir(path.join(fixture.laptopPiDir, "extensions"));
    await mkdir(path.join(fixture.laptopPiDir, "prompts"));
    await writeJson(path.join(fixture.laptopPiDir, "settings.json"), {
      lastChangelogVersion: "999.0.0",
      theme: "personal",
      packages: ["npm:is-odd", "/Users/example/local-only-package"],
    });
    await writeFile(path.join(fixture.laptopPiDir, "extensions/dummy.ts"), "export default () => {};\n");
    await writeFile(path.join(fixture.laptopPiDir, "extensions/work-only.ts"), "export default () => {};\n");
    await writeFile(path.join(fixture.laptopPiDir, "prompts/hello.md"), "hello prompt\n");

    await laptop.prompt("/pisync push --yes");
    git(["clone", fixture.remote, fixture.remoteWorktree]);

    await assertFile(path.join(fixture.remoteWorktree, "settings.json"));
    await assertFile(path.join(fixture.remoteWorktree, "extensions/dummy.ts"));
    await assertFile(path.join(fixture.remoteWorktree, "prompts/hello.md"));
    await assertNoPath(path.join(fixture.remoteWorktree, "extensions/work-only.ts"));
    await assertNotContains(path.join(fixture.remoteWorktree, "settings.json"), "lastChangelogVersion");
    await assertContains(path.join(fixture.remoteWorktree, "settings.json"), "npm:is-odd");
    await assertNotContains(path.join(fixture.remoteWorktree, "settings.json"), "/Users/example/local-only-package");
  });

  await t.test("desktop pull merges settings and preserves excluded local paths", async () => {
    await mkdir(path.join(fixture.desktopPiDir, "extensions"), { recursive: true });
    await writeFile(path.join(fixture.desktopPiDir, "extensions/work-only.ts"), "export default () => {};\n");
    await writeJson(path.join(fixture.desktopPiDir, "settings.json"), {
      lastChangelogVersion: "local-version",
      packages: ["/tmp/local-b-package"],
    });

    await desktop.prompt("/pisync pull --yes --force");

    await assertFile(path.join(fixture.desktopPiDir, "extensions/dummy.ts"));
    await assertFile(path.join(fixture.desktopPiDir, "prompts/hello.md"));
    await assertFile(path.join(fixture.desktopPiDir, "extensions/work-only.ts"));
    await assertContains(path.join(fixture.desktopPiDir, "settings.json"), "local-version");
    await assertContains(path.join(fixture.desktopPiDir, "settings.json"), "/tmp/local-b-package");
    await assertContains(path.join(fixture.desktopPiDir, "settings.json"), "npm:is-odd");
  });

  await t.test("remote repository changes can be pulled by laptop", async () => {
    await writeFile(path.join(fixture.remoteWorktree, "prompts/remote.md"), "remote changed prompt\n");
    git(["add", "prompts/remote.md"], fixture.remoteWorktree);
    git([
      "-c",
      "user.name=Smoke Test",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "-m",
      "remote prompt change",
    ], fixture.remoteWorktree);
    git(["push", "origin", "main"], fixture.remoteWorktree);

    await laptop.prompt("/pisync pull --yes --force");
    await assertFile(path.join(fixture.laptopPiDir, "prompts/remote.md"));
  });

  await t.test("laptop symlinks are skipped on push", async () => {
    await symlink("/tmp", path.join(fixture.laptopPiDir, "extensions/symlinked"));
    await laptop.prompt("/pisync push --yes --force");
    git(["pull", "--ff-only"], fixture.remoteWorktree);

    await assertNoPath(path.join(fixture.remoteWorktree, "extensions/symlinked"));
  });

  await t.test("hard denied paths win over explicit includes", async () => {
    await writeJson(path.join(fixture.laptopPiDir, "pi-sync.json"), {
      repository: fixture.remote,
      branch: "main",
      autoSync: false,
      policy: {
        includeDefaults: false,
        includePaths: [".pisync", "pi-sync.json", ".env", "node_modules", "settings.json"],
        excludePaths: [],
      },
    });
    await mkdir(path.join(fixture.laptopPiDir, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(fixture.laptopPiDir, ".env"), "SECRET=bad\n");
    await writeFile(path.join(fixture.laptopPiDir, "node_modules/pkg/index.js"), "module\n");

    await laptop.prompt("/pisync push --yes --force");
    await rm(fixture.remoteWorktree, { recursive: true, force: true });
    git(["clone", fixture.remote, fixture.remoteWorktree]);

    await assertFile(path.join(fixture.remoteWorktree, "settings.json"));
    await assertNoPath(path.join(fixture.remoteWorktree, ".env"));
    await assertNoPath(path.join(fixture.remoteWorktree, "node_modules"));
    await assertNoPath(path.join(fixture.remoteWorktree, "pi-sync.json"));
    await assertNoPath(path.join(fixture.remoteWorktree, ".pisync"));
  });
});
