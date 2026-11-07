import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  MemoryEngineBridge,
  MemoryEngineMemoryDetail,
  MemoryEngineRecallLogEntry,
  MemoryEngineSearchResult,
  MemoryEngineStoredFact,
  MemoryEngineTimeline,
  MemoryPanelStatus,
} from '../../../main/src/memory-engine/bridge-types.js';

type Tab = 'facts' | 'conversations' | 'search' | 'recalled';
type FactFilter = 'active' | 'unreviewed' | 'old';

const TABS: { id: Tab; label: string }[] = [
  { id: 'facts', label: 'Facts' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'search', label: 'Search' },
  { id: 'recalled', label: 'Recalled' },
];

const KIND_LABELS: Record<string, string> = {
  turn: 'Exchange',
  fact: 'Fact',
  session: 'Conversation summary',
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback;
}

function formatWhen(iso: string, withTime = true) {
  const date = new Date(iso);
  const day = date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return withTime ? `${day}, ${date.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}` : day;
}

function localDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function authorLabel(fact: MemoryEngineStoredFact) {
  const model = fact.model ? ` (${fact.model})` : '';
  if (fact.author === 'user') return 'added by you';
  if (fact.author === 'extractor') return `found in a conversation${model}`;
  return fact.agent ? `noted by ${fact.agent}${model}` : `noted in conversation${model}`;
}

/** Unpinned facts that are rarely used drop out of the conversation brief (still searchable). */
function fadingLabel(fact: MemoryEngineStoredFact) {
  if (fact.pinned || fact.status !== 'active' || fact.accessibility === undefined) return null;
  return fact.accessibility < 0.25 ? 'fading: rarely comes up' : null;
}

/** The most conversations one day lists (the engine's own maximum). */
const DAY_LIMIT = 200;

function statusSummary(status: MemoryPanelStatus | null): string {
  if (!status) return 'Checking…';
  if (!status.enabled) return 'Long-term memory is off (MEMORY_ENABLED=0).';
  if (!status.reachable) {
    return `The memory engine isn’t reachable at ${status.url}.${status.pending ? ` ${status.pending} writes are queued and will be sent when it is.` : ''}`;
  }
  const health = status.health ?? {};
  const counts = (health.counts ?? {}) as { sessions?: number; messages?: number };
  const parts = [
    health.database === 'ready' ? `${counts.sessions ?? 0} conversations, ${counts.messages ?? 0} messages` : 'database starting',
    health.embedder ? 'meaning search on' : 'word search only',
  ];
  const summariser = health.summariser as { model?: string; error?: string } | null | undefined;
  parts.push(summariser ? (summariser.error ? 'summaries failing (see the engine log)' : `summaries by ${summariser.model}`) : 'no summaries');
  const storage = health.storage as
    | {
        database?: { local?: boolean; where?: string };
        mirror?: { where?: string; error?: string | null } | null;
        moving?: boolean;
        move_error?: string | null;
      }
    | undefined;
  if (storage?.moving) parts.push('copying memory to the new database');
  else if (storage?.move_error) parts.push(`not moved: ${storage.move_error}`);
  else if (storage?.database && !storage.database.local) parts.push(`kept on ${storage.database.where}`);
  if (storage?.mirror) parts.push(storage.mirror.error ? `mirror to ${storage.mirror.where} failing` : `mirrored to ${storage.mirror.where}`);
  if (status.pending) parts.push(`${status.pending} writes queued`);
  return parts.join(' · ');
}

