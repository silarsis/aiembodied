import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackgroundBridge, BackgroundSummary } from '../../../main/src/backgrounds/types.js';
import { DEFAULT_IDLE_SETTINGS, sanitizeIdleSettings, type IdleSettings } from '../../../main/src/rooms/idle-settings.js';
import type { RoomFile, RoomSummary } from '../../../main/src/rooms/types.js';

export const isRoomId = (id: string | null): id is string => Boolean(id?.startsWith('room:'));

export function useBackgrounds(api?: BackgroundBridge) {
  const [items, setItems] = useState<BackgroundSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loadedImage, setLoadedImage] = useState<{ id: string; url: string } | null>(null);
  const [loadedRoom, setLoadedRoom] = useState<{ id: string; room: RoomFile } | null>(null);
  const [loading, setLoading] = useState(Boolean(api));
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idleSettings, setIdleSettingsState] = useState<IdleSettings>(DEFAULT_IDLE_SETTINGS);
  const idleRef = useRef<IdleSettings>(DEFAULT_IDLE_SETTINGS);
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
