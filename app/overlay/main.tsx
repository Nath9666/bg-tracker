import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Bonuses from './Bonuses.js';
import Combat from './Combat.js';
import Overlay from './Overlay.js';
import RatingPrompt from './RatingPrompt.js';
import Side from './Side.js';
import './styles.css';

const racine = document.getElementById('root');
if (racine === null) throw new Error('Element #root introuvable');

// La meme page sert toutes les fenetres : le mode arrive en parametre d'URL.
const mode = new URLSearchParams(window.location.search).get('mode');

const VUES: Record<string, JSX.Element> = {
  left: <Overlay />,
  right: <Side />,
  combat: <Combat />,
  bonus: <Bonuses />,
  rating: <RatingPrompt />,
};

createRoot(racine).render(<StrictMode>{VUES[mode ?? 'left'] ?? <Overlay />}</StrictMode>);
