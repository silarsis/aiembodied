import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A pop-up for one settings area. Its contents stay mounted while it's closed, so
 * unsaved edits survive closing it and anything that loads on mount (such as the
 * avatar library choosing the active avatar) runs at startup.
 */
export function PanelDialog({
  id,
  title,
  subtitle,
  open,
  onClose,
  wide = false,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  open: boolean;
  onClose(): void;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    } else if (!open && element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [open]);

  return createPortal(
    <dialog
      ref={dialog}
      id={`panel-${id}`}
      className="panelDialog"
      data-wide={wide ? 'true' : undefined}
      aria-labelledby={`panel-${id}-title`}
      onClose={(event) => {
        if (event.target === dialog.current && open) onClose();
      }}
      onCancel={(event) => {
        if (event.target !== dialog.current) return;
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // Escape closes this pop-up only, not the drawer behind it.
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <header className="panelDialog__header">
        <h2 id={`panel-${id}-title`}>{title}</h2>
        {subtitle ? <span>{subtitle}</span> : null}
        <button type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
          ✕ Close
        </button>
      </header>
      <div className="panelDialog__body">{children}</div>
    </dialog>,
    document.body,
  );
}
