# WochIt

Watch a film that lives on one Windows PC together, from two different states. Either of you can
play, pause and scrub, and both screens stay on the same moment. A chat sits beside the picture,
with emoji and three reactions that rain down both screens.

**Setting it up, or running a movie night: start with [docs/SETUP.md](docs/SETUP.md).**

Status: under construction. The docs describe the design; the host agent and the web app are
being built against them.

## How it works

1. A host agent (Node) runs on the Windows PC next to VLC and the films and listens on `127.0.0.1:8788`.
2. `tailscale serve` publishes it to your tailnet as `https://<pc>.<tailnet>.ts.net:8443`; her phone gets there through the Tailscale app.
3. When a browser asks for video, ffmpeg (NVENC on the GPU) encodes 4-second HLS segments on demand and caches them, so play starts in seconds and cached scrubs are instant.
4. Each browser plays that HLS with its own buffer, and a WebSocket room on the host keeps one shared clock that every client follows.
5. When you watch in VLC, the host reads VLC's loopback web interface as the master clock and sends play, pause and seek from either side to VLC.
6. Chat, reactions and presence ride the same WebSocket. There is no cloud backend; Vercel only hosts a copy of the static web app as a connect page.

## Features (the design)

- Play, pause and scrub from either side, decided by the host, with an "In sync" pill on screen.
- VLC as the clock on the host PC. The host's own browser shows chat and remote controls, not a second copy of the film.
- Just-in-time H.264 HLS (1080p, 720p, 480p, 360p), and a quality menu with Auto and a buffer readout.
- Subtitles picked per person, from embedded text tracks or sidecar `.srt`, `.vtt` and `.ass` files.
- A chat drawer with an emoji picker, big emoji-only messages, a typing indicator and nicknames.
- GIF search through Klipy (or GIPHY), proxied by the host so no key reaches the browser ([SETUP §6](docs/SETUP.md#6-gif-search-klipy-or-giphy)).
- Three full-screen reactions: 👏 cheer, 🍅 boo, ❤️ heart.
- A library browser on the host with "Open in VLC" and "Play in browsers". Guests never see file paths.
- Private by default: Tailscale plus a room PIN, with Tailscale Funnel as a no-install fallback at about 480p.
- Phone first: add it to the home screen and it runs full-screen.

Docs: [setup](docs/SETUP.md) · [architecture](docs/ARCHITECTURE.md) · [protocol](docs/PROTOCOL.md) ·
[UI](docs/UI.md) · [decisions](docs/DECISIONS.md)

## Quick start (host PC)

```
pnpm install
pnpm build
copy .env.example .env      # set WOCHIT_PIN, WOCHIT_MEDIA_ROOTS, WOCHIT_CACHE_DIR, WOCHIT_VLC_HTTP_PASSWORD, KLIPY_API_KEY
pnpm host                   # or double-click scripts\start-host.cmd
tailscale serve --bg --https=8443 http://127.0.0.1:8788    # once; survives reboots
```

Then open `https://<your-machine>.<tailnet>.ts.net:8443` on both ends.
[SETUP.md](docs/SETUP.md) covers getting her onto your tailnet, VLC, autostart and troubleshooting.

## Development

```
pnpm --filter @wochit/host dev     # host on :8788
pnpm --filter @wochit/web dev      # web on :5173 (proxies to the host)
pnpm typecheck && pnpm test && pnpm e2e
```

MIT.
