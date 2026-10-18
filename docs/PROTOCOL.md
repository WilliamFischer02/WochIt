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
C→S ping { t: Date.now() }
S→C pong { t, serverTime }
```

Client computes `offset = serverTime - (t + rtt/2)`; see `ClockSync`.

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

## REST

| method & path | auth | returns |
|---|---|---|
| `GET /api/health` | none | `HealthResponse` |
| `GET /api/library?parent=<id>` | header `x-wochit-pin`, local only | `LibraryResponse` |
| `GET /api/gif/search?q=&pos=&limit=` | header `x-wochit-pin` | `GifSearchResponse` |
| `GET /api/gif/featured?pos=&limit=` | header `x-wochit-pin` | `GifSearchResponse` |
| `GET /media/:id/master.m3u8?t=` | media token | master playlist |
| `GET /media/:id/:rendition/index.m3u8?t=` | media token | virtual media playlist |
| `GET /media/:id/:rendition/seg00042.ts?t=` | media token | segment (JIT) |
| `GET /media/:id/subs/:n.vtt?t=` | media token | WebVTT |
| `GET /media/:id/poster.jpg?t=` | media token | JPEG |
| `GET /*` | none | `web/dist` (SPA fallback to `index.html`) |

Errors are JSON `{ error: ErrorCode, message }` with 400/401/403/404/429/500.

## Close codes

| code | meaning |
|---|---|
| 4000 | no `hello` within 5 s |
| 4001 | bad PIN |
| 4002 | protocol version mismatch |
| 4003 | rate limited |
| 1001 | host shutting down (clients reconnect with backoff 1 s → 10 s) |
