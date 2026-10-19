# UI specification

Design for her phone first (390×844 portrait, 844×390 landscape), then his desktop (1440×900+).
Everything that is not the picture is glass over black: translucent panels with `backdrop-blur`,
soft borders, generous radius, no hard white.

## Tokens (Tailwind v4 `@theme` in `web/src/app/theme.css`)

| token | value | use |
|---|---|---|
| `--color-bg` | `#0b0b10` | page background |
| `--color-surface` | `#14141c` | drawer, cards |
| `--color-surface-2` | `#1c1c27` | inputs, bubbles (them) |
| `--color-line` | `rgba(255,255,255,.08)` | borders |
| `--color-text` | `#f2f2f7` | primary text |
| `--color-muted` | `#9a9ab0` | secondary text |
| `--color-accent` | `#8b5cf6` | buttons, active states, my bubbles |
| `--color-accent-2` | `#f472b6` | heart, highlights |
| `--color-ok` | `#34d399` | in sync, connected |
| `--color-warn` | `#fbbf24` | catching up, buffering |
| `--color-bad` | `#f87171` | disconnected, errors |
| `--radius-xl` | `20px` | panels |
| `--radius-pill` | `999px` | chips, buttons |
| font | `Inter, system-ui, -apple-system, "Segoe UI", sans-serif` | everything; `font-variant-numeric: tabular-nums` on times |

Glass: `bg-white/6 backdrop-blur-xl border border-white/8 shadow-[0_8px_40px_rgba(0,0,0,.45)]`.
Icons: `lucide-react`, 20 px in controls, 24 px on phone tap targets. Minimum tap target 44×44.
Motion: 160–220 ms ease-out for panels; controls auto-hide after 3 s of no pointer/touch while
playing (tap anywhere on the video to show them again). `prefers-reduced-motion` → no particle
rain, tints only, no slide animations.

## Screens

### 1. Connect (`/`, `web/src/features/connect`)

Centered card on `--color-bg` with a faint radial accent glow. Logo mark + "WochIt". Fields:
- **Host** (only when the page is not served by the host agent; i.e. on Vercel or `localhost:5173`
  without proxy): URL input prefilled from `?h=` or `localStorage['wochit.host']`.
- **PIN**: 6-digit numeric keypad input (`inputmode=numeric`, autocomplete off), remembered.
- **Your name**: text, 24 max, remembered.
- Small segmented switch "Auto / I'm on the host PC / I'm a guest" (default Auto), remembered.
- Primary button **Join**. Errors inline in `--color-bad` ("Wrong PIN").
While connecting: button spinner. On `welcome` route to Guest or Host view.

### 2. Guest view (phone), `web/src/features/player` + `controls` + `chat`

Portrait layout, top to bottom:
1. **Stage**: 16:9 black box full width; the `<video playsinline>` letterboxed inside; the
   reactions canvas spans the whole viewport (not just the stage).
2. **Controls** overlay the stage bottom (gradient to black, auto-hide):
   - Row 1: scrubber — thin track with buffered ranges in white/20, played in accent, a 14 px knob
     that grows to 20 px while dragging; ghost time bubble above the thumb while dragging.
   - Row 2, left to right: play/pause (large, 48 px), elapsed `/` duration (tabular), spacer,
     **reactions** (three 40 px round glass buttons 👏 🍅 ❤️ — fire on tap, bounce 120 ms),
     spacer, CC (subtitles menu), quality (`HD` chip showing current rendition or `Auto`),
     volume (desktop only; hidden on touch devices where hardware buttons rule), chat toggle with
     unread badge, theater/fullscreen.
   - Top-left over the stage: title and a **sync pill**: green dot "In sync", amber "Catching up
     +0.6s", red "Reconnecting…", with the other member's nick when present ("with Mia").
3. **Chat** fills the remainder (portrait) — see § Chat. The chat toggle in the controls scrolls
   it into/out of view; in portrait the chat is "tucked" by collapsing to a 48 px bar showing the
   last message preview and unread count.

Landscape: the stage fills the viewport; the chat is a right drawer 70 % wide (max 380 px) sliding
over the picture with glass, toggled by the chat button; the controls stay at the bottom under
the drawer. Desktop (≥ 900 px): stage left, chat a fixed 360 px right column, both full height;
the chat toggle collapses the column to a 56 px rail with the icon and badge.

