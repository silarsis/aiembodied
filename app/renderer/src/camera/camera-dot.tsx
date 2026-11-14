/**
 * A small dot in the corner of bija's own stage while its camera is live (green), so a camera that films Kevin's
 * desk is never on without a sign. Nothing is drawn while it is off. A satellite shows its own pair of dots instead.
 */
export function CameraLiveDot({ live }: { live: boolean }) {
  if (!live) return null;
  return (
    <div className="deviceDots" role="group" aria-label="Camera" data-testid="camera-live">
      <span className="deviceDot" data-level="live" data-testid="camera-live-dot" title="Camera presence is on: it only notes that a face is there" role="img" aria-label="Camera live" />
    </div>
  );
}
