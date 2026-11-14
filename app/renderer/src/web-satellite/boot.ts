import { browserSocketFactory } from './browser-socket.js';
import { WebSatellite } from './web-satellite.js';
import { WebStore } from './web-store.js';
import { readShellHook } from './shell-hook.js';
import { hubAssetResolver, setAssetUrlResolver } from '../rooms/asset-url.js';
import type { PreloadApi } from '../preload-api.js';

/** The page was served by a hub (`/app/`): its own address is the hub's. */
export function pageServedByHub(win: Window = window): boolean {
  return win.location.pathname.startsWith('/app/') || win.location.pathname === '/app';
}

/**
 * Starts the web satellite when the page is not running inside the Electron app (no preload bridge). It makes
 * `window.aiembodied` the same API the preload builds, on the room link, and returns the satellite, or null when
 * Electron's bridge is there. Call it once, before React renders.
 */
export function bootWebSatellite(win: Window = window): WebSatellite | null {
  if ((win as unknown as { aiembodied?: unknown }).aiembodied) return null;
  const shell = readShellHook(win);
  const pageOrigin = pageServedByHub(win) || shell ? win.location.origin : null;
  const satellite = new WebSatellite({
    store: new WebStore(win.localStorage),
    socketFactory: browserSocketFactory(),
    fetchFn: (input, init) => win.fetch(input, init),
    shell,
    pageOrigin: pageOrigin && pageOrigin !== 'null' ? pageOrigin : null,
    isVisible: () => win.document.visibilityState === 'visible',
    reload: () => win.location.reload(),
    deviceName: 'This browser',
    logger: console,
  });
  (win as unknown as { aiembodied?: PreloadApi }).aiembodied = satellite.bridge as unknown as PreloadApi;
  setAssetUrlResolver(hubAssetResolver(() => satellite.assetBase(), () => satellite.assetKey()));
  win.document.addEventListener('visibilitychange', () => satellite.visibilityChanged());
  // Using the app counts as activity (wandering and urgent news look at it). Throttled inside; passive so scrolling is not held up.
  for (const type of ['touchstart', 'pointerdown', 'keydown']) win.document.addEventListener(type, () => satellite.noteActivity(), { passive: true, capture: true });
  // Leaving the page drops the link, which closes the gate; stop capture first if anything is still running.
  win.addEventListener('pagehide', () => satellite.stop());
  // A page restored from the back/forward cache has a stopped satellite: start over.
  win.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) win.location.reload();
  });
  satellite.start();
  return satellite;
}
