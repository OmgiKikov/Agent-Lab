// `raindrop update` / `raindrop workshop update` — in-place upgrade to the
// latest release on a channel (default `stable`). Same manifest schema,
// sha256 verification, and atomic-rename + .prev rollback as install.sh.
//
// Refuses to operate from `bun run src/index.ts` (no embedded version to
// replace) or from a Homebrew-managed path (`brew upgrade` is the right
// tool there).
import { createHash } from "node:crypto";
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

import { VERSION } from "./version";
import { loadInstallRegistry, defaultInstallRegistryPath } from "./install/registry";

type Channel = "stable" | "beta";

interface PlatformEntry {
  url: string;
  sha256: string;
  size: number;
  gzip?: {
    url: string;
    sha256: string;
    size: number;
  };
}

interface ChannelEntry {
  version: string;
  platforms: Partial<Record<string, PlatformEntry>>;
}

interface Manifest {
  stable?: ChannelEntry;
  beta?: ChannelEntry;
  min_supported?: string;
}

const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/raindrop-ai/workshop/main/latest.json";

interface UpdateArgs {
  channel: Channel;
  check: boolean;
  manifestUrl: string;
  force: boolean;
}

function parseUpdateArgs(rawArgs: string[]): UpdateArgs {
  const out: UpdateArgs = {
    channel: "stable",
    check: false,
    manifestUrl: process.env.RAINDROP_MANIFEST_URL ?? DEFAULT_MANIFEST_URL,
    force: false,
  };
  for (const a of rawArgs) {
    if (a === "--check") out.check = true;
    else if (a === "--force") out.force = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "raindrop update — upgrade to the latest release.",
          "",
          "USAGE",
          "    raindrop update [--channel=stable|beta] [--check] [--force]",
          "    raindrop workshop update [--channel=stable|beta] [--check] [--force]",
          "",
          "OPTIONS",
          "    --channel=stable|beta   Channel to install (default: stable).",
          "    --check                 Print what would happen, don't apply.",
          "    --force                 Re-install even if already on latest.",
          "    -h, --help              This help.",
          "",
          "ENVIRONMENT",
          "    RAINDROP_MANIFEST_URL   Override manifest source (advanced).",
        ].join("\n"),
      );
      process.exit(0);
    } else if (a.startsWith("--channel=")) {
      const v = a.slice("--channel=".length);
      if (v !== "stable" && v !== "beta") {
        console.error(`update: --channel must be stable|beta, got ${v}`);
        process.exit(2);
      }
      out.channel = v;
    } else if (a.startsWith("--manifest=")) {
      out.manifestUrl = a.slice("--manifest=".length);
    } else {
      console.error(`update: unknown arg: ${a}`);
      console.error("run `raindrop update --help` for usage.");
      process.exit(2);
    }
  }
  return out;
}

function detectPlatformKey(): string {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  throw new Error(`update: unsupported platform: ${platform}-${arch}`);
}

/**
 * Compare two semver-ish version strings. Returns -1 / 0 / 1.
 *
 * Handles the X.Y.Z and X.Y.Z-prerelease shapes we actually publish (e.g.
 * 0.0.1, 0.0.1-beta1). Pre-release versions sort *lower* than the base
 * version, per semver.
 *
 * Not a full semver implementation — does not handle pre-release with
 * dots ("0.0.1-rc.1"), build metadata, or non-numeric pre-release tags.
 * Good enough for our published versions; revisit if the schema grows.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  const splitVer = (v: string): { core: number[]; pre: string | null } => {
    const dash = v.indexOf("-");
    const core = (dash === -1 ? v : v.slice(0, dash))
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
    while (core.length < 3) core.push(0);
    return { core, pre: dash === -1 ? null : v.slice(dash + 1) };
  };
  const A = splitVer(a);
  const B = splitVer(b);
  for (let i = 0; i < 3; i++) {
    if (A.core[i] !== B.core[i]) return A.core[i] < B.core[i] ? -1 : 1;
  }
  // Cores equal: a release sorts higher than its prerelease.
  if (A.pre === null && B.pre !== null) return 1;
  if (A.pre !== null && B.pre === null) return -1;
  if (A.pre === null && B.pre === null) return 0;
  // Both prerelease: lexicographic on the tag string.
  // (Good enough: "beta1" < "beta2" < "rc1".)
  return (A.pre ?? "") < (B.pre ?? "") ? -1 : 1;
}

/**
 * Resolve the on-disk path of the binary the user is running.
 * For a Bun-compiled binary, `process.execPath` is the raindrop binary itself.
 * For `bun run src/index.ts`, `process.execPath` is the `bun` interpreter.
 */
