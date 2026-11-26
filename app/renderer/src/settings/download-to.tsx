import { useEffect, useState } from 'react';
import type { DownloadHosts } from '../../../main/src/shared/aicontroller/remote-downloads-types.js';
import type { ModelsBridge } from '../preload-api.js';

/** The value for "Best fit": the model controller picks the machine by GPU fit and disk. */
export const BEST_FIT = 'auto';

/** The machines the model controller can download to; null while unknown or when there is no controller. */
export function useDownloadHosts(api: ModelsBridge): DownloadHosts | null {
  const [hosts, setHosts] = useState<DownloadHosts | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(api.downloadHosts?.())
      .then((found) => {
        if (live) setHosts(found?.inUse ? found : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);
  return hosts;
}

/** "Download to": this PC (the default), each machine the model controller knows, or the best fit. Hidden without the controller. */
export function DownloadTo({
  hosts,
  value,
  onChange,
  disabled,
  id,
}: {
  hosts: DownloadHosts | null;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  id: string;
}) {
  if (!hosts) return null;
  return (
    <label className="modelsDialog__inline" htmlFor={id}>
      Download to{' '}
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        <option value="">This PC</option>
        {hosts.hosts.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={BEST_FIT}>Best fit (automatic)</option>
      </select>
    </label>
  );
}
