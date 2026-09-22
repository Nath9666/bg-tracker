import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Overlay from './Overlay.js';
import RatingPrompt from './RatingPrompt.js';
import './styles.css';

const racine = document.getElementById('root');
if (racine === null) throw new Error('Element #root introuvable');

// La meme page sert les deux fenetres : le mode arrive en parametre.
const mode = new URLSearchParams(window.location.search).get('mode');

createRoot(racine).render(
  <StrictMode>{mode === 'rating' ? <RatingPrompt /> : <Overlay />}</StrictMode>,
);
