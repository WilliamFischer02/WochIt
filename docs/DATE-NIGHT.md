# Date night: the two-phone walkthrough

For William, with her on the phone. She never logs into *your* Tailscale. She makes her own free
Tailscale account in the app, and your share link lets that account see one machine: this PC.

## You, before you call her (5 minutes)

1. Double-click **WochIt Host** on the Desktop. Wait until every readiness row is green except VLC.
2. Open https://login.tailscale.com/admin/machines. On the **william-desktop** row open the **⋯**
   menu → **Share** → tab **Copy invite link** → **Copy share link**.
3. In the console's Share card paste it into **Tailscale share link** → **Save**.
4. **Copy invite** → text it to her. Say the PIN out loud, do not text it with the link.
5. In the library pick the film → **Open in VLC**. VLC opens here; the VLC row turns green.

## Her, on the iPhone (10 minutes the first time, 10 seconds after)

1. Tap the link in your text. A page opens: "William invited you to a movie night", four steps.
2. **Step 1, Get Tailscale.** Tap it → App Store → Get → Open. In the app tap **Log in** and choose
   **Sign in with Apple** (Google also works). iPhone asks to allow a VPN configuration: **Allow**,
   then Face ID. She now has her own Tailscale account. Nothing else to set up in the app.
3. **Step 2, Accept William's invite.** Back in Safari (the invite page), tap the step. Tailscale's
   website opens; if it asks her to sign in, same Apple/Google as the app. Tap **Accept**. Back to
   the invite page, tap **Done** on the step.
4. **Step 3, Turn it on.** Open the Tailscale app, flip the switch at the top to **Connected**. In
   the app's device list **william-desktop** is listed. Back to the invite page: **It is on**.
5. **Step 4** finds your PC by itself and shows **Open WochIt**. Tap it → PIN → her name → **Join**
   → **Tap to join playback**. Sound starts after that tap.
6. When the "Add to Home Screen" card appears: Safari **Share** (the box with the arrow, on newer
   iOS under **⋯**) → **Add to Home Screen** → **Add**. From now on: Tailscale on, tap the icon.

## How you check it is working

- Tailscale admin → william-desktop → **Share**: her account is listed under *Shared with*.
- Console readiness row **Guests** says *1 connected*; the Guests panel shows her name.
- Her row says **Playing**, drift under 1 s, a buffer of some seconds. That is "in sync".
- Press pause in VLC: her row flips to **Paused** within a second, and so does her phone.
- Press play on her phone: VLC resumes here.
- Dry run without her: open `http://127.0.0.1:8788/?mode=guest` in a second tab on this PC; it
  shows up in the Guests panel exactly like she will.

## If it sticks

| She sees | Do |
|---|---|
| Step 4 keeps "Looking for William's PC" | Tailscale switch on? Device list shows william-desktop? If not, redo Step 2 and accept. Then tap **Open WochIt anyway**. |
| "Open WochIt" opens a blank page or "cannot connect" | Toggle Tailscale off and on, pull to refresh. The console's Tailscale row must say *Published*. |
| Wrong PIN | The PIN is on the console's Share card. If you changed `.env`, the host was restarted after. |
| Video stalls | Her **Quality** menu → 720p or 480p. |
| Nothing works tonight | Tell me; the Funnel fallback (SETUP § 4) gives her a public link with nothing to install, at 480p. |
