/** The WochIt mark: a chat bubble with a play triangle inside. Same geometry as public/icons/icon.svg. */
export default function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="wochit-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#f472b6" />
        </linearGradient>
      </defs>
      <path d="M30 18h40a16 16 0 0 1 16 16v26a16 16 0 0 1-16 16H42l-14 14 2-14h0a16 16 0 0 1-16-16V34a16 16 0 0 1 16-16z" fill="url(#wochit-g)" />
      <path d="M43 32v30l24-15z" fill="#fff" />
    </svg>
  );
}
