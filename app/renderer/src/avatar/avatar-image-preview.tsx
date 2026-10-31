import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function ExpandedImage({ src, alt, onDismiss }: { src: string; alt: string; onDismiss(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="avatarPreview__dialog"
      aria-label={`${alt} full-size preview`}
      onClose={onDismiss}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onKeyDown={(event) => {
        // Escape dismisses this popup without also closing the controls drawer.
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <div className="avatarPreview__header">
        <span>{alt}</span>
        <button type="button" onClick={onDismiss} aria-label="Close image preview">
          ✕ Close
        </button>
      </div>
      <img src={src} alt={`${alt} full size`} className="avatarPreview__fullImage" />
    </dialog>,
    document.body,
  );
}

export function AvatarImagePreview({
  src,
  alt,
  caption,
}: {
  src: string;
  alt: string;
  caption: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <figure className="avatarPreview">
      <button
        type="button"
        className="avatarPreview__thumbnail"
        aria-label={`Enlarge ${alt.toLowerCase()}`}
        aria-haspopup="dialog"
        title="Click to enlarge"
        onClick={() => setExpanded(true)}
      >
        <img src={src} alt={alt} />
      </button>
      <figcaption>{caption}</figcaption>
      {expanded ? <ExpandedImage src={src} alt={alt} onDismiss={() => setExpanded(false)} /> : null}
    </figure>
  );
}
