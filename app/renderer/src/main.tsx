import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SatelliteGate } from './satellite/satellite-gate';
import './index.css';
import { bootWebSatellite } from './web-satellite/boot';

// Not inside the Electron app (no preload bridge): this page is a web satellite, a room that talks to bija over the room link.
bootWebSatellite();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SatelliteGate>
      <App />
    </SatelliteGate>
  </React.StrictMode>,
);