Waiting states on the stage:
- No media: poster-less dark stage with "Waiting for William to pick something" (host's nick).
- First play / seek into untranscoded range: centered spinner with "Preparing 720p…" from
  `transcode` messages; never a frozen frame without feedback for more than 500 ms.
- iOS gesture gate: "Tap to join playback" large button over the stage.

### 3. Host view — the console (desktop), `web/src/features/hostmode`

Two columns on `--color-bg` from 900 px up: main column (max 1100 px) and the chat column on the
right (same component as guest, open by default, collapsible to the rail). Below 900 px the panels
take the full width and the chat is a drawer over them, toggled from the header
(`host-chat-toggle`, unread badge); nothing may overflow horizontally at 390 px.

The console polls `GET /api/health` every 10 s through one shared hook, `useHostHealth()`
(`hostConsoleStore.ts`), and reads S2C `telemetry` into `store.telemetry`. `data-testid="host-view"`
on the root.

Main column, top to bottom:

- **ReadinessPanel** (`readiness`): "Ready to watch?" with a summary chip (`readiness-summary`:
  "All set" / "n things to fix", counting every non-ok row) and a collapse chevron
  (`readiness-toggle`) that only works once all rows are ok; the collapsed state is remembered in
  `localStorage['wochit.console.readinessCollapsed']`. One row per check, `ready-row-<key>` with
  `data-tone` ok|warn|bad|muted, a status dot, a label, the status text (`ready-status-<key>`) and an
  inline action (`ready-action-<key>`). Rules in `readiness.ts`:
  - `host`: ok "Host agent v<version> on <local url>"; bad "Host agent not answering on <url>".
  - `tailnet`: ok "Published: <url>"; bad "Not published. Run scripts\publish-tailnet.ps1" with a
    copy button; warn "Tailscale CLI not found on the host" when health has no `tailnet`.
  - `vlc`: ok "VLC connected, room follows it"; warn "VLC connected, not followed" + **Follow**
    (sends `follow_vlc on`); muted "Not running. Pick a film below and press Open in VLC". Uses the
    live socket `vlc` state, not the poll.
  - `encoder`: ok "GPU encoder h264_nvenc" (any `*nvenc*`); warn "Software encoder <name>, expect
    lower quality"; bad "ffmpeg not found".
  - `gif`: ok "GIF search: <provider>"; bad "No key" with the inline key form (`gif-key-form`):
    provider toggle `gif-provider-klipy` / `gif-provider-giphy`, a password input `gif-key-input`
    ("Paste your Klipy key" / "Paste your GIPHY key"), **Save** (`gif-key-save`) →
    `PATCH /api/host/settings` with the PIN header → "Saved. GIF search: <provider>" and the input
    clears; errors inline (`gif-key-error`). "Get a free key" (`gif-key-link`, new tab, noopener)
    points at partner.klipy.com, or developers.giphy.com/dashboard/ when GIPHY is toggled. A saved
    key is never shown.
  - `guests`: ok "<n> connected" (presence count, falling back to `health.members.guests`); muted
    "None yet. Open the link on your phone to test."
- **ShareCard — the invite composer** (`share-card`, `data-tailnet`). The tailnet URL is the
  published one from health (else a listed `.ts.net` URL when the host cannot check). Without one
  the card shows a warning (`share-local-hint`) and the invite is disabled.
  - **Tailscale share link**, one time (`share-link-form`): input `share-link-input`, **Save**
    (`share-link-save`, PATCHes `tailscaleShareLink`), help line "Tailscale admin → Machines →
    <machine> → Share → Copy share link" and **Open Tailscale admin** (`share-link-admin`, new
    tab, noopener → login.tailscale.com/admin/machines). Once stored: "Share link saved"
    (`share-link-saved`) with **Change** (`share-link-change`) and **Clear** (`share-link-clear`,
    PATCHes `''`). Errors inline (`share-link-error`).
  - **Copy invite** (`copy-invite`, `data-invite-url` = the composed URL) copies
    `Movie night 🎬 Tap this on your phone and follow the steps: <inviteUrl>` where `inviteUrl` =
    `buildInviteUrl(PUBLIC_ORIGIN, { h: tailnetUrl, s: shareLink?, n: hostNick? })`
    (`web/src/lib/publicOrigin.ts`: `VITE_PUBLIC_ORIGIN`, default `https://wochit.vercel.app`).
    The PIN is never in the message.
  - The PIN (`share-pin`, `copy-pin`) with "Tell her the PIN separately."
  - The raw tailnet address, small (`share-url`, `copy-url`).
  - A QR of the same invite URL as inline SVG (`share-qr`, error-correction M,
    `qrcode-generator` lazy-loaded; `share-qr-placeholder` while unpublished).
- **Show video here too** stage (`host-stage`), only when the checkbox below is on.
- **NowPlayingCard** (`now-playing`): poster, source badge (`source-badge`), remote sync pill,
  title (`now-playing-title`), an encode line (`encode-status`, `data-tone`) from `transcode`
  messages — "Encoding 720p · 32:10 ready of 1:53:20" (the rendition furthest behind), "Encoded"
  when all are done, red "Encoding 360p failed: <message>" — big elapsed/duration, the scrubber,
  play/pause (`host-play-pause`) and the three reaction buttons.