/** A button that asks "really?" on the first press and acts on the second. */
function ConfirmButton({ label, confirmLabel, disabled, onConfirm }: { label: string; confirmLabel: string; disabled?: boolean; onConfirm(): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? 'memoryPanel__danger' : undefined}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/**
 * The Memory pop-up: what the assistant remembers. Facts to check and correct, conversations by
 * day (with their summaries) to read or forget, search, and what auto-recall put in front of the
 * model. `active` is true while the pop-up is open, so it reloads each time it opens.
 */
export function MemoryPanel({ memory, active }: { memory?: MemoryEngineBridge; active: boolean }) {
  const [tab, setTab] = useState<Tab>('facts');
  const [status, setStatus] = useState<MemoryPanelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<MemoryEngineMemoryDetail | null>(null);

  const [factFilter, setFactFilter] = useState<FactFilter>('active');
  const [facts, setFacts] = useState<MemoryEngineStoredFact[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; subject: string } | null>(null);
  const [draft, setDraft] = useState({ text: '', subject: '', pinned: false });

  const [day, setDay] = useState(() => localDay(new Date()));
  const [timeline, setTimeline] = useState<MemoryEngineTimeline | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryEngineSearchResult[] | null>(null);

  const [recalled, setRecalled] = useState<MemoryEngineRecallLogEntry[] | null>(null);

  const run = useCallback(async (key: string, action: () => Promise<unknown>, fallback: string) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure, fallback));
    } finally {
      setBusy(null);
    }
  }, []);

  const loadFacts = useCallback(async () => {
    if (!memory) return;
    const options =
      factFilter === 'unreviewed'
        ? { status: 'active' as const, unreviewed: true }
        : factFilter === 'old'
          ? { status: 'all' as const }
          : { status: 'active' as const };
    const list = await memory.facts(options);
    setFacts(factFilter === 'old' ? list.filter((fact) => fact.status !== 'active') : list);
  }, [memory, factFilter]);

  const loadDay = useCallback(async () => {
    if (!memory) return;
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    setTimeline(await memory.timeline(day.toISOString(), next.toISOString()));
  }, [memory, day]);

  const loadRecalled = useCallback(async () => {
    if (!memory) return;
    setRecalled(await memory.recallLog(100));
  }, [memory]);

  const reload = useCallback(async () => {
    if (!memory) return;
    const next = await memory.status().catch(() => null);
    setStatus(next);
    if (!next?.reachable) return;
    if (tab === 'facts') await run('load', loadFacts, 'Couldn’t load the facts.');
    if (tab === 'conversations') await run('load', loadDay, 'Couldn’t load that day.');
    if (tab === 'recalled') await run('load', loadRecalled, 'Couldn’t load what was recalled.');
  }, [memory, tab, run, loadFacts, loadDay, loadRecalled]);

  useEffect(() => {
    if (active) void Promise.resolve().then(reload);
  }, [active, reload]);

  if (!memory) {
    return <p className="kiosk__helper">The Memory panel needs a newer app build.</p>;
  }

  const open = (id: string) =>
    void run(`open:${id}`, async () => setOpened(await memory.memory(id, 1)), 'Couldn’t open that memory.');

  const handleAdd = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.text.trim()) return;
    void run(
      'add',
      async () => {
        await memory.addFact({ text: draft.text, subject: draft.subject || undefined, pinned: draft.pinned });
        setDraft({ text: '', subject: '', pinned: false });
        await loadFacts();
      },
      'Couldn’t save that fact.',
    );
  };

  const changeFact = (fact: MemoryEngineStoredFact, patch: Parameters<MemoryEngineBridge['updateFact']>[1]) =>
    void run(
      fact.id,
      async () => {
        await memory.updateFact(fact.id, patch);
        await loadFacts();
      },
      'Couldn’t save that.',
    );

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    void run('search', async () => setResults(await memory.search(query)), 'Search failed.');
  };

  const reachable = status?.reachable === true;

  return (
    <div className="memoryPanel toolsSettings">
      <section className="toolsSettings__section" aria-label="Memory engine status">
        <p className="kiosk__helper" role="status">
          {statusSummary(status)}
        </p>
        {reachable && status?.health?.summariser ? (
          <div className="toolsSettings__actions">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  'summaries',
                  async () => {
                    const { done } = await memory.runSummaries();
                    setError(done.length ? null : 'Nothing was waiting to be summarised.');
                    await reload();
                  },
                  'Summaries failed.',
                )
              }
            >
              {busy === 'summaries' ? 'Summarising…' : 'Summarise now'}
            </button>
            <span className="kiosk__helper">Otherwise this happens on its own while the assistant is idle.</span>
          </div>
        ) : null}
      </section>

      <div className="memoryPanel__tabs" role="tablist" aria-label="Memory sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id);
              setOpened(null);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="memoryPanel__error" role="alert">
          {error}
        </p>
      ) : null}

      {opened ? (
        <article className="toolsSettings__server memoryPanel__opened" aria-label="Opened memory">
          <div className="toolsSettings__serverHeader">
            <strong>{KIND_LABELS[opened.kind] ?? opened.kind}</strong>
            <span className="kiosk__helper">{formatWhen(opened.period_start)}</span>
            <button type="button" className="toolsSettings__status" onClick={() => setOpened(null)}>
              Close
            </button>
          </div>
          {opened.text ? <p>{opened.text}</p> : null}
          {opened.messages?.length ? (
            <ul className="toolsSettings__list memoryPanel__messages">
              {opened.messages.map((message) => (
                <li key={message.id}>
                  <strong>{message.role === 'user' ? message.speaker ?? 'You' : message.role === 'tool' ? message.tool?.name ?? 'Tool' : opened.agent ?? 'Assistant'}</strong>
                  <span>{message.content}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ) : null}

      {!reachable ? null : tab === 'facts' ? (
        <section className="toolsSettings__section" aria-label="Facts">
          <div className="toolsSettings__actions">
            <label>
              Show{' '}
              <select value={factFilter} onChange={(event) => setFactFilter(event.target.value as FactFilter)}>
                <option value="active">Everything known</option>
                <option value="unreviewed">New since you last checked</option>
                <option value="old">Replaced or retracted</option>
              </select>
            </label>
            {factFilter === 'unreviewed' && facts?.length ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    'review',
                    async () => {
                      await memory.reviewFacts(facts.map((fact) => fact.id));
                      await loadFacts();
                    },
                    'Couldn’t mark those as checked.',
                  )
                }
              >
                Mark all as checked
              </button>
            ) : null}
          </div>
          {facts === null ? (
            <p className="kiosk__helper">Loading…</p>
          ) : facts.length === 0 ? (
            <p className="kiosk__helper">{factFilter === 'unreviewed' ? 'Nothing new to check.' : 'No facts here yet.'}</p>
          ) : (
            <ul className="toolsSettings__list">
              {facts.map((fact) => (
                <li key={fact.id} className="memoryPanel__fact" data-status={fact.status}>
                  {editing?.id === fact.id ? (
                    <form
                      className="memoryPanel__edit"
                      onSubmit={(event) => {
                        event.preventDefault();
                        changeFact(fact, { text: editing.text, subject: editing.subject || null, reviewed: true });
                        setEditing(null);
                      }}
                    >
                      <input aria-label="Fact" value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
                      <input
                        aria-label="Subject"
                        placeholder="Subject"
                        value={editing.subject}
                        onChange={(event) => setEditing({ ...editing, subject: event.target.value })}
                      />
                      <button type="submit" disabled={!editing.text.trim()}>
                        Save
                      </button>
                      <button type="button" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <span className="memoryPanel__factText">
                      {fact.pinned ? '📌 ' : ''}
                      {fact.text}
                    </span>
                  )}
                  <span className="kiosk__helper">
                    {[fact.subject, authorLabel(fact), formatWhen(fact.created_at, false), fact.status !== 'active' ? fact.status : null, fadingLabel(fact)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="toolsSettings__actions">
                    {fact.status === 'active' ? (
                      <>
                        <button type="button" disabled={busy !== null} onClick={() => changeFact(fact, { pinned: !fact.pinned, reviewed: true })}>
                          {fact.pinned ? 'Unpin' : 'Pin'}
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => setEditing({ id: fact.id, text: fact.text, subject: fact.subject ?? '' })}
                        >
                          Edit
                        </button>
                        {!fact.reviewed_at ? (
                          <button type="button" disabled={busy !== null} onClick={() => changeFact(fact, { reviewed: true })}>
                            Looks right
                          </button>
                        ) : null}
                        <button type="button" disabled={busy !== null} onClick={() => changeFact(fact, { status: 'retracted', reviewed: true })}>
                          Not true
                        </button>
                      </>
                    ) : (
                      <button type="button" disabled={busy !== null} onClick={() => changeFact(fact, { status: 'active', reviewed: true })}>
                        Restore
                      </button>
                    )}
                    {fact.status === 'active' && (fact.session_id || fact.source_message_ids.length) ? (
                      <button type="button" disabled={busy !== null} onClick={() => open(fact.id)}>
                        Where from?
                      </button>
                    ) : null}
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Really delete?"
                      disabled={busy !== null}
                      onConfirm={() =>
                        void run(
                          fact.id,
                          async () => {
                            await memory.deleteFact(fact.id);
                            await loadFacts();
                          },
                          'Couldn’t delete that.',
                        )
                      }
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form className="toolsSettings__add memoryPanel__addFact" onSubmit={handleAdd} aria-label="Add a fact">
            <label>
              Add a fact the assistant should know
              <input
                value={draft.text}
                placeholder="Prefers tea to coffee"
                onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              />
            </label>
            <div className="toolsSettings__actions">
              <input
                aria-label="Subject (optional)"
                placeholder="Subject (optional)"
                value={draft.subject}
                onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
              />
              <label>
                <input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} /> Pin it
                (always in the brief)
              </label>
              <button type="submit" className="faces__submit" disabled={busy !== null || !draft.text.trim()}>
                {busy === 'add' ? 'Saving…' : 'Add'}
              </button>
            </div>
          </form>
        </section>
      ) : tab === 'conversations' ? (
        <section className="toolsSettings__section" aria-label="Conversations">
          <div className="toolsSettings__actions">
            <button type="button" onClick={() => setDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1))} aria-label="Previous day">
              ←
            </button>
            <input
              type="date"
              aria-label="Day"
              value={dayInputValue(day)}
              onChange={(event) => {
                const [y, m, d] = event.target.value.split('-').map(Number);
                if (y && m && d) setDay(new Date(y, m - 1, d));
              }}
            />
            <button type="button" onClick={() => setDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1))} aria-label="Next day">
              →
            </button>
            <button type="button" onClick={() => setDay(localDay(new Date()))}>
              Today
            </button>
          </div>
          {timeline === null ? (
            <p className="kiosk__helper">Loading…</p>
          ) : timeline.sessions.length === 0 ? (
            <p className="kiosk__helper">No conversations on {formatWhen(day.toISOString(), false)}.</p>
          ) : (
            <>
              {timeline.sessions.length >= DAY_LIMIT ? (
                <p className="kiosk__helper" role="note">
                  Showing the first {DAY_LIMIT} conversations of this day; search finds the later ones.
                </p>
              ) : null}
              {timeline.sessions.map((session) => (
              <article key={session.session_id} className="toolsSettings__server" aria-label={session.summary?.title ?? session.title ?? 'Conversation'}>
                <div className="toolsSettings__serverHeader">
                  <strong>{session.summary?.title ?? session.title ?? 'Conversation'}</strong>
                  <span className="kiosk__helper">
                    {formatWhen(session.started_at)} · {session.agent ?? 'assistant'} · {session.message_count} messages
                  </span>
                </div>
                {session.summary ? <p>{session.summary.text}</p> : <p className="kiosk__helper">Not summarised yet.</p>}
                <div className="toolsSettings__actions">
                  <button type="button" onClick={() => setExpanded(expanded === session.session_id ? null : session.session_id)}>
                    {expanded === session.session_id ? 'Hide exchanges' : 'Show exchanges'}
                  </button>
                  <ConfirmButton
                    label="Forget this conversation"
                    confirmLabel="Really forget it? This can’t be undone."
                    disabled={busy !== null}
                    onConfirm={() =>
                      void run(
                        session.session_id,
                        async () => {
                          await memory.forgetSession(session.session_id);
                          await loadDay();
                        },
                        'Couldn’t forget that conversation.',
                      )
                    }
                  />
                </div>
                {expanded === session.session_id ? (
                  <ul className="toolsSettings__list memoryPanel__messages">
                    {session.turns.map((turn) => (
                      <li key={turn.id}>
                        <span className="kiosk__helper">{formatWhen(turn.at)}</span>
                        <span className="memoryPanel__turn">{turn.text}</span>
                        <button type="button" onClick={() => open(turn.id)}>
                          Open
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
              ))}
            </>
          )}
        </section>
      ) : tab === 'search' ? (
        <section className="toolsSettings__section" aria-label="Search memory">
          <form className="toolsSettings__actions" onSubmit={handleSearch} role="search">
            <input aria-label="Search memory" placeholder="tomatoes, the car, last trip…" value={query} onChange={(event) => setQuery(event.target.value)} />
            <button type="submit" className="faces__submit" disabled={busy !== null || !query.trim()}>
              {busy === 'search' ? 'Searching…' : 'Search'}
            </button>
          </form>
          {results === null ? null : results.length === 0 ? (
            <p className="kiosk__helper">Nothing found.</p>
          ) : (
            <ul className="toolsSettings__list">
              {results.map((result) => (
                <li key={result.id}>
                  <span className="kiosk__helper">
                    {KIND_LABELS[result.kind] ?? result.kind} · {formatWhen(result.period_start, false)}
                    {result.agent ? ` · ${result.agent}` : ''}
                  </span>
                  <span className="memoryPanel__turn">{result.text}</span>
                  <button type="button" onClick={() => open(result.id)}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section className="toolsSettings__section" aria-label="Recalled">
          <p className="kiosk__helper">
            Before each reply, memories that closely match what you said are added for the assistant to see. Most turns get none.
          </p>
          {recalled === null ? (
            <p className="kiosk__helper">Loading…</p>
          ) : recalled.length === 0 ? (
            <p className="kiosk__helper">Nothing has been recalled yet.</p>
          ) : (
            <ul className="toolsSettings__list">
              {recalled.map((entry) => (
                <li key={entry.id}>
                  <span className="kiosk__helper">{formatWhen(entry.at)}</span>
                  <span className="memoryPanel__turn">“{entry.query}”</span>
                  {entry.items.length ? (
                    <span className="toolsSettings__actions">
                      {entry.items.map((item, index) => (
                        <button key={item.id} type="button" onClick={() => open(item.id)} title={`similarity ${item.similarity?.toFixed(2) ?? '–'}`}>
                          {KIND_LABELS[item.kind] ?? item.kind} {index + 1}
                        </button>
                      ))}
                    </span>
                  ) : (
                    <span className="kiosk__helper">
                      {entry.reason === 'short' ? 'too short to look up' : entry.reason === 'no embedder' ? 'meaning search off' : 'no close match'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
