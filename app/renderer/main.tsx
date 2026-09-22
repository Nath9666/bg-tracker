import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';

const racine = document.getElementById('root');
if (racine === null) throw new Error('Element #root introuvable');

createRoot(racine).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
