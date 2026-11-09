import type { BackgroundController } from './use-backgrounds.js';

/** "Describe a room": a text box and a Build button, with progress and any notes about what was left out. */
export function RoomDescribeForm({
  backgrounds,
  prompt,
  onPromptChange,
}: {
  backgrounds: BackgroundController;
  prompt: string;
  onPromptChange: (value: string) => void;
}) {
  const { roomBuilding, roomBusy, roomMaking } = backgrounds;
  return (
    <>
      <form
        className="faces__form"
        aria-label="Describe a room"
        onSubmit={(event) => {
          event.preventDefault();
          void backgrounds.buildRoom(prompt.trim());
        }}
      >
        <label className="faces__field">
          <span>Room description</span>
          <textarea
            rows={3}
            maxLength={1000}
            value={prompt}
            placeholder="A cosy reading room with an armchair by the window and a wall of books…"
            onChange={(event) => onPromptChange(event.target.value)}
            disabled={roomBusy}
          />
        </label>
        <button type="submit" className="faces__submit" disabled={roomBusy || !prompt.trim()}>
          {roomBuilding ? 'Building room…' : roomMaking ? 'Making objects…' : 'Build room'}
        </button>
        {roomBusy ? (
          <button type="button" className="faces__submit" onClick={() => void backgrounds.cancelRoom()}>
            Cancel
          </button>
        ) : null}
      </form>
      <p className="kiosk__helper">
        Describe a room and a language model plans it. Furniture comes from the free Poly Haven library (downloaded the first time
        it is needed). Anything not found is made on this PC from a generated picture when that is switched on below (it takes
        minutes per object and the room is usable meanwhile), else it becomes a simple shape.
      </p>
      {roomBuilding && backgrounds.roomProgress ? <p role="status">{backgrounds.roomProgress}</p> : null}
      {!roomBuilding && roomMaking ? <p role="status">{roomMaking.message}</p> : null}
      {backgrounds.roomWarnings.length > 0 ? (
        <ul className="kiosk__helper" aria-label="Notes about the new room">
          {backgrounds.roomWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
