// Types only: shared/ holds what the main process and the renderer both need.

export type CallResult =
  | {
      ok: true;
      avatarId: string;
      name: string;
      /** Somebody is at the place already: nobody was called. */ alreadyHere: boolean;
    }
  | { ok: false; reason: string };
