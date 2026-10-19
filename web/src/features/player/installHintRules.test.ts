import { describe, expect, it } from 'vitest';
import { isIosSafari, shouldShowInstallHint } from './installHintRules';

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

describe('install hint', () => {
  it('only targets Safari on iOS', () => {
    expect(isIosSafari(SAFARI)).toBe(true);
    expect(isIosSafari(CHROME_IOS)).toBe(false);
    expect(isIosSafari(ANDROID)).toBe(false);
  });
  it('shows once, in a tab, on iOS Safari', () => {
    expect(shouldShowInstallHint({ userAgent: SAFARI, standalone: false, dismissed: false })).toBe(true);
    expect(shouldShowInstallHint({ userAgent: SAFARI, standalone: true, dismissed: false })).toBe(false);
    expect(shouldShowInstallHint({ userAgent: SAFARI, standalone: false, dismissed: true })).toBe(false);
    expect(shouldShowInstallHint({ userAgent: ANDROID, standalone: false, dismissed: false })).toBe(false);
  });
});
