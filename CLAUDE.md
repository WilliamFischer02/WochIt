# WochIt — rules for anyone (human or agent) working in this repo

WochIt lets two people in different states watch a film that lives on one Windows PC, with
play/pause/scrub kept in sync, a chat sidebar with emoji and GIFs, and three screen-filling
reactions. Read `docs/ARCHITECTURE.md` first, then `docs/PROTOCOL.md`, then `docs/UI.md`.
`docs/DECISIONS.md` records why the design is what it is; do not relitigate those without a
new reason written down there.

## Layout

- `shared/` — `@wochit/shared`. Zod schemas and types for every message, plus the pure sync
  math. **The single source of truth for the wire protocol.** Build it (`pnpm --filter
  @wochit/shared build`) after editing; host and web import its `dist`.
- `host/` — `@wochit/host`. Node 22+ TypeScript. Serves the built web app, HLS media, the
  WebSocket room, the VLC bridge and the Tenor proxy. Runs only on the host PC.
- `web/` — `@wochit/web`. Vite + React 19 + TypeScript + Tailwind v4. Static. Served by the host
  at `/` and mirrored on Vercel as a public connect page.
- `docs/` — architecture, protocol, UI spec, decisions, setup.

## Hard rules

1. **No secrets in git.** `.env` is ignored; `.env.example` documents every key with a safe
   default. The Tenor key and the VLC password live only in `.env`.
2. **Guests never learn filesystem paths.** Media is addressed by opaque `MediaInfo.id`. The
   library browser is host-only and shows paths relative to a configured root.
3. **The host agent never fetches from the internet except the Tenor API** (and only when a key
   is configured). No telemetry, no update checks.
4. **Protocol changes go through `shared/src/protocol.ts` first**, then both sides, with a
   `PROTOCOL_VERSION` bump if breaking. Never hand-write a message shape in host or web.
5. **Sync is server-authoritative.** Clients send intents (`control`), the host decides, every
   client follows `state`. A client may apply its own intent optimistically but must reconcile.
6. **VLC is the master clock whenever it is being followed.** The host never fights VLC: it reads
   VLC's position and pushes the room to it; controls from the site go *to* VLC.
7. **No `any`, no `@ts-ignore`.** `pnpm typecheck` and `pnpm test` must pass before a commit.
8. **Phones first.** Every guest-facing screen is designed at 390×844 portrait and 844×390
   landscape before desktop. Respect safe-area insets; use `100dvh`, never `100vh`.
9. **Nothing destructive in the cache without a size reason.** Eviction is LRU past
   `WOCHIT_CACHE_MAX_GB`; never wipe the cache on startup.
10. **Agents do not commit.** The integrating session commits at wave boundaries so history stays
    linear. Leave the tree building and tested, and report what you touched.

## Commands

```
pnpm install
pnpm build            # shared → host → web
pnpm typecheck && pnpm test
pnpm --filter @wochit/host dev     # host on :8788 (needs .env)
pnpm --filter @wochit/web dev      # web on :5173, proxies /api /media /ws to :8788
pnpm e2e              # Playwright: host + two browsers + generated test video
```

## Testing a host-only feature from one machine

Open two tabs: `http://127.0.0.1:8788/?mode=host` and `http://127.0.0.1:8788/?mode=guest`.
`mode=guest` forces guest rendering even from the host PC; `mode=host` is only honoured for
local connections. The e2e suite relies on this.
