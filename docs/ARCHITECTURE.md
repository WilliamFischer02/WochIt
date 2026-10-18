# WochIt architecture

## The problem in one paragraph

William's desktop in Montana holds the film and runs VLC. His girlfriend in Washington has only a
phone. Both must be able to play, pause and scrub, and both screens must show the same moment,
with a chat beside the picture, GIFs, emoji and three big reactions. His own screen should not
re-stream the film to itself: when the site is opened on the host PC it shows the chat and the
remote controls, not the video.

## Shape

```
┌──────────────── host PC (Windows, Montana) ────────────────┐      ┌── phone (Washington) ──┐
│  VLC 3  ◀── HTTP intf (loopback :8089) ──┐                 │      │  Safari / Chrome       │
│                                          ▼                 │      │  ┌──────────────────┐  │
│  media file ─▶ ffmpeg (NVENC) ─▶ HLS cache (Z:) ─▶ host agent (Node, :8788) ◀──HTTPS/WSS──▶ │ web app (guest)  │  │
│                                                   │  ▲     │      │  │ video + controls │  │
│  browser on the host PC ◀── same origin ──────────┘  │     │      │  │ chat · reactions │  │
│  (web app in host mode: chat + remote, no video)     │     │      │  └──────────────────┘  │
│                                          Tailscale Serve   │      │  Tailscale app         │
│                                          :8443 → :8788     │      └────────────────────────┘
└────────────────────────────────────────────────────────────┘
```

Three packages, one repo:

| package | runs where | job |
|---|---|---|
| `shared` | both | zod schemas for every message, sync math |
| `host` | host PC only | HTTP + WebSocket server, media pipeline, VLC bridge, room, GIF proxy, serves `web/dist` |
| `web` | any browser | the whole UI; connects to the host over WebSocket and plays HLS from it |

There is no cloud backend. Vercel hosts a copy of `web/dist` as a public landing page that asks
for the host URL; the real sessions run against the host agent. Both of them are the same bundle.

## Networking (see DECISIONS.md for why)

- Primary: **Tailscale**. The host agent listens on `127.0.0.1:8788`. `tailscale serve
  --https=8443 http://127.0.0.1:8788` publishes `https://william-desktop.tail2ac207.ts.net:8443`
  to the tailnet with a real certificate. Port 443 is already taken by another service on this
  machine, so WochIt uses 8443. The guest installs the Tailscale app and gets the desktop
  **shared as a node** to her own (free) tailnet, or joins his tailnet as an invited user. Traffic is
  WireGuard, peer to peer when NAT allows, relayed otherwise; no bandwidth cap that matters.
- Fallback: **Tailscale Funnel** on the same port makes the URL public (no app on the phone).
  Funnel is relayed and bandwidth-limited; expect 480p. The room PIN is what protects the room in
  this mode, so it is mandatory everywhere.
- When the web app is served by the host agent it connects to its own origin; when served from
  Vercel it asks for the host URL once and remembers it.
- Behind `tailscale serve` every connection arrives from `127.0.0.1`; the real client address is in
  `X-Forwarded-For` and the tailnet identity in `Tailscale-User-Login`. Host detection must read
  those (see below).

## Playback sources

`PlaybackState.source`:

