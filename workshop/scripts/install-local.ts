#!/usr/bin/env bun
/**
 * scripts/install-local.ts — exercise the full customer install flow against
 * a binary built from your local checkout. No GitHub. No internet.
 *
 * What this proves end-to-end (Layer 3 in docs/releases.md terms):
 *   1. `bun scripts/build-bun.ts` produces a working host binary.
 *   2. macOS ad-hoc signature gate passes.
 *   3. `scripts/generate-manifest.ts` produces a parseable latest.json.
 *   4. `scripts/install.sh` correctly: detects platform, fetches manifest,
 *      sha256-verifies, atomically installs, prints the next-steps banner.
 *   5. The installed binary boots and answers /health.
 *
 * Usage:
 *   bun scripts/install-local.ts                   # full flow, isolated sandbox
 *   bun scripts/install-local.ts --no-build        # reuse existing build/bun/
 *   bun scripts/install-local.ts --keep            # leave HTTP mirror running
 *                                                    (useful to re-run install.sh by hand)
 *   bun scripts/install-local.ts --install-dir=DIR # override sandbox dir
 *                                                    (default: /tmp/raindrop-local/bin)
 *   bun scripts/install-local.ts --port=N          # daemon smoke-test port (default: 5912)
 *   bun scripts/install-local.ts --http-port=N     # local mirror port      (default: 8765)
 *   bun scripts/install-local.ts --channel=beta    # stable | beta          (default: beta)
 *   bun scripts/install-local.ts --skip-smoke      # skip the boot+/health check
 *   bun scripts/install-local.ts -h                # this help
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(REPO_ROOT, "build", "bun");

interface Args {
  noBuild: boolean;
  keep: boolean;
  installDir: string;
  port: number;
  httpPort: number;
  channel: "stable" | "beta";
  skipSmoke: boolean;
}

function parseArgs(): Args {
  const out: Args = {
    noBuild: false,
    keep: false,
    installDir: "/tmp/raindrop-local/bin",
    port: 5912,
    httpPort: 8765,
    channel: "beta",
    skipSmoke: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "-h" || a === "--help") {
      console.log(
        [
          "scripts/install-local.ts — install raindrop from local source for testing.",
          "",
          "USAGE",
          "    bun scripts/install-local.ts [OPTIONS]",
          "",
          "OPTIONS",
          "    --no-build              Reuse existing build/bun/ instead of recompiling.",
          "    --keep                  Leave the local HTTP mirror running after install.",
          "    --install-dir=DIR       Sandbox install path (default: /tmp/raindrop-local/bin).",
          "    --port=N                Daemon smoke-test port (default: 5912).",
          "    --http-port=N           Local mirror port      (default: 8765).",
          "    --channel=stable|beta   Channel to install     (default: beta).",
          "    --skip-smoke            Skip the boot + /health check after install.",
          "    -h, --help              This help.",
        ].join("\n"),
      );
      process.exit(0);
    }
    if (a === "--no-build") out.noBuild = true;
    else if (a === "--keep") out.keep = true;
    else if (a === "--skip-smoke") out.skipSmoke = true;
    else if (a.startsWith("--install-dir=")) out.installDir = a.slice("--install-dir=".length);
    else if (a.startsWith("--port=")) out.port = Number(a.slice("--port=".length));
    else if (a.startsWith("--http-port=")) out.httpPort = Number(a.slice("--http-port=".length));
    else if (a.startsWith("--channel=")) {
      const v = a.slice("--channel=".length);
      if (v !== "stable" && v !== "beta") {
        console.error(`--channel must be stable|beta, got ${v}`);
        process.exit(2);
      }
      out.channel = v;
    } else {
      console.error(`Unknown arg: ${a}`);
      console.error("run `bun scripts/install-local.ts --help` for usage.");
      process.exit(2);
    }
  }
  return out;
}

function detectHostKey(): string {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  throw new Error(`Unsupported host: ${platform}-${arch}`);
}

function platformBinaryName(hostKey: string): string {
  return hostKey === "windows-x64"
    ? `raindrop-bun-${hostKey}.exe`
    : `raindrop-bun-${hostKey}`;
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): void {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
  }
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const body = (await res.json()) as { service?: string };
        if (body.service === "workshop") return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const hostKey = detectHostKey();
  const binaryName = platformBinaryName(hostKey);
  const binaryPath = path.join(BUILD_DIR, binaryName);

  console.log(`[install-local] host=${hostKey} channel=${args.channel}`);
  console.log(`[install-local] install dir=${args.installDir}`);
  console.log("");

  // 1. Build (or reuse).
  if (args.noBuild) {
    if (!existsSync(binaryPath)) {
      throw new Error(
        `--no-build passed but ${binaryPath} missing. Drop --no-build or run 'bun scripts/build-bun.ts' first.`,
      );
    }
    console.log(`[install-local] reusing existing binary: ${binaryPath}`);
  } else {
    run("bun", ["scripts/build-bun.ts", `--target=bun-${hostKey}`]);
  }

  // 2. Generate a one-platform manifest pointing at our local mirror.
  const baseUrl = `http://localhost:${args.httpPort}`;
  const manifestPath = path.join(BUILD_DIR, "latest.local.json");
  run("bun", [
    "scripts/generate-manifest.ts",
    "--version=0.0.0-local",
    `--channel=${args.channel}`,
    `--base-url=${baseUrl}`,
    "--min-supported=0.0.0",
    `--out=${manifestPath}`,
    "--allow-missing",
  ]);
  console.log("");

  // 3. Spin up local HTTP mirror.
  console.log(`[install-local] starting local mirror on ${baseUrl}`);
  const server = Bun.serve({
    port: args.httpPort,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname.slice(1); // strip leading /
      let file: string | null = null;
      if (p === "install.sh") file = path.join(REPO_ROOT, "scripts", "install.sh");
      else if (p === "latest.json") file = manifestPath;
      else if (p === binaryName) file = binaryPath;
      if (!file || !existsSync(file)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(Bun.file(file));
    },
  });

  // 4. Run install.sh exactly the way a customer would.
  //    RAINDROP_INSECURE_PROTO=1 disables curl's --proto '=https' so we
  //    can pull from http://localhost. Customers never set this.
  // Wipe any prior sandbox install so we exercise the fresh-install path.
  if (existsSync(args.installDir)) {
    rmSync(args.installDir, { recursive: true, force: true });
  }
  mkdirSync(args.installDir, { recursive: true });

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━ install.sh output ━━━━━━━━━━━━━━━━━━━━");
  const installEnv = {
    ...process.env,
    RAINDROP_INSECURE_PROTO: "1",
    RAINDROP_INSTALL_DIR: args.installDir,
    RAINDROP_MANIFEST_URL: `${baseUrl}/latest.json`,
  };
  // Match the customer experience: pipe install.sh from curl to bash.
  // We do it in-process via spawn to keep stdio clean and to capture exit code.
  //
  // Skip automatic `raindrop setup` here so install:local does not write into
  // the dev's real ~/.cursor / ~/.claude. The IDE-wiring path is covered by
  // tests/install-init.test.ts and manual `raindrop setup` runs.
  const installResult = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "-c",
        `curl -fsSL "${baseUrl}/install.sh" | RAINDROP_INSECURE_PROTO=1 RAINDROP_SKIP_SETUP=1 RAINDROP_INSTALL_DIR="${args.installDir}" RAINDROP_MANIFEST_URL="${baseUrl}/latest.json" bash -s -- --channel=${args.channel}`,
      ],
      { stdio: "inherit", env: installEnv },
    );
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", reject);
  });
  console.log("━━━━━━━━━━━━━━━━━━━━ end install.sh output ━━━━━━━━━━━━━━━━");
  console.log("");

  if (installResult !== 0) {
    await server.stop(true);
    throw new Error(`install.sh exited with ${installResult}`);
  }

  const installedBinary = path.join(args.installDir, "raindrop");
  console.log(`[install-local] installed: ${installedBinary}`);

  // 5. Smoke test: daemonize via `start`, hit /health, `stop`.
  // We deliberately go through start/status/stop instead of running the
  // binary in foreground, because daemonization is the customer-facing
  // path and has its own gotchas (compiled-binary __filename resolution,
  // PID file handling). A foreground smoke test would not catch them.
  if (!args.skipSmoke) {
    console.log(`[install-local] smoke test on :${args.port} (start/status/stop)`);
    const env = {
      ...process.env,
      RAINDROP_WORKSHOP_PORT: String(args.port),
      RAINDROP_WORKSHOP_DB_PATH: "/tmp/raindrop-local-smoke.db",
    };
    const startResult = spawnSync(
      installedBinary,
      ["workshop", "start"],
      { stdio: "inherit", env },
    );
    if (startResult.status !== 0) {
      console.error(`[install-local] ✗ raindrop workshop start exited with ${startResult.status}`);
      await server.stop(true);
      process.exit(1);
    }
    const booted = await waitForHealth(args.port, 5_000);
    if (!booted) {
      console.error(`[install-local] ✗ /health did NOT respond within 5s after start returned`);
      // Best-effort cleanup
      spawnSync(installedBinary, ["workshop", "stop"], { stdio: "inherit", env });
      await server.stop(true);
      process.exit(1);
    }
    console.log(`[install-local] ✓ /health passed on :${args.port}`);

    // UI smoke: GET / must serve embedded HTML, not 404 with an ENOENT for
    // the build-host's __dirname. v0.1.0 shipped without this check and
    // shipped a broken UI. Any future regression on UI-asset embedding is
    // caught here AND in the CI smoke tests in .github/workflows/{ci,release}.yml.
    let uiOk = false;
    try {
      const res = await fetch(`http://127.0.0.1:${args.port}/`);
      const body = await res.text();
      if (res.ok && /<!doctype html|<html/i.test(body)) {
        uiOk = true;
      } else {
        console.error(
          `[install-local] ✗ GET / returned status=${res.status}, body[0..200]=${body.slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.error(`[install-local] ✗ GET / threw:`, err);
    }
    if (!uiOk) {
      spawnSync(installedBinary, ["workshop", "stop"], { stdio: "inherit", env });
      await server.stop(true);
      process.exit(1);
    }
    console.log(`[install-local] ✓ UI served on :${args.port}/`);

    const stopResult = spawnSync(
      installedBinary,
      ["workshop", "stop"],
      { stdio: "inherit", env },
    );
    if (stopResult.status !== 0) {
      console.error(`[install-local] ✗ raindrop workshop stop exited with ${stopResult.status}`);
      await server.stop(true);
      process.exit(1);
    }
  }

  // 6. Cleanup or hand off.
  if (args.keep) {
    console.log("");
    console.log(`[install-local] --keep: HTTP mirror still running at ${baseUrl}`);
    console.log(`[install-local]   curl -fsSL ${baseUrl}/install.sh | bash -s -- --channel=${args.channel}`);
    console.log(`[install-local]   (Ctrl-C to stop)`);
    // Block forever until SIGINT.
    await new Promise(() => {});
  } else {
    await server.stop(true);
    console.log("");
    console.log("[install-local] ✓ done");
    console.log(`    binary:  ${installedBinary}`);
    console.log(`    next:    ${installedBinary} setup`);
    console.log(`             (wires IDEs and opens Workshop)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
