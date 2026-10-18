# WochIt

Watch a film that lives on one PC together from anywhere. Both of you can play, pause and scrub.
Both screens stay on the same moment. A chat sits beside the picture with emoji, GIFs and three
reactions that rain down both screens.

- The **host PC** (Windows, with VLC and an NVIDIA/Intel/AMD encoder or a decent CPU) runs the
  host agent. It transcodes the file on demand to adaptive HLS, bridges VLC, and runs the room.
- The **guest** needs only a phone browser and the Tailscale app.
- The host PC's own browser shows the chat and the remote controls, not the video, because the
  film is already on that screen in VLC.

Docs: [architecture](docs/ARCHITECTURE.md) · [protocol](docs/PROTOCOL.md) · [UI](docs/UI.md) ·
[decisions](docs/DECISIONS.md) · [setup](docs/SETUP.md)

## Quick start (host PC)

```
pnpm install
pnpm build
copy .env.example .env      # set WOCHIT_MEDIA_ROOTS, WOCHIT_CACHE_DIR, TENOR_API_KEY
pnpm host
```

The host prints the URLs to open and the room PIN. Publish it to your tailnet with
`tailscale serve --bg --https=8443 http://127.0.0.1:8788` (once), then open
`https://<your-machine>.<tailnet>.ts.net:8443` on both ends.

## Development

```
pnpm --filter @wochit/host dev     # host on :8788
pnpm --filter @wochit/web dev      # web on :5173 (proxies to the host)
pnpm typecheck && pnpm test && pnpm e2e
```

MIT.
