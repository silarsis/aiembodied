import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const SearchContext = createContext('');
const VisibilityContext = createContext(true);
export function useControlsVisible() {
  return useContext(VisibilityContext);
}

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
  const drawerRef = useRef<HTMLElement>(null);
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
        ref={drawerRef}
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
        <VisibilityContext.Provider value={open}>
          <SearchContext.Provider value={query.trim().toLowerCase()}>
            <div className="controlsDrawer__groups">
              {children}
              <p className="controlsDrawer__empty" role="status">
                No settings match “{query}”.
              </p>
            </div>
          </SearchContext.Provider>
        </VisibilityContext.Provider>
      </aside>
      <div className="controlsHint" aria-hidden="true">
        Ctrl / Cmd + / · controls
      </div>
    </>
  );
}

export function ControlGroup({
  id,
  title,
  summary,
  keywords = '',
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  summary?: string;
  keywords?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const query = useContext(SearchContext);
  const parentVisible = useControlsVisible();
  const [expanded, setExpanded] = useState(defaultOpen);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [matches, setMatches] = useState(true);
  useEffect(() => {
    const text = [title, summary, keywords, bodyRef.current?.textContent].join(' ').toLowerCase();
    setMatches(!query || text.includes(query));
  }, [query, title, summary, keywords, children]);
  useEffect(() => {
    if (!query) return;
    const details = Array.from(bodyRef.current?.querySelectorAll('details') ?? []);
    const original = details.map((element) => element.open);
    details.forEach((element) => {
      element.open = true;
    });
    return () =>
      details.forEach((element, index) => {
        element.open = original[index];
      });
  }, [query]);
  const isOpen = expanded || Boolean(query);
  return (
    <section className="controlGroup" hidden={!matches}>
      <h3 className="controlGroup__heading">
        <button
          type="button"
          id={`controls-${id}-heading`}
          aria-expanded={isOpen}
          aria-controls={`controls-${id}-body`}
          onClick={() => setExpanded(!expanded)}
        >
          <span>{title}</span>
          <span className="controlGroup__summary">{summary}</span>
          <span className="controlGroup__chevron" aria-hidden="true">
            ⌄
          </span>
        </button>
      </h3>
      <div
        ref={bodyRef}
        id={`controls-${id}-body`}
        className="controlGroup__body"
        hidden={!isOpen}
        aria-labelledby={`controls-${id}-heading`}
      >
        <VisibilityContext.Provider value={parentVisible && matches && isOpen}>
          {children}
        </VisibilityContext.Provider>
      </div>
    </section>
  );
}
