import { describe, expect, it } from 'vitest';
import { createTailscaleLookup, parseSelf, parseWhois, shortNodeName, tailscaleCommand } from '../../src/room-hub/tailscale.js';

// Hand-written from the shapes in Tailscale's documentation (`tailscale whois --json`, `tailscale status --json`).
const WHOIS = {
  Node: {
    ID: 123,
    Name: 'kevins-desk.tail1234.ts.net.',
    ComputedName: 'kevins-desk',
    Addresses: ['100.101.102.103/32'],
    Hostinfo: { OS: 'windows', Hostname: 'KEVINS-DESK' },
  },
  UserProfile: { ID: 77, LoginName: 'Kevin@Example.com', DisplayName: 'Kevin' },
  Caps: [],
};

const STATUS = {
  Version: '1.80.0',
  Self: { ID: 'n1', HostName: 'bija', DNSName: 'bija.tail1234.ts.net.', UserID: 77, TailscaleIPs: ['100.64.0.1'] },
  User: { '77': { ID: 77, LoginName: 'kevin@example.com', DisplayName: 'Kevin' } },
};

describe('tailscale parsing', () => {
  it('shortens DNS names', () => {
    expect(shortNodeName('Kevins-Desk.tail1234.ts.net.')).toBe('kevins-desk');
    expect(shortNodeName('')).toBe('');
  });

  it('reads whois: ComputedName first, then Name, then Hostinfo.Hostname', () => {
    expect(parseWhois(WHOIS)).toEqual({ node: 'kevins-desk', login: 'kevin@example.com' });
    expect(parseWhois({ ...WHOIS, Node: { Name: 'desk.t.ts.net.' } })).toEqual({ node: 'desk', login: 'kevin@example.com' });
    expect(parseWhois({ ...WHOIS, Node: { Hostinfo: { Hostname: 'Laptop' } } })).toEqual({ node: 'laptop', login: 'kevin@example.com' });
    expect(parseWhois({ ...WHOIS, Node: { HostInfo: { Hostname: 'Laptop' } } })).toEqual({ node: 'laptop', login: 'kevin@example.com' });
  });

  it('gives null for anything it cannot read', () => {
    expect(parseWhois(null)).toBeNull();
    expect(parseWhois('x')).toBeNull();
    expect(parseWhois({ Node: { ComputedName: 'a' } })).toBeNull();
    expect(parseWhois({ UserProfile: { LoginName: 'a@b' } })).toBeNull();
    expect(parseSelf({})).toBeNull();
    expect(parseSelf({ Self: { HostName: 'bija' } })).toBeNull();
  });

  it('reads this PC from status: HostName or DNSName, login from the User map', () => {
    expect(parseSelf(STATUS)).toEqual({ node: 'bija', login: 'kevin@example.com' });
    expect(parseSelf({ ...STATUS, Self: { DNSName: 'bija.tail1234.ts.net.', UserID: 77 } })).toEqual({ node: 'bija', login: 'kevin@example.com' });
    expect(parseSelf({ ...STATUS, Self: { HostName: 'bija', UserID: 5 } })).toBeNull();
  });

  it('finds the CLI: PATH, else the Windows install folder', () => {
    expect(tailscaleCommand({}, 'linux')).toBe('tailscale');
    expect(tailscaleCommand({ ProgramFiles: 'C:\\Program Files' }, 'win32', () => true)).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
    expect(tailscaleCommand({ ProgramFiles: 'C:\\Program Files' }, 'win32', () => false)).toBe('tailscale');
  });
});

describe('createTailscaleLookup', () => {
  it('runs the CLI with --json and parses the answer', async () => {
    const calls: string[][] = [];
    const lookup = createTailscaleLookup({
      command: 'ts',
      exec: async (command, args) => {
        calls.push([command, ...args]);
        return args[0] === 'whois' ? WHOIS : STATUS;
      },
    });
    expect(await lookup.whois('100.101.102.103')).toEqual({ node: 'kevins-desk', login: 'kevin@example.com' });
    expect(await lookup.self()).toEqual({ node: 'bija', login: 'kevin@example.com' });
    expect(calls).toEqual([
      ['ts', 'whois', '--json', '100.101.102.103'],
      ['ts', 'status', '--json'],
    ]);
  });

  it('gives null when the CLI is missing or fails', async () => {
    const lookup = createTailscaleLookup({
      exec: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(await lookup.whois('100.1.1.1')).toBeNull();
    expect(await lookup.self()).toBeNull();
  });
});
