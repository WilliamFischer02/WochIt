// A QR code as inline SVG. The generator (qrcode-generator, MIT, ~50 KB) is loaded on demand so
// the main bundle does not carry it; the share card is the only place that wants one.
import { useEffect, useState } from 'react';

/** Modules of white border around the symbol (the spec asks for 4; 2 is enough on a dark page). */
const QUIET_ZONE = 2;

// The package is `export =` in its typings but `export default` in its ESM build, so name the shape.
type QrFactory = typeof import('qrcode-generator');
type QrModule = { default: QrFactory };
let qrModule: Promise<QrModule> | null = null;
function loadQr(): Promise<QrModule> {
  qrModule ??= import('qrcode-generator');
  return qrModule;
}

/** One `M x y h1 v1 h-1 z` per dark module, so the whole symbol is a single <path>. */
export function qrPath(isDark: (row: number, col: number) => boolean, count: number, margin: number): string {
  const parts: string[] = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (isDark(r, c)) parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
    }
  }
  return parts.join('');
}

export interface QrSvgProps {
  text: string;
  /** Rendered size in CSS px (the SVG scales; modules stay crisp). */
  size?: number;
  className?: string;
}

export default function QrSvg({ text, size = 160, className }: QrSvgProps) {
  const [symbol, setSymbol] = useState<{ text: string; count: number; path: string } | null>(null);

  useEffect(() => {
    let alive = true;
    loadQr()
      .then((m) => {
        if (!alive) return;
        const qr = m.default(0, 'M');
        qr.addData(text, 'Byte');
        qr.make();
        const count = qr.getModuleCount();
        setSymbol({ text, count, path: qrPath((r, c) => qr.isDark(r, c), count, QUIET_ZONE) });
      })
      .catch(() => {
        if (alive) setSymbol(null);
      });
    return () => {
      alive = false;
    };
  }, [text]);

  if (!symbol || symbol.text !== text) {
    return <div className={className} style={{ width: size, height: size }} data-testid="share-qr-loading" aria-hidden="true" />;
  }
  const side = symbol.count + QUIET_ZONE * 2;
  return (
    <svg
      data-testid="share-qr"
      role="img"
      aria-label={`QR code for ${text}`}
      viewBox={`0 0 ${side} ${side}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={side} height={side} fill="#ffffff" />
      <path d={symbol.path} fill="#0b0b10" />
    </svg>
  );
}
