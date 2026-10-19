# Wire protocol

Canonical definitions: `shared/src/protocol.ts` (zod). This page is the narrative. One WebSocket
per client at `/ws`, JSON text frames, one message per frame. Every message has `type`. The host
validates with `C2S.safeParse`; anything invalid gets `error bad_message` and is dropped (the
socket stays open). The web app validates with `S2C.safeParse` and ignores invalid frames.

## Connect

```
C→S hello   { v: 1, pin, nick, clientId, mode: 'auto'|'host'|'guest' }
S→C welcome { v: 1, you: Member, room: RoomSnapshot, serverTime, mediaToken,
              gifSearchAvailable, vlc: { connected, following } }
   or error  { code: 'bad_pin' }   then the socket is closed with 4001
S→C presence { members }          to everyone else
```

`clientId` is random, persisted in `localStorage['wochit.clientId']`. Reconnecting with the same
id reuses the `Member.id`. The first message must be `hello` within 5 s or the socket closes.

## Clock

```
C→S ping { t: Date.now(), telemetry?: PlayerTelemetry }
S→C pong { t, serverTime }
```

Client computes `offset = serverTime - (t + rtt/2)`; see `ClockSync`. `telemetry` is optional
and only meaningful from a guest with a player; host connections omit it. The host uses it for
nothing but the `telemetry` relay described under [Guest telemetry](#guest-telemetry-host-connections-only).

## Playback

```
C→S control { action: 'play' | 'pause' | 'toggle' | 'seek', position? }
S→C state   { state: PlaybackState }          to everyone, including the sender
```

`state` arrives on every change and every second while playing. `seq` increases monotonically;
discard stale ones. `position` is where the media was at `updatedAt` (host clock); use
`expectedPosition()` to project to now.

When the room's media changes (host selected a file, VLC opened a different one):

```
S→C media { media: MediaInfo | null }
S→C state { ... mediaId, position: 0, playing: false }
```

Transcode progress, mostly for the "buffering the first time" hint:

```
S→C transcode { mediaId, rendition, status: 'starting'|'running'|'done'|'error', readyToSec?, message? }
```

VLC bridge status:

```
S→C vlc { connected, following }
```

## Chat

```
C→S chat     { kind: 'text', text }  |  { kind: 'gif', gif: Gif }
S→C chat     { message: ChatMessage }                   to everyone
C→S typing   { on }
S→C presence { members }                                 typing flags live on Member
C→S nick     { nick }
S→C presence { members }  +  chat { message: { kind: 'system', text: 'A is now B' } }
```

`RoomSnapshot.recentChat` carries the last 200 messages on connect.

## Reactions

```
C→S reaction { kind: 'cheer' | 'boo' | 'heart' }
S→C reaction { kind, from: { id, nick }, at }          to everyone, including the sender
```

The sender animates on the echo, not on tap, so both screens fire within one round trip of each
other. Rate limit: one per `REACTION_MIN_GAP_MS` per member; excess is silently dropped.

## Host-only

```
C→S select_media { mediaId }     → media + state, source 'browser' (or 'vlc' if VLC has that file open)
C→S open_in_vlc  { mediaId }     → host launches VLC with the file; when VLC reports it, source 'vlc'
C→S follow_vlc   { on }          → whether VLC's open file overrides the room's media
```

From a guest these return `error not_host`.

## Guest telemetry (host connections only)

A guest's player reports on every `ping`. The host stamps the report, works out the guest's
drift against the room's expected position, keeps the latest report per member, and relays the
list to the host connections:

```
C→S ping      { t, telemetry: { position, playing, bufferedAheadSec, rendition, stalled, rttMs } }
S→C telemetry { members: MemberTelemetry[] }          host connections only
```

`PlayerTelemetry`: `position` is the video element's current media time in seconds; `playing`
is true only while the element is actually advancing (not paused, not ended, not waiting for
data); `bufferedAheadSec` is the media buffered past `position`; `rendition` is the rung the
player is on, `'auto'` while hls.js chooses, `'native'` on Safari's own HLS, `null` without a
player; `stalled` is true while waiting for data; `rttMs` is the client's last measured round
trip, `null` before its first pong.

`MemberTelemetry` is that report plus the member `id`, `driftSec` (player position minus the
room's expected position when the report arrived; negative means behind) and `at` (host clock,
ms, at arrival).

`telemetry` goes only to connections whose member `isHost`; guests never see each other's
figures. It is sent when a report arrives, coalesced to at most one message per 500 ms, and once
more with `members: []` when the last guest leaves, so the console can clear its Guests panel.
Figures are as fresh as the guest's ping cadence: 2 s for the first five pings, then 3 s while a
player is attached (`PING_TELEMETRY_MS`), 10 s for a connection with nothing to report.

## REST

| method & path | auth | returns |
|---|---|---|
| `GET /api/health` | none | `HealthResponse` |
| `GET /api/library?parent=<id>` | header `x-wochit-pin`, local only | `LibraryResponse` |
| `GET /api/host/settings` | header `x-wochit-pin`, local only | `HostSettingsResponse` |
| `PATCH /api/host/settings` | header `x-wochit-pin`, local only; JSON body `HostSettingsPatch` | `HostSettingsResponse` |
| `POST /api/host/shutdown` | header `x-wochit-pin`, local only | `ShutdownResponse`, then the host exits |
| `GET /api/gif/search?q=&pos=&limit=` | header `x-wochit-pin` | `GifSearchResponse` |
| `GET /api/gif/featured?pos=&limit=` | header `x-wochit-pin` | `GifSearchResponse` |
| `GET /media/:id/master.m3u8?t=` | media token | master playlist |
| `GET /media/:id/:rendition/index.m3u8?t=` | media token | virtual media playlist |
| `GET /media/:id/:rendition/seg00042.ts?t=` | media token | segment (JIT) |
| `GET /media/:id/subs/:n.vtt?t=` | media token | WebVTT |
| `GET /media/:id/poster.jpg?t=` | media token | JPEG |
| `GET /*` | none | `web/dist` (SPA fallback to `index.html`) |

Errors are JSON `{ error: ErrorCode, message }` with 400/401/403/404/429/500.

### Host-only routes

`/api/library` and everything under `/api/host/` need both a correct `x-wochit-pin` header and a
local client address (loopback, one of this machine's own addresses, or `WOCHIT_HOST_ADDRS`; see
host detection in ARCHITECTURE.md). The PIN is checked first: a missing or wrong header is
`401 bad_pin` and counts toward the per-address limit (`429 rate_limited` after five failures in
a minute); a good PIN from a non-local address is `403 not_host`. Behind `tailscale serve` every
connection arrives from loopback, so the check unwraps one `X-Forwarded-For` layer and her phone
still gets 403.

- `GET /api/host/settings` → `{ gifSearchAvailable, gifProvider, keys: { klipy, giphy },
  tailscaleShareLink }`. `keys` says whether a key is present per provider; a key itself is never
  sent. `tailscaleShareLink` is the stored Tailscale share link in full (or `null`): the route is
  host-only, and the console needs it to build the invite.
- `PATCH /api/host/settings` with `{ klipyApiKey?, giphyApiKey?, tailscaleShareLink? }` (keys:
  strings of at most 200 characters, trimmed; the share link: a URL of at most 500 characters)
  writes the given values into `.env` as `KLIPY_API_KEY` / `GIPHY_API_KEY` /
  `WOCHIT_TS_SHARE_LINK`, leaving every other line as it was; an empty string removes the entry.
  GIF search is reconfigured in place, no restart, and the answer is the same
  `HostSettingsResponse`. A body that fails `HostSettingsPatch` is a 400.
- `POST /api/host/shutdown` answers `{ ok: true, message }` and then shuts the host down the way
  Ctrl+C would: clients get close code 1001, transcode jobs stop, VLC is left running.

### Health

`GET /api/health` is unauthenticated; the launcher and the console's Readiness panel poll it.
Besides `ok`, `version`, `protocol`, `source`, `ffmpeg { found, encoder }` and
`gifSearchAvailable`, a `HealthResponse` carries:

- `vlc { connected, following }` — `following` is whether VLC's open file overrides the room's
  media; absent on hosts built before it was added;
- `gifProvider` — `'klipy'`, `'giphy'`, or `null` when no key is configured;
- `cache { usedBytes, maxBytes }` and `urls`, the local and tailnet URLs the host believes it
  has, for the footer's copy buttons;
- `tailnet { published, url, checkedAt }` — whether `tailscale serve status` currently maps
  `:8443` to this host, re-checked about once a minute, and the resulting URL; absent when the
  tailscale CLI was not found;
- `members { hosts, guests }` — connections right now.

### Invite URL

Not a wire message, but shared code: the console builds the guest invite with
`buildInviteUrl(publicOrigin, InviteParams)` and the public page reads it back with
`parseInviteHash(location.hash)`.

```
https://wochit.vercel.app/invite#h=<host origin>&s=<Tailscale share link>&n=<host name>
```

`INVITE_PATH` is `/invite`. `h` (required) is the host origin to open once Tailscale is on, e.g.
`https://william-desktop.tail2ac207.ts.net:8443`; `s` (optional) is the share link; `n`
(optional, 1–24 characters) is the host's display name. Values are `encodeURIComponent`-encoded
and `&`-joined; the parser also accepts `+` for a space and returns `null` for anything that does
not validate. Everything is in the fragment, which browsers never send to a server. The PIN is
never part of it.

## Close codes

| code | meaning |
|---|---|
| 4000 | no `hello` within 5 s |
| 4001 | bad PIN |
| 4002 | protocol version mismatch |
| 4003 | rate limited |
| 1001 | host shutting down (clients reconnect with backoff 1 s → 10 s) |
