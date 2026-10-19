// Whether to offer "Add to Home Screen" after a guest's first join: iOS Safari in a normal tab
// (not already installed), and not dismissed before. Pure for the test; the hook reads the browser.
import { loadPref, savePref } from '../../lib/storage';

const PREF = 'installHintDismissed';

export interface InstallHintEnv {
  userAgent: string;
  /** Running as an installed web app (`display-mode: standalone` or `navigator.standalone`). */
  standalone: boolean;
  dismissed: boolean;
}

export function isIosSafari(ua: string): boolean {
  if (!/iP(hone|ad|od)/.test(ua)) return false;
  // Chrome / Firefox / Edge on iOS use WebKit too but cannot add to the Home Screen the same way.
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

export function shouldShowInstallHint(env: InstallHintEnv): boolean {
  return isIosSafari(env.userAgent) && !env.standalone && !env.dismissed;
}

export function readInstallHintEnv(): InstallHintEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone = nav.standalone === true || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  return { userAgent: navigator.userAgent, standalone, dismissed: loadPref(PREF) === '1' };
}

export function dismissInstallHint(): void {
  savePref(PREF, '1');
}
