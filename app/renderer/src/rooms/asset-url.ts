/**
 * Where a room asset URL (`aiembodied-asset://polyhaven/chair/chair.gltf`) is really fetched from.
 *
 * In the Electron app the main process serves that scheme itself, so the URL is used as it is. In a web page the
 * scheme does not exist: the web satellite installs a resolver that turns it into `/v1/asset?url=...&k=<link key>`
 * on the hub (the key is this link's own, and stops working when the link closes). Loaders that fetch a model's
 * textures and buffers by relative path run those through the same resolver (three.js `LoadingManager`).
 */
export const ASSET_SCHEME = 'aiembodied-asset';

export type AssetUrlResolver = (url: string) => string;

let resolver: AssetUrlResolver | null = null;

export function setAssetUrlResolver(next: AssetUrlResolver | null): void {
  resolver = next;
}

/** The URL to fetch for an asset URL. Anything that is not an asset URL is returned unchanged. */
export function resolveAssetUrl(url: string): string {
  return resolver && url.startsWith(`${ASSET_SCHEME}:`) ? resolver(url) : url;
}

/** The resolver the web satellite uses: `/v1/asset` on `base`, with the link's key. An unknown key (offline) leaves the URL as it is, which fails to load. */
export function hubAssetResolver(base: () => string, key: () => string | null): AssetUrlResolver {
  return (url) => {
    const k = key();
    if (!k) return url;
    return `${base()}/v1/asset?url=${encodeURIComponent(url)}&k=${encodeURIComponent(k)}`;
  };
}
