# TODO

* Pair the prompt with the model and avatar, so I get more coherent behaviour/can alter the character based on how they look and think.
  Partly there: the avatar's description is added to the prompt, but the
  personality text is still one global prompt, not saved per avatar.

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

## Voice output

### Voice cloning

- **Today:** Kokoro, Kitten TTS or Piper locally, with downloads and a voice
  per character (#363), or OpenAI voices. None of them clone a voice.
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

- **Today:** VRM expressions and VRMA animations exist, motion can be
  generated from text (`{move:...}`), and generated avatars get six emotion
  expressions and emotion stance poses. The LLM is told to pick an emotion
  stance with `{pose:...}`, but nothing tags each sentence with an emotion or
  drives the face from it.
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

### Full persona

- **Today:** a single instructions text shared by every avatar. Each avatar
  already has its own description (added to the prompt), voice per speaking
  engine, emotion poses and expressions.
- **Akari:** name, backstory and speaking style, "remembered everywhere".
- **Dipal:** personality archetypes (nurturing, tsundere, childhood friend,
  hyper-energetic, yandere), backstory, and traits down to star sign. 70,000+
  ready-made characters, each with look, voice and motions.
- **To do:** a persona is a bundle of name, archetype, backstory, speaking
  style, traits, likes and dislikes, VRM avatar, voice, wake word, idle and
  reaction motions, and its own memories (one memory is shared by all characters for now). Start from archetype templates, edit
  freely, switch personas from Settings, and export or import a persona as one
  file. See [features/02-custom-voice-personas.md](./features/02-custom-voice-personas.md).

## Tools and the world

### Full MCP support

- **Today:** MCP over SSE works and the Tools / MCP pop-up adds, enables and
  tests servers. Tools are passed to local Qwen through tool calling (#282,
  #283), with web search on SearXNG. The stdio client is still a stub, there is
  no Streamable HTTP transport, and voice simply leaves out tools that need
  confirmation instead of asking out loud.
- **Akari:** MCP connectors for files, smart home and a 3D printer, plus
  voice-taught custom actions and shareable "recipe" packs.
- **Dipal:** built-in assistant features only.
- **To do:** finish the stdio client and add Streamable HTTP transport. Ask for spoken confirmation
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

- **Today:** step 1 is in. The memory engine listens to one or more Home
  Assistants over WebSocket, keeps their events apart from conversation, and
  offers a `home_history` tool (#364). Homes are managed in Models and servers
  (#365). The avatar cannot control anything or speak on HA speakers yet. The
  design is in the Home Assistant Claude Doc.
- **Akari:** Home Assistant is next on the roadmap, then HomeKit and Matter.
  Also drives GPIO, Arduino and ESP32 boards directly, with six safety checks,
  spoken confirmation for risky actions and a Stop All button.
- **Dipal:** smart home control claimed, no detail.
- **To do:** control through each home's MCP server (needs Streamable HTTP,
  above), then our own call_service tools with per-entity confirm levels. Play
  our TTS on HA speakers. Feed selected entity states into the tick.
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

## Avatars together

Design and decisions: [Echo event bus Claude Doc](https://claude.ai/artifact/5zmHyKjHcRsYBSjWbCMmvB).

### Event bus (switchboard)

- **Today:** every path (voice, tools, approvals, coding runner, Home
  Assistant) is a separate link through the Electron main process, with no
  avatar id, person id or link between a request and its outcome.
- **Decided (2026-11-09):** a Python "switchboard" service on :8196 with one
  event envelope (producer, addressees, transaction, audience), a SQLite
  journal and transaction ledger, and a floor manager per scene using rules
  first, then bids. Audio and motion stay on their direct paths.
- **To do:** build it locally in phases: mirror today's events, make Echo an
  actor with an inbox policy, then several local avatars.

### Several avatars in one scene

- **Decided (2026-11-09):** every avatar shares the same models by default
  (no loading or unloading between avatars), with its own settings: prompt,
  voice and so on. An avatar may instead use a remote server option (for
  example one on ChatGPT, one local). Avatars talk to each other out loud and
  over a back channel, with a toggle for whether Kevin hears their chatter.

### Voice ID

- **To do (not started, separate work):** tell people apart by voice (Kevin,
  Erika, guests), so the avatars know who is speaking and memory records it.

### Remote avatars (AvChat)

- **To do (after local works):** remote avatars talk over a text channel
  only, like WhatsApp messages between them, through an internal "AvChat" app
  the avatars use. Kevin will test with a copy of the avatar on another server.
- **To do:** decide the remote protocol (our own envelope between switchboards,
  or A2A at the edge). See the Remote avatars section of the design doc.

## Interface

### Display modes and interface clean-up

- **Today:** kiosk window in production, fullscreen in dev. Controls now sit in
  one drawer of buttons that open pop-ups (#332): Character, avatar studio,
  Models and servers, Tools / MCP, Memory, Status and diagnostics. `App.tsx` is
  still about 2,900 lines with lint warnings, and there is only one window
  mode.
- **Akari:** kiosk (avatar standing by), "mind" (particle view of thinking,
  memories, timers and sensors), dashboard (arrangeable widgets, no 3D), and
  voice-only (tray icon, no window).
- **Dipal:** the pod screen itself, with the character movable to the phone.
- **To do:** three window modes, switchable at runtime: half-screen (docked to
  one side, avatar plus compact chat), full screen (avatar with widgets), and
  kiosk (avatar only, no chrome). Possibly a voice-only tray mode. Split
  `App.tsx` into components and clear the lint warnings.

### Phone app or interface

- **Today:** draft PR #311 has an Android companion (a Kotlin WebView shell)
  and a desktop hub on port 8790 with a pairing code and Tailscale for remote
  use. It is waiting on a test on a real phone.
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
- Web search (SearXNG locally, Brave optional).
- Home Assistant history from several homes, kept out of the conversation.
- Train your own wake word in the app.
- Long-term memory engine (PostgreSQL + pgvector) with a Memory panel to view, edit and delete.
- A voice per character, across Kokoro, Kitten TTS, Piper and OpenAI.
- Source we own and can change.
