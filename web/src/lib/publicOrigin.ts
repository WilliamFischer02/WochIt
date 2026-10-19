// Where the public connect/invite page lives (Vercel). The invite link the host sends points here,
// because the guest cannot reach the host's tailnet URL before Tailscale is on.
const fromEnv: unknown = import.meta.env.VITE_PUBLIC_ORIGIN;

export const PUBLIC_ORIGIN: string = typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim().replace(/\/+$/, '') : 'https://wochit.vercel.app';
