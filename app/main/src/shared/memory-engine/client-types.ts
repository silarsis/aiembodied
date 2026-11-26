// Types only: shared/ holds what the main process and the renderer both need.


export interface MemoryEngineSearchResult {
  id: string;
  kind: string;
  source_id: string;
  session_id: string | null;
  agent: string | null;
  period_start: string;
  period_end: string;
  text: string;
  score: number;
  private: boolean;
  /** Cosine similarity to the query, when the item and query were embedded. */
  similarity?: number | null;
  matched?: string[];
  /** Where it came from; absent or "conversation" for memory of conversations. */
  source?: string;
  /** Home Assistant events only: which home it happened in. */
  home_id?: string | null;
  home_name?: string | null;
}


export interface MemoryEngineTimelineSession {
  session_id: string;
  agent: string | null;
  channel: string | null;
  title: string | null;
  started_at: string;
  last_at: string;
  message_count: number;
  /** The background summary of the conversation, once it has one. */
  summary?: { id: string; title: string | null; text: string; topics: string[] } | null;
  turns: Array<{ id: string; at: string; text: string }>;
}


/** A day, week or month summary. */
export interface MemoryEngineSummary {
  id: string;
  kind: string;
  period_start: string;
  period_end: string;
  title: string | null;
  text: string;
  topics: string[];
}


export interface MemoryEngineTimeline {
  summaries: MemoryEngineSummary[];
  sessions: MemoryEngineTimelineSession[];
}


export interface MemoryEngineMemoryDetail {
  id: string;
  kind: string;
  period_start: string;
  session_id?: string;
  agent?: string | null;
  text?: string;
  subject?: string | null;
  status?: string;
  messages?: Array<{ id: string; role: string; speaker: string | null; content: string; tool: { name?: string } | null; created_at: string }>;
}


/** A stored fact, as the engine lists it. */
export interface MemoryEngineStoredFact {
  id: string;
  text: string;
  subject: string | null;
  status: 'active' | 'superseded' | 'retracted';
  pinned: boolean;
  author: 'agent' | 'user' | 'extractor';
  agent: string | null;
  session_id: string | null;
  source_message_ids: string[];
  supersedes: string | null;
  private: boolean;
  reviewed_at: string | null;
  created_at: string;
  /** The model that wrote it (the conversation or summary model); null for the user's own. */
  model?: string | null;
  /** Conversations it was recalled in, and when last. */
  recall_count?: number;
  last_recalled_at?: string | null;
  /** 0-1: how easily it comes up; unused facts fade out of the brief (pinned stay at 1). */
  accessibility?: number;
}


export interface MemoryEngineFactPatch {
  text?: string;
  subject?: string | null;
  pinned?: boolean;
  status?: 'active' | 'superseded' | 'retracted';
  private?: boolean;
  reviewed?: boolean;
}


export interface MemoryEngineRecallLogEntry {
  id: number;
  at: string;
  session_id: string | null;
  query: string;
  items: Array<{ id: string; kind: string; score: number; similarity: number | null }>;
  reason: string | null;
}