function resolveCurrentBinary(): { path: string; isCompiled: boolean } {
  const exe = process.execPath;
  const base = path.basename(exe).toLowerCase();
  // Compiled Bun binaries embed the raindrop entrypoint and are typically
  // named `raindrop` or `raindrop.exe`. The Bun interpreter is `bun`/`bun.exe`.
  const isCompiled = base.startsWith("raindrop");
  return { path: exe, isCompiled };
}

function detectManagedInstall(binaryPath: string): string | null {
  // Homebrew formulae land under /opt/homebrew/Cellar (Apple Silicon) or
  // /usr/local/Cellar (Intel). brew owns the lifecycle there.
  if (binaryPath.includes("/Cellar/")) return "homebrew";
  return null;
}

async function fetchManifest(url: string): Promise<Manifest> {
  const res = await fetch(url, {
    headers: { "user-agent": `raindrop-cli/${VERSION}` },
  });
  if (!res.ok) {
    throw new Error(`update: manifest fetch failed: HTTP ${res.status} ${url}`);
  }
  return (await res.json()) as Manifest;
}

async function downloadAndVerify(
  url: string,
  expectedSha: string,
  expectedSize: number,
  outPath: string,
  compressed = false,
  expectedRawSha = expectedSha,
  expectedRawSize = expectedSize,
): Promise<void> {
  const res = await fetch(url, {
    headers: { "user-agent": `raindrop-cli/${VERSION}` },
  });
  if (!res.ok) {
    throw new Error(`update: download failed: HTTP ${res.status} ${url}`);
  }
  const artifact = Buffer.from(await res.arrayBuffer());
  if (artifact.length !== expectedSize) {
    throw new Error(
      `update: size mismatch: expected ${expectedSize}, got ${artifact.length}`,
    );
  }
  const actualSha = createHash("sha256").update(artifact).digest("hex");
  if (actualSha !== expectedSha) {
    throw new Error(
      `update: sha256 mismatch: expected ${expectedSha}, got ${actualSha}`,
    );
  }
  let buf = artifact;
  if (compressed) {
    try {
      buf = gunzipSync(artifact);
    } catch (err) {
      throw new Error(`update: gzip decompression failed: ${(err as Error).message}`);
    }
    if (buf.length !== expectedRawSize) {
      throw new Error(
        `update: size mismatch after unpack: expected ${expectedRawSize}, got ${buf.length}`,
      );
    }
    const actualRawSha = createHash("sha256").update(buf).digest("hex");
    if (actualRawSha !== expectedRawSha) {
      throw new Error(
        `update: sha256 mismatch after unpack: expected ${expectedRawSha}, got ${actualRawSha}`,
      );
    }
  }
  const fd = openSync(outPath, "w", 0o755);
  try {
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
}

function resolveDownloadArtifact(platformEntry: PlatformEntry): {
  url: string;
  sha256: string;
  size: number;
  compressed: boolean;
} {
  const gzip = platformEntry.gzip;
  if (gzip?.url && gzip.sha256 && typeof gzip.size === "number") {
    return { ...gzip, compressed: true };
  }
  return {
    url: platformEntry.url,
    sha256: platformEntry.sha256,
    size: platformEntry.size,
    compressed: false,
  };
}

/**
 * Atomic install: rename current binary aside (.prev), move new into place.
 *
 * Uses two `renameSync` calls. On macOS/Linux `rename` is atomic within the
 * same filesystem, and the install dir is the same FS for both. The running
 * daemon is unaffected — the kernel keeps the old inode mapped for the
 * already-open process; the new binary only takes effect after the next
 * `workshop start`.
 *
 * If we crash between the two renames, the user is left with a missing
 * binary at $DEST and the `.prev` still in place. Recovery is one move:
 *   mv ~/.raindrop/bin/raindrop.prev ~/.raindrop/bin/raindrop
 */
function atomicReplace(currentPath: string, newPath: string): string | null {
  const prevPath = `${currentPath}.prev`;
  // If a .prev already exists from a previous update, drop it. The user's
  // last-known-good is becoming the *new* prev; we only keep one.
  try {
    unlinkSync(prevPath);
  } catch {
    // ENOENT is fine
  }
  let prevWritten: string | null = null;
  try {
    renameSync(currentPath, prevPath);
    prevWritten = prevPath;
  } catch (err) {
    // If the current binary doesn't exist (rare), continue without a .prev.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  renameSync(newPath, currentPath);
  return prevWritten;
}

interface UpdateResult {
  fromVersion: string;
  toVersion: string;
  channel: Channel;
  applied: boolean;
  reason?: string;
  prevPath: string | null;
}

/**
 * Programmatic entrypoint — used by tests.
 * Public CLI entrypoint is `runUpdate` below.
 */
export async function performUpdate(opts: {
  args: UpdateArgs;
  currentBinaryPath: string;
  currentVersion: string;
  platformKey: string;
  fetchManifestImpl?: (url: string) => Promise<Manifest>;
  downloadImpl?: (
    url: string,
    sha: string,
    size: number,
    out: string,
    compressed?: boolean,
    rawSha?: string,
    rawSize?: number,
  ) => Promise<void>;
  workDir?: string;
  onBeforeDownload?: () => void;
}): Promise<UpdateResult> {
  const fetchM = opts.fetchManifestImpl ?? fetchManifest;
  const download = opts.downloadImpl ?? downloadAndVerify;

  const manifest = await fetchM(opts.args.manifestUrl);
  const channelEntry = manifest[opts.args.channel];
  if (!channelEntry) {
    throw new Error(
      `update: manifest has no entry for channel=${opts.args.channel}`,
    );
  }
  const platformEntry = channelEntry.platforms[opts.platformKey];
  if (!platformEntry) {
    throw new Error(
      `update: manifest ${opts.args.channel}/${channelEntry.version} has no entry for platform=${opts.platformKey}`,
    );
  }

  const cmp = compareVersions(opts.currentVersion, channelEntry.version);
  if (cmp >= 0 && !opts.args.force) {
    return {
      fromVersion: opts.currentVersion,
      toVersion: channelEntry.version,
      channel: opts.args.channel,
      applied: false,
      reason: cmp === 0 ? "already on latest" : "current is newer than channel head",
      prevPath: null,
    };
  }

  if (opts.args.check) {
    return {
      fromVersion: opts.currentVersion,
      toVersion: channelEntry.version,
      channel: opts.args.channel,
      applied: false,
      reason: "--check; nothing applied",
      prevPath: null,
    };
  }

  const workDir = opts.workDir ?? path.join(os.homedir(), ".raindrop", "updates", channelEntry.version);
  await Bun.write(path.join(workDir, ".touch"), "");
  const downloadPath = path.join(workDir, "raindrop.new");
  opts.onBeforeDownload?.();
  const artifact = resolveDownloadArtifact(platformEntry);
  await download(
    artifact.url,
    artifact.sha256,
    artifact.size,
    downloadPath,
    artifact.compressed,
    platformEntry.sha256,
    platformEntry.size,
  );

  const prevPath = atomicReplace(opts.currentBinaryPath, downloadPath);
  return {
    fromVersion: opts.currentVersion,
    toVersion: channelEntry.version,
    channel: opts.args.channel,
    applied: true,
    prevPath,
  };
}

/**
 * CLI entrypoint dispatched from `src/index.ts`.
 */
export async function runUpdate(rawArgs: string[]): Promise<number> {
  const args = parseUpdateArgs(rawArgs);
  const { path: binaryPath, isCompiled } = resolveCurrentBinary();
  if (!isCompiled) {
    console.error("update: this command only works when running the installed binary.");
    console.error("update: you appear to be running from source — re-run install.sh to upgrade your installation:");
    console.error("        curl -fsSL https://raw.githubusercontent.com/raindrop-ai/workshop/main/install.sh | bash");
    return 64;
  }
  const managedBy = detectManagedInstall(binaryPath);
  if (managedBy === "homebrew") {
    console.error(`update: raindrop appears to be managed by Homebrew (${binaryPath}).`);
    console.error("update: use `brew upgrade raindrop` to upgrade.");
    return 64;
  }

  const platformKey = detectPlatformKey();

  let res: UpdateResult;
  try {
    res = await performUpdate({
      args,
      currentBinaryPath: binaryPath,
      currentVersion: VERSION,
      platformKey,
      onBeforeDownload: () => console.log("Downloading and verifying update..."),
    });
  } catch (err) {
    console.error(`[update] ${(err as Error).message}`);
    return 1;
  }

  if (!res.applied) {
    if (res.reason === "already on latest") {
      console.log(`Already on latest version (${res.fromVersion}).`);
    } else if (res.reason === "--check; nothing applied") {
      console.log(`Check complete: update available ${res.fromVersion} -> ${res.toVersion}.`);
    } else {
      console.log(`[update] ${res.reason ?? "no update"} (current=${res.fromVersion}, channel=${res.toVersion})`);
    }
    return 0;
  }

  console.log(`Successfully updated to version ${res.toVersion}.`);
  if (res.prevPath) {
    console.log(`[update] previous binary preserved at: ${res.prevPath}`);
    console.log(`[update] rollback: mv ${res.prevPath} ${binaryPath}`);
  }

  // Refresh skills + MCP entries in every place we previously
  // installed. We MUST spawn the new binary for this — the running
  // process is still the old one that just got renamed aside, and
  // its embedded skill content is stale. Spawning the on-disk
  // binary at `binaryPath` (which now points at the new version)
  // re-reads the new EMBEDDED_SKILLS map.
  await runPostUpdateSync(binaryPath);

  return await restartDaemonIfRunning(binaryPath);
}

async function restartDaemonIfRunning(binaryPath: string): Promise<number> {
  if (!(await isDaemonRunning())) return 0;

  const stop = spawnSync(binaryPath, ["workshop", "stop"], { stdio: "inherit" });
  if (stop.error) {
    console.warn(`[update] failed to stop Workshop: ${stop.error.message}`);
    return 1;
  }
  if (stop.status === null) return 1;
  if (typeof stop.status === "number" && stop.status !== 0) return stop.status;

  const start = spawnSync(binaryPath, ["workshop", "start"], { stdio: "inherit" });
  if (start.error) {
    console.warn(`[update] failed to start Workshop: ${start.error.message}`);
    return 1;
  }
  return start.status ?? 1;
}

/**
 * Spawn the just-installed binary to run `raindrop sync` so the
 * registry's recorded files get the new release's skill content.
 *
 * Why a spawn instead of an in-process call: by the time we get
 * here, the *binary on disk* is the new version, but the *running
 * process image* is still the old version. Calling `runSync()`
 * directly would copy the OLD skills into every IDE config dir —
 * the exact opposite of what we want. The newly-installed binary
 * has the new EMBEDDED_SKILLS map, so we exec that.
 *
 * Skipped when the registry is empty (user never ran `raindrop
 * setup`); we don't want to print sync output when there's nothing
 * to sync. The user can manually `raindrop setup` later, and from
 * that point on every `update` will auto-sync.
 *
 * Failure is non-fatal — surface the error and tell the user how
 * to retry. The binary swap already succeeded; demoting the whole
 * `update` to a failure because sync hiccupped would be wrong.
 */
async function runPostUpdateSync(newBinaryPath: string): Promise<void> {
  let registryEmpty = true;
  try {
    const reg = loadInstallRegistry();
    registryEmpty = reg.installs.length === 0;
  } catch (err) {
    console.warn(
      `[update] could not read ${defaultInstallRegistryPath()} (${(err as Error).message}). ` +
        `Skipping sync. Run \`raindrop sync\` manually after editing the registry.`,
    );
    return;
  }
  if (registryEmpty) {
    // Nothing to sync — first-time-after-install, or user has never
    // wired raindrop into an IDE.
    return;
  }

  console.log("");
  console.log("[update] refreshing IDE skills + MCP entries…");
  const res = spawnSync(newBinaryPath, ["sync"], { stdio: "inherit" });
  if (res.error) {
    console.warn(
      `[update] sync exec failed: ${res.error.message}. Run \`raindrop sync\` manually.`,
    );
    return;
  }
  if (typeof res.status === "number" && res.status !== 0) {
    console.warn(
      `[update] sync exited with code ${res.status}. Run \`raindrop sync\` manually for details.`,
    );
  }
}

async function isDaemonRunning(): Promise<boolean> {
  const port = parseInt(process.env.RAINDROP_WORKSHOP_PORT ?? "5899", 10);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { service?: string };
    return body.service === "workshop";
  } catch {
    return false;
  }
}

/**
 * Re-export internals so tests can drive performUpdate directly with mocks.
 */
export const _internal = {
  parseUpdateArgs,
  detectPlatformKey,
  resolveCurrentBinary,
  detectManagedInstall,
  atomicReplace,
  downloadAndVerify,
  resolveDownloadArtifact,
};
