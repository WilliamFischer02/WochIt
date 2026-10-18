// Fake room data for the chat dev harness: 30 messages, two members, SVG "GIFs" (offline, so
// screenshots are deterministic) and a fake GIF proxy behind window.fetch.
import type { ChatMessage, Gif, GifSearchResponse, Member } from '@wochit/shared';

export const YOU: Member = { id: 'u-william', nick: 'William', isHost: true, typing: false };
export const MIA: Member = { id: 'u-mia', nick: 'Mia', isHost: false, typing: false };
export const SYSTEM = { id: 'system', nick: 'WochIt' };

export function fakeGif(id: string, label: string, hue: number, width: number, height: number): Gif {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 80% 58%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 75% 38%)"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${width * 0.78}" cy="${height * 0.28}" r="${Math.min(width, height) * 0.16}" fill="rgba(255,255,255,.22)"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, sans-serif" font-weight="800"
    font-size="${Math.round(Math.min(width, height) / 6.5)}" fill="white" fill-opacity=".92">${label}</text>
</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return { id, provider: 'klipy', url, previewUrl: url, width, height, title: label };
}

const MIN = 60_000;

export function seedMessages(now: number): ChatMessage[] {
  let t = now - 38 * MIN;
  let n = 0;
  const at = (gapMs: number) => (t += gapMs);
  const m = (from: { id: string; nick: string }, gapMs: number, body: Partial<ChatMessage>): ChatMessage => ({
    id: `seed-${++n}`,
    from,
    kind: 'text',
    at: at(gapMs),
    ...body,
  });
  const you = { id: YOU.id, nick: YOU.nick };
  const mia = { id: MIA.id, nick: MIA.nick };
  return [
    m(SYSTEM, 0, { kind: 'system', text: 'William opened the room' }),
    m(SYSTEM, 40_000, { kind: 'system', text: 'Mia joined' }),
    m(mia, 5_000, { text: 'hiii 👋' }),
    m(mia, 4_000, { text: "ok I'm in, the link worked first try" }),
    m(you, 15_000, { text: 'nice!! can you hear it ok?' }),
    m(mia, 20_000, { text: 'yes! a little quiet though' }),
    m(you, 12_000, { text: "turn your phone up, it's mixed loud for the explosions lol" }),
    m(mia, 6_000, { text: '🙉' }),
    m(SYSTEM, 30_000, { kind: 'system', text: 'William picked Dune: Part Two' }),
    m(mia, 8_000, { kind: 'gif', gif: fakeGif('popcorn', 'popcorn time', 32, 220, 160) }),
    m(you, 10_000, { text: 'ok starting in 3' }),
    m(you, 1_000, { text: '2' }),
    m(you, 1_000, { text: '1' }),
    m(mia, 3_000, { text: '😂😂' }),
    m(mia, 6 * MIN, { text: 'wait who is that' }),
    m(you, 9_000, { text: 'Feyd-Rautha. Austin Butler' }),
    m(mia, 5_000, { text: 'ELVIS??' }),
    m(you, 4_000, { text: 'the very same' }),
    m(you, 2_000, { kind: 'gif', gif: fakeGif('mind', 'mind = blown', 280, 220, 124) }),
    m(mia, 7_000, { text: '❤️‍🔥' }),
    m(SYSTEM, 9 * MIN, { kind: 'system', text: 'Mia paused at 1:12:40' }),
    m(mia, 2_000, { text: 'bathroom brb' }),
    m(you, 6_000, { text: '👍' }),
    m(SYSTEM, 3 * MIN, { kind: 'system', text: 'Mia resumed' }),
    m(mia, 4 * MIN, { text: 'this score is insane. https://www.imdb.com/title/tt15239678/ says Hans Zimmer again' }),
    m(you, 20_000, { text: 'he never misses' }),
    m(mia, 3 * MIN, { text: 'ok real talk\nthe sandworm scene\nI was holding my breath the whole time' }),
    m(you, 15_000, { kind: 'gif', gif: fakeGif('worm', 'RIDE', 190, 160, 240) }),
    m(mia, 6_000, { text: 'lmaooo' }),
    m(mia, 2_000, { text: '🍿' }),
  ];
}

const WORDS = ['yes', 'wow', 'lol', 'omg', 'nope', 'clap', 'dance', 'cry', 'hype', 'sleepy', 'love', 'what'];
const RATIOS: Array<[number, number]> = [
  [220, 124],
  [220, 220],
  [200, 260],
  [220, 165],
  [220, 110],
  [180, 240],
];

/** Fake /api/gif/* behind window.fetch: 24 per page, 4 pages, 250 ms latency. */
export function installFakeGifApi(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.href);
    if (!url.pathname.startsWith('/api/gif/')) return real(input, init);
    await new Promise((r) => setTimeout(r, 250));
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const q = url.searchParams.get('q') ?? '';
    const pos = Number(url.searchParams.get('pos') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '24');
    if (q.toLowerCase() === 'zzz') return json({ provider: 'klipy', results: [], next: null });
    if (q.toLowerCase() === 'busy') {
      return new Response(JSON.stringify({ error: 'rate_limited', message: 'quota' }), { status: 429 });
    }
    const results: Gif[] = Array.from({ length: limit }, (_, i) => {
      const k = pos + i;
      const [w, h] = RATIOS[k % RATIOS.length] ?? [220, 124];
      const label = q ? `${q} ${k + 1}` : (WORDS[k % WORDS.length] ?? 'gif');
      return fakeGif(`${q || 'featured'}-${k}`, label, (k * 47) % 360, w, h);
    });
    const next = pos + limit < 96 ? String(pos + limit) : null;
    return json({ provider: 'klipy', results, next });
  };
}

function json(body: GifSearchResponse): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
