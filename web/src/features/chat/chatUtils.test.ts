import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@wochit/shared';
import { GROUP_GAP_MS, groupMessages, isEmojiOnly, isVideoUrl, previewText, splitLinks } from './chatUtils';

const mia = { id: 'mia', nick: 'Mia' };
const will = { id: 'will', nick: 'William' };
let n = 0;
function msg(from: { id: string; nick: string }, at: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m${++n}`, from, kind: 'text', text: 'hi', at, ...extra };
}

describe('groupMessages', () => {
  it('groups consecutive messages from one sender within 2 minutes', () => {
    const items = groupMessages(
      [msg(mia, 0), msg(mia, 60_000), msg(mia, 60_000 + GROUP_GAP_MS + 1), msg(will, 400_000), msg(will, 401_000)],
      'will',
    );
    expect(items.map((i) => (i.type === 'group' ? `${i.from.id}:${i.messages.length}:${i.mine}` : 'sys'))).toEqual([
      'mia:2:false',
      'mia:1:false',
      'will:2:true',
    ]);
  });

  it('breaks groups at system lines', () => {
    const items = groupMessages(
      [msg(mia, 0), msg({ id: 'system', nick: 'WochIt' }, 1, { kind: 'system', text: 'Mia joined' }), msg(mia, 2)],
      null,
    );
    expect(items.map((i) => i.type)).toEqual(['group', 'system', 'group']);
  });
});

describe('isEmojiOnly', () => {
  it.each([
    ['😂', true],
    ['😂😂😂', true],
    [' ❤️ 🔥 ', true],
    ['👍🏽', true],
    ['👨‍👩‍👧', true],
    ['🇺🇸', true],
    ['😂😂😂😂', false],
    ['lol 😂', false],
    ['123', false],
    ['', false],
    [undefined, false],
  ])('%s → %s', (text, expected) => {
    expect(isEmojiOnly(text)).toBe(expected);
  });
});

describe('previewText', () => {
  it('names the sender, says You for me, and describes GIFs', () => {
    expect(previewText(msg(mia, 0, { text: 'hey\nthere' }), 'will')).toBe('Mia: hey there');
    expect(previewText(msg(will, 0, { text: 'yo' }), 'will')).toBe('You: yo');
    expect(previewText(msg(mia, 0, { kind: 'gif', text: undefined }), 'will')).toBe('Mia sent a GIF');
    expect(previewText(undefined, null)).toBe('No messages yet');
  });
});

describe('splitLinks', () => {
  it('links only http(s) URLs and leaves trailing punctuation outside', () => {
    expect(splitLinks('see https://example.com/a?b=1. ok javascript:alert(1)')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'https://example.com/a?b=1' },
      { type: 'text', value: '. ok javascript:alert(1)' },
    ]);
  });
});

describe('isVideoUrl', () => {
  it('detects mp4 by path, not query', () => {
    expect(isVideoUrl('https://static.klipy.com/ii/x/preview.mp4')).toBe(true);
    expect(isVideoUrl('https://static.klipy.com/ii/x/full.gif?f=.mp4')).toBe(false);
  });
});
