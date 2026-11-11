/**
 * Conversation client for the local backend: the same surface as RealtimeClient, so App.tsx,
 * lip-sync and the avatar tag handling work unchanged, but each turn runs through the main
 * process: utterance → services/speech STT → local LLM → Kokoro TTS, one sentence at a time.
 *
 * Turn-taking is half-duplex: while a reply is being transcribed, generated or played, the mic
 * is ignored, so the assistant never hears (and answers) its own voice through the speakers.
 * With `requireWakeWord`, an utterance is only answered if the wake word was heard during it,
 * or it began within `wakeWindowMs` of the wake word or of the end of the last reply. Speech
 * before the wake word is thrown away: an utterance that spans it is cut at the detection.
 */
import type { LocalVoiceBridge } from '../preload-api.js';
import type { LocalVoiceEvent, LocalVoiceStatus } from '../../../main/src/local-voice/types.js';
import type { RealtimeClientCallbacks, RealtimeClientOptions, RealtimeClientState } from './realtime-client.js';
import type { VoiceActivity, VoicePhase } from './voice-activity.js';

/** The avatar that answers when an event or result names none. */
export const DEFAULT_SPEAKER_ID = 'echo';

export interface LocalVoiceClientCallbacks extends RealtimeClientCallbacks {
  /** For the speaker's lines `avatarId` is passed only when it is not `echo`. */
  onTextContent?: (content: string, avatarId?: string) => void;
  onFirstAudioFrame?: (avatarId?: string) => void;
  onUserTranscript?: (text: string) => void;
  onAssistantTranscript?: (text: string, avatarId?: string) => void;
  /**
   * An avatar other than `echo` got its own audio output (created when it first speaks). Echo's
   * stream goes to `onRemoteStream`, as before.
   */
  onAvatarStream?: (avatarId: string, stream: MediaStream) => void;
  /** A system turn (an update from the coding agent) ran: the note the model was given, marked as not from the user. */
  onSystemNote?: (text: string) => void;
  /** An urgent update was announced while no conversation was running: the note given to the model and its spoken reply. */
  onAnnouncement?: (announcement: { note?: string; reply?: string }) => void;
  /** Turn progress: waiting → listening → transcribing → thinking → responding. */
  onActivity?: (activity: VoiceActivity) => void;
  /** A tool the model called (web_search, MCP tools), as it starts and when it finishes. */
  onToolCall?: (event: LocalVoiceToolEvent) => void;
}

export type LocalVoiceToolEvent = Extract<LocalVoiceEvent, { type: 'tool' }>;

export interface LocalVoiceClientOptions {
  getBridge: () => LocalVoiceBridge | undefined;
  callbacks?: LocalVoiceClientCallbacks;
  /** Wake phrase to strip from the start of transcripts, e.g. "Hey Jarvis". */
  wakePhrase?: string;
  requireWakeWord?: boolean;
  wakeWindowMs?: number;
  /** Quiet this long ends an utterance. */
  silenceMs?: number;
  /** Utterances with less speech than this are ignored (coughs, clicks). */
  minSpeechMs?: number;
  maxUtteranceMs?: number;
  /** How often to re-check the local services while they are down. */
  statusPollMs?: number;
  createAudioContext?: () => AudioContext;
  now?: () => number;
}

type SessionConfig = NonNullable<RealtimeClientOptions['sessionConfig']>;

// The upstream mic stream is already gated to silence by the renderer VAD, so any real signal
// counts as speech.
const SPEECH_RMS = 0.004;
const PROCESSOR_FRAME = 2048;
const PLAYBACK_TAIL_MS = 300;
const WAKE_GRACE_MS = 600;
// Detection lands a little after the wake phrase ends, so the cut starts slightly before it to
// keep a request said in the same breath; any tail of the phrase is stripped from the transcript.
const WAKE_TRIM_LEAD_MS = 250;

export class LocalVoiceClient {
  private readonly getBridge: () => LocalVoiceBridge | undefined;
  private readonly callbacks: LocalVoiceClientCallbacks;
  private readonly wakePattern: RegExp | null;
  private readonly wakeSearchPattern: RegExp | null;
  private readonly minSpeechMs: number;
  private readonly requireWakeWord: boolean;
  private readonly wakeWindowMs: number;
  private readonly statusPollMs: number;
  private readonly createAudioContext: () => AudioContext;
  private readonly now: () => number;
  private readonly segmenter: UtteranceSegmenter;
  private state: RealtimeClientState = { status: 'idle' };
  private sessionConfig: SessionConfig = {};
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  /** One audio output per avatar, created lazily; `echo` is created at connect. */
  private readonly outputs = new Map<string, MediaStreamAudioDestinationNode>();
  /** Out-loud chatter from avatars (requests this client did not start), by request id. */
  private readonly chatterTurns = new Map<string, Turn>();
  /** Request ids this client started, so a late event of one is never mistaken for chatter. */
  private readonly ownRequestIds: string[] = [];
  private chatterPhaseBefore: VoicePhase | null = null;
  private remoteAudioElement: HTMLAudioElement | null = null;
  private outputDeviceId: string | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeSystemReady: (() => void) | null = null;
  private unsubscribeWatch: (() => void) | null = null;
  /** Main said an update for the assistant is ready; it runs as soon as the conversation is idle. */
  private systemReady = false;
  private statusTimer: number | null = null;
  private connectionId = 0;
  private busy = false;
  private lastWakeAt = Number.NEGATIVE_INFINITY;
  private awakeUntil = Number.NEGATIVE_INFINITY;
  private turn: Turn | null = null;
  private disposed = false;
  private activity: VoiceActivity;
  private awakeTimer: number | null = null;

