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
  const { roomBuilding } = backgrounds;
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
            disabled={roomBuilding}
          />
        </label>
        <button type="submit" className="faces__submit" disabled={roomBuilding || !prompt.trim()}>
          {roomBuilding ? 'Building room…' : 'Build room'}
        </button>
        {roomBuilding ? (
          <button type="button" className="faces__submit" onClick={() => void backgrounds.cancelRoom()}>
            Cancel
          </button>
        ) : null}
      </form>
      <p className="kiosk__helper">
        Describe a room and a language model plans it. Furniture comes from the free Poly Haven library (downloaded the first time
        it is needed); anything not found becomes a simple shape.
      </p>
      {roomBuilding && backgrounds.roomProgress ? <p role="status">{backgrounds.roomProgress}</p> : null}
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
