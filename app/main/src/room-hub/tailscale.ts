/**
 * Who is on the other end of a connection, according to Tailscale. A satellite is trusted when its node
 * name is the one recorded at pairing and its login is the login of this PC's own node (same person).
 *
 * The tailscale command line does the lookup (`tailscale whois --json <ip>`, `tailscale status --json`).
 * It is injected into the hub, so the tests use a fake. Parsing is defensive: the shapes are Tailscale's
 * documented ones, but any field may be missing.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface TailscaleIdentity {
  /** Short node name ("kevins-desk"), lowercase. */
  node: string;
  /** Login name of the node's owner ("kevin@example.com"), lowercase. */
  login: string;
}

export interface TailscaleLookup {
  /** Who owns this tailnet address. Null when Tailscale does not know it or the CLI is missing or fails. */
  whois(ip: string): Promise<TailscaleIdentity | null>;
  /** This PC's own node. Null when the CLI is missing or fails. */
  self(): Promise<TailscaleIdentity | null>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** "kevins-desk.tail1234.ts.net." -> "kevins-desk". */
export function shortNodeName(name: string): string {
  return name.replace(/\.$/, '').split('.')[0]?.toLowerCase() ?? '';
}

/** `tailscale whois --json` output: Node.ComputedName, else Node.Name, else Node.Hostinfo.Hostname; UserProfile.LoginName. */
export function parseWhois(json: unknown): TailscaleIdentity | null {
  const root = record(json);
  const node = record(root?.Node);
  const hostInfo = record(node?.Hostinfo) ?? record(node?.HostInfo);
  const name = text(node?.ComputedName) || shortNodeName(text(node?.Name)) || text(hostInfo?.Hostname);
  const login = text(record(root?.UserProfile)?.LoginName);
  if (!name || !login) return null;
  return { node: shortNodeName(name), login: login.toLowerCase() };
}

/** `tailscale status --json` output: Self.HostName or Self.DNSName; the login is Self.UserID looked up in the User map. */
export function parseSelf(json: unknown): TailscaleIdentity | null {
  const root = record(json);
  const self = record(root?.Self);
  const name = text(self?.HostName) || text(self?.DNSName);
  const userId = self?.UserID;
  const users = record(root?.User);
  const user = userId !== undefined && userId !== null ? record(users?.[String(userId)]) : null;
  const login = text(user?.LoginName);
  if (!name || !login) return null;
  return { node: shortNodeName(name), login: login.toLowerCase() };
}

/** The tailscale CLI: from PATH, else the Windows install folder. */
export function tailscaleCommand(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (file: string) => boolean = existsSync): string {
  if (platform === 'win32') {
    const base = env.ProgramFiles ?? 'C:\\Program Files';
    const installed = path.win32.join(base, 'Tailscale', 'tailscale.exe');
    if (exists(installed)) return installed;
  }
  return 'tailscale';
}

export type ExecJson = (command: string, args: string[]) => Promise<unknown>;

const defaultExec: ExecJson = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });

export function createTailscaleLookup(options: { exec?: ExecJson; command?: string } = {}): TailscaleLookup {
  const exec = options.exec ?? defaultExec;
  const run = async (args: string[]): Promise<unknown> => exec(options.command ?? tailscaleCommand(), args);
  return {
    async whois(ip) {
      try {
        return parseWhois(await run(['whois', '--json', ip]));
      } catch {
        return null;
      }
    },
    async self() {
      try {
        return parseSelf(await run(['status', '--json']));
      } catch {
        return null;
      }
    },
  };
}
