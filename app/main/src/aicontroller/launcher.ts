/**
 * Vendored from silarsis/aicontroller, clients/typescript/src/launcher.ts (commit 00bc054).
 * Kept as upstream wrote it;
 * resync from there rather than editing it. The client has no runtime dependencies.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "http://127.0.0.1:8200";

/** Starts an installed service; resolves true when a start command succeeded. */
export type ServiceStarter = () => Promise<boolean> | boolean;
/** Starts the controller detached from the caller. */
export type Launcher = (opts: { home: string; config?: string }) => Promise<void> | void;

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "::1" || h.startsWith("127.");
  } catch {
    return false;
  }
}

/** AICONTROLLER_HOME, else the option, else ~/repos/github/silarsis/aicontroller (when it exists). */
export function findHome(option?: string): string | undefined {
  const candidates = [process.env.AICONTROLLER_HOME, option, join(homedir(), "repos/github/silarsis/aicontroller")];
  return candidates.find((c): c is string => !!c && existsSync(c));
}

function run(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: "ignore", timeout: 30_000 }).status === 0;
  } catch {
    return false;
  }
}

/** Windows service `aicontroller` (sc.exe) or the Linux systemd user unit. May fail without rights. */
export const startService: ServiceStarter = () => {
  if (process.platform === "win32") {
    return run("sc.exe", ["query", "aicontroller"]) && run("sc.exe", ["start", "aicontroller"]);
  }
  if (process.platform === "linux") {
    return run("systemctl", ["--user", "cat", "aicontroller"]) && run("systemctl", ["--user", "start", "aicontroller"]);
  }
  return false;
};

/** `<home>/.venv/.../python -m aicontroller serve --config <config>`, detached, logging to logs/autostart.log. */
export const launchDetached: Launcher = ({ home, config }) => {
  const win = process.platform === "win32";
  const py = join(home, win ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const cfg = config ?? process.env.AICONTROLLER_CONFIG ?? join(home, "config.yaml");
  mkdirSync(join(home, "logs"), { recursive: true });
  const log = openSync(join(home, "logs", "autostart.log"), "a");
  const child = spawn(py, ["-m", "aicontroller", "serve", "--config", cfg], {
    cwd: home,
    detached: true, // new session on POSIX, DETACHED_PROCESS | new process group on Windows
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  child.on("error", () => {}); // a missing python shows up as "still not available"
  child.unref();
};

/** True when another client started a launch less than `maxAgeS` ago; otherwise claims the lock. */
export function claimLaunchLock(home: string, maxAgeS: number): boolean {
  const lock = join(home, "logs", "autostart.lock");
  try {
    if (Date.now() - statSync(lock).mtimeMs < maxAgeS * 1000) return false;
  } catch {
    /* no lock yet */
  }
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(lock, String(process.pid));
  return true;
}
