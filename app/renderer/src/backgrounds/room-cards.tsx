import { useEffect, useState } from 'react';
import type { BackgroundController } from './use-backgrounds.js';
import { roomThumbnail } from '../rooms/room-thumbnail.js';

/** Thumbnails come from rendering each room; where WebGL isn't available the card shows a swatch. */
function useRoomThumbnails(backgrounds: BackgroundController): Record<string, string | null> {
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const { rooms, loadRoom, roomRevisions } = backgrounds;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const room of rooms) {
        if (cancelled) return;
        const key = `${room.id}#${roomRevisions[room.id] ?? 0}`;
        let url: string | null = null;
        try {
          const file = await loadRoom(room.id);
          url = file ? await roomThumbnail(file) : null;
        } catch {
          url = null;
        }
        if (cancelled) return;
        setThumbnails((previous) => (key in previous ? previous : { ...previous, [key]: url }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rooms, loadRoom, roomRevisions]);
  return thumbnails;
}

export function RoomCards({ backgrounds, onPickDescription }: { backgrounds: BackgroundController; onPickDescription?: (description: string) => void }) {
  const thumbnails = useRoomThumbnails(backgrounds);
  const selected = backgrounds.rooms.find((room) => room.id === backgrounds.activeId);
  return (
    <>
      <div className="backgroundControls__grid" aria-label="Room choices">
        {backgrounds.rooms.map((room) => {
          const thumbnail = thumbnails[`${room.id}#${backgrounds.roomRevisions[room.id] ?? 0}`];
          const making = backgrounds.roomMaking?.roomId === room.id;
          return (
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
              {thumbnail ? <img src={thumbnail} alt="" /> : <span className="backgroundCard__plain backgroundCard__room" />}
              <span>{room.name}</span>
              {making ? <span className="backgroundCard__making" role="status" aria-label={`Making new objects for ${room.name}`} /> : null}
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
          );
        })}
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
