import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SatelliteGate } from './satellite/satellite-gate';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SatelliteGate>
      <App />
    </SatelliteGate>
  </React.StrictMode>,
);