  constructor(options: LocalVoiceClientOptions) {
    this.getBridge = options.getBridge;
    this.callbacks = options.callbacks ?? {};
    this.wakePattern = options.wakePhrase ? buildWakePattern(options.wakePhrase) : null;
    this.wakeSearchPattern = options.wakePhrase ? buildWakeSearchPattern(options.wakePhrase) : null;
    this.minSpeechMs = options.minSpeechMs ?? 300;
    this.requireWakeWord = options.requireWakeWord ?? true;
    this.wakeWindowMs = options.wakeWindowMs ?? 8000;
    this.statusPollMs = options.statusPollMs ?? 5000;
    this.createAudioContext = options.createAudioContext ?? (() => new AudioContext());
    this.now = options.now ?? Date.now;
    this.segmenter = new UtteranceSegmenter({
      silenceMs: options.silenceMs ?? 700,
      minSpeechMs: this.minSpeechMs,
      maxUtteranceMs: options.maxUtteranceMs ?? 30_000,
    });
    this.activity = { phase: 'off', since: this.now() };
  }

  getState(): RealtimeClientState {
    return this.state;
  }

  getActivity(): VoiceActivity {
    return this.activity;
  }

  getRemoteStream(): MediaStream | null {
    return this.output?.stream ?? null;
  }

  /** Echo's output node (the one that has always existed). */
  private get output(): MediaStreamAudioDestinationNode | null {
    return this.outputs.get(DEFAULT_SPEAKER_ID) ?? null;
  }

  /** The audio output of `avatarId`, created on first use; `onAvatarStream` hears of a new non-echo one. */
  private outputFor(avatarId: string): MediaStreamAudioDestinationNode | null {
    const existing = this.outputs.get(avatarId);
    if (existing) {
      return existing;
    }
    const context = this.context;
    if (!context || avatarId === DEFAULT_SPEAKER_ID) {
      return avatarId === DEFAULT_SPEAKER_ID ? this.output : null;
    }
    const created = context.createMediaStreamDestination();
    this.outputs.set(avatarId, created);
    this.callbacks.onAvatarStream?.(avatarId, created.stream);
    return created;
  }

