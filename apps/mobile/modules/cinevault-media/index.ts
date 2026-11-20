// The native side is Android only (MediaCodecList, focus, the car's driving
// restrictions); elsewhere (tests, web) nothing is known and the app plays it safe.

import { requireOptionalNativeModule } from 'expo';

interface CinevaultMediaModule {
  supports(
    mime: string,
    profile: number | null,
    width: number | null,
    height: number | null,
  ): boolean;
  decoders(): string[];
  focus(viewTag: number): Promise<boolean>;
  isAutomotive?(): boolean;
  drivingRestricted?(): boolean;
  notifySetup?(servers: string[], token: string | null, admin: boolean): boolean;
  notifyEnable?(on: boolean): boolean;
  notifyForget?(): boolean;
  notifyStatus?(): NativeNotifyStatus;
  notifyCheck?(): Promise<number>;
  notifyAskBattery?(): boolean;
  addListener?(
    event: 'onDrivingRestrictionChange',
    listener: (event: { restricted: boolean }) => void,
  ): { remove(): void };
}

/** The notification service on the phone (NotifyService), for Profiel → Meldingen. */
export interface NativeNotifyStatus {
  enabled: boolean;
  /** The service runs (Android keeps it running, also with the app closed). */
  running: boolean;
  /** It has its request open to the server: a new notification comes at once. */
  connected: boolean;
  /** Android lets the app show notifications. */
  permitted: boolean;
  /** Android's battery saving leaves the app alone. */
  batteryExempt: boolean;
  server?: string | null;
  /** Epoch ms. */
  connectedAt?: number | null;
  checkedAt?: number | null;
  shownAt?: number | null;
  shown?: number;
  error?: string | null;
  errorAt?: number | null;
}

const native = requireOptionalNativeModule<CinevaultMediaModule>('CinevaultMedia');

export function supportsDecoder(
  mime: string,
  options: { profile?: number; width?: number; height?: number } = {},
): boolean {
  if (!native) return false;
  return native.supports(
    mime,
    options.profile ?? null,
    options.width ?? null,
    options.height ?? null,
  );
}

export function decoderList(): string[] {
  return native?.decoders() ?? [];
}

/** Moves the focus to the native view with this tag (a TV's D-pad follows it). */
export function focusView(viewTag: number | null | undefined): Promise<boolean> {
  if (!native || viewTag == null) return Promise.resolve(false);
  return native.focus(viewTag).catch(() => false);
}

/** A car with Android Automotive OS (Google built-in); false on an older build of the app's native side. */
export function isAutomotive(): boolean {
  return native?.isAutomotive?.() ?? false;
}

/** In a car: whether it drives now (the driving restrictions are on), so no video. */
export function drivingRestricted(): boolean {
  return native?.drivingRestricted?.() ?? false;
}

/** Calls back when the car starts or stops driving. */
export function onDrivingRestrictionChange(listener: (restricted: boolean) => void): {
  remove(): void;
} {
  const subscription = native?.addListener?.('onDrivingRestrictionChange', (event) =>
    listener(Boolean(event.restricted)),
  );
  return subscription ?? { remove() {} };
}

/**
 * The phone's own notification service (a build of the app from 2026-11-12
 * on); undefined in an older build, on the web and in tests.
 */
export const notifyService = native?.notifyStatus
  ? {
      setup: (servers: string[], token: string | null, admin: boolean) =>
        native.notifySetup?.(servers, token, admin) ?? false,
      enable: (on: boolean) => native.notifyEnable?.(on) ?? false,
      forget: () => native.notifyForget?.() ?? false,
      status: (): NativeNotifyStatus | undefined => native.notifyStatus?.(),
      check: (): Promise<number> => native.notifyCheck?.() ?? Promise.resolve(0),
      askBattery: () => native.notifyAskBattery?.() ?? false,
    }
  : undefined;
