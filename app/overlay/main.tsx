import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Combat from './Combat.js';
import Overlay from './Overlay.js';
import RatingPrompt from './RatingPrompt.js';
import './styles.css';

const racine = document.getElementById('root');
if (racine === null) throw new Error('Element #root introuvable');

// La meme page sert les trois fenetres : le mode arrive en parametre.
const mode = new URLSearchParams(window.location.search).get('mode');

const vue =
  mode === 'rating' ? <RatingPrompt /> : mode === 'combat' ? <Combat /> : <Overlay />;

createRoot(racine).render(<StrictMode>{vue}</StrictMode>);