- **VlcCard** (`vlc-card`): **Follow VLC** switch (`follow-vlc`) and status (`vlc-status`).
- **GuestsPanel** (`guests`): one row per guest, `guest-row-<memberId>` (`data-stale`,
  `data-state`): nick (presence, "Guest" if unknown), state chip Playing / Paused / Stalled
  (`guest-state-<id>`), position (`guest-position-<id>`, formatTime), drift
  (`guest-drift-<id>`, signed one decimal + "ahead"/"behind", inner `data-tone` ok < 0.3 s,
  warn < 1 s, bad otherwise), buffer "<n> s", rendition label (720p / Auto / Native / —), rtt
  "<n> ms" when known, and "updated <n>s ago" (`guest-age-<id>`) from `at` against the synced
  server clock; the row greys at 15 s. A guest on the presence list without a report shows
  "Connected, no player yet". Empty state (`guests-empty`): "No guest connected. Open the link on
  another device; it appears here within a few seconds." Guests send `PlayerTelemetry` with every
  ping (every 3 s after the initial burst); host-mode clients never do.
- **Show video here too** checkbox (`show-video`; for testing, the host PC normally watches in VLC).
- **LibraryBrowser** (`library`): breadcrumbs (`crumb-<i>`), filter (`library-filter`), rows
  `lib-row-<id>` with **Open in VLC** (`open-in-vlc-<id>`) and **Play in browsers**
  (`play-in-browsers-<id>`). Selecting switches the room's media and posts a system chat line.
- **HostFooter** (`host-footer`): URLs (`host-url`, the `.ts.net` one tagged "share this") and
  PIN with copy buttons, "<h> host · <n> guests" (`members-count`, from `health.members`), cache
  usage (`cache-usage`), encoder, and **Stop host** (`stop-host`) → inline "Really stop? Yes / No"
  (`stop-host-confirm`, `stop-host-yes`, `stop-host-no`) → `POST /api/host/shutdown` with the PIN
  header → the whole console is replaced by a centred card "Host stopped. You can close this
  window." (`host-stopped`); errors inline (`stop-host-error`).

The invite page she lands on is § 6.

### 4. Chat drawer, `web/src/features/chat`

- Header: room title "WochIt", member chips (nick, host crown icon for the host, typing "…"
  pulse), my nick editable inline (pencil icon → input → Enter).
- Messages: virtualised not required (200 max). Bubbles: mine right in accent, theirs left in
  `surface-2`, system lines centered muted small. Group consecutive messages within 2 min under
  one nick label; time on hover/long-press. GIF messages render `previewUrl` in a rounded box max
  220 px wide, tap to open `url` large in a lightbox. Emoji-only messages (1–3 emoji) render at
  2.25× size with no bubble.
- Composer (sticks to bottom, respects keyboard and safe-area): emoji button (opens
  `emoji-picker-element` in a popover above, dark theme, recent row), text input (auto-grow to 4
  lines, Enter sends, Shift+Enter newline), GIF button (opens the GIF panel), send button appears
  when there is text.
- GIF panel: replaces the picker area, search field autofocus, grid of 2 columns (3 on desktop)
  of `previewUrl`s with aspect-correct heights, infinite scroll via `next`, "Featured" when the
  query is empty, tap sends immediately. placeholder "Search KLIPY" (required by Klipy) or "Search GIPHY"; "Powered by KLIPY/GIPHY" footer from `GifSearchResponse.provider`. If `gifSearchAvailable` is
  false: friendly empty state with the one-line setup pointer.
- Unread: count messages received while the drawer is tucked; badge on the toggle; clear on open.
- Typing: send `typing on` on first keystroke, `off` after 2 s idle or send.

### 5. Reactions overlay, `web/src/features/reactions`

See ARCHITECTURE § Reactions for the particle spec. Toast: bottom-center glass pill
"Mia 🍅" for 1.4 s, stacking upward if several. On desktop host view the overlay covers the
whole window too.

## Subtitles menu

Sheet (phone) / popover (desktop) listing "Off" plus each `MediaInfo.subtitles` entry by label
and language; unsupported bitmap tracks shown disabled with the reason. Choice persisted per
media id in `localStorage['wochit.subs.<mediaId>']`. Rendered via `<track>` elements with
`mode = 'showing'` on the chosen one; add a size toggle (S/M/L) that sets `::cue` font size.

## Quality menu

"Auto" plus each rendition ("1080p · 5.2 Mbps"). Current one ticked; a live buffer meter
("12 s buffered") helps her pick lower when it stalls. On iOS native HLS switching swaps the
source (see ARCHITECTURE § Sync) — show a brief "Switching…" while it reloads.

## Accessibility & misc

- All controls are buttons with `aria-label`; the scrubber is `role=slider` with keyboard
  arrows (±5 s) and Home/End.
- Live regions: sync pill text and system chat lines use `aria-live="polite"`.
- PWA: `public/manifest.webmanifest` (name WochIt, standalone, `theme_color #0b0b10`,
  `background_color #0b0b10`, 192/512 icons generated as simple SVG→PNG by the player agent),
  no service worker in v1 (the host serves everything; offline makes no sense here).
- Keyboard on desktop: Space play/pause, ←/→ ±5 s, C chat, S subtitles, 1/2/3 reactions, Esc
  closes panels. Not while typing in the composer.
