import { useEffect, useMemo, useState } from 'react';
import { createIdleDirector, type IdleDirector, type IdleDirectorInputs, type IdleExecutor } from './idle-director.js';

export interface UseIdleDirectorOptions extends IdleDirectorInputs {
  executor: IdleExecutor;
  /** The voice pipeline's phase (waiting, listening, transcribing, thinking, responding…). */
  phase: string;
}

/**
 * Runs an `IdleDirector` for the lifetime of the component and keeps it fed with the room, the
 * settings and the voice phase. Returns the director and the "just before this, while idle, you…"
 * note for the model's instructions, which the director only changes while the assistant is not
 * mid-response.
 */
export function useIdleDirector(options: UseIdleDirectorOptions): { director: IdleDirector; idleNote: string } {
  const { executor, room, settings, motionReady, persona, phase, pick, run, avatars } = options;
  const [idleNote, setIdleNote] = useState('');
  const { director, setInputs } = useMemo(() => createIdleDirector(executor, setIdleNote), [executor]);

  // Declared first, so the director sees the new values when the effects below call it.
  useEffect(() => {
    setInputs({ room, settings, motionReady, persona, pick, run, avatars });
  });
  useEffect(() => {
    director.start();
    return () => director.stop();
  }, [director]);
  useEffect(() => {
    director.update();
  }, [director, room, settings.enabled, settings.restlessness, motionReady]);
  useEffect(() => {
    director.setConversationPhase(phase);
  }, [director, phase]);

  return { director, idleNote };
}
