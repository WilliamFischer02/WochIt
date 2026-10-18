// Entry for web/dev-chat.html (dev server only; not part of the production build).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../app/theme.css';
import ChatHarness, { seedStore } from './ChatHarness';

seedStore();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ChatHarness />
    </StrictMode>,
  );
}
