import React from 'react';
import ReactDOM from 'react-dom/client';
import { CompanionApp } from './companion-app.js';
import './companion.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <CompanionApp />
  </React.StrictMode>,
);