  private newRequestId(prefix: string): string {
    const requestId = `${prefix}-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.ownRequestIds.push(requestId);
    if (this.ownRequestIds.length > 64) {
      this.ownRequestIds.shift();
    }
    return requestId;
  }

  /** Stop avatar chatter that is playing (Kevin is speaking, or the conversation ended). */
  stopChatter(): void {
    if (this.chatterTurns.size === 0) {
      return;
    }
    for (const turn of this.chatterTurns.values()) {
      turn.stop();
    }
    this.chatterTurns.clear();
    this.restoreAfterChatter();
  }

  bindRemoteAudioElement(element: HTMLAudioElement | null): void {
    this.remoteAudioElement = element;
    void this.applyOutputDevice();
  }

  async setOutputDeviceId(deviceId?: string): Promise<void> {
    this.outputDeviceId = deviceId ?? null;
    await this.applyOutputDevice();
  }

  // RealtimeClient API kept for App.tsx; there is no jitter buffer or API key locally.
  setJitterBufferMs(): void {}

  setReconnectApiKeyProvider(): void {}

  notifySpeechActivity(): void {}

  updateSessionConfig(next: RealtimeClientOptions['sessionConfig']): void {
    this.sessionConfig = { ...this.sessionConfig, ...(next ?? {}) };
  }

  getSessionConfigSnapshot(): Record<string, unknown> {
    return { type: 'local', instructions: this.sessionConfig.instructions };
  }

  /**
   * Speak a one-off preview reply (Character → Test Response) through the avatar, so it plays on
   * the conversation's output with lip-sync. It stays out of the conversation history and memory.
   * Returns null when the conversation is not running; the caller then plays it on its own.
   */
  async preview(text: string, instructions?: string): Promise<{ text: string; cancelled: boolean } | null> {
    const bridge = this.getBridge();
    const context = this.context;
    const output = this.output;
    if (!bridge || !context || !output || this.state.status !== 'connected') {
      return null;
    }
    if (this.busy) {
      throw new Error('The assistant is busy with a reply; try again when it has finished.');
    }
    this.busy = true;
    const connectionId = this.connectionId;
    const previousPhase = this.activity.phase;
    const turn = new Turn(`preview-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, context, output);
    this.ownRequestIds.push(turn.requestId);
    turn.onSentenceStart = (sentence, first) => {
      if (first) {
        this.setActivity('responding', 'Voice preview');
      }
      this.callbacks.onTextContent?.(sentence);
    };
    this.turn = turn;
    try {
      const result = await bridge.respond({ requestId: turn.requestId, text, instructions, preview: true });
      await turn.finished();
      return { text: result.text, cancelled: result.cancelled === true };
    } finally {
      if (connectionId === this.connectionId) {
        if (this.turn === turn) {
          this.turn = null;
        }
        this.busy = false;
        this.segmenter.reset();
        if (previousPhase === 'listening') {
          this.listen('Listening');
        } else {
          this.setActivity(this.requireWakeWord ? 'waiting' : 'listening');
        }
        void this.maybeRunSystemTurn();
      }
    }
  }

  /** The wake word was heard: answer what is said next. */
  notifyWake(timestamp = this.now()): void {
    this.lastWakeAt = timestamp;
    this.awakeUntil = Math.max(this.awakeUntil, timestamp + this.wakeWindowMs);
    if (this.state.status === 'connected' && !this.busy) {
      this.listen('Wake word heard');
    }
  }

  /**
   * Push-to-talk or a tap on the screen: answer what is said next, no wake word needed. Pressed
   * again while speech is being captured, it sends that speech without waiting for a pause; pressed
   * while a reply is being generated or spoken, it stops the reply and listens. Before the local
   * services are up, listening starts as soon as they are.
   */
  talk(timestamp = this.now()): void {
    this.awakeUntil = Math.max(this.awakeUntil, timestamp + this.wakeWindowMs);
    if (this.state.status !== 'connected') {
      return;
    }
    this.stopChatter();
    if (this.turn) {
      this.log('info', 'Reply interrupted to talk');
      void this.getBridge()?.cancel(this.turn.requestId);
      // respond() then finishes the turn and listens for a follow-up.
      this.turn.stop();
      return;
    }
    if (this.busy) {
      return;
    }
    if (this.activity.phase === 'listening') {
      const utterance = this.segmenter.flush(this.now());
      if (utterance) {
        void this.handleUtterance(utterance);
        return;
      }
    }
    this.listen('Listening: no wake word needed');
  }

  async connect(options: { apiKey?: string; inputStream: MediaStream }): Promise<void> {
    if (this.disposed) {
      throw new Error('Local voice client has been disposed.');
    }
    const bridge = this.getBridge();
    if (!bridge) {
      throw new Error('Local voice bridge is unavailable.');
    }

    this.teardown();
    const connectionId = ++this.connectionId;
    this.updateState({ status: 'connecting' });

    const context = this.createAudioContext();
    await context.resume?.();
    const source = context.createMediaStreamSource(options.inputStream);
    const processor = context.createScriptProcessor(PROCESSOR_FRAME, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    const output = context.createMediaStreamDestination();
    processor.onaudioprocess = (event) => {
      this.handleAudio(event.inputBuffer.getChannelData(0), context.sampleRate);
    };

    this.context = context;
    this.source = source;
    this.processor = processor;
    this.sink = sink;
    this.outputs.set(DEFAULT_SPEAKER_ID, output);
    this.unsubscribeEvents = bridge.onEvent((event) => this.handleEvent(event));
    this.unsubscribeSystemReady =
      bridge.onSystemReady?.(() => {
        this.systemReady = true;
        void this.maybeRunSystemTurn();
      }) ?? null;
    this.log('info', 'Local voice capture started', { sampleRate: context.sampleRate });

    await this.waitForServices(bridge, connectionId);
  }

  async disconnect(): Promise<void> {
    this.connectionId += 1;
    this.teardown();
    this.updateState({ status: 'idle' });
    this.setActivity('off');
  }

  /**
   * Announce urgent updates even when the conversation is not running (state idle): an output-only
   * turn that never opens the microphone. Non-urgent updates wait for the next conversation. Call
   * once after creating the client; `unwatchUpdates` (or destroy) stops it.
   */
  watchUpdates(): void {
    const bridge = this.getBridge();
    if (!bridge || this.disposed || this.unsubscribeWatch) {
      return;
    }
    let active = true;
    const unsubscribe = bridge.onSystemReady?.((info) => {
      if (this.state.status === 'connected') {
        this.systemReady = true;
        void this.maybeRunSystemTurn();
      } else if (info?.urgent === true) {
        void this.announce();
      }
    });
    this.unsubscribeWatch = () => {
      active = false;
      unsubscribe?.();
    };
    // Updates that were queued before this window loaded.
    void bridge
      .systemStatus?.()
      .then((status) => {
        if (active && status.ready && status.urgent) {
          void this.announce();
        }
      })
      .catch(() => undefined);
  }

  unwatchUpdates(): void {
    this.unsubscribeWatch?.();
    this.unsubscribeWatch = null;
  }

  /** Output-only system turn while no conversation is running. State stays idle and the mic stays closed. */
  private async announce(): Promise<void> {
    const bridge = this.getBridge();
    if (!bridge || this.disposed || this.busy || this.state.status !== 'idle') {
      return;
    }
    this.busy = true;
    const connectionId = this.connectionId;
    let context: AudioContext | null = null;
    try {
      context = this.createAudioContext();
      await context.resume?.();
      if (connectionId !== this.connectionId || this.disposed) {
        return;
      }
      const output = context.createMediaStreamDestination();
      this.context = context;
      this.outputs.set(DEFAULT_SPEAKER_ID, output);
      this.unsubscribeEvents = bridge.onEvent((event) => this.handleEvent(event));
      this.callbacks.onRemoteStream?.(output.stream);
      await this.respond(bridge, '', connectionId, true, true);
    } catch (error) {
      const failure = describe(error);
      this.log('error', 'Local voice announcement failed', failure);
    } finally {
      if (connectionId === this.connectionId) {
        this.unsubscribeEvents?.();
        this.unsubscribeEvents = null;
        this.stopChatter();
        this.disconnectOutputs();
        this.context = null;
        this.turn = null;
        this.busy = false;
        this.setActivity('off');
      }
      // A connect() during the announcement tore this context down already; otherwise close it here.
      void context?.close().catch(() => undefined);
    }
  }

  async destroy(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unwatchUpdates();
    await this.disconnect();
  }

  private async waitForServices(bridge: LocalVoiceBridge, connectionId: number): Promise<void> {
    let problem: string | null;
    try {
      problem = describeServiceProblem(await bridge.getStatus());
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (connectionId !== this.connectionId) {
      return;
    }

    if (problem) {
      if (this.state.error !== problem) {
        this.log('warn', 'Local voice services unavailable', { problem });
      }
      this.updateState({ status: 'error', error: problem });
      this.setActivity('error', problem);
      this.statusTimer = window.setTimeout(() => {
        this.statusTimer = null;
        void this.waitForServices(bridge, connectionId);
      }, this.statusPollMs);
      return;
    }

    this.updateState({ status: 'connected' });
    if (this.requireWakeWord && this.awakeUntil > this.now()) {
      // talk() was pressed while connecting.
      this.listen('Listening: no wake word needed');
    } else {
      this.setActivity(this.requireWakeWord ? 'waiting' : 'listening');
    }
    if (this.output) {
      this.callbacks.onRemoteStream?.(this.output.stream);
    }
    // Updates that arrived while no conversation was running.
    void bridge
      .systemStatus?.()
      .then((status) => {
        if (status.ready && connectionId === this.connectionId) {
          this.systemReady = true;
          void this.maybeRunSystemTurn();
        }
      })
      .catch(() => undefined);
  }

  /**
   * Speak an update from the coding agent when nothing else is going on: connected, not busy with
   * a reply, and nobody is mid-sentence. Otherwise it waits (systemReady stays set) and is tried
   * again when the current turn ends.
   */
  private async maybeRunSystemTurn(): Promise<void> {
    const bridge = this.getBridge();
    if (!this.systemReady || !bridge || this.state.status !== 'connected' || this.busy || this.segmenter.inProgress) {
      return;
    }
    this.systemReady = false;
    this.busy = true;
    const connectionId = this.connectionId;
    const previousPhase = this.activity.phase;
    try {
      const spoke = await this.respond(bridge, '', connectionId, true);
      if (connectionId !== this.connectionId) {
        return;
      }
      if (spoke) {
        this.listen('Follow-up: no wake word needed');
      } else if (previousPhase === 'listening') {
        this.listen('Listening');
      } else {
        this.setActivity(this.requireWakeWord ? 'waiting' : 'listening');
      }
    } catch (error) {
      const failure = describe(error);
      this.log('error', 'Local voice update failed', failure);
      if (connectionId === this.connectionId) {
        this.setActivity('error', `Update failed: ${failure.message}`);
      }
    } finally {
      if (connectionId === this.connectionId) {
        this.busy = false;
        this.segmenter.reset();
        void this.maybeRunSystemTurn();
      }
    }
  }

  private handleAudio(samples: Float32Array, sampleRate: number): void {
    if (this.state.status !== 'connected' || this.busy) {
      return;
    }
    const utterance = this.segmenter.push(samples, sampleRate, this.now());
    if (utterance) {
      void this.handleUtterance(utterance);
    }
  }

  private async handleUtterance(heard: Utterance): Promise<void> {
    const bridge = this.getBridge();
    if (!bridge || this.busy) {
      return;
    }
    this.busy = true;
    const connectionId = this.connectionId;
    try {
      let utterance = heard;
      if (this.requireWakeWord) {
        let admitted = this.admit(heard);
        if (admitted === null) {
          // The wake event can land just after a short "hey echo" utterance ends.
          await wait(WAKE_GRACE_MS);
          admitted = this.admit(heard);
        }
        if (admitted === null) {
          const durationMs = heard.endAt - heard.startAt;
          this.log('info', 'Ignoring speech without the wake word', { durationMs });
          this.setActivity('waiting', `Ignored ${(durationMs / 1000).toFixed(1)} s of speech without the wake word`);
          return;
        }
        if (admitted === 'wake-only') {
          this.log('info', 'Dropped speech before the wake word', { durationMs: heard.endAt - heard.startAt });
          this.listen('Wake word heard: say your request');
          return;
        }
        if (admitted !== heard) {
          this.log('info', 'Dropped speech before the wake word', { droppedMs: admitted.startAt - heard.startAt });
        }
        utterance = admitted;
      }

      // Kevin is speaking: avatar chatter gives way.
      this.stopChatter();
      this.setActivity('transcribing');
      const transcript = await bridge.transcribe(encodeWav(utterance.samples, utterance.sampleRate));
      if (connectionId !== this.connectionId) {
        return;
      }
      const text = this.stripWakePhrase(transcript.text);
      this.log('info', 'Local voice transcript', { text: transcript.text, timings: transcript.timings });
      if (!text) {
        // Only the wake word was said: keep listening for the request.
        this.listen('Wake word heard: say your request');
        return;
      }
      this.callbacks.onUserTranscript?.(text);
      this.setActivity('thinking', `“${text}”`);
      await this.respond(bridge, text, connectionId, false);
      if (connectionId === this.connectionId) {
        this.listen('Follow-up: no wake word needed');
      }
    } catch (error) {
      const failure = describe(error);
      this.log('error', 'Local voice turn failed', failure);
      if (connectionId === this.connectionId) {
        this.setActivity('error', `Turn failed: ${failure.message}`);
      }
    } finally {
      if (connectionId === this.connectionId) {
        this.busy = false;
        this.segmenter.reset();
        void this.maybeRunSystemTurn();
      }
    }
  }

  /** Run one turn and play it. For a system turn `text` is empty; true if the assistant said something. */
  private async respond(
    bridge: LocalVoiceBridge,
    text: string,
    connectionId: number,
    system: boolean,
    announcement = false,
  ): Promise<boolean> {
    const context = this.context;
    const output = this.output;
    if (!context || !output) {
      return false;
    }
    const turn = new Turn(this.newRequestId('local'), context, output);
    turn.onSentenceStart = (sentence, first) => {
      if (first) {
        if (turn.avatarId === DEFAULT_SPEAKER_ID) {
          this.callbacks.onFirstAudioFrame?.();
        } else {
          this.callbacks.onFirstAudioFrame?.(turn.avatarId);
        }
        this.setActivity('responding');
      }
      this.emitText(sentence, turn.avatarId);
    };
    this.turn = turn;

    if (system) {
      this.setActivity('thinking', 'Update from the coding agent');
    }
    const result = await bridge.respond({
      requestId: turn.requestId,
      text,
      instructions: this.sessionConfig.instructions,
      ...(system ? { system: true } : {}),
    });
    await turn.finished();
    if (connectionId !== this.connectionId) {
      return false;
    }
    this.turn = null;
    if (system && !result.note) {
      return false;
    }
    await wait(PLAYBACK_TAIL_MS);
    if (announcement) {
      if ((result.note || result.text) && !result.cancelled) {
        this.callbacks.onAnnouncement?.({ note: result.note, reply: result.text || undefined });
      }
      return true;
    }
    // A follow-up needs no wake word for a little while.
    this.awakeUntil = this.now() + this.wakeWindowMs;
    if (result.note) {
      this.callbacks.onSystemNote?.(result.note);
    }
    if (result.text && !result.cancelled) {
      // The result names who answered (the floor may have routed it elsewhere); events name it too.
      const speaker = result.avatarId || turn.avatarId;
      if (speaker === DEFAULT_SPEAKER_ID) {
        this.callbacks.onAssistantTranscript?.(result.text);
      } else {
        this.callbacks.onAssistantTranscript?.(result.text, speaker);
      }
    }
    return true;
  }

  private emitText(sentence: string, avatarId: string): void {
    if (avatarId === DEFAULT_SPEAKER_ID) {
      this.callbacks.onTextContent?.(sentence);
    } else {
      this.callbacks.onTextContent?.(sentence, avatarId);
    }
  }

  /** The turn's sentences play on the speaker's output, chosen when the first one arrives. */
  private routeTurn(turn: Turn, avatarId: string): void {
    if (turn.routed) {
      return;
    }
    turn.avatarId = avatarId;
    if (avatarId !== DEFAULT_SPEAKER_ID) {
      const output = this.outputFor(avatarId);
      if (output) {
        turn.output = output;
      }
    }
    turn.routed = true;
  }

  private handleEvent(event: LocalVoiceEvent): void {
    const turn = this.turn;
    if (!turn || event.requestId !== turn.requestId) {
      this.handleChatterEvent(event);
      return;
    }
    if (event.type === 'sentence') {
      this.routeTurn(turn, event.avatarId || DEFAULT_SPEAKER_ID);
      turn.enqueue(event.text, event.wav, (error) => this.log('warn', 'Failed to decode reply audio', describe(error)));
    } else if (event.type === 'error') {
      this.log('error', 'Local voice reply error', { message: event.message });
      this.setActivity('error', `Reply failed: ${event.message}`);
    } else if (event.type === 'tool') {
      this.log(event.status === 'failed' ? 'warn' : 'info', `Tool ${event.name} ${event.status}`, {
        label: event.label,
        detail: event.detail,
      });
      this.callbacks.onToolCall?.(event);
    }
  }

  /**
   * Speech of an avatar this client did not ask for (out-loud back-channel talk, or a second
   * avatar answering Kevin after the first): play it on that avatar's output. It never touches the
   * microphone or the busy state.
   */
  private handleChatterEvent(event: LocalVoiceEvent): void {
    if (event.type !== 'sentence' || !this.context || this.disposed || this.state.status !== 'connected') {
      return;
    }
    if (this.ownRequestIds.includes(event.requestId)) {
      return;
    }
    const avatarId = event.avatarId || DEFAULT_SPEAKER_ID;
    let turn = this.chatterTurns.get(event.requestId);
    let isNew = false;
    if (!turn) {
      const output = this.outputFor(avatarId);
      if (!output) {
        return;
      }
      const created = new Turn(event.requestId, this.context, output);
      created.avatarId = avatarId;
      created.routed = true;
      created.onSentenceStart = (sentence, first) => {
        if (first) {
          if (avatarId === DEFAULT_SPEAKER_ID) {
            this.callbacks.onFirstAudioFrame?.();
          } else {
            this.callbacks.onFirstAudioFrame?.(avatarId);
          }
          if (!this.busy && this.chatterPhaseBefore === null && (this.activity.phase === 'waiting' || this.activity.phase === 'listening')) {
            this.chatterPhaseBefore = this.activity.phase;
            this.setActivity('responding', 'Avatar chatter');
          }
        }
        this.emitText(sentence, avatarId);
      };
      this.chatterTurns.set(event.requestId, created);
      turn = created;
      isNew = true;
    }
    turn.enqueue(event.text, event.wav, (error) => this.log('warn', 'Failed to decode chatter audio', describe(error)));
    if (isNew) {
      const tracked = turn;
      // Forget the turn once what is queued has played (its next sentence, if any, starts a new one).
      void tracked.idle().then(() => {
        if (this.chatterTurns.get(tracked.requestId) === tracked) {
          this.chatterTurns.delete(tracked.requestId);
          this.restoreAfterChatter();
        }
      });
    }
  }

  /** Chatter is over: give back the activity it took, if nothing else has changed it. */
  private restoreAfterChatter(): void {
    if (this.chatterTurns.size > 0 || this.chatterPhaseBefore === null) {
      return;
    }
    const before = this.chatterPhaseBefore;
    this.chatterPhaseBefore = null;
    if (!this.busy && this.activity.phase === 'responding' && this.activity.detail === 'Avatar chatter') {
      this.setActivity(before);
    }
  }

  private disconnectOutputs(): void {
    for (const node of this.outputs.values()) {
      node.disconnect();
    }
    this.outputs.clear();
  }

  /**
   * The part of an utterance to answer: from the wake word on when it was heard during the
   * utterance (or just after it ended), all of it when it began after the wake word or within a
   * follow-up window, 'wake-only' when nothing but the wake word and what came before it is left,
   * and null when the wake word has not been heard.
   */
  private admit(utterance: Utterance): Utterance | 'wake-only' | null {
    const wakeAt = this.lastWakeAt;
    if (wakeAt > utterance.startAt && wakeAt <= utterance.endAt + WAKE_GRACE_MS) {
      const rest = trimUtterance(utterance, wakeAt - WAKE_TRIM_LEAD_MS);
      return voicedMs(rest.samples, rest.sampleRate) >= this.minSpeechMs ? rest : 'wake-only';
    }
    return utterance.startAt <= this.awakeUntil ? utterance : null;
  }

  private stripWakePhrase(text: string): string {
    let trimmed = text.trim();
    if (this.wakeSearchPattern) {
      // Anything said before the full wake phrase was not meant for the assistant.
      let end = -1;
      for (const match of trimmed.matchAll(this.wakeSearchPattern)) {
        end = (match.index ?? 0) + match[0].length;
      }
      if (end >= 0) {
        trimmed = trimmed.slice(end).trim();
      }
    }
    const stripped = this.wakePattern ? trimmed.replace(this.wakePattern, '') : trimmed;
    return /[\p{L}\p{N}]/u.test(stripped) ? stripped.trim() : '';
  }

  /** Answering without the wake word until `awakeUntil`, then back to waiting for it. */
  private listen(detail: string): void {
    this.setActivity('listening', detail);
    if (this.awakeTimer !== null) {
      window.clearTimeout(this.awakeTimer);
      this.awakeTimer = null;
    }
    if (!this.requireWakeWord) {
      return;
    }
    const remainingMs = this.awakeUntil - this.now();
    this.awakeTimer = window.setTimeout(() => {
      this.awakeTimer = null;
      if (!this.busy && this.activity.phase === 'listening') {
        this.setActivity('waiting');
      }
    }, Math.max(0, remainingMs));
  }

  private setActivity(phase: VoicePhase, detail?: string): void {
    if (this.activity.phase === phase && this.activity.detail === detail) {
      return;
    }
    this.activity = { phase, detail, since: this.now() };
    this.callbacks.onActivity?.(this.activity);
  }

  private teardown(): void {
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.awakeTimer !== null) {
      window.clearTimeout(this.awakeTimer);
      this.awakeTimer = null;
    }
    if (this.turn) {
      void this.getBridge()?.cancel(this.turn.requestId);
      this.turn.stop();
      this.turn = null;
    }
    this.stopChatter();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.unsubscribeSystemReady?.();
    this.unsubscribeSystemReady = null;
    if (this.processor) {
      this.processor.onaudioprocess = null;
    }
    this.source?.disconnect();
    this.processor?.disconnect();
    this.sink?.disconnect();
    this.disconnectOutputs();
    if (this.context) {
      void this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.source = null;
    this.processor = null;
    this.sink = null;
    this.busy = false;
    this.segmenter.reset();
  }

  private async applyOutputDevice(): Promise<void> {
    const element = this.remoteAudioElement as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!element || typeof element.setSinkId !== 'function') {
      return;
    }
    try {
      await element.setSinkId(this.outputDeviceId ?? '');
    } catch (error) {
      this.log('warn', 'Failed to apply output device', describe(error));
    }
  }

  private updateState(state: RealtimeClientState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    this.callbacks.onLog?.({ level, message, data });
  }
}

