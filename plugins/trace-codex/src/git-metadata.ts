import { spawnSync } from "node:child_process";

export interface GitMetadata {
  git_origin_url?: string;
  git_branch?: string;
  git_commit_sha?: string;
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: 500,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function redactGitRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function gitMetadataForCwd(cwd: string | undefined): GitMetadata {
  if (!cwd) return {};

  const origin = runGit(cwd, ["remote", "get-url", "origin"]);
  const branch = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const commit = runGit(cwd, ["rev-parse", "HEAD"]);

  return {
    ...(origin ? { git_origin_url: redactGitRemoteUrl(origin) } : {}),
    ...(branch ? { git_branch: branch } : {}),
    ...(commit ? { git_commit_sha: commit } : {}),
  };
}
