// Compile the `codex-hook` binary.
//
// The Codex hook command invokes a single, fixed-name binary:
//   ${PLUGIN_ROOT}/bin/codex-hook
// (no shell, no uname, no per-platform command string). So the build always
// produces that fixed-name binary for the HOST platform.
//
// For distribution we additionally emit per-platform named binaries
// (codex-hook-<os>-<arch>). A future prebuilt-distribution flow can ship all of
// them and select the right one at install time; for build-on-install we only
// need the host binary.
//
// Supported targets: macOS (arm64, x64) and Linux (x64, arm64). Windows is
// not yet built but slots in cleanly (bun-windows-x64 -> codex-hook.exe,
// referenced via a `commandWindows` entry in hooks.json).

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src/index.ts");
const OUT_DIR = join(ROOT, "bin");

/** Fixed name the Codex hook command invokes. */
const HOST_BINARY_NAME = "codex-hook";

interface Target {
  /** Bun --target value. */
  bunTarget: string;
  /** Output suffix: <os>-<arch>. */
  suffix: string;
}

const TARGETS: Target[] = [
  { bunTarget: "bun-darwin-arm64", suffix: "darwin-arm64" },
  { bunTarget: "bun-darwin-x64", suffix: "darwin-x64" },
  { bunTarget: "bun-linux-x64", suffix: "linux-x64" },
  { bunTarget: "bun-linux-arm64", suffix: "linux-arm64" },
  // Future: { bunTarget: "bun-windows-x64", suffix: "windows-x64.exe" },
];

function hostTargetSuffix(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

async function compile(bunTarget: string, outfile: string): Promise<void> {
  process.stderr.write(`building ${bunTarget} -> ${outfile}\n`);
  await $`bun build ${ENTRY} --compile --target=${bunTarget} --outfile ${outfile}`.quiet();
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const hostSuffix = hostTargetSuffix();
  const hostOnly = process.env.BUILD_HOST_ONLY === "1";
  const targets = hostOnly ? TARGETS.filter((t) => t.suffix === hostSuffix) : TARGETS;

  for (const target of targets) {
    const outfile = join(OUT_DIR, `codex-hook-${target.suffix}`);
    await compile(target.bunTarget, outfile);
  }

  // Always provide the fixed-name host binary the hook command points at.
  const hostNamed = join(OUT_DIR, `codex-hook-${hostSuffix}`);
  const hostFixed = join(OUT_DIR, HOST_BINARY_NAME);
  copyFileSync(hostNamed, hostFixed);
  process.stderr.write(`host binary: ${hostFixed}\n`);

  process.stderr.write(`done: built ${targets.length} target(s)\n`);
}

main().catch((err) => {
  process.stderr.write(`build failed: ${err}\n`);
  process.exit(1);
});
