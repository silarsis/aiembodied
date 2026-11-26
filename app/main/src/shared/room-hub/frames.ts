/**
 * The wire format of the room link (docs/features/room-link-protocol.md).
 *
 * - A text frame is one JSON object `{ "op": "...", ... }`, at most 1 MB.
 * - A binary frame is `[4-byte big-endian header length N][N bytes of UTF-8 JSON header][payload]`, at most 64 MB.
 *   The header is a normal op object. The payload is raw bytes.
 * - Bytes inside an op (`args`, `value`) are swapped for `{ "$bin": <index> }` and travel in the payload of a
 *   binary frame. The header lists their lengths in `bins`.
 *
 * Nothing here needs Electron or Node-only APIs (only Uint8Array, DataView, TextEncoder), so a satellite's
 * renderer could use the same file.
 */

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;

export type Op = { op: string; [key: string]: unknown };

export class FrameError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Anything that is bytes: a Uint8Array (a Node Buffer is one), a typed-array view or an ArrayBuffer. */
export function isBytes(value: unknown): value is Uint8Array | ArrayBuffer | ArrayBufferView {
  return value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function toBytes(value: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** Encodes one op as a text frame. */
export function encodeText(op: Op): string {
  const text = JSON.stringify(op);
  if (encoder.encode(text).byteLength > MAX_TEXT_BYTES) throw new FrameError('Text frame is larger than 1 MB.');
  return text;
}

export function decodeText(text: string): Op {
  if (text.length > MAX_TEXT_BYTES || encoder.encode(text).byteLength > MAX_TEXT_BYTES) throw new FrameError('Text frame is larger than 1 MB.');
  return parseHeader(text);
}

function parseHeader(text: string): Op {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FrameError('Frame is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { op?: unknown }).op !== 'string') {
    throw new FrameError('Frame has no op.');
  }
  return parsed as Op;
}

/** Encodes a binary frame: header length, header, payload. */
export function encodeBinaryFrame(header: Op, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const head = encoder.encode(JSON.stringify(header));
  const total = 4 + head.byteLength + payload.byteLength;
  if (total > MAX_FRAME_BYTES) throw new FrameError('Binary frame is larger than 64 MB.');
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, head.byteLength, false);
  out.set(head, 4);
  out.set(payload, 4 + head.byteLength);
  return out;
}

export function decodeBinaryFrame(data: Uint8Array): { header: Op; payload: Uint8Array } {
  if (data.byteLength > MAX_FRAME_BYTES) throw new FrameError('Binary frame is larger than 64 MB.');
  if (data.byteLength < 4) throw new FrameError('Binary frame is too short.');
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
  if (length === 0 || length > MAX_TEXT_BYTES || 4 + length > data.byteLength) throw new FrameError('Binary frame has a bad header length.');
  const header = parseHeader(decoder.decode(data.subarray(4, 4 + length)));
  return { header, payload: data.subarray(4 + length) };
}

/** Swaps every byte value in `value` for `{ $bin: index }` and returns the bytes it took out, in order. */
export function extractBinaries(value: unknown): { value: unknown; bins: Uint8Array[] } {
  const bins: Uint8Array[] = [];
  const walk = (item: unknown): unknown => {
    if (isBytes(item)) {
      bins.push(toBytes(item));
      return { $bin: bins.length - 1 };
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(item)) out[key] = walk(inner);
      return out;
    }
    return item;
  };
  return { value: walk(value), bins };
}

/** Puts the bytes back where `{ $bin: index }` stands. */
export function restoreBinaries(value: unknown, bins: Uint8Array[]): unknown {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length === 1 && keys[0] === '$bin' && typeof record.$bin === 'number') {
        const bytes = bins[record.$bin];
        if (!bytes) throw new FrameError('Frame points at a binary value it does not carry.');
        return bytes;
      }
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(record)) out[key] = walk(inner);
      return out;
    }
    return item;
  };
  return walk(value);
}

/**
 * Encodes an op for the wire: a text frame when it holds no bytes, else a binary frame whose payload is the
 * byte values joined in order.
 */
export function encodeMessage(op: Op): string | Uint8Array {
  const { value, bins } = extractBinaries(op);
  if (bins.length === 0) return encodeText(op);
  const payload = new Uint8Array(bins.reduce((sum, bin) => sum + bin.byteLength, 0));
  let offset = 0;
  for (const bin of bins) {
    payload.set(bin, offset);
    offset += bin.byteLength;
  }
  return encodeBinaryFrame({ ...(value as Op), bins: bins.map((bin) => bin.byteLength) }, payload);
}

export interface DecodedMessage {
  op: Op;
  /** Raw bytes of a binary frame that has no `bins` list (an `asset` answer). Null otherwise. */
  payload: Uint8Array | null;
}

/** Decodes a frame as the socket delivered it (a string for text, bytes for binary). */
export function decodeMessage(data: string | Uint8Array): DecodedMessage {
  if (typeof data === 'string') return { op: decodeText(data), payload: null };
  const { header, payload } = decodeBinaryFrame(data);
  const lengths = header.bins;
  if (lengths === undefined) return { op: header, payload };
  if (!Array.isArray(lengths) || lengths.some((length) => typeof length !== 'number' || !Number.isInteger(length) || length < 0)) {
    throw new FrameError('Frame has a bad bins list.');
  }
  const bins: Uint8Array[] = [];
  let offset = 0;
  for (const length of lengths as number[]) {
    if (offset + length > payload.byteLength) throw new FrameError('Frame is shorter than its bins list.');
    bins.push(payload.subarray(offset, offset + length));
    offset += length;
  }
  const { bins: _bins, ...rest } = header;
  void _bins;
  return { op: restoreBinaries(rest, bins) as Op, payload: null };
}
