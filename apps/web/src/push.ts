// Web push in this browser: only over HTTPS (or localhost). On an iPhone or
// iPad it also needs CineVault on the home screen (iOS 16.4 and later).

import { api } from './api.js';

export type PushState = 'unsupported' | 'insecure' | 'denied' | 'off' | 'on';

export function pushState(): Promise<PushState> | PushState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return currentSubscription().then((sub) => (sub ? 'on' : 'off'));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** The server's key, as PushManager wants it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function toServer(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  };
}

/** Asks for permission and subscribes this browser for the signed-in profile. */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  await api.subscribePush(toServer(subscription));
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const subscription = await currentSubscription();
  if (subscription) {
    await api.unsubscribePush(subscription.endpoint).catch(() => undefined);
    await subscription.unsubscribe();
  }
  return 'off';
}

/**
 * A browser gets the messages of whoever is signed in: after logging in
 * as another profile, the subscription moves along.
 */
export async function claimPush(): Promise<void> {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) await api.subscribePush(toServer(subscription)).catch(() => undefined);
}
