import type { BackgroundController } from './use-backgrounds.js';
import { MAX_OBJECTS_PER_ROOM } from '../../../main/src/rooms/object-settings.js';

/**
 * "Make missing objects": whether objects the Poly Haven library has nothing for are made on this
 * PC (image model, then 3D model), and how many per room. Hidden when the image and 3D steps are
 * not set up, with a hint where to set them up.
 */
export function MakeMissingObjects({ backgrounds }: { backgrounds: BackgroundController }) {
  const { objectSettings: settings, setObjectSettings } = backgrounds;
  if (!settings) return null;
  return (
    <section className="backgroundControls__idle" aria-labelledby="make-objects-title">
      <h3 id="make-objects-title">New objects</h3>
      {settings.available ? (
        <>
          <label className="kiosk__helper">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => void setObjectSettings({ enabled: event.target.checked })}
            />{' '}
            Make missing objects
          </label>
          <div className="control">
            <label htmlFor="make-objects-max">At most this many per room</label>
            <input
              id="make-objects-max"
              type="number"
              min={0}
              max={MAX_OBJECTS_PER_ROOM}
              step={1}
              value={settings.maxPerRoom}
              disabled={!settings.enabled}
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(value)) void setObjectSettings({ maxPerRoom: Math.min(MAX_OBJECTS_PER_ROOM, Math.max(0, value)) });
              }}
            />
          </div>
          <p className="kiosk__helper">
            When the library has no good match, the object is drawn and turned into a 3D model on this PC (the image and 3D
            models from Models and servers). It takes minutes per object, one at a time, after the room is already showing;
            the most important pieces (beds, seats, tables) come first. Objects beyond the limit, or that fail, stay simple
            shapes.
          </p>
        </>
      ) : (
        <p className="kiosk__helper">
          To make missing objects, set up a ComfyUI server for the Concept image and 3D model jobs in Models and servers.
          Until then they become simple shapes.
        </p>
      )}
    </section>
  );
}

/** The objects made so far, with the picture each came from, so a bad one can be removed. */
export function GeneratedObjects({ backgrounds }: { backgrounds: BackgroundController }) {
  const { generatedObjects, removeGeneratedObject } = backgrounds;
  if (generatedObjects.length === 0) return null;
  return (
    <section className="backgroundControls__idle" aria-labelledby="generated-objects-title">
      <h3 id="generated-objects-title">Generated objects</h3>
      <ul className="backgroundCard__objects" aria-label="Generated objects">
        {generatedObjects.map((object) => (
          <li key={object.id}>
            <img src={object.imageUrl} alt="" />
            <span>{object.name}</span>
            <button
              type="button"
              className="backgroundCard__delete"
              aria-label={`Delete generated ${object.name}`}
              onClick={() => void removeGeneratedObject(object.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <p className="kiosk__helper">
        Later rooms reuse these. Deleting one makes rooms that use it show a simple shape instead.
      </p>
    </section>
  );
}
