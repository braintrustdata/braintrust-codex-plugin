import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitMetadataForCwd, redactGitRemoteUrl } from "./git-metadata.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeGitRepo(): { dir: string; commit: string } {
  const dir = makeTempDir("codex-git-metadata-");
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://token@github.com/acme/app.git"], {
    cwd: dir,
  });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { dir, commit };
}

describe("git metadata", () => {
  test("redacts credentials from URL-style remotes", () => {
    expect(redactGitRemoteUrl("https://token:secret@github.com/acme/app.git")).toBe(
      "https://github.com/acme/app.git",
    );
  });

  test("keeps scp-like SSH remotes intact", () => {
    expect(redactGitRemoteUrl("git@github.com:acme/app.git")).toBe("git@github.com:acme/app.git");
  });

  test("captures origin, branch, and commit", () => {
    const repo = makeGitRepo();

    expect(gitMetadataForCwd(repo.dir)).toEqual({
      git_origin_url: "https://github.com/acme/app.git",
      git_branch: "main",
      git_commit_sha: repo.commit,
    });
  });

  test("omits branch for detached HEAD", () => {
    const repo = makeGitRepo();
    execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: repo.dir, stdio: "ignore" });

    expect(gitMetadataForCwd(repo.dir)).toEqual({
      git_origin_url: "https://github.com/acme/app.git",
      git_commit_sha: repo.commit,
    });
  });

  test("omits all fields outside a git repo", () => {
    expect(gitMetadataForCwd(makeTempDir("codex-not-git-"))).toEqual({});
  });
});
