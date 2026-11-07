/**
 * GPU memory on this PC: one bar for dedicated memory and one for shared, each split by the
 * app's local servers, everything else as "Other", and the rest free.
 */
import { useEffect, useState } from 'react';
import type { GpuMemoryBridge, GpuMemorySnapshot, GpuMemoryUse } from '../../../main/src/diagnostics/gpu-memory.js';

export const GPU_MEMORY_POLL_MS = 5000;

const SERVER_COLOURS = ['#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#fb923c', '#2dd4bf', '#818cf8'];
const OTHER_COLOUR = '#64748b';

const GB = 1024 ** 3;
export function formatGb(bytes: number): string {
  const gb = bytes / GB;
  return gb >= 10 ? `${gb.toFixed(0)} GB` : gb >= 0.1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

interface Segment {
  key: string;
  label: string;
  colour: string;
  bytes: number;
  title: string;
}

type Pool = keyof GpuMemoryUse;

/** Segments for one pool (dedicated or shared): each server, Other, then free. */
export function buildSegments(snapshot: GpuMemorySnapshot, pool: Pool): { segments: Segment[]; used: number; total: number | null } {
  const segments: Segment[] = [];
  snapshot.servers.forEach((server, index) => {
    if (server[pool] <= 0) return;
    segments.push({
      key: server.id,
      label: server.name,
      colour: SERVER_COLOURS[index % SERVER_COLOURS.length],
      bytes: server[pool],
      title: `${server.name}: ${formatGb(server[pool])} (port ${server.port}${server.processName ? `, ${server.processName}` : ''})`,
    });
  });
  const otherBytes = snapshot.others.reduce((sum, proc) => sum + proc[pool], 0) + snapshot.unattributed[pool];
  if (otherBytes > 0) {
    const top = snapshot.others
      .filter((proc) => proc[pool] > 0)
      .slice(0, 6)
      .map((proc) => `${proc.name} (pid ${proc.pid}): ${formatGb(proc[pool])}`);
    if (snapshot.unattributed[pool] > 0) top.push(`Not tied to a process: ${formatGb(snapshot.unattributed[pool])}`);
    segments.push({ key: 'other', label: 'Other', colour: OTHER_COLOUR, bytes: otherBytes, title: `Other: ${formatGb(otherBytes)}\n${top.join('\n')}` });
  }
  const used = snapshot.used[pool];
  const total = pool === 'dedicated' ? snapshot.dedicatedTotal : snapshot.sharedTotal;
  return { segments, used, total };
}

function PoolBar({ snapshot, pool, label }: { snapshot: GpuMemorySnapshot; pool: Pool; label: string }) {
  const { segments, used, total } = buildSegments(snapshot, pool);
  // With no known total, scale to what is in use.
  const scale = Math.max(total ?? 0, used, segments.reduce((sum, segment) => sum + segment.bytes, 0), 1);
  return (
    <div className="gpuMemory__pool" data-testid={`gpu-memory-${pool}`}>
      <div className="gpuMemory__poolHeader">
        <span>{label}</span>
        <span>
          {formatGb(used)} used{total !== null ? ` of ${formatGb(total)}` : ''}
          {total !== null ? ` · ${formatGb(Math.max(0, total - used))} free` : ''}
        </span>
      </div>
      <div className="gpuMemory__bar" role="img" aria-label={`${label}: ${segments.map((s) => `${s.label} ${formatGb(s.bytes)}`).join(', ')}`}>
        {segments.map((segment) => (
          <div
            key={segment.key}
            className="gpuMemory__segment"
            style={{ width: `${(segment.bytes / scale) * 100}%`, background: segment.colour }}
            title={segment.title}
          />
        ))}
      </div>
      <ul className="gpuMemory__legend">
        {segments.map((segment) => (
          <li key={segment.key} title={segment.title}>
            <span className="gpuMemory__swatch" style={{ background: segment.colour }} />
            {segment.label} {formatGb(segment.bytes)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GpuMemoryView({ snapshot }: { snapshot: GpuMemorySnapshot | null }) {
  if (!snapshot) return <p className="gpuMemory__note">Reading GPU memory…</p>;
  if (!snapshot.supported) return <p className="gpuMemory__note">{snapshot.reason ?? 'GPU memory is not available.'}</p>;
  const idle = snapshot.servers.filter((server) => server.dedicated + server.shared <= 0).map((server) => server.name);
  return (
    <>
      {snapshot.adapterName ? <p className="gpuMemory__note">{snapshot.adapterName}</p> : null}
      <PoolBar snapshot={snapshot} pool="dedicated" label="Dedicated" />
      <PoolBar snapshot={snapshot} pool="shared" label="Shared (system RAM)" />
      {idle.length > 0 ? <p className="gpuMemory__note">Not using the GPU or not running: {idle.join(', ')}</p> : null}
    </>
  );
}

/** Polls while `active` (the pop-up is open). */
export function GpuMemoryPanel({ api, active }: { api?: GpuMemoryBridge; active: boolean }) {
  const [snapshot, setSnapshot] = useState<GpuMemorySnapshot | null>(null);
  useEffect(() => {
    if (!api || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api.read();
        if (!cancelled) setSnapshot(next);
      } catch (error) {
        if (!cancelled) {
          setSnapshot({
            supported: false,
            reason: error instanceof Error ? error.message : String(error),
            dedicatedTotal: null,
            sharedTotal: null,
            used: { dedicated: 0, shared: 0 },
            servers: [],
            others: [],
            unattributed: { dedicated: 0, shared: 0 },
            takenAt: Date.now(),
          });
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), GPU_MEMORY_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, active]);
  if (!api) return null;
  return (
    <section className="gpuMemory" aria-label="GPU memory">
      <h2 className="gpuMemory__title">GPU memory on this PC</h2>
      <GpuMemoryView snapshot={snapshot} />
    </section>
  );
}
