# Decisions

Dated, with the alternatives that lost. Add to the bottom; do not rewrite history.

## 2026-10-18 — Stream the file, not the playback

**Chosen:** the host transcodes the media file to HLS on demand and each browser plays it with its
own buffer; sync is a shared clock, not a shared video signal. VLC, when used, is only the
master clock and William's own display.

**Rejected:**
- *VLC's own streaming output (sout → HLS/RTSP).* Six-plus seconds of latency, one fixed quality,
  the guest cannot scrub independently of what VLC emits, and every pause re-primes the stream.
- *WebRTC capture of the playing video (browser `captureStream` or OBS → SFU).* Sub-second and
  zero-install, but quality is capped by a real-time encoder at a few Mbps, subtitles are burned
  in, there is no buffer so every network hiccup is a visible stall, and it needs a TURN relay
  for the NAT cases that P2P cannot cross. Kept as a possible future "live mode" for sharing
  things that are not files (a game, a browser tab).
- *Jellyfin/Plex as the backend with SyncPlay/Watch Together.* Solves transcoding and sync
  out of the box, but the sync UI is theirs and cannot be embedded; the chat, GIFs, reactions and
  host-mode would live beside the player, not over it. Too much to bolt on for what it saves.

## 2026-10-18 — Tailscale, not a public tunnel

**Chosen:** the host listens on loopback; `tailscale serve --https=8443` publishes it to the
tailnet with a Let's Encrypt certificate. The guest installs the Tailscale app and receives the
desktop as a shared node (or an invite). Traffic is end-to-end WireGuard, direct when possible.

**Rejected:**
- *Cloudflare Tunnel.* Excellent ergonomics, but Cloudflare's self-serve terms require a paid
  Stream/Images-type product for serving video through their network. A two-hour film every
  Friday is exactly the case they mean.
- *Tailscale Funnel as the primary.* Public URL and zero install, but relayed and
  bandwidth-limited; fine as a fallback at 480p when installing the app is not an option.
- *Port forwarding on the home router + dynamic DNS + a certificate.* Works, exposes the PC
  directly to the internet, and breaks whenever the ISP changes the address.

## 2026-10-18 — No cloud component for sync or chat

Both clients must reach the host for video anyway, so the room (WebSocket) lives there too. A
hosted realtime service (Ably, PartyKit, Supabase Realtime) would add an account, a dependency and
a second clock to reconcile, for no gain. Vercel hosts only a copy of the static web bundle as a
"connect" page.

## 2026-10-18 — VLC via its HTTP interface, read as master

VLC 3.0.21 is installed. Its Lua HTTP interface gives `status.json` (state, 0–1 position) and
commands `pl_forceresume`, `pl_forcepause`, `seek&val=<seconds>`. Seek granularity is one
second; acceptable for scrubbing a film. The host launches VLC itself with `--extraintf http
--http-host 127.0.0.1 --http-port 8089 --http-password <pw>` when asked to open a file, and
also works with a VLC the user started by hand if the web interface is enabled in VLC's
preferences (documented in SETUP.md).

## 2026-10-18 — Just-in-time HLS with virtual playlists

Pre-transcoding a whole film before pressing play is a 10–30 minute wait. Serving a virtual VOD
playlist and encoding from whatever segment is requested (the Plex/Jellyfin pattern) gives play
within seconds and instant scrubbing anywhere, while the job keeps running to the end so the
cache fills up behind the viewer. `-copyts` keeps segment timestamps equal to playlist time; the
`force_key_frames` expression pins keyframes to source-time multiples of four seconds so
restarts produce identical segment boundaries. MPEG-TS segments over fMP4 because restarts need
no shared init segment and hls.js/Safari both handle them.

## 2026-10-18 — H.264 everywhere

The RTX 5070 can do HEVC and AV1, which would halve the bitrate. iPhones decode HEVC in HLS, but
Android Chrome support is uneven and AV1 in HLS is not something Safari plays. H.264 High profile
plays on everything she might hold. Revisit when the guest device is known to be an iPhone and
bandwidth is the limiting factor.

## 2026-10-18 — Tenor for GIFs

Tenor v2 (Google) has a free key, a clean JSON API, content filtering, and is what Gboard and
Discord use. GIPHY works too but its free tier is "beta" rate-limited. Proxied through the host
so the key never reaches the browser and so chat GIF URLs can be restricted to Tenor's CDN.

## 2026-10-18 — Repo and deploy shape

pnpm workspaces (`shared`, `host`, `web`). Host serves `web/dist`; Vercel builds the same
`web/dist` from the repo as the public connect page. GitHub Actions on ubuntu for CI (ffmpeg via
apt for the e2e job). Agents do not commit; the integrating session does, at wave boundaries.
