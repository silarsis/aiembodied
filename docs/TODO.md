# TODO

The goal is the best of Project Akari and Dipal D1, plus what only aiembodied
does (fully local, text-to-motion, local avatar generation, provider choice per
part). Each item notes where aiembodied stands today and how the competition
does it.

Competition, as researched on 2026-10-29 from marketing pages and press (not
hands-on):

- **Project Akari** (Maruko Labs, <https://marukolabs.com/akari>): desktop app
  for Windows, macOS, Linux and Raspberry Pi 5. VRM avatar, OpenAI Realtime
  plus ElevenLabs, no local models. $79 to $99 once.
- **Dipal D1** (<https://www.tripo3d.ai/blog/dipal-d1-with-tripo>): desktop
  "character pod" with an 8" curved OLED, eye tracking and a touch screen.
  Cloud chatbot (model not named), subscription over $100 a year.

Older design drafts in [features/](./features/README.md) cover some of these in
more depth and are linked where they apply.

---

## Voice input

### Wake word selection in settings

- **Today:** openWakeWord, chosen with the `WAKE_WORD_MODEL` env var
  (`hey_jarvis` default, `alexa`, `hey_mycroft`, `hey_rhasspy`, or a path to an
  `.onnx`). Threshold and cooldown are env vars too. Nothing in the Settings tab.
- **Akari:** "Hey Akari", plain "Akari", or a custom-trained wake word, picked in
  setup.
- **Dipal:** not described.
- **To do:** wake word dropdown (built-ins plus any `.onnx` dropped into a
  user folder), threshold slider showing the live score from the status panel,
  and a short guide for training a custom word with openWakeWord's notebook.
  A model named after the avatar ("hey <name>") is the target.

## Voice output

### Voice cloning

- **Today:** Kokoro preset voices (style fixed per voice) or OpenAI voices,
  chosen in Settings.
- **Akari:** any ElevenLabs voice, including ones you clone yourself (paid
  ElevenLabs plan).
- **Dipal:** licensed character voice packs (for example A-SOUL), not
  user-cloned.
- **To do:** a local cloning engine as a third TTS option, fed by a short
  reference clip. Chatterbox was too slow on CPU (about 1x real time, PR #284),
  so look at GPU-capable options on bija and keep Kokoro as the fast default.
  ElevenLabs as an optional cloud provider alongside OpenAI.

## Body and presence

### Emotional expressions

- **Today:** VRM expressions and VRMA animations exist, and motion can be
  generated from text, but nothing ties the mood of a reply to the face or body.
- **Akari:** not described beyond breathing and blinking.
- **Dipal:** 18+ emotions with matching facial and body animation. It also
  reads your mood from your face and voice and changes tone (teasing,
  soothing).
- **To do:** have the LLM tag each sentence with an emotion, map tags to VRM
  expression blends and to a motion prompt, and fade between them while
  speaking. Later, feed detected user mood (camera, voice) into the prompt.

### Camera cues for where I am

- **Today:** a camera cue bus exists (`camera:detection` IPC,
  `behavior-cues.tsx`, one cue `greet_face`), but nothing produces detections.
- **Akari:** no camera features. A webcam-driven face for streamers is on the
  "later" roadmap.
- **Dipal:** real-time eye tracking. The character follows your gaze, the
  perspective shifts as you move, it waves back, and it notices when you seem
  down.
- **To do:** local face detection in the renderer (MediaPipe or similar), set
  the VRM look-at target from face position, emit `greet_face` when someone
  arrives and a "left" cue when they go. Presence also feeds the tick (see
  below). All local; no frames leave the machine.

### Touch reactions

- **Today:** none.
- **Akari:** none.
- **Dipal:** touching the character triggers speech and motion responses
  (for example covering herself when poked in the chest).
- **To do:** raycast clicks and touches on the avatar to a body region (head,
  face, hands, torso), play a short reaction motion and expression, and pass the
  event to the LLM so it can comment. Head pats and the like per persona.

## Mind

### Long-term memory

- **Today:** transcripts are saved to SQLite, but the local conversation only
  sees the last few turns, and history resets after 10 minutes idle. Nothing is
  recalled across days.
- **Akari:** a local database of memories with "receipts" (where each came
  from), a memory viewer, and delete at any time.
- **Dipal:** long-term memory and preference learning claimed, no detail.
- **To do:** after each conversation, extract facts and preferences with the
  LLM, store them with a link to the source turn, and inject the relevant ones
  (embedding search) into each prompt. Add a memory viewer with edit and delete.
  Memories belong to a persona (see below).

### Full persona

- **Today:** a single instructions text.
- **Akari:** name, backstory and speaking style, "remembered everywhere".
- **Dipal:** personality archetypes (nurturing, tsundere, childhood friend,
  hyper-energetic, yandere), backstory, and traits down to star sign. 70,000+
  ready-made characters, each with look, voice and motions.
- **To do:** a persona is a bundle of name, archetype, backstory, speaking
  style, traits, likes and dislikes, VRM avatar, voice, wake word, idle and
  reaction motions, and its own memories. Start from archetype templates, edit
  freely, switch personas from Settings, and export or import a persona as one
  file. See [features/02-custom-voice-personas.md](./features/02-custom-voice-personas.md).

## Tools and the world

### Full MCP support

- **Today:** MCP over SSE works; the stdio client is a stub. Registered tools
  are not passed to the local Qwen path, so tools only work with OpenAI.
- **Akari:** MCP connectors for files, smart home and a 3D printer, plus
  voice-taught custom actions and shareable "recipe" packs.
- **Dipal:** built-in assistant features only.
- **To do:** finish the stdio client, pass tools to Qwen through the
  OpenAI-compatible tool-calling API, add Streamable HTTP transport, and a
  Settings page to add, enable and test servers. Ask for spoken confirmation
  before risky tools, and keep a log of every call and refusal (Akari does
  both). See [features/02-mcp-integration.md](./features/02-mcp-integration.md).

### Timers, alarms, reminders, todos, weather, clocks, and a world tick

- **Today:** none.
- **Akari:** timers, alarms, reminders, todos, Pomodoro, weather and world
  clocks, each also shown as a widget.
- **Dipal:** alarms, reminders and schedules, and reacts to time of day.
- **To do:** built-in tools for all of these, stored in SQLite so they survive
  restarts, plus widgets for the display modes. A regular tick (every minute or
  so) gathers the world state: time, weather, due items, calendar, presence
  from the camera, Home Assistant state, and anything new from web search
  subscriptions. See [features/03-scheduled-actions.md](./features/03-scheduled-actions.md).

### Home Assistant integration

- **Today:** none.
- **Akari:** Home Assistant is next on the roadmap, then HomeKit and Matter.
  Also drives GPIO, Arduino and ESP32 boards directly, with six safety checks,
  spoken confirmation for risky actions and a Stop All button.
- **Dipal:** smart home control claimed, no detail.
- **To do:** use Home Assistant's own MCP server through the MCP work above,
  with a direct REST fallback. Feed selected entity states into the tick.
  Confirm before locks, alarms and anything else risky.

### Spontaneous reactions and speech

- **Today:** none. The avatar only speaks when spoken to.
- **Akari:** "speaks unprompted" is on the later roadmap, as are anniversary
  callbacks.
- **Dipal:** reacts to music and time of day, comforts you when you seem down,
  waves when you look at it.
- **To do:** on each tick, decide whether to say or do anything: greet on
  arrival, mention a due reminder, react to weather or a Home Assistant event,
  bring up a remembered anniversary. Needs a cheap appropriateness check first
  (is anyone there, are they busy or on a call, is it quiet hours, how long
  since it last spoke). Kevin suggested "laya" for this check; still to be
  identified. Small actions (a glance, a stretch) can happen without speech.

## Interface

### Display modes and interface clean-up

- **Today:** kiosk window in production, fullscreen in dev, plus the status
  panel and Settings, Character and avatar tabs. `App.tsx` is large and has
  lint warnings.
- **Akari:** kiosk (avatar standing by), "mind" (particle view of thinking,
  memories, timers and sensors), dashboard (arrangeable widgets, no 3D), and
  voice-only (tray icon, no window).
- **Dipal:** the pod screen itself, with the character movable to the phone.
- **To do:** three window modes, switchable at runtime: half-screen (docked to
  one side, avatar plus compact chat), full screen (avatar with widgets), and
  kiosk (avatar only, no chrome). Possibly a voice-only tray mode. Move
  settings and tools behind one panel, split `App.tsx` into components, and
  clear the lint warnings.

### Phone app or interface

- **Today:** none.
- **Akari:** "one Akari, many surfaces" is on the later roadmap.
- **Dipal:** a mobile app with the same ID, and the character can move to the
  phone.
- **To do:** start with a web interface served by the main process on the home
  network (chat, push-to-talk, timers, todos, memory viewer, settings), usable
  from the phone browser and installable as a PWA. Later, render the avatar and
  stream audio to the phone. Remote access through Tailscale rather than the
  open internet.

---

## Already ahead of both

Keep these as differentiators while building the list above:

- Runs fully local on bija, with no cloud fees and nothing leaving the house.
- Text-to-motion (ARDY/Kimodo), AI poses and IK, rather than fixed clips.
- Local avatar generation with ComfyUI.
- Local or OpenAI per part (LLM, STT, TTS, motion).
- Web search (in progress).
- Source we own and can change.
