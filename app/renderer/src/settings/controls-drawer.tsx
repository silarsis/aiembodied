import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const SearchContext = createContext('');

/**
 * The side drawer: a search box and one button per area. Each button opens that area's
 * pop-up; the pop-ups themselves are rendered outside the drawer.
 */
export function ControlsDrawer({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key === '/') {
        event.preventDefault();
        onOpenChange(!open);
      } else if (event.key === 'Escape' && open) {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
    } else if (wasOpen.current) {
      handleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      <button
        ref={handleRef}
        type="button"
        className="controlsHandle"
        aria-controls="controls-drawer"
        aria-expanded={open}
        onClick={() => onOpenChange(true)}
        hidden={open}
      >
        Controls
      </button>
      <aside
        id="controls-drawer"
        className="controlsDrawer"
        aria-label="Controls"
        inert={!open}
        aria-hidden={!open}
      >
        <div className="controlsDrawer__header">
          <h2>Controls</h2>
          <button type="button" onClick={() => onOpenChange(false)} aria-label="Close controls">
            ✕ <span>close</span>
          </button>
        </div>
        <label className="sr-only" htmlFor="controls-search">
          Search settings
        </label>
        <input
          ref={searchRef}
          id="controls-search"
          className="controlsDrawer__search"
          type="search"
          placeholder="Search settings…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SearchContext.Provider value={query.trim().toLowerCase()}>
          <nav className="controlsDrawer__groups" aria-label="Settings">
            {children}
            <p className="controlsDrawer__empty" role="status">
              No settings match “{query}”.
            </p>
          </nav>
        </SearchContext.Provider>
      </aside>
      <div className="controlsHint" aria-hidden="true">
        Ctrl / Cmd + / · controls
      </div>
    </>
  );
}

/** One area of the drawer: a button that opens its pop-up. Hidden when the search doesn't match. */
export function ControlButton({
  id,
  title,
  summary,
  keywords = '',
  disabled = false,
  onOpen,
}: {
  id: string;
  title: string;
  summary?: string;
  keywords?: string;
  disabled?: boolean;
  onOpen(): void;
}) {
  const query = useContext(SearchContext);
  const text = [title, summary, keywords].join(' ').toLowerCase();
  const matches = !query || query.split(/\s+/).every((word) => text.includes(word));
  return (
    <button
      type="button"
      id={`controls-${id}`}
      className="controlButton"
      hidden={!matches}
      disabled={disabled}
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      <span className="controlButton__title">{title}</span>
      {summary ? <span className="controlButton__summary">{summary}</span> : null}
      <span className="controlButton__chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
