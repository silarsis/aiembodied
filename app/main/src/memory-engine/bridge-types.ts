/** The Memory panel's bridge from the renderer, shared by preload and renderer. Types only. */
import type {
  MemoryEngineFactPatch,
  MemoryEngineMemoryDetail,
  MemoryEngineRecallLogEntry,
  MemoryEngineSearchResult,
  MemoryEngineStoredFact,
  MemoryEngineTimeline,
} from './client.js';
import type { MemoryPanelStatus } from './ipc.js';

export type {
  MemoryEngineFactPatch,
  MemoryEngineMemoryDetail,
  MemoryEngineRecallLogEntry,
  MemoryEngineSearchResult,
  MemoryEngineStoredFact,
  MemoryEngineTimeline,
  MemoryPanelStatus,
};

export interface MemoryEngineBridge {
  status(): Promise<MemoryPanelStatus>;
  search(query: string, period?: { from?: string; to?: string }): Promise<MemoryEngineSearchResult[]>;
  timeline(from: string, to: string): Promise<MemoryEngineTimeline>;
  memory(id: string, around?: number): Promise<MemoryEngineMemoryDetail>;
  facts(options?: { status?: 'active' | 'superseded' | 'retracted' | 'all'; unreviewed?: boolean }): Promise<MemoryEngineStoredFact[]>;
  addFact(fact: { text: string; subject?: string; pinned?: boolean }): Promise<{ id: string }>;
  updateFact(id: string, patch: MemoryEngineFactPatch): Promise<{ id: string }>;
  reviewFacts(ids: string[]): Promise<{ reviewed: number }>;
  deleteFact(id: string): Promise<unknown>;
  forgetSession(id: string): Promise<{ forgotten: string; dropped: number }>;
  recallLog(limit?: number): Promise<MemoryEngineRecallLogEntry[]>;
  runSummaries(): Promise<{ done: Array<Record<string, unknown>> }>;
}
