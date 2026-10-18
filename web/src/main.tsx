// Placeholder entry so the skeleton typechecks and builds. The player agent replaces this with the
// real app shell (see docs/UI.md and docs/ARCHITECTURE.md § File ownership).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PROTOCOL_VERSION } from '@wochit/shared';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main style={{ color: '#f2f2f7', background: '#0b0b10', minHeight: '100dvh', display: 'grid', placeItems: 'center', fontFamily: 'Inter, system-ui, sans-serif' }}>
      WochIt · protocol v{PROTOCOL_VERSION} · app not built yet
    </main>
  </StrictMode>,
);
