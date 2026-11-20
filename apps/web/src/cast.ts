// Casting from the browser to a Chromecast, with Google's Cast SDK for the web
// (the "Web Sender"). It only works in Chrome (and Edge) over HTTPS or on
// localhost, so the script is loaded only there, and only when a player opens.
// The Default Media Receiver plays what the Android app casts too: an HLS
// session of the transcoder, under /api/cast/<token>/… (routes/cast.ts).
//
// Only the parts of the SDK CineVault uses are typed here.

import type { CastQuality } from '@cinevault/shared';
import { useEffect, useSyncExternalStore } from 'react';

const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
const QUALITY_KEY = 'cinevault.castQuality';

export interface CastDevice {
  friendlyName?: string;
  modelName?: string;
}

export interface CastMediaSession {
  playerState?: string;
  idleReason?: string;
}

export interface CastSession {
  getCastDevice(): CastDevice;
  loadMedia(request: unknown): Promise<unknown>;
  getMediaSession(): CastMediaSession | null;
}

interface CastContext {
  setOptions(options: object): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  getCastState(): string;
  getCurrentSession(): CastSession | null;
  requestSession(): Promise<unknown>;
  endCurrentSession(stopCasting: boolean): void;
}

export interface RemotePlayer {
  currentTime: number;
  duration: number;
  isPaused: boolean;
  isConnected: boolean;
  playerState: string | null;
}

export interface RemotePlayerController {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  playOrPause(): void;
  seek(): void;
}

interface CastFramework {
  CastContext: { getInstance(): CastContext };
  CastContextEventType: { CAST_STATE_CHANGED: string; SESSION_STATE_CHANGED: string };
  CastState: { NO_DEVICES_AVAILABLE: string; CONNECTED: string };
  RemotePlayer: new () => RemotePlayer;
  RemotePlayerController: new (player: RemotePlayer) => RemotePlayerController;
  RemotePlayerEventType: { ANY_CHANGE: string };
}

type Ctor<T = object> = new (...args: never[]) => T;

export interface ChromeCast {
  AutoJoinPolicy: { ORIGIN_SCOPED: string };
  Image: new (url: string) => object;
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    MediaInfo: new (contentId: string, contentType: string) => Record<string, unknown>;
    LoadRequest: new (media: object) => Record<string, unknown>;
    Track: new (id: number, type: string) => Record<string, unknown>;
    MovieMediaMetadata: Ctor<Record<string, unknown>>;
    TvShowMediaMetadata: Ctor<Record<string, unknown>>;
    TrackType: { TEXT: string };
    TextTrackType: { SUBTITLES: string };
    StreamType: { BUFFERED: string };
    HlsSegmentFormat?: { FMP4: string };
    HlsVideoSegmentFormat?: { FMP4: string };
  };
}

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: { framework?: CastFramework };
    chrome?: { cast?: ChromeCast };
  }
}

export interface CastState {
  /** The SDK is there (Chrome over HTTPS). */
  ready: boolean;
  /** A Chromecast was found on the network. */
  devices: boolean;
  /** Casting now, to this device. */
  session?: CastSession;
  device?: string;
}

let state: CastState = { ready: false, devices: false };
const listeners = new Set<() => void>();
let loading: Promise<boolean> | undefined;

function set(next: CastState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Chrome or Edge (they have the Cast SDK), over HTTPS or on localhost. */
export function castPossible(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext) return false;
  const ua = navigator.userAgent;
  // Chrome on iOS (CriOS) is Safari underneath: no Cast SDK.
  return /Chrome\//.test(ua) && !/CriOS|Android.*wv\)/.test(ua);
}

function framework(): { cast: CastFramework; chrome: ChromeCast } | undefined {
  const cast = window.cast?.framework;
  const chrome = window.chrome?.cast;
  return cast && chrome ? { cast, chrome } : undefined;
}

function update() {
  const sdk = framework();
  if (!sdk) return;
  const context = sdk.cast.CastContext.getInstance();
  const session = context.getCurrentSession() ?? undefined;
  const castState = context.getCastState();
  const device = session?.getCastDevice().friendlyName;
  set({
    ready: true,
    devices: castState !== sdk.cast.CastState.NO_DEVICES_AVAILABLE,
    ...(session && castState === sdk.cast.CastState.CONNECTED && { session }),
    ...(session && device && { device }),
  });
}

function setUp(): boolean {
  const sdk = framework();
  if (!sdk) return false;
  const context = sdk.cast.CastContext.getInstance();
  context.setOptions({
    receiverApplicationId: sdk.chrome.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: sdk.chrome.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  context.addEventListener(sdk.cast.CastContextEventType.CAST_STATE_CHANGED, update);
  context.addEventListener(sdk.cast.CastContextEventType.SESSION_STATE_CHANGED, update);
  update();
  return true;
}

/** Loads the Cast SDK once (where it can work); true when it is there. */
export function loadCast(): Promise<boolean> {
  if (loading) return loading;
  if (!castPossible()) return Promise.resolve(false);
  loading = new Promise<boolean>((resolve) => {
    // Already there (a test page, or loaded before).
    if (framework()) return resolve(setUp());
    window.__onGCastApiAvailable = (available) => resolve(available && setUp());
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const snapshot = () => state;

/** The Cast state; loads the SDK when it is first used. */
export function useCast(): CastState {
  useEffect(() => {
    void loadCast();
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Chrome's device picker; resolves when a device was chosen (or the picker closed). */
export async function startCasting(): Promise<void> {
  const sdk = framework();
  if (!sdk) return;
  try {
    await sdk.cast.CastContext.getInstance().requestSession();
  } catch {
    // Closed without choosing, or the device didn't answer: nothing to do.
  }
  update();
}

export function stopCasting(): void {
  framework()?.cast.CastContext.getInstance().endCurrentSession(true);
  update();
}

/** The remote: the receiver's position and state, and play/pause and seek. */
export function remotePlayer(): { player: RemotePlayer; controller: RemotePlayerController } {
  const sdk = framework();
  if (!sdk) throw new Error('the Cast SDK is not loaded');
  const player = new sdk.cast.RemotePlayer();
  return { player, controller: new sdk.cast.RemotePlayerController(player) };
}

/** The receiver to `seconds` in what it plays. */
export function seekRemote(
  remote: { player: RemotePlayer; controller: RemotePlayerController },
  seconds: number,
): void {
  remote.player.currentTime = seconds;
  remote.controller.seek();
}

export function remoteChangeEvent(): string {
  return framework()?.cast.RemotePlayerEventType.ANY_CHANGE ?? 'anyChanged';
}

export function chromeCast(): ChromeCast {
  const sdk = framework();
  if (!sdk) throw new Error('the Cast SDK is not loaded');
  return sdk.chrome;
}

/** 4K or 1080p for the Chromecast, set in Profiel (the browser can't ask the model). */
export function savedCastQuality(): CastQuality {
  try {
    const value = localStorage.getItem(QUALITY_KEY);
    return value === '4k' || value === '1080p' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveCastQuality(quality: CastQuality): void {
  try {
    localStorage.setItem(QUALITY_KEY, quality);
  } catch {
    // Private mode: only for now.
  }
}
