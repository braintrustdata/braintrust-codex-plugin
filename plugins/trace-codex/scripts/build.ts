// Compile the `codex-hook` binary.
//
// Two steps:
//   1. tsup bundles src/index.ts into a single self-contained CommonJS file
//      (dist/codex-hook.cjs), inlining the `braintrust` dependency and the
//      plugin.json version so the binary needs no node_modules at runtime.
//   2. @yao-pkg/pkg wraps that bundle plus a Node runtime into a standalone
//      executable per target (it downloads/caches base binaries, so it can
//      cross-compile every target from one host).
//
// The Codex hook command invokes a single, fixed-name binary:
//   ${PLUGIN_ROOT}/bin/codex-hook
// (no shell, no uname, no per-platform command string). So the build always
// produces that fixed-name binary for the HOST platform.
//
// For distribution we additionally emit per-platform named binaries
// (codex-hook-<os>-<arch>); the launcher downloads the matching one.
//
// Supported targets: macOS (arm64, x64) and Linux (x64, arm64). Windows is
// not yet built but slots in cleanly (pkg target node22-win-x64 -> a
// codex-hook.exe, referenced via a `commandWindows` entry in hooks.json).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "dist/codex-hook.cjs");
const OUT_DIR = join(ROOT, "bin");
const bin = (name: string): string => join(ROOT, "node_modules/.bin", name);

/** Node runtime version pkg wraps into the produced binaries. */
const NODE_RANGE = "node22";

/** Fixed name the Codex hook command invokes. */
const HOST_BINARY_NAME = "codex-hook";

interface Target {
  /** pkg platform-arch selector, e.g. "macos-arm64". */
  pkgPlatform: string;
  /** Output suffix: <os>-<arch>. */
  suffix: string;
}

const TARGETS: Target[] = [
  { pkgPlatform: "macos-arm64", suffix: "darwin-arm64" },
  { pkgPlatform: "macos-x64", suffix: "darwin-x64" },
  { pkgPlatform: "linux-x64", suffix: "linux-x64" },
  { pkgPlatform: "linux-arm64", suffix: "linux-arm64" },
  // Future: { pkgPlatform: "win-x64", suffix: "windows-x64.exe" },
];

function hostTargetSuffix(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

function run(cmd: string, args: string[]): void {
  process.stderr.write(`$ ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT });
}

function bundle(): void {
  process.stderr.write("bundling src/index.ts -> dist/codex-hook.cjs (tsup)\n");
  run(bin("tsup"), []);
}

function compile(pkgPlatform: string, outfile: string): void {
  process.stderr.write(`building ${pkgPlatform} -> ${outfile}\n`);
  run(bin("pkg"), [BUNDLE, "--targets", `${NODE_RANGE}-${pkgPlatform}`, "--output", outfile]);
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  // Bundle once; pkg then wraps the same bundle for each target.
  bundle();

  const hostSuffix = hostTargetSuffix();
  const hostOnly = process.env.BUILD_HOST_ONLY === "1";
  const targets = hostOnly ? TARGETS.filter((t) => t.suffix === hostSuffix) : TARGETS;

  for (const target of targets) {
    const outfile = join(OUT_DIR, `codex-hook-${target.suffix}`);
    compile(target.pkgPlatform, outfile);
  }

  // Always provide the fixed-name host binary the hook command points at.
  const hostNamed = join(OUT_DIR, `codex-hook-${hostSuffix}`);
  const hostFixed = join(OUT_DIR, HOST_BINARY_NAME);
  copyFileSync(hostNamed, hostFixed);
  process.stderr.write(`host binary: ${hostFixed}\n`);

  process.stderr.write(`done: built ${targets.length} target(s)\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`build failed: ${err}\n`);
  process.exit(1);
}
