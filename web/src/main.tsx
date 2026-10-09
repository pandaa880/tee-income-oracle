import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HomePage } from './pages/home-page.tsx';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <HomePage />
  </StrictMode>,
);
