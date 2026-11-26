// Types only: shared/ holds what the main process and the renderer both need.
import type { LinkState } from './link-shared.js';


export interface SatelliteStatus {
  role: 'satellite';
  /** This PC has a token for a hub (the "Connect to bija" screen shows when false). */
  paired: boolean;
  hubUrl: string | null;
  deviceName: string | null;
  placeId: string | null;
  placeName: string | null;
  link: LinkState;
  /** Why bija refused this PC (auth, peer, protocol, revoked, replaced). */
  linkCode: string | null;
  /** The last thing that went wrong, in words for Kevin (a failed pairing, a refusal, a keychain problem). */
  lastError: string | null;
  /** This PC's name, offered as the device name on the connect screen. */
  hostname: string;
  /** Only the web satellite sets these. The address to offer on the connect screen (the page's own origin when the hub served it), and what kind of device this is. */
  suggestedHubUrl?: string | null;
  deviceKind?: 'browser';
}


export interface PairInput {
  hubUrl: string;
  code: string;
  placeName?: string;
  deviceName?: string;
}


/** How long one spoken turn took on this PC, measured from the end of speech (milliseconds). */
export interface TurnTiming {
  /** Until the transcript came back from bija. Null for a typed line. */
  transcriptMs: number | null;
  /** Until the first sentence of audio arrived. */
  firstAudioMs: number | null;
  /** Until the first sentence started playing. */
  playbackMs: number | null;
}
