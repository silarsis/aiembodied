import { describe, expect, it } from 'vitest';
import {
  FrameError,
  MAX_FRAME_BYTES,
  MAX_TEXT_BYTES,
  decodeBinaryFrame,
  decodeMessage,
  decodeText,
  encodeBinaryFrame,
  encodeMessage,
  encodeText,
} from '../../src/room-hub/frames.js';

describe('room link frames', () => {
  it('round-trips a text op', () => {
    const text = encodeText({ op: 'ping', t: 5 });
    expect(decodeText(text)).toEqual({ op: 'ping', t: 5 });
    expect(decodeMessage(text)).toEqual({ op: { op: 'ping', t: 5 }, payload: null });
  });

  it('refuses a text frame that is not an op or is over 1 MB', () => {
    expect(() => decodeText('nope')).toThrow(FrameError);
    expect(() => decodeText('[1]')).toThrow(FrameError);
    expect(() => decodeText('{"x":1}')).toThrow(FrameError);
    expect(() => encodeText({ op: 'x', big: 'a'.repeat(MAX_TEXT_BYTES) })).toThrow(FrameError);
    expect(() => decodeText(JSON.stringify({ op: 'x', big: 'a'.repeat(MAX_TEXT_BYTES) }))).toThrow(FrameError);
  });

  it('round-trips a binary frame: big-endian header length, header, payload', () => {
    const frame = encodeBinaryFrame({ op: 'turn.audio', requestId: 'r1' }, new Uint8Array([1, 2, 3]));
    const header = new TextEncoder().encode(JSON.stringify({ op: 'turn.audio', requestId: 'r1' }));
    expect(new DataView(frame.buffer).getUint32(0, false)).toBe(header.byteLength);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded.header).toEqual({ op: 'turn.audio', requestId: 'r1' });
    expect([...decoded.payload]).toEqual([1, 2, 3]);
    // Without bins the payload comes back as it is.
    expect([...(decodeMessage(frame).payload ?? [])]).toEqual([1, 2, 3]);
  });

  it('refuses short or lying binary frames, and frames over 64 MB', () => {
    expect(() => decodeBinaryFrame(new Uint8Array([0, 0]))).toThrow(FrameError);
    expect(() => decodeBinaryFrame(new Uint8Array([0, 0, 0, 200, 1, 2]))).toThrow(FrameError);
    expect(() => decodeBinaryFrame(new Uint8Array([0, 0, 0, 0]))).toThrow(FrameError);
    expect(() => encodeBinaryFrame({ op: 'x' }, new Uint8Array(MAX_FRAME_BYTES))).toThrow(FrameError);
  });

  it('sends an op with no bytes as text', () => {
    expect(typeof encodeMessage({ op: 'result', ref: 'a', value: { n: 1 } })).toBe('string');
  });

  it('moves bytes inside args or a result into a binary frame and puts them back', () => {
    const wav = new Uint8Array([7, 8, 9, 10]);
    const vrm = Buffer.from([1, 2]);
    const frame = encodeMessage({ op: 'call', ref: 'a', channel: 'x', args: [{ audio: wav, name: 'n' }, vrm.buffer.slice(vrm.byteOffset, vrm.byteOffset + 2)] });
    expect(frame).toBeInstanceOf(Uint8Array);
    const { header } = decodeBinaryFrame(frame as Uint8Array);
    expect(header.bins).toEqual([4, 2]);
    expect(JSON.stringify(header.args)).toBe('[{"audio":{"$bin":0},"name":"n"},{"$bin":1}]');
    const { op } = decodeMessage(frame as Uint8Array);
    const args = op.args as Array<{ audio: Uint8Array; name: string } | Uint8Array>;
    expect([...(args[0] as { audio: Uint8Array }).audio]).toEqual([7, 8, 9, 10]);
    expect((args[0] as { name: string }).name).toBe('n');
    expect([...(args[1] as Uint8Array)]).toEqual([1, 2]);
    expect(op.bins).toBeUndefined();
  });

  it('refuses a bins list that does not fit the payload', () => {
    const frame = encodeBinaryFrame({ op: 'x', value: { $bin: 0 }, bins: [50] }, new Uint8Array(3));
    expect(() => decodeMessage(frame)).toThrow(FrameError);
    const missing = encodeBinaryFrame({ op: 'x', value: { $bin: 3 }, bins: [1] }, new Uint8Array(1));
    expect(() => decodeMessage(missing)).toThrow(FrameError);
  });
});
