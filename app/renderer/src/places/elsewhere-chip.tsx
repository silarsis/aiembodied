import type { PlacesSnapshot } from '../../../main/src/places/place-manager.js';
import { describeAbsent, type AbsentAvatar } from './stage-presence.js';

export interface ElsewhereChipProps {
  absent: AbsentAvatar[];
  snapshot: PlacesSnapshot;
  nameOf: (avatarId: string) => string;
  /** Asks main to bring the avatar to this screen's place. */
  onCall: (avatarId: string) => void;
}

/**
 * Who is not on stage: one line each ("Echo is next door"), with a Call button that brings them back.
 * Shown only when somebody is away. An avatar already on the move cannot be called, so its button is off.
 */
export function ElsewhereChip({ absent, snapshot, nameOf, onCall }: ElsewhereChipProps) {
  if (absent.length === 0) return null;
  return (
    <div className="elsewhereChip" role="group" aria-label="Elsewhere" data-testid="elsewhere-chip">
      <span className="elsewhereChip__title">Elsewhere</span>
      <ul className="elsewhereChip__list">
        {absent.map((entry) => {
          const name = nameOf(entry.id);
          return (
            <li key={entry.id} className="elsewhereChip__row">
              <span className="elsewhereChip__text">{describeAbsent(entry, name, snapshot)}</span>
              <button
                type="button"
                className="elsewhereChip__call"
                onClick={() => onCall(entry.id)}
                disabled={entry.state !== 'away'}
                aria-label={`Call ${name}`}
              >
                Call
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
