// localStorage under the `wochit.` prefix, never throwing (private mode, blocked storage).
const PREFIX = 'wochit.';

export function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function savePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, value);
  } catch {
    // ignore
  }
}

/** Random, persisted per browser so reconnects keep the same Member id (docs/PROTOCOL.md). */
export function getClientId(): string {
  let id = loadPref('clientId');
  if (!id || id.length < 8) {
    id = crypto.randomUUID();
    savePref('clientId', id);
  }
  return id;
}