- **`vlc`** — VLC on the host PC is the master clock. The host polls VLC's HTTP interface
  (`/requests/status.json`) every 250 ms and republishes `{playing, position}`; every `control`
  from any client is translated into a VLC command (`pl_forceresume`, `pl_forcepause`,
  `seek&val=<int seconds>`). VLC's `position` is a 0–1 float; multiply by the ffprobe duration for
  sub-second position (VLC's own `length` and `time` are whole seconds). The host also reads
  `/requests/playlist.json` to learn which file VLC has open (`uri: file:///...`) and makes that
  the room's media automatically ("follow VLC", on by default).
- **`browser`** — no VLC. The host keeps a virtual clock: `position` at `updatedAt`, advancing
  while `playing`. Controls mutate it directly. Both browsers follow it. This is also what the e2e
  suite runs, since CI has no VLC.
- **`none`** — nothing chosen yet. The guest sees a "waiting for the host" screen.

The host PC's own browser (host mode) shows no video by default in either source; a "show video
here too" toggle exists for testing.

## Media pipeline (host/src/media)

1. **Identity.** `mediaId = sha1(absolutePath + size + mtimeMs).slice(0, 16)`. Stable across
   restarts, meaningless to guests.
2. **Probe.** `ffprobe -v error -print_format json -show_format -show_streams`. Record duration,
   video codec/size/fps, audio streams (codec, channels, language, title), subtitle streams
   (codec, language, title, default/forced flags). Pick the default audio stream (first `default`
   disposition, else first). Sidecar subtitles: same basename with `.srt`/`.vtt`/`.ass`, optional
   `.en`/`.eng` style language tags.
3. **Ladder.** From `RENDITION_LADDER`, drop rungs taller than the source. Always keep at least
   one rung (the smallest ≥ source height, or 360p). Width = even number preserving aspect.
4. **Just-in-time HLS.** Nothing is pre-transcoded. The host serves **virtual playlists**: the
   master lists renditions; each media playlist lists all `N = ceil(duration / 4)` segments
   `seg00000.ts … seg{N-1}.ts` with `#EXTINF:4.000` (last one = remainder),
   `#EXT-X-PLAYLIST-TYPE:VOD`, `#EXT-X-INDEPENDENT-SEGMENTS`, `#EXT-X-ENDLIST`. A request for
   segment `k` of rendition `r`:
   - if `cache/<id>/<r>/seg{k}.ts` exists → serve it;
   - else if a transcode job for `(id, r)` is running and `k` is within `[job.nextSegment,
     job.nextSegment + 8]` → wait for the file (poll every 100 ms, up to 30 s);
   - else kill that job (if any) and start one at segment `k`; wait as above.
   Jobs run to the end of the file at full speed (NVENC manages ~5–10× realtime), so after a few
   minutes the whole film is cached and every scrub is instant. The cache persists on disk across
   runs; LRU eviction by whole media past `WOCHIT_CACHE_MAX_GB`.
5. **The ffmpeg command** (one job = one rendition; run ≤ 3 jobs at once, kill the oldest idle):

   ```
   ffmpeg -hide_banner -loglevel warning -nostdin
     -ss <k*4> -i <file>                       # accurate seek: decode from the prior keyframe,
                                               #   drop frames before k*4 so output starts exactly there
     -map 0:v:0 -map 0:a:<audioIndex>
     -copyts -start_at_zero                    # keep source timestamps so PTS in seg k ≈ k*4 (hls.js
                                               #   places segments by playlist position; they must agree)
     -vf scale=-2:<height>:flags=lanczos
     -c:v h264_nvenc -preset p4 -tune hq -rc vbr -cq 23 -b:v <kbps>k -maxrate <kbps*1.2>k -bufsize <kbps*2>k
       -profile:v high -bf 2 -spatial-aq 1 -temporal-aq 1 -no-scenecut 1
       -g 240 -keyint_min 240                  # upper bound only; forced keyframes below rule
     -force_key_frames "expr:if(isnan(prev_forced_t),gte(t,0),gte(t,floor(prev_forced_t/4)*4+4))"
                                               # keyframe at the first frame, then at every multiple of 4 s
                                               #   of *source* time. Do not use gte(t,n_forced*4): with
                                               #   copyts it fires on every frame until n_forced catches up.
     -c:a aac -b:a 128k -ac 2 -ar 48000
     -f hls -hls_time 4 -hls_list_size 0 -hls_playlist_type vod
     -hls_flags temp_file+independent_segments   # temp_file: a segment file exists only when complete
     -start_number <k> -hls_segment_filename cache/<id>/<r>/seg%05d.ts
     cache/<id>/<r>/_ffmpeg.m3u8               # ignored; the host serves its own virtual playlist
   ```
   `libx264` fallback: `-preset veryfast -crf 23 -sc_threshold 0` in place of the nvenc flags.
   `h264_qsv` / `h264_amf` may be added behind `WOCHIT_ENCODER`.

   **What the measurements changed (2026-10-18, see `host/src/media/transcoder.ts` for the
   command actually run):** `-forced-idr 1` for NVENC (otherwise forced keyframes are non-IDR
   and the muxer cuts 8 s segments); `-hls_segment_options mpegts_copyts=1` (otherwise the TS
   muxer adds its 1.4 s delay and segment 10 starts at 41.4 s); `-bf 0` (B-frames shift a job
   that starts at t=0 by two frames, so segments from different jobs disagreed by 67 ms);
   `-af atrim=start=0.0215` on the k=0 job (AAC priming packet otherwise shifts that job by one
   audio frame); `scale=W:H,setsar=1,format=yuv420p` (anamorphic and 10-bit sources); audio is
   always re-encoded (stream copy drags pre-seek audio into the first segment); jobs skip runs of
   already-cached segments instead of re-encoding to the end. With these, segment k from any job
   starts at exactly k·4.000 s (Δ 0.000 between a k=10 job and a k=0 job).

   **Verify, don't trust.** The media agent must generate a test file
   (`ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -t 90 ...`,
   with a burned-in timecode via `drawtext`), start a job at k=10, and check with
   `ffprobe -show_entries packet=pts_time -select_streams v -read_intervals ...` that seg00010.ts
   starts at 40.00 ±0.05 s and seg00011.ts at 44.00. Then start a second job at k=0 and confirm
   seg00010.ts produced by *that* job is byte-compatible (same first PTS, same duration). Then
   load the virtual playlist in hls.js (Playwright) and seek to 41 s: the displayed timecode must
   read 41.
6. **Subtitles.** Text subtitle streams (`subrip`, `ass`, `ssa`, `mov_text`, `webvtt`) are extracted
   once per media with `ffmpeg -i file -map 0:s:<n> -f webvtt cache/<id>/subs/<n>.vtt`; sidecars
   are converted the same way. Bitmap subtitles (`hdmv_pgs_subtitle`, `dvd_subtitle`) are listed
   with `kind: 'embedded'` but flagged unsupported in the label ("PGS — not supported yet"); a
   later version may burn them in as a separate rendition. Each client picks its own track.
7. **Poster.** One frame at 10 % duration, 480 px wide JPEG, for the connect/wait screens.
8. **Access.** Every `/media/...` URL requires `?t=<mediaToken>` where
   `mediaToken = HMAC-SHA256(pin, 'media')` hex, issued in `welcome`. Range requests are
   honoured. `Cache-Control: private, max-age=31536000` on segments (content is immutable per id).

## Room (host/src/room)

- One room per host process. State per `PlaybackState`, members per `Member`, last 200 chat
  messages in memory plus an append-only `logs/chat-YYYY-MM-DD.jsonl` on disk.
- `hello` → verify PIN (constant-time compare; 5 failures per address per minute → `rate_limited`),
  resolve `isHost` (below), reply `welcome`, broadcast `presence`.
- `control` → if `source === 'vlc'`: send to VLC, and immediately publish an optimistic `state`
  (the next poll corrects it). Otherwise mutate the virtual clock. Always bump `seq`.
- `state` is broadcast on every change and as a heartbeat every 1000 ms while playing (VLC poll
  position), so a client that missed a message converges within a second.
- `reaction` → rate limit `REACTION_MIN_GAP_MS` per member, broadcast with `from`.
- `chat` → assign id and `at`, validate `gif.url` is https and its host belongs
  to Klipy (`*.klipy.com`) or GIPHY (`*.giphy.com`); no arbitrary image URLs, broadcast, log.
- `nick` → update member, broadcast `presence`, post a `system` chat line "A is now B".
- `select_media` / `open_in_vlc` / `follow_vlc` → host members only (`not_host` otherwise).
- Disconnect → remove member, broadcast `presence`. Reconnect with the same `clientId` reuses the
  member id so chat history reads continuously.

### Host detection

A connection is **local** when, after unwrapping one layer of `X-Forwarded-For` only if the direct
peer is loopback, the client address is: loopback, one of this machine's interface addresses
(including its Tailscale IPv4/IPv6), or in `WOCHIT_HOST_ADDRS`. Then:

| requested `mode` | local | result |
|---|---|---|
| `auto` | yes | host |
| `auto` | no | guest |
| `host` | yes | host |
| `host` | no | guest + `error not_host` (informational) |
| `guest` | any | guest |

The web app sends `mode` from the `?mode=` query if present, else `auto`, and shows a small "I'm
on the host PC / I'm a guest" switch on the connect screen for the rare misdetection.

## Sync (web, using shared/sync.ts)

- On connect the client pings every 2 s for the first 10 s, then every 10 s; `ClockSync` turns the
  round trips into a server-time offset.
- Every 500 ms while media is loaded: `target = expectedPosition(state, clock.serverNow())`,
  `action = driftAction(video.currentTime, target, state.playing)`; apply: `none` → rate 1,
  `nudge` → `video.playbackRate = rate`, `seek` → `video.currentTime = target` (+0.3 s when
  playing on a phone, to cover the seek latency). Pause/play transitions call `pause()`/`play()`.
- Local intents: tapping play/pause or releasing the scrubber sends `control` and applies the
  change locally at once; the next `state` reconciles. Scrubbing shows a ghost time while dragging
  and sends a single `seek` on release (plus at most one every 300 ms while dragging if the user
  holds, so the other side can follow a slow scrub).
- Autoplay: iOS requires a user gesture before `play()` with sound. The guest screen starts with a
  "Tap to join playback" overlay that calls `play()` muted-then-unmuted inside the gesture.
- Quality: hls.js `currentLevel` for manual, `-1` for auto, with a buffer-health readout. On iOS
  Safari (native HLS, hls.js unsupported) the quality menu swaps `video.src` between
  `renditions[i].playlistUrl` and the master, then seeks back to `target`.

## GIFs (host/src/gif, web chat)

Google shut down the Tenor API on 2026-06-30, so the host proxies **Klipy** (free developer API,
`https://api.klipy.com/api/v1/<key>/gifs/search|trending`) or **GIPHY** (beta keys free but capped
at 100 calls/hour) behind one interface: `/api/gif/search?q=&pos=&limit=24` and
`/api/gif/featured?pos=&limit=`. `WOCHIT_GIF_PROVIDER=auto` picks Klipy when `KLIPY_API_KEY` is
set, else GIPHY when `GIPHY_API_KEY` is set. The host calls Klipy with `content_filter=medium` and
`format_filter=gif,webp,mp4`, normalises to `Gif` (`previewUrl` = `file.sm.gif`, `url` =
`file.md.gif`), maps `has_next` to an opaque `next` page string, caches queries for 60 s (featured
for 5 min) because testing-mode keys allow 100 requests/hour, and stamps
`GifSearchResponse.provider` so the panel shows the right attribution. Klipy requires the search
box placeholder to read exactly "Search KLIPY"; "Powered by KLIPY" is optional and shown in the
panel footer. Chat GIF URLs
are accepted only from those providers' CDN hosts. With no key: `gifSearchAvailable: false` in
`welcome` and the GIF button explains how to add one.

## Reactions (web/src/features/reactions)

A single full-viewport `<canvas>` (`pointer-events: none`, above video and under the chat drawer).
On a `reaction` message spawn 18–28 particles over 1.2 s: emoji from `REACTION_EMOJI[kind]`, size
24–48 px, start above the top edge at random x, fall at 90–160 px/s with a sine sway and a slow
spin, fade out over the last 40 % of a 2.8–4 s life. Cap 80 live particles; drop spawns beyond it.
Simultaneously a full-screen tint fades in and out over 1.6 s: cheer `rgba(255,196,0,.09)`, boo
`rgba(96,160,64,.11)`, heart `rgba(255,88,140,.09)`. A small toast names the sender ("Mia 🍅").
`requestAnimationFrame` only while particles exist; respect `prefers-reduced-motion` (tint only).

## Configuration

`.env` (see `.env.example`). The host prints at start: URL(s) to open, the PIN, ffmpeg path and
encoder, VLC bridge status, cache dir and size. `--pin`, `--port`, `--roots` CLI flags override.

## Testing

- `shared`: vitest on `sync.ts` (expectedPosition, driftAction thresholds, ClockSync median).
- `host`: vitest on virtual playlist generation, ladder selection, VLC status parsing (fixtures),
  host detection table, protocol validation, media token, GIF provider normalisation (Klipy and GIPHY fixtures).
- `web`: vitest for the sync controller (fake video element), chat reducer, reaction scheduler.
- e2e (`web/e2e`, Playwright, Chromium): build everything, generate a 60 s test video with
  ffmpeg, start the host with `--pin 123456 --roots <tmp>` in `browser` source, open
  `/?mode=host` and `/?mode=guest`, select the media on the host tab, play, assert the guest's
  `currentTime` tracks within 0.5 s after 5 s, pause from the guest and assert the host's state,
  seek to 30 s from the guest and assert playback resumes at 30 ±0.5, send a text and a GIF
  (mock GIF API) each way, fire a reaction and assert the canvas has pixels and the toast shows.

## File ownership for the build agents

| area | owner | path |
|---|---|---|
| media pipeline | media agent | `host/src/media/**`, `host/test/media/**` |
| server, room, VLC, gif, CLI | server agent | `host/src/{server,room,vlc,gif,config,index}.ts`, `host/test/**` except media |
| app shell, connect, player, sync, controls, subtitles, host mode | player agent | `web/src/{app,features/{connect,player,sync,controls,subtitles,hostmode},lib}/**` |
| chat drawer, GIF picker, emoji, reactions overlay, presence | chat agent | `web/src/features/{chat,gif,reactions,presence}/**` |
| docs/SETUP.md, scripts, README polish | docs agent | `docs/SETUP.md`, `scripts/**`, `README.md` |

Shared interfaces between the two web agents live in `web/src/app/store.ts` (zustand) and
`web/src/lib/socket.ts`; the player agent writes them first, the chat agent consumes them and
may add slices under its own keys. Shared host interfaces live in `host/src/media/index.ts`
(exported `MediaService` type, written by the media agent) consumed by the server agent.
