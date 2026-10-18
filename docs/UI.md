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

### 3. Host view (desktop), `web/src/features/hostmode`

Two columns on `--color-bg`: left 2/3 content, right 1/3 chat (same component as guest, always
open, collapsible to the rail).

Left column, top to bottom:
- **Now playing card** (glass): poster thumbnail, title, source badge (`VLC`, `Browser`, `—`),
  big elapsed/duration, a full-width scrubber (same component as guest), play/pause, the three
  reaction buttons, and the sync pill for the guest ("Mia · in sync · 720p · 2.4 Mbps" from the
  guest's reported stats — see `presence` extension below if implemented; otherwise just
  "Mia connected").
- **Follow VLC** toggle with status ("VLC connected · Dune.mkv"). When VLC is not reachable, a
  hint: "Start VLC from here or enable its web interface — see Setup".
- **Library**: breadcrumb + list of folders/files (name, duration, size) from `/api/library`;
  search box filters the current folder; each file row has **Open in VLC** (primary) and **Play in
  browsers** (secondary). Selecting switches the room's media and posts a system chat line.
- Collapsed by default: **Show video here too** (renders the player stage above the card).
- Footer line: host URL(s) and PIN with copy buttons, cache usage, encoder in use.

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
