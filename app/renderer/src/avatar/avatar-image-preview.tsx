import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function ExpandedImage({
  src,
  alt,
  onDismiss,
  onPrevious,
  onNext,
}: {
  src: string;
  alt: string;
  onDismiss(): void;
  /** With these, left and right arrows (buttons and keys) step through a set of images. */
  onPrevious?(): void;
  onNext?(): void;
}) {
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
        if (event.key === 'ArrowLeft' && onPrevious) {
          event.preventDefault();
          onPrevious();
        }
        if (event.key === 'ArrowRight' && onNext) {
          event.preventDefault();
          onNext();
        }
      }}
    >
      <div className="avatarPreview__header">
        <span>{alt}</span>
        <button type="button" onClick={onDismiss} aria-label="Close image preview">
          ✕ Close
        </button>
      </div>
      <div className="avatarPreview__stage">
        {onPrevious ? (
          <button
            type="button"
            className="avatarPreview__nav avatarPreview__nav--previous"
            onClick={onPrevious}
            aria-label="Previous image"
          >
            ‹
          </button>
        ) : null}
        <img src={src} alt={`${alt} full size`} className="avatarPreview__fullImage" />
        {onNext ? (
          <button
            type="button"
            className="avatarPreview__nav avatarPreview__nav--next"
            onClick={onNext}
            aria-label="Next image"
          >
            ›
          </button>
        ) : null}
      </div>
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
