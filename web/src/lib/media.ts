// Media URLs in MediaInfo are relative to the host origin. Every /media/ URL also needs the room's
// media token as `?t=` (docs/PROTOCOL.md § REST); some already carry it, some do not.
export function resolveMediaUrl(url: string, hostOrigin: string | null, mediaToken: string | null): string {
  const base = hostOrigin ?? window.location.origin;
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return url;
  }
  if (mediaToken && u.pathname.startsWith('/media/') && !u.searchParams.has('t')) {
    u.searchParams.set('t', mediaToken);
  }
  return u.toString();
}
