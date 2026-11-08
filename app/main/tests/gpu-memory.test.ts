import { describe, expect, it } from 'vitest';
import { GpuMemoryReader, localPort, summariseGpuReading, type RawGpuReading } from '../src/diagnostics/gpu-memory.js';

const GB = 1024 ** 3;
const LUID = 'luid_0x00000000_0x0000d1a2';
const BASIC = 'luid_0x00000000_0x0000aaaa';
const counter = (instance: string, kind: 'Dedicated' | 'Shared', gb: number) => ({
  path: `\\\\bija\\gpu ${instance.startsWith('pid') ? 'process' : 'adapter'} memory(${instance})\\${kind.toLowerCase()} usage`,
  instance,
  value: gb * GB,
});

const reading: RawGpuReading = {
  counters: [
    counter(`${LUID}_phys_0`, 'Dedicated', 95),
    counter(`${LUID}_phys_0`, 'Shared', 3),
    counter(`${BASIC}_phys_0`, 'Dedicated', 0.1),
    counter(`pid_100_${LUID}_phys_0`, 'Dedicated', 80),
    counter(`pid_100_${LUID}_phys_0`, 'Shared', 1),
    counter(`pid_200_${LUID}_phys_0`, 'Dedicated', 1),
    counter(`pid_300_${LUID}_phys_0`, 'Dedicated', 10),
    counter(`pid_400_${BASIC}_phys_0`, 'Dedicated', 0.1),
  ],
  listen: [
    { port: 1234, pid: 100 },
    { port: 1235, pid: 200 },
    { port: 8192, pid: 500 },
  ],
  procs: [
    { pid: 100, name: 'llama-server' },
    { pid: 200, name: 'llama-server' },
    { pid: 300, name: 'UnslothStudio' },
  ],
  adapters: [
    { name: 'Microsoft Basic Render Driver', memory: 0 },
    { name: 'AMD Radeon(TM) 8060S Graphics', memory: 96 * GB },
  ],
  ram: 32 * GB,
};

const servers = [
  { id: 'local-llm', name: 'Language model', port: 1234 },
  { id: 'local-asr', name: 'ASR', port: 1235 },
  { id: 'local-speech', name: 'Speech', port: 8192 },
  { id: 'local-comfy', name: 'ComfyUI', port: 8188 },
];

describe('summariseGpuReading', () => {
  it('splits the busiest adapter by server, with other processes and the remainder', () => {
    const snapshot = summariseGpuReading(reading, servers, 1);
    expect(snapshot.adapterName).toBe('AMD Radeon(TM) 8060S Graphics');
    expect(snapshot.dedicatedTotal).toBe(96 * GB);
    expect(snapshot.sharedTotal).toBe(16 * GB);
    expect(snapshot.used).toEqual({ dedicated: 95 * GB, shared: 3 * GB });
    expect(snapshot.servers.map((s) => [s.id, s.dedicated / GB, s.pid])).toEqual([
      ['local-llm', 80, 100],
      ['local-asr', 1, 200],
      ['local-speech', 0, 500],
      ['local-comfy', 0, undefined],
    ]);
    expect(snapshot.others).toEqual([{ pid: 300, name: 'UnslothStudio', dedicated: 10 * GB, shared: 0 }]);
    expect(snapshot.unattributed.dedicated / GB).toBeCloseTo(4);
    expect(snapshot.unattributed.shared / GB).toBeCloseTo(2);
  });

  it('accepts single objects where PowerShell drops the array', () => {
    const snapshot = summariseGpuReading(
      { counters: counter(`pid_7_${LUID}_phys_0`, 'Dedicated', 2), listen: { port: 1234, pid: 7 }, adapters: { name: 'GPU', memory: 8 * GB } },
      servers,
    );
    expect(snapshot.servers[0].dedicated).toBe(2 * GB);
    expect(snapshot.used.dedicated).toBe(2 * GB);
    expect(snapshot.sharedTotal).toBeNull();
  });

  it('counts a process once when two servers share it', () => {
    const snapshot = summariseGpuReading(
      { counters: [counter(`pid_7_${LUID}_phys_0`, 'Dedicated', 2)], listen: [{ port: 1234, pid: 7 }, { port: 1235, pid: 7 }] },
      servers,
    );
    expect(snapshot.servers[0].dedicated + snapshot.servers[1].dedicated).toBe(2 * GB);
  });
});

describe('GpuMemoryReader', () => {
  it('reports unsupported off Windows', async () => {
    const snapshot = await new GpuMemoryReader({ platform: 'linux' }).read(servers);
    expect(snapshot.supported).toBe(false);
  });

  it('reports a failed read', async () => {
    const snapshot = await new GpuMemoryReader({ run: () => Promise.reject(new Error('boom')) }).read(servers);
    expect(snapshot.supported).toBe(false);
    expect(snapshot.reason).toContain('boom');
  });

  it('shares one read between overlapping calls', async () => {
    let calls = 0;
    const reader = new GpuMemoryReader({ run: async () => { calls += 1; return JSON.stringify(reading); } });
    const [a, b] = await Promise.all([reader.read(servers), reader.read(servers)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
});

describe('localPort', () => {
  it('returns ports of local URLs only', () => {
    expect(localPort('http://127.0.0.1:1234/v1')).toBe(1234);
    expect(localPort('http://localhost:8188')).toBe(8188);
    expect(localPort('postgres://memory@127.0.0.1:5433/memory')).toBe(5433);
    expect(localPort('http://[::1]:8192')).toBe(8192);
    expect(localPort('https://api.openai.com/v1')).toBeNull();
    expect(localPort('http://mutiara:8188')).toBeNull();
    expect(localPort(undefined)).toBeNull();
  });
});
