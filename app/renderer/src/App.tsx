import { useEffect, useState } from 'react';

function usePing(): string {
  const [value, setValue] = useState('...');

  useEffect(() => {
    const api = (window as unknown as { aiembodied?: { ping?: () => string } }).aiembodied;
    if (typeof api?.ping === 'function') {
      try {
        setValue(api.ping());
        return;
      } catch (error) {
        console.error('Failed to call preload ping bridge', error);
      }
    }

    setValue('unavailable');
  }, []);

  return value;
}

export default function App() {
  const preloadStatus = usePing();

  return (
    <main className="app">
      <h1>Embodied Assistant MVP</h1>
      <p>Preload bridge status: {preloadStatus}</p>
    </main>
  );
}
