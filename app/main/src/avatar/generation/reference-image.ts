import { PNG } from 'pngjs';

/** Renderer uploads are converted to PNG; validate again before persisting or queuing them. */
export function decodeReferenceImage(value: unknown): Buffer | null {
  if (value === undefined) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    !('mimeType' in value) ||
    value.mimeType !== 'image/png' ||
    !('data' in value) ||
    typeof value.data !== 'string' ||
    value.data.length > 36 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
  ) {
    throw new Error('Upload a valid PNG, JPEG or WebP character image.');
  }
  const bytes = Buffer.from(value.data, 'base64');
  if (
    bytes.length < 24 ||
    bytes.length > 25 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(16) < 1 ||
    bytes.readUInt32BE(16) > 4096 ||
    bytes.readUInt32BE(20) < 1 ||
    bytes.readUInt32BE(20) > 4096
  ) {
    throw new Error('The reference image must be at most 4096 × 4096 pixels and 25 MB.');
  }
  try {
    PNG.sync.read(bytes);
  } catch {
    throw new Error('The reference image could not be decoded.');
  }
  return bytes;
}
