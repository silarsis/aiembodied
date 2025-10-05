export type PreloadApi = import('../../main/src/preload.js').PreloadApi;

export function getPreloadApi(): PreloadApi | undefined {
  return (window as unknown as { aiembodied?: PreloadApi }).aiembodied;
}
