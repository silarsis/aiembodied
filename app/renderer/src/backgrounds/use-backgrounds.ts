import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackgroundBridge, BackgroundSummary } from '../../../main/src/backgrounds/types.js';
import { DEFAULT_IDLE_SETTINGS, sanitizeIdleSettings, type IdleSettings } from '../../../main/src/rooms/idle-settings.js';
import type { GeneratedObjectSummary, ObjectSettings, ObjectSettingsView } from '../../../main/src/rooms/object-settings.js';
import type { RoomGenerationProgress } from '../../../main/src/rooms/room-generation.js';
import type { RoomFile, RoomSummary } from '../../../main/src/rooms/types.js';

export const isRoomId = (id: string | null): id is string => Boolean(id?.startsWith('room:'));

/**
 * `forcedId` fixes the stage to one room or background instead of the one bija has active: a satellite shows the room
 * of its place. `undefined` means not forced; `null` is forced but not known yet (nothing is shown until it is).
 */
export function useBackgrounds(api?: BackgroundBridge, forcedId?: string | null) {
  const [items, setItems] = useState<BackgroundSummary[]>([]);
  const [storedActiveId, setActiveId] = useState<string | null>(null);
  const activeId = forcedId !== undefined ? forcedId : storedActiveId;
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loadedImage, setLoadedImage] = useState<{ id: string; url: string } | null>(null);
  const [loadedRoom, setLoadedRoom] = useState<{ id: string; room: RoomFile } | null>(null);
  const [loading, setLoading] = useState(Boolean(api));
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomBuilding, setRoomBuilding] = useState(false);
  const [roomProgress, setRoomProgress] = useState<string>('');
  const [roomWarnings, setRoomWarnings] = useState<string[]>([]);
  const [idleSettings, setIdleSettingsState] = useState<IdleSettings>(DEFAULT_IDLE_SETTINGS);
  const idleRef = useRef<IdleSettings>(DEFAULT_IDLE_SETTINGS);
  /** The saved room whose new objects are still being made in the background. */
  const [roomMaking, setRoomMaking] = useState<{ roomId: string; message: string } | null>(null);
  const [objectSettings, setObjectSettingsState] = useState<ObjectSettingsView | null>(null);
  const [generatedObjects, setGeneratedObjects] = useState<GeneratedObjectSummary[]>([]);
  /** Counts up per room each time its file changed, so cached pictures of it can be redrawn. */
  const [roomRevisions, setRoomRevisions] = useState<Record<string, number>>({});
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const selection = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    Promise.all([api.list(), api.getActive(), api.listRooms().catch(() => [] as RoomSummary[])])
      .then(([next, active, nextRooms]) => {
        if (!cancelled) {
          setItems(next);
          setRooms(nextRooms);
          setActiveId(active);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(message(cause));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!api?.getIdleSettings) return;
    let cancelled = false;
    api
      .getIdleSettings()
      .then((saved) => {
        if (cancelled) return;
        idleRef.current = sanitizeIdleSettings(saved);
        setIdleSettingsState(idleRef.current);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  const refreshGenerated = useCallback(async () => {
    if (!api?.listGeneratedObjects) return;
    try {
      const next = await api.listGeneratedObjects();
      if (alive.current) setGeneratedObjects(next);
    } catch {
      /* The list is a convenience; the rooms still work. */
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .listGeneratedObjects?.()
      .then((list) => {
        if (!cancelled) setGeneratedObjects(list);
      })
      .catch(() => undefined);
    api
      .getObjectSettings?.()
      .then((saved) => {
        if (!cancelled && saved) setObjectSettingsState(saved);
      })
      .catch(() => undefined);
    api
      .getMakingRoom?.()
      .then((roomId) => {
        if (!cancelled && roomId) setRoomMaking((previous) => previous ?? { roomId, message: 'Making new objects…' });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  /** Applies at once and saves under `rooms.objects`. */
  const setObjectSettings = useCallback(
    async (patch: Partial<ObjectSettings>) => {
      if (!api?.setObjectSettings) return;
      try {
        const saved = await api.setObjectSettings(patch);
        if (alive.current) setObjectSettingsState(saved);
      } catch (cause) {
        if (alive.current) setError(message(cause));
      }
    },
    [api],
  );

  /** Applies at once and saves under `rooms.idle`. */
  const setIdleSettings = useCallback(
    async (patch: Partial<IdleSettings>) => {
      const next = sanitizeIdleSettings({ ...idleRef.current, ...patch });
      idleRef.current = next;
      setIdleSettingsState(next);
      try {
        await api?.setIdleSettings?.(next);
      } catch (cause) {
        if (alive.current) setError(message(cause));
      }
    },
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    if (api && isRoomId(activeId)) {
      api
        .loadRoom(activeId)
        .then((room) => {
          if (!cancelled) setLoadedRoom({ id: activeId, room });
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(message(cause));
        });
    } else if (api && activeId) {
      api
        .load(activeId)
        .then((image) => {
          if (!cancelled) setLoadedImage({ id: activeId, url: image });
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(message(cause));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [api, activeId]);

  const select = useCallback(
    async (id: string | null) => {
      if (!api) return;
      const ticket = ++selection.current;
      setError(null);
      try {
        await api.setActive(id);
        if (alive.current && ticket === selection.current) setActiveId(id);
      } catch (cause) {
        if (alive.current) setError(message(cause));
      }
    },
    [api],
  );

  const generate = useCallback(
    async (prompt: string) => {
      if (!api) return false;
      setGenerating(true);
      setError(null);
      try {
        const created = await api.generate(prompt);
        if (alive.current) setItems((previous) => [...previous, created]);
        return true;
      } catch (cause) {
        if (alive.current) setError(message(cause));
        return false;
      } finally {
        if (alive.current) setGenerating(false);
      }
    },
    [api],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!api) return;
      setError(null);
      try {
        await api.delete(id);
        const [next, active] = await Promise.all([api.list(), api.getActive()]);
        if (alive.current) {
          setItems(next);
          setActiveId(active);
        }
      } catch (cause) {
        if (alive.current) setError(message(cause));
      }
    },
    [api],
  );

  useEffect(() => {
    if (!api?.onRoomProgress) return;
    return api.onRoomProgress((progress: RoomGenerationProgress) => {
      if (!alive.current) return;
      if (progress.phase === 'making' && progress.roomId) {
        setRoomMaking({ roomId: progress.roomId, message: progress.message });
      } else if (progress.phase === 'done' && progress.roomId) {
        setRoomMaking(null);
        const notes = progress.warnings ?? [];
        if (notes.length) setRoomWarnings((previous) => [...previous, ...notes.filter((note) => !previous.includes(note))]);
        void refreshGenerated();
      } else {
        setRoomProgress(progress.message);
      }
    });
  }, [api, refreshGenerated]);

  /** The main process changed a saved room's file: show the new version if it is the stage. */
  useEffect(() => {
    if (!api?.onRoomUpdated) return;
    return api.onRoomUpdated((roomId: string) => {
      if (!alive.current) return;
      setRoomRevisions((previous) => ({ ...previous, [roomId]: (previous[roomId] ?? 0) + 1 }));
      void refreshGenerated();
      if (activeIdRef.current !== roomId) return;
      api
        .loadRoom(roomId)
        .then((room) => {
          if (alive.current && activeIdRef.current === roomId) setLoadedRoom({ id: roomId, room });
        })
        .catch(() => undefined);
    });
  }, [api, refreshGenerated]);

  /** Describes a room in words; on success the new room is listed and becomes the stage. */
  const buildRoom = useCallback(
    async (description: string) => {
      if (!api?.generateRoom) return false;
      setRoomBuilding(true);
      setRoomWarnings([]);
      setRoomProgress('Planning the room');
      setError(null);
      try {
        const result = await api.generateRoom(description);
        const next = await api.listRooms();
        if (!alive.current) return true;
        setRooms(next);
        setRoomWarnings(result.warnings);
        if (result.making) setRoomMaking((previous) => previous ?? { roomId: result.room.id, message: 'Making new objects…' });
        await api.setActive(result.room.id);
        if (alive.current) setActiveId(result.room.id);
        return true;
      } catch (cause) {
        if (alive.current) setError(message(cause));
        return false;
      } finally {
        if (alive.current) {
          setRoomBuilding(false);
          setRoomProgress('');
        }
      }
    },
    [api],
  );

  const cancelRoom = useCallback(async () => {
    await api?.cancelRoomGeneration?.();
  }, [api]);

  const removeRoom = useCallback(
    async (id: string) => {
      if (!api?.deleteRoom) return;
      setError(null);
      try {
        await api.deleteRoom(id);
        const [next, active] = await Promise.all([api.listRooms(), api.getActive()]);
        if (alive.current) {
          setRooms(next);
          setActiveId(active);
        }
      } catch (cause) {
        if (alive.current) setError(message(cause));
      }
    },
    [api],
  );

  /** Deletes a generated object; rooms that used it show a simple shape the next time they load. */
  const removeGeneratedObject = useCallback(
    async (id: string) => {
      if (!api?.deleteGeneratedObject) return;
      setError(null);
      try {
        await api.deleteGeneratedObject(id);
        await refreshGenerated();
        const current = activeIdRef.current;
        if (isRoomId(current)) {
          const room = await api.loadRoom(current);
          if (alive.current && activeIdRef.current === current) setLoadedRoom({ id: current, room });
        }
      } catch (cause) {
        if (alive.current) setError(message(cause));
      }
    },
    [api, refreshGenerated],
  );

  const activeKind: '2d' | '3d' = isRoomId(activeId) ? '3d' : '2d';
  const active = items.find((item) => item.id === activeId) ?? null;
  const activeRoomSummary = rooms.find((room) => room.id === activeId) ?? null;

  const loadRoom = useCallback(async (id: string) => (api ? api.loadRoom(id) : null), [api]);

  return {
    items,
    rooms,
    loadRoom,
    activeId,
    activeKind,
    active,
    activeRoomSummary,
    /** Name for summaries: the room in 3D mode, the picture in 2D mode. */
    activeName: activeRoomSummary?.name ?? active?.name ?? 'Plain background',
    activeRoom: activeKind === '3d' && loadedRoom?.id === activeId ? loadedRoom.room : null,
    imageUrl: activeKind === '2d' && loadedImage?.id === activeId ? loadedImage.url : null,
    idleSettings,
    setIdleSettings,
    loading,
    generating,
    roomBuilding,
    roomMaking,
    /** A room is being planned or its objects made: no other can be started. */
    roomBusy: roomBuilding || roomMaking !== null,
    roomRevisions,
    objectSettings,
    setObjectSettings,
    generatedObjects,
    removeGeneratedObject,
    roomProgress,
    roomWarnings,
    buildRoom,
    cancelRoom,
    removeRoom,
    error,
    select,
    generate,
    remove,
    available: Boolean(api),
  };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The background could not be updated.';
}

export type BackgroundController = ReturnType<typeof useBackgrounds>;
