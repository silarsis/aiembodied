import { useEffect, useState } from 'react';
import type { BackgroundController } from './use-backgrounds.js';
import { roomThumbnail } from '../rooms/room-thumbnail.js';

/** Thumbnails come from rendering each room; where WebGL isn't available the card shows a swatch. */
function useRoomThumbnails(backgrounds: BackgroundController): Record<string, string | null> {
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const { rooms, loadRoom } = backgrounds;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const room of rooms) {
        if (cancelled) return;
        let url: string | null = null;
        try {
          const file = await loadRoom(room.id);
          url = file ? await roomThumbnail(file) : null;
        } catch {
          url = null;
        }
        if (cancelled) return;
        setThumbnails((previous) => (room.id in previous ? previous : { ...previous, [room.id]: url }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rooms, loadRoom]);
  return thumbnails;
}

export function RoomCards({ backgrounds, onPickDescription }: { backgrounds: BackgroundController; onPickDescription?: (description: string) => void }) {
  const thumbnails = useRoomThumbnails(backgrounds);
  const selected = backgrounds.rooms.find((room) => room.id === backgrounds.activeId);
  return (
    <>
      <div className="backgroundControls__grid" aria-label="Room choices">
        {backgrounds.rooms.map((room) => (
          <div className="backgroundCard__entry" key={room.id}>
            <button
              type="button"
              className="backgroundCard"
              aria-pressed={room.id === backgrounds.activeId}
              onClick={() => {
                if (room.description && !room.builtIn && !backgrounds.roomBuilding) onPickDescription?.(room.description);
                void backgrounds.select(room.id);
              }}
            >
              {thumbnails[room.id] ? (
                <img src={thumbnails[room.id] ?? undefined} alt="" />
              ) : (
                <span className="backgroundCard__plain backgroundCard__room" />
              )}
              <span>{room.name}</span>
            </button>
            {!room.builtIn ? (
              <button
                type="button"
                className="backgroundCard__delete"
                aria-label={`Delete ${room.name}`}
                onClick={() => void backgrounds.removeRoom(room.id)}
              >
                Delete
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {backgrounds.rooms.length === 0 && !backgrounds.loading ? (
        <p className="kiosk__helper">No rooms are available.</p>
      ) : null}
      <p className="kiosk__helper">
        {selected?.description ?? 'Pick a room and the avatar will stand in it.'}
      </p>
    </>
  );
}
