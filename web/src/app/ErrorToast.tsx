import { useEffect, useState } from 'react';
import { useApp } from './store';

const FRIENDLY: Partial<Record<string, string>> = {
  not_host: 'This connection is not from the host PC, so you joined as a guest.',
  unknown_media: 'That file is not in the library any more.',
  rate_limited: 'Slow down a little.',
  vlc_unreachable: 'VLC is not reachable. See Setup for enabling its web interface.',
  transcode_failed: 'Transcoding failed on the host. Check the host log.',
  server_error: 'The host hit an error.',
};

/** Server errors after joining (bad_pin is shown inline by the connect card). */
export default function ErrorToast() {
  const err = useApp((s) => s.lastError);
  const view = useApp((s) => s.view);
  const [shown, setShown] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    if (!err || view === 'connect' || err.code === 'bad_pin' || err.code === 'bad_message') return;
    setShown(err);
    const t = setTimeout(() => setShown(null), 4500);
    return () => clearTimeout(t);
  }, [err, view]);

  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 safe-b" role="status" aria-live="polite">
      <div className="glass max-w-md rounded-pill px-4 py-2 text-sm text-text animate-slide-up" data-testid="error-toast">
        {FRIENDLY[shown.code] ?? shown.message}
      </div>
    </div>
  );
}
