// What kind of screen the app runs on. Smart TVs get the "10-foot" layout:
// bigger type, clear focus, and everything reachable with the arrow keys of a
// remote. The choice can be forced per device (Profiel → Weergave).

const TV_KEY = 'cinevault.tv';

export type TvSetting = 'auto' | 'on' | 'off';

const TV_AGENT =
  /SmartTV|SMART-TV|Tizen|Web0S|webOS|NetCast|BRAVIA|HbbTV|AFT[A-Z]|Android TV|GoogleTV|CrKey|Roku|Viera|VIDAA|Hisense|PhilipsTV|Xbox|PlayStation/i;

export function tvSetting(): TvSetting {
  try {
    const value = localStorage.getItem(TV_KEY);
    if (value === 'on' || value === 'off') return value;
  } catch {
    // Storage blocked: automatic.
  }
  return 'auto';
}

export function setTvSetting(value: TvSetting): void {
  try {
    if (value === 'auto') localStorage.removeItem(TV_KEY);
    else localStorage.setItem(TV_KEY, value);
  } catch {
    // Not remembered; applies until the page reloads.
  }
  applyDeviceClasses();
}

export function looksLikeTv(): boolean {
  return typeof navigator !== 'undefined' && TV_AGENT.test(navigator.userAgent);
}

export function isTv(): boolean {
  const setting = tvSetting();
  return setting === 'auto' ? looksLikeTv() : setting === 'on';
}

/** Sets `tv` on <html>, which the styles use for the 10-foot layout. */
export function applyDeviceClasses(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('tv', isTv());
}

/** A touch screen without a mouse: phones and tablets. */
export function isTouch(): boolean {
  try {
    return matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}
