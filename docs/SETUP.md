# WochIt setup

Everything you do on the host PC and everything she does on her phone, in order. Commands are
for PowerShell on the host PC unless a step says otherwise.

> **Status.** The host agent is still being built. Steps that depend on it (the banner, "Open in
> VLC", the library) describe the design in [ARCHITECTURE.md](ARCHITECTURE.md). If the real
> output differs, trust the host and fix this page.

This PC: `William-Desktop`, tailnet name `william-desktop.tail2ac207.ts.net`, host port `8788`,
tailnet port `8443` (443 already belongs to another app), VLC 3.0.21, ffmpeg 9.0.2 from winget
`Gyan.FFmpeg`, Node 24, pnpm 10, Tailscale 1.102.4.

1. [Host PC, first time](#1-host-pc-first-time)
2. [Publish to your tailnet](#2-publish-to-your-tailnet)
3. [Get her connected](#3-get-her-connected)
4. [Fallback: Funnel, nothing to install](#4-fallback-funnel-nothing-to-install)
5. [VLC](#5-vlc)
6. [GIF search (Klipy or GIPHY)](#6-gif-search-klipy-or-giphy)
7. [Date-night checklist](#7-date-night-checklist)
8. [Troubleshooting](#8-troubleshooting)
9. [Updating](#9-updating)

## 1. Host PC, first time

1. **Check the tools.** Open a *new* PowerShell window (winget adds ffmpeg to PATH only for
   windows opened after the install) and run:
   ```
   node -v; pnpm -v; ffmpeg -hide_banner -version; tailscale version
   ```
   You need Node 22 or newer, pnpm 10, any ffmpeg, Tailscale signed in. Missing ffmpeg:
   `winget install Gyan.FFmpeg`, then open another new window.
2. **Clone and build.**
   ```
   git clone https://github.com/WilliamFischer02/WochIt.git C:\dev\WochIt
   cd C:\dev\WochIt
   pnpm install
   pnpm build
   ```
   `pnpm build` builds `shared`, then `host`, then `web`. If `pnpm install` reports ignored build
   scripts, run `pnpm approve-builds`, allow them, then `pnpm install` again.
3. **Create `.env`** in the repo root.
   ```
   copy .env.example .env
   notepad .env
   ```
   Set at least these. Use full paths; no quotes needed.
   ```
   WOCHIT_PIN=<six digits>
   WOCHIT_CACHE_DIR=Z:\WochIt\cache
   WOCHIT_CACHE_MAX_GB=60
   WOCHIT_MEDIA_ROOTS=Z:\Movies;Z:\Shows
   WOCHIT_VLC_HTTP_PASSWORD=<long random string>
   KLIPY_API_KEY=<from §6, or empty for now>
   ```
   - **PIN**: any six digits, e.g. from `Get-Random -Minimum 100000 -Maximum 1000000`. Setting it
     keeps it the same every night. Left empty, the host makes one up and prints it.
   - **Cache**: a 2-hour film in four qualities is about 8 GB. Put it on a roomy drive
     (`Get-PSDrive Z` shows free space). Past `WOCHIT_CACHE_MAX_GB` the least recently watched
     film is evicted.
   - **Media roots**: the folders the library may browse, separated by `;`. The two above are
     placeholders; use your own. Guests never see these paths.
   - **VLC password**: generate one with
     `-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })`.
   - **GIFs**: a free Klipy key turns on GIF search; see [§6](#6-gif-search-klipy-or-giphy). Empty is fine:
     everything else works without it.
   - Everything else in `.env.example` has a working default. ffmpeg is looked up on PATH and in
     the winget folder; set `WOCHIT_FFMPEG`/`WOCHIT_FFPROBE` only if the banner says it is
     missing. If the banner cannot find VLC, set
     `WOCHIT_VLC_EXE=C:\Program Files (x86)\VideoLAN\VLC\vlc.exe`.
4. **Start the host.**
   ```
   pnpm host
   ```
   Or double-click `scripts\start-host.cmd`, which keeps the window open if the host crashes.
   `powershell -ExecutionPolicy Bypass -File scripts\start-host.ps1 -Build` rebuilds first.
5. **Read the banner.** It shows:
   - **Local** `http://127.0.0.1:8788/` (this PC) and **Tailnet**
     `https://william-desktop.tail2ac207.ts.net:8443/` (for her, once [§2](#2-publish-to-your-tailnet) is done);
   - **PIN**, marked "generated for this run" if `WOCHIT_PIN` is empty;
   - **ffmpeg** and the encoder. On this PC expect `h264_nvenc` (the GPU). `libx264` means it
     fell back to the CPU; see [§8](#8-troubleshooting);
   - **VLC**: `connected`, or `waiting on 127.0.0.1:8089` until a VLC with the web interface is
     open ([§5](#5-vlc));
   - **GIF search**: `klipy` (or `giphy`) once a key is set, otherwise off ([§6](#6-gif-search-klipy-or-giphy));
   - **Cache**: folder and space used. **Roots**: your media folders, flagged `(missing)` if a
     path is wrong.

   The host listens on `127.0.0.1` only. Tailscale Serve reaches it there, nothing else on your
   home network can, and Windows Firewall has nothing to ask about. Only if you want to open it
   from another device on your Wi-Fi by plain HTTP (`http://<this PC's IP>:8788`, unencrypted,
   no Tailscale) set `WOCHIT_BIND=0.0.0.0` in `.env`; Windows Firewall then asks, and you allow
   Private networks only.
6. **Open the host view.** On this PC open `http://127.0.0.1:8788`. A local connection gets the
   host view: chat, remote and library, no video (the film plays in VLC).
7. **Optional: start with Windows.**
   ```
   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
   ```
   This registers a "WochIt Host" scheduled task that starts the host hidden at each logon. Its
   output goes to `%LOCALAPPDATA%\WochIt\host.log`, so set `WOCHIT_PIN` (a generated one would
   only be in the log). `-Remove` deletes the task; `-WhatIf` shows what it would do.

## 2. Publish to your tailnet

Do this once. `--bg` keeps the mapping across reboots.

1. **Publish** the host on port 8443 of your tailnet name:
   ```
   tailscale serve --bg --https=8443 http://127.0.0.1:8788
   ```
   `scripts\publish-tailnet.ps1` runs the same command, but first checks that 8443 is not
   already pointing somewhere else.
2. **Check:**
   ```
   tailscale serve status
   ```
   You should see two entries, both "(tailnet only)": the other app on
   `https://william-desktop.tail2ac207.ts.net` (port 443), and
   `https://william-desktop.tail2ac207.ts.net:8443` proxying to `http://127.0.0.1:8788`.
3. **Test** from your own iPhone (already on your tailnet): Tailscale on, open
   `https://william-desktop.tail2ac207.ts.net:8443`. The connect screen means it works.
4. **Remove** it when you want WochIt off the tailnet:
   ```
   tailscale serve --https=8443 off
   ```
   Or run `scripts\unpublish-tailnet.ps1`.
5. **Leave 443 alone.** Never run `tailscale serve reset` or `tailscale funnel reset`: they clear
   every mapping, including the other app on 443. Never point `--https=443` at WochIt.

## 3. Get her connected

Over Tailscale the film goes from this PC to her phone through an encrypted WireGuard tunnel,
direct whenever your two networks allow it, so 1080p is possible if your upload can carry it,
while a public Funnel link is relayed and bandwidth-limited to about 480p. Nothing is exposed to
the internet either: only her signed-in phone can reach the page at all, so the PIN is a second
lock, not the only one.

**Recommended: (a) share this PC with her own Tailscale account.** She sees only this one
machine. It costs nothing, her account stays hers, and you can revoke it in one click. Use (b)
only if sharing does not work out.

### (a) Share the PC (recommended)

1. **She installs Tailscale.** iPhone: App Store. Android: Google Play. She opens it and signs
   in with any account it offers, which creates her own free tailnet, then allows the VPN prompt.
2. **You create the invite.** Open the [Machines page](https://login.tailscale.com/admin/machines),
   open the menu on **william-desktop** and choose **Share**. On the **Copy invite link** tab,
   select **Copy share link**, or use **Share by email** with her address. Send it to her and
   treat it like a password. Unused links expire after 30 days.
3. **She accepts.** She opens the link on her phone, signs in with the same account she used in
   the app, and accepts. Her profile then appears in your Share dialog.
4. **She checks.** In her Tailscale app, william-desktop is now listed. She must use the full
   name `william-desktop.tail2ac207.ts.net`; the short name does not work from her tailnet.
5. **Access rules.** The default "allow all" policy already covers shared users. If you have
   edited your tailnet policy, allow `autogroup:shared` to reach this machine on port 8443.

To undo it later: Machines → william-desktop → **Share** → menu next to her → **Revoke invite**.

### (b) Invite her into your tailnet

1. **You invite her.** Open the [Users page](https://login.tailscale.com/admin/users) → **Invite
   external users**. Enter her email, or use the **Copy invite link** tab and **Generate & copy
   invite link**. Choose the **Member** role and send it.
2. **She joins.** She opens the invite in her browser, signs in, installs the Tailscale app and
   signs in there with the same account.
3. **What that means.** She becomes a user of your tailnet; the free Personal plan allows up to
   6 users. Unless your policy restricts it, she can also see your other devices, which is
   another reason to prefer (a).

### Then, either way

1. **Tailscale app on.** It must say connected.
2. **Open the link** `https://william-desktop.tail2ac207.ts.net:8443` in Safari (iPhone) or
   Chrome (Android).
3. **Join.** She types the PIN and her name, then taps **Join**.
4. **Tap to join playback.** She taps that button when it appears. Phones only start video with
   sound after a tap.
5. **Add to Home Screen**, so it opens full-screen like an app:
   - iPhone, Safari: Share button (on newer iOS it is under the ⋯ button) → **Add to Home
     Screen** → keep **Open as Web App** on if shown → **Add**.
   - Android, Chrome: ⋮ menu → **Add to home screen** (or **Install app**) → **Install**.

   From then on she opens WochIt from that icon. On iPhone the home-screen app keeps its own
   storage, so she types the PIN and name once more there.

## 4. Fallback: Funnel, nothing to install

Use this only if she cannot install Tailscale. The URL becomes public, so the PIN is the only
lock.

1. **Allow Funnel once.** The first `tailscale funnel` command prints a link asking you to approve
   Funnel; approving adds the `funnel` node attribute to your tailnet policy. Or do it in advance:
   [Access controls](https://login.tailscale.com/admin/acls) → Funnel section → **Add Funnel to
   policy**. Funnel also needs MagicDNS and HTTPS certificates, which this tailnet already has.
2. **Turn it on:**
   ```
   tailscale funnel --bg --https=8443 http://127.0.0.1:8788
   ```
   Funnel only listens on ports 443, 8443 and 10000. 8443 works, and 443 stays with the other
   app. The 8443 mapping is now public instead of tailnet-only: a port is one or the other, and
   the most recent command decides.
3. **Check:** `tailscale funnel status`.
4. **She opens** the same `https://william-desktop.tail2ac207.ts.net:8443` in her normal browser.
   The very first time, public DNS can take up to 10 minutes.
5. **Expect 480p.** Funnel traffic is relayed and has bandwidth limits you cannot change. If Auto
   keeps stalling, pick 480p in the quality menu.
6. **Use a fresh PIN** for Funnel nights: change `WOCHIT_PIN` and restart the host. Anyone who
   finds the URL reaches the PIN screen, and wrong guesses are rate-limited.
7. **Turn it off afterwards.** Put 8443 back to tailnet-only:
   ```
   tailscale serve --bg --https=8443 http://127.0.0.1:8788
   ```
   To remove 8443 entirely instead, run `tailscale funnel --https=8443 off`. Then check with
   `tailscale serve status`: the `:8443` entry says "(tailnet only)" or is gone.
   `scripts\publish-tailnet.ps1` also switches a Funneled 8443 back to tailnet-only.

## 5. VLC

**The normal way: let the host start VLC.** In the host view's library, click **Open in VLC** on
a file. The host starts `C:\Program Files (x86)\VideoLAN\VLC\vlc.exe` (or `WOCHIT_VLC_EXE`) with
`--extraintf http --http-host 127.0.0.1 --http-port 8089 --http-password <WOCHIT_VLC_HTTP_PASSWORD>`
and the file. You set nothing in VLC. The host view's Follow VLC line then says **VLC
connected**, and the banner's VLC line `connected on 127.0.0.1:8089`. Close any VLC you opened
yourself first, because the host cannot see a VLC whose web interface is off.

**A VLC you started yourself** (for example by double-clicking a file) needs its web interface
switched on once. This only works with `WOCHIT_VLC_HTTP_PASSWORD` set in `.env`. If it is empty,
the host makes up a password each run and only VLCs it launches itself can connect.

1. **Show all settings.** In VLC: **Tools → Preferences**, then bottom-left **Show settings: All**.
2. **Turn on the web interface.** **Interface → Main interfaces**: tick **Web**.
3. **Set the password.** **Interface → Main interfaces → Lua**, section **Lua HTTP**: set
   **Password** to the value of `WOCHIT_VLC_HTTP_PASSWORD`.
4. **Keep it on this PC.** Click the **Input / Codecs** heading itself and find the section
   **Network settings**. Set **HTTP server address** to `127.0.0.1` and **HTTP server port** to
   `8089` (the value of `WOCHIT_VLC_HTTP_PORT`). VLC's own help says that otherwise "the server
   will listen on any local IP address", on port 8080.
5. **Restart VLC.** **Save**, quit VLC completely, start it again. These settings now apply to
   every VLC you open.
6. **Check.** The host view says **VLC connected** (banner: `connected on 127.0.0.1:8089`). To test by hand, open
   `http://127.0.0.1:8089/requests/status.json` on this PC, leave the user name empty and type
   the password. You should see JSON.

**Why loopback is safe.** VLC's web interface can do far more than play and pause: it can browse
your folders and open any file. Bound to `127.0.0.1`, only programs on this PC can reach it.
Tailscale Serve forwards only 8443 → 8788 (WochIt), never 8089, and the password is a second
lock. Her phone never talks to VLC; the host turns her play, pause and seek into VLC commands. If
Windows Firewall asks about VLC, decline.

## 6. GIF search (Klipy or GIPHY)

WochIt searches GIFs through Klipy, with GIPHY as the alternative. (Google shut down the Tenor
API on 30 June 2026.) The host makes the search calls, so the key never reaches a browser.
Without a key, the GIF button says GIF search is not configured; chat, emoji and reactions work
either way.

### Klipy (recommended, free)

1. **Sign up.** Open the [Klipy Partner Panel](https://partner.klipy.com/) and create an
   account.
2. **Create the key.** In the Partner Panel go to **API Keys** and create your platform (name it
   WochIt). Copy its key. A new key is in Testing mode: free, limited to 100 API requests per
   hour. The app keeps a short cache of results, so that is enough for a movie night.
3. **Put it in `.env`:**
   ```
   WOCHIT_GIF_PROVIDER=auto
   KLIPY_API_KEY=<your key>
   ```
   `auto` uses Klipy whenever `KLIPY_API_KEY` is set.
4. **Restart the host** (Ctrl+C, then `pnpm host` again). The banner now says
   `GIF search: klipy`.
5. **Request Production once.** In the Partner Panel, request Production access for the key.
   It is a one-time form and still free, and it removes the 100-per-hour limit, so a GIF-heavy
   evening never hits it.
6. **Optional: content filter.** [Manage content](https://partner.klipy.com/manage-content) in
   the Partner Panel sets what Klipy may return for your platform.

Klipy's own steps: [Getting started](https://docs.klipy.com/getting-started) and
[klipy.com/developers](https://klipy.com/developers).

### GIPHY (alternative)

- **Key:** at [developers.giphy.com](https://developers.giphy.com/dashboard/) create an app and
  take its API key. It is a free beta key, capped at 100 calls per hour.
- **Set it:** `GIPHY_API_KEY=<key>` in `.env` with `KLIPY_API_KEY` empty, then restart the host.
  The banner says `GIF search: giphy`.
- **Production keys are paid:** GIPHY reviews the application and discusses pricing with you.

## 7. Date-night checklist

On the host PC:

- [ ] Host running (`scripts\start-host.cmd` or the logon task). The banner shows the PIN,
      encoder `h264_nvenc` and the cache folder.
- [ ] `tailscale serve status` lists `:8443` → `http://127.0.0.1:8788`, tailnet only.
- [ ] Host view open at `http://127.0.0.1:8788`.
- [ ] Film picked in the library: **Open in VLC** (you watch in VLC, VLC is the clock) or **Play
      in browsers**. With VLC, the host view says **VLC connected**.
- [ ] Text her the link and the PIN: `https://william-desktop.tail2ac207.ts.net:8443`.

On her phone:

- [ ] Tailscale app connected.
- [ ] WochIt icon on the home screen (or the link) → PIN and name → **Join**.
- [ ] She taps **Tap to join playback**.

Together:

- [ ] Either of you can play, pause and scrub. The pill says **In sync**; an amber "Catching up"
      settles by itself.
- [ ] Chat, emoji, GIFs and the 👏 🍅 ❤️ reactions. GIFs need a key ([§6](#6-gif-search-klipy-or-giphy)).
- [ ] If her video stalls: **Quality** → 720p or 480p. The menu shows how many seconds are
      buffered.
- [ ] Subtitles are per person: she picks hers in the CC menu, you pick yours in VLC.
- [ ] Afterwards: close VLC, then stop the host with Ctrl+C or leave it running. If you used
      Funnel, turn it off ([§4](#4-fallback-funnel-nothing-to-install)).

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Wrong PIN" | Typo; host restarted with a new generated PIN; PIN changed in `.env` | Read the PIN off the banner (or `%LOCALAPPDATA%\WochIt\host.log` if autostarted). Set `WOCHIT_PIN` so it never changes. Five wrong tries within a minute get that device rate-limited; wait a minute, then retry. |
| "Reconnecting…" forever | Host not running; PC asleep; the 8443 mapping is gone; her Tailscale app is off | Check the host window or log. `tailscale serve status` must list `:8443` → `http://127.0.0.1:8788`; if not, redo [§2](#2-publish-to-your-tailnet). Her Tailscale app must say connected and list william-desktop. `powercfg /change standby-timeout-ac 0` stops the PC sleeping while plugged in. Test from your own phone. |
| Video stalls | Quality too high for your upload or for the route | Quality → 720p or 480p. On the host, run `tailscale status` while she watches: her phone's line says `direct <ip:port>` (good) or `relay "<region>"` (through a Tailscale relay, slower: pick a lower quality). Your upload must carry the quality: 1080p ≈ 5.2 Mbps, 720p ≈ 2.8, 480p ≈ 1.4, 360p ≈ 0.8, plus 0.13 for audio. Run a speed test on the host PC. Over Funnel, 480p is the ceiling. |
| "Preparing 720p…" takes long | Encoder fell back to the CPU (`libx264`); very heavy source (4K HEVC) | The banner's encoder should say `h264_nvenc`. Test the GPU encoder: `ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -t 2 -c:v h264_nvenc -f null -` (no output means it works). If it errors, update the NVIDIA driver and reboot. The first jump to a new spot always takes a few seconds; once cached it is instant. |
| No sound on iPhone | Silent mode or volume; playback started without a tap | Turn Silent mode off and raise the volume with the side buttons. Tap **Tap to join playback**, or tap the video once: iOS only allows sound after a tap. Check that Bluetooth headphones are not taking the audio. |
| VLC not detected | VLC started without its web interface; wrong port or password; a second VLC | Close every VLC window and click **Open in VLC** again. For a VLC you start yourself, redo [§5](#5-vlc): Web ticked, password = `WOCHIT_VLC_HTTP_PASSWORD`, address `127.0.0.1`, port `8089`, VLC restarted. Test `http://127.0.0.1:8089/requests/status.json`. |
| GIF button says not configured | No `KLIPY_API_KEY` or `GIPHY_API_KEY` in `.env`; host not restarted after adding it | Follow [§6](#6-gif-search-klipy-or-giphy), then restart the host. The banner must say `GIF search: klipy` (or `giphy`). If it still says off, check the key for typos or spaces. |
| GIF search worked, then stopped | The key's 100-per-hour limit (Klipy Testing mode or GIPHY beta) | Wait for the hour to pass. For Klipy, request Production access once in the Partner Panel ([§6](#6-gif-search-klipy-or-giphy)) and the limit goes away. |
| Cache drive full | Cache cap bigger than the free space | Lower `WOCHIT_CACHE_MAX_GB` or point `WOCHIT_CACHE_DIR` at a bigger drive, then restart the host. With the host stopped, deleting folders inside the cache is safe; they are rebuilt when played. `Get-PSDrive Z` shows free space. |
| Port 8788 busy | A host is already running (e.g. the logon task), or another program has the port | `Get-NetTCPConnection -LocalPort 8788 -State Listen \| Select-Object OwningProcess`, then `Get-Process -Id <pid>`. If it is WochIt's `node`, use that one or `Stop-Process -Id <pid>`. Otherwise set `WOCHIT_PORT` to a free port, restart the host, then `tailscale serve --https=8443 off` and `tailscale serve --bg --https=8443 http://127.0.0.1:<new port>`. |
| Her phone cannot open the URL at all | Invite not accepted; Tailscale off; short name used | Your Share dialog for william-desktop should list her. Her Tailscale app must say connected. Use the full `william-desktop.tail2ac207.ts.net:8443`. |

## 9. Updating

```
cd C:\dev\WochIt
git pull && pnpm install && pnpm build
```

`&&` works in cmd and PowerShell 7. In Windows PowerShell 5.1, run the three commands one at a
time. Then restart the host. If it runs from the logon task:

```
Get-NetTCPConnection -LocalPort 8788 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }
Start-ScheduledTask -TaskName 'WochIt Host'
```

New settings show up in `.env.example`; see what changed with
`git diff 'HEAD@{1}' -- .env.example` and copy any new keys into `.env`.

---

Commands checked on 2026-10-18 against the Tailscale docs
([Serve](https://tailscale.com/kb/1242/tailscale-serve),
[`tailscale serve` CLI](https://tailscale.com/docs/reference/tailscale-cli/serve),
[Funnel](https://tailscale.com/kb/1223/funnel),
[`tailscale funnel` CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel),
[Sharing](https://tailscale.com/kb/1084/sharing),
[Inviting users](https://tailscale.com/kb/1271/invite-any-user),
[Pricing](https://tailscale.com/pricing)), the `--help` of Tailscale 1.102.4, the
[VLC HTTP interface wiki](https://wiki.videolan.org/Documentation:Modules/http_intf/) and VLC
3.0.21's own preference labels, and the Klipy and GIPHY pages linked in [§6](#6-gif-search-klipy-or-giphy).
