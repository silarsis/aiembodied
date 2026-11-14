/**
 * What this room's settings are, read from a places snapshot. Shared by the Electron satellite's device runtime and
 * the web satellite's gate. No Electron, no Node.
 */
import { cameraPresenceOn } from '../places/camera-setting.js';
import { doorbellOn } from '../places/doorbell-setting.js';

/** This room's camera setting from a places snapshot. A snapshot that cannot be read gives off (fail closed). */
export function cameraSettingHere(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const { places, localPlaceId } = snapshot as { places?: unknown; localPlaceId?: unknown };
  if (!Array.isArray(places) || typeof localPlaceId !== 'string') return false;
  const here = places.find((place) => (place as { id?: unknown } | null)?.id === localPlaceId) as { node?: unknown; camera?: unknown } | undefined;
  if (!here || typeof here.node !== 'string') return false;
  return cameraPresenceOn({ node: here.node, camera: typeof here.camera === 'boolean' ? here.camera : undefined });
}

/**
 * This room's doorbell setting from a places snapshot. A snapshot that cannot be read gives off (fail closed).
 * The setting lives on bija (Settings > Places); satellite.json no longer decides it.
 */
export function doorbellSettingHere(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const { places, localPlaceId } = snapshot as { places?: unknown; localPlaceId?: unknown };
  if (!Array.isArray(places) || typeof localPlaceId !== 'string') return false;
  const here = places.find((place) => (place as { id?: unknown } | null)?.id === localPlaceId) as { node?: unknown; doorbell?: unknown } | undefined;
  if (!here || typeof here.node !== 'string') return false;
  return doorbellOn({ node: here.node, doorbell: typeof here.doorbell === 'boolean' ? here.doorbell : undefined });
}
