// Pure helpers for the chat drawer: grouping, emoji-only detection, previews, link splitting.
// Kept free of React and the store so they can be unit-tested directly.
import type { ChatMessage } from '@wochit/shared';

/** Consecutive messages from one member within this gap share a nick label. */
export const GROUP_GAP_MS = 2 * 60_000;

export type ChatItem =
  | { type: 'system'; key: string; message: ChatMessage }
  | {
      type: 'group';
      key: string;
      mine: boolean;
      from: ChatMessage['from'];
      messages: ChatMessage[];
    };

/** Splits the flat message list into system lines and per-sender groups. */
export function groupMessages(messages: readonly ChatMessage[], youId: string | null): ChatItem[] {
  const items: ChatItem[] = [];
  let current: Extract<ChatItem, { type: 'group' }> | null = null;
  for (const m of messages) {
    if (m.kind === 'system') {
      current = null;
      items.push({ type: 'system', key: m.id, message: m });
      continue;
    }
    const last = current?.messages[current.messages.length - 1];
    if (current && last && current.from.id === m.from.id && m.at - last.at <= GROUP_GAP_MS) {
      current.messages.push(m);
      continue;
    }
    current = { type: 'group', key: m.id, mine: youId !== null && m.from.id === youId, from: m.from, messages: [m] };
    items.push(current);
  }
  return items;
}

const PICTO = /\p{Extended_Pictographic}/u;
const REGIONAL = /^\p{Regional_Indicator}{2}$/u;
const KEYCAP = /^[0-9#*]️?⃣$/u;
const MAX_EMOJI_ONLY = 3;

function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** True for 1–3 emoji and nothing else (whitespace ignored). Such messages render enlarged. */
export function isEmojiOnly(text: string | undefined): boolean {
  if (!text) return false;
  const parts = graphemes(text.replace(/\s+/gu, ''));
  if (parts.length === 0 || parts.length > MAX_EMOJI_ONLY) return false;
  return parts.every((g) => PICTO.test(g) || REGIONAL.test(g) || KEYCAP.test(g));
}

/** Host-clock ms → local wall-clock "9:41 PM" (or "21:41" per locale). */
export function formatTime(atHostMs: number, serverOffsetMs: number): string {
  const local = new Date(atHostMs - serverOffsetMs);
  return local.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** One-line preview for the tucked sheet bar. */
export function previewText(m: ChatMessage | undefined, youId: string | null): string {
  if (!m) return 'No messages yet';
  if (m.kind === 'system') return m.text ?? '';
  const who = youId !== null && m.from.id === youId ? 'You' : m.from.nick;
  if (m.kind === 'gif') return `${who} sent a GIF`;
  return `${who}: ${(m.text ?? '').replace(/\s+/gu, ' ').trim()}`;
}

export type TextPart = { type: 'text'; value: string } | { type: 'link'; value: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/giu;

/** Splits message text into plain runs and http(s) links. Nothing else becomes a link. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index;
    if (start > last) parts.push({ type: 'text', value: text.slice(last, start) });
    parts.push({ type: 'link', value: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

/** GIF providers can hand back mp4/webm assets; those need a <video> instead of an <img>. */
export function isVideoUrl(url: string): boolean {
  try {
    return /\.(mp4|webm)$/iu.test(new URL(url, 'http://x').pathname);
  } catch {
    return false;
  }
}