/**
 * Speak a one-off preview reply (Character → Test Response) when the conversation is not
 * running: the reply's sentences play straight to the speakers (`outputDeviceId` when set).
 */
export async function playPreviewReply(
  bridge: LocalVoiceBridge,
  request: { text: string; instructions?: string },
  options: { outputDeviceId?: string | null; createAudioContext?: () => AudioContext } = {},
): Promise<{ text: string; cancelled: boolean }> {
  const context = (options.createAudioContext ?? (() => new AudioContext()))();
  try {
    await context.resume?.();
    const sinkContext = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (options.outputDeviceId && typeof sinkContext.setSinkId === 'function') {
      await sinkContext.setSinkId(options.outputDeviceId).catch((error: unknown) => {
        console.warn('Preview: could not use the chosen output device', error);
      });
    }
    const turn = new Turn(`preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, context, context.destination);
    const unsubscribe = bridge.onEvent((event) => {
      if (event.requestId !== turn.requestId) {
        return;
      }
      if (event.type === 'sentence') {
        turn.enqueue(event.text, event.wav, (error) => console.warn('Preview: failed to decode reply audio', error));
      }
    });
    try {
      const result = await bridge.respond({ requestId: turn.requestId, ...request, preview: true });
      await turn.finished();
      return { text: result.text, cancelled: result.cancelled === true };
    } finally {
      unsubscribe();
    }
  } finally {
    void context.close().catch(() => undefined);
  }
}

/** One reply being played: sentences are decoded and scheduled back to back, in order. */
class Turn {
  onSentenceStart: ((sentence: string, first: boolean) => void) | null = null;
  private nextStartAt = 0;
  private decoding: Promise<void> = Promise.resolve();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly timers = new Set<number>();
  private started = false;
  private stopped = false;
  /** Who speaks this turn; set from the first sentence event (default echo). */
  avatarId = DEFAULT_SPEAKER_ID;
  /** The output was chosen from the first sentence event. */
  routed = false;

  constructor(
    readonly requestId: string,
    private readonly context: AudioContext,
    /** Replaced by the speaker's output when the first sentence arrives (see LocalVoiceClient.routeTurn). */
    public output: AudioNode,
  ) {}

  /** Resolves when what is queued has played (or the turn was stopped). */
  async idle(): Promise<void> {
    let seen: Promise<void> | null = null;
    // New sentences may be queued while waiting, so loop until nothing more was added.
    while (seen !== this.decoding && !this.stopped) {
      seen = this.decoding;
      await this.finished();
    }
  }

  enqueue(text: string, wav: Uint8Array, onError: (error: unknown) => void): void {
    this.decoding = this.decoding.then(async () => {
      if (this.stopped) {
        return;
      }
      try {
        const audio = wav.byteLength > 0 ? await this.context.decodeAudioData(copyBuffer(wav)) : null;
        if (this.stopped) {
          return;
        }
        const startAt = Math.max(this.context.currentTime + 0.02, this.nextStartAt);
        if (audio) {
          const source = this.context.createBufferSource();
          source.buffer = audio;
          source.connect(this.output);
          source.onended = () => this.sources.delete(source);
          source.start(startAt);
          this.sources.add(source);
          this.nextStartAt = startAt + audio.duration;
        }
        const first = !this.started;
        this.started = true;
        const delayMs = Math.max(0, (startAt - this.context.currentTime) * 1000);
        const timer = window.setTimeout(() => {
          this.timers.delete(timer);
          if (!this.stopped) {
            this.onSentenceStart?.(text, first);
          }
        }, delayMs);
        this.timers.add(timer);
      } catch (error) {
        onError(error);
      }
    });
  }

  /** Resolves when everything queued so far has been played. */
  async finished(): Promise<void> {
    await this.decoding;
    const remainingMs = (this.nextStartAt - this.context.currentTime) * 1000;
    if (remainingMs > 0 && !this.stopped) {
      await wait(remainingMs);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear();
    for (const timer of this.timers) {
      window.clearTimeout(timer);
    }
    this.timers.clear();
  }
}

export interface Utterance {
  samples: Float32Array;
  sampleRate: number;
  startAt: number;
  endAt: number;
}

/** Cuts a gated mic stream into utterances: speech, then `silenceMs` of quiet. */
export class UtteranceSegmenter {
  /** Someone is mid-utterance. */
  get inProgress(): boolean {
    return this.chunks.length > 0;
  }

  private chunks: Float32Array[] = [];
  private startAt = 0;
  private lastVoiceAt = 0;
  private speechMs = 0;
  private sampleRate = 48000;

  constructor(private readonly options: { silenceMs: number; minSpeechMs: number; maxUtteranceMs: number }) {}

  push(samples: Float32Array, sampleRate: number, nowMs: number): Utterance | null {
    this.sampleRate = sampleRate;
    const voiced = rms(samples) > SPEECH_RMS;
    const frameMs = (samples.length / sampleRate) * 1000;

    if (this.chunks.length === 0) {
      if (!voiced) {
        return null;
      }
      this.startAt = nowMs - frameMs;
    }
    this.chunks.push(Float32Array.from(samples));
    if (voiced) {
      this.lastVoiceAt = nowMs;
      this.speechMs += frameMs;
    }

    const ended = nowMs - this.lastVoiceAt >= this.options.silenceMs;
    const tooLong = nowMs - this.startAt >= this.options.maxUtteranceMs;
    if (!ended && !tooLong) {
      return null;
    }
    return this.flush(nowMs);
  }

  /** End the utterance in progress now, without waiting for a pause; null if there is none. */
  flush(nowMs: number): Utterance | null {
    if (this.chunks.length === 0) {
      return null;
    }
    const utterance: Utterance = {
      samples: concat(this.chunks),
      sampleRate: this.sampleRate,
      startAt: this.startAt,
      endAt: nowMs,
    };
    const speechMs = this.speechMs;
    this.reset();
    return speechMs >= this.options.minSpeechMs ? utterance : null;
  }

  reset(): void {
    this.chunks = [];
    this.speechMs = 0;
  }
}

/** The utterance from `fromMs` on. */
export function trimUtterance(utterance: Utterance, fromMs: number): Utterance {
  if (fromMs <= utterance.startAt) {
    return utterance;
  }
  const offset = Math.round(((fromMs - utterance.startAt) / 1000) * utterance.sampleRate);
  return {
    ...utterance,
    samples: utterance.samples.slice(Math.min(offset, utterance.samples.length)),
    startAt: Math.min(fromMs, utterance.endAt),
  };
}

/** How much of `samples` is speech, counted in processor-sized frames. */
export function voicedMs(samples: Float32Array, sampleRate: number): number {
  let voiced = 0;
  for (let i = 0; i < samples.length; i += PROCESSOR_FRAME) {
    const frame = samples.subarray(i, i + PROCESSOR_FRAME);
    if (rms(frame) > SPEECH_RMS) {
      voiced += frame.length;
    }
  }
  return (voiced / sampleRate) * 1000;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

/** Matches the wake phrase (and punctuation after it) at the start of a transcript. */
export function buildWakePattern(phrase: string): RegExp | null {
  const words = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) {
    return null;
  }
  const last = words.pop() as string;
  const leading = words.map((word) => `(?:${word}[\\s,.!?-]*)?`).join('');
  return new RegExp(`^\\s*(?:(?:hey|hi|okay|ok)[\\s,]+)?${leading}${last}\\b[\\s,.!?-]*`, 'i');
}

/** Matches the whole wake phrase anywhere in a transcript (every word, so "echo" alone does not). */
export function buildWakeSearchPattern(phrase: string): RegExp | null {
  const words = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) {
    return null;
  }
  return new RegExp(`\\b${words.join('[\\s,.!?-]+')}\\b[\\s,.!?-]*`, 'gi');
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
}

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function describe(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : String(error) };
}

/** Why the pipeline cannot take a turn yet, or null when every part it uses is ready. */
export function describeServiceProblem(status: LocalVoiceStatus): string | null {
  if (!status.llm.available) {
    return status.llm.provider === 'openai'
      ? 'The OpenAI language model needs an OpenAI API key (Settings).'
      : `Local LLM is not reachable at ${status.llm.baseUrl} (start scripts/start-local-llm.ps1).`;
  }
  const sttOnOpenAi = status.stt?.provider === 'openai';
  const ttsOnOpenAi = status.tts?.provider === 'openai';
  if (sttOnOpenAi && !status.stt?.available) {
    return 'OpenAI speech-to-text needs an OpenAI API key (Settings).';
  }
  if (ttsOnOpenAi && !status.tts?.available) {
    return 'OpenAI text-to-speech needs an OpenAI API key (Settings).';
  }
  if (sttOnOpenAi && ttsOnOpenAi) {
    return null;
  }
  return !status.speech.available
    ? 'Speech service is not running (start services/speech/scripts/start.ps1).'
    : status.speech.error
      ? `Speech service failed: ${status.speech.error}`
      : !status.speech.ready
        ? 'Speech service is still loading its models.'
        : null;
}
