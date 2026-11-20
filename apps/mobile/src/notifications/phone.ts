// Notifications on the phone without Firebase.
//
// Since 2026-11-12 the app's native side runs a service that keeps one
// request open to the server (NotifyService in modules/cinevault-media): a new
// notification shows at once, with the app closed too, in CineVault's look
// (poster, picture, buttons). This file hands it the login and addresses.
//
// Without that service (an older build of the native side, or a car), every
// 15 minutes or so (Android decides, WorkManager) the app asks the server
// what is new and shows it as an Android notification; while the app is open
// every minute (Android doesn't run the background task then).

import { createApiClient, type NotificationDto, type NotificationType } from '@cinevault/shared';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { notifyService, type NativeNotifyStatus } from '../../modules/cinevault-media';
import { isCar } from '../car';
import { pickServer, readServers } from '../server';
import { NOTIFY_SEEN_KEY as SEEN_KEY, SERVER_KEY, SERVERS_KEY, TOKEN_KEY } from '../storageKeys';
import { pickNew } from './pick';

const TASK = 'cinevault-notifications';
/** "1" when notifications are on for this phone. */
const ENABLED_KEY = 'cinevault.notify';
/** The last check (CheckStatus as JSON), for the settings. */
const LAST_KEY = 'cinevault.notify.last';

export interface CheckStatus {
  /** ISO 8601. */
  at: string;
  /** From the background task (the app closed), or with the app open. */
  background: boolean;
  shown: number;
  error?: string;
}

/** The service, on a phone or tablet (not on a TV, which shows no Android notifications, nor in a car). */
const service = !Platform.isTV && !isCar ? notifyService : undefined;

/** Hands the service the login and the addresses (from SecureStore), and starts it. */
async function setupService(admin: boolean): Promise<void> {
  if (!service) return;
  const [stored, list, token] = await Promise.all([
    SecureStore.getItemAsync(SERVER_KEY),
    SecureStore.getItemAsync(SERVERS_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  const servers = readServers(list, stored);
  service.setup(servers, token, admin);
  // Switched on in the app, but not (or no longer, after logging out) in the service.
  if (token && (await phoneNotificationsOn()) && !service.status()?.enabled) service.enable(true);
}

const CHANNEL: Record<NotificationType, string> = {
  'new-episodes': 'episodes',
  airing: 'episodes',
  recommended: 'tips',
  'new-login': 'account',
  'admin-unmatched': 'admin',
  'admin-transcoder': 'admin',
  'admin-health': 'admin',
  'request-new': 'admin',
  'request-update': 'requests',
  test: 'account',
};

/** The "Beheer" channel only for admins: members see nothing of the admin side, not even in Android's settings. */
async function ensureChannels(admin: boolean): Promise<void> {
  if (Platform.OS !== 'android') return;
  const high = Notifications.AndroidImportance.HIGH;
  const normal = Notifications.AndroidImportance.DEFAULT;
  await Promise.all([
    Notifications.setNotificationChannelAsync('episodes', {
      name: 'Nieuwe afleveringen',
      description: 'Een nieuwe aflevering van een serie die je volgt',
      importance: high,
    }),
    Notifications.setNotificationChannelAsync('tips', {
      name: 'Aanraders',
      description: 'Nieuwe titels die passen bij wat je keek',
      importance: normal,
    }),
    Notifications.setNotificationChannelAsync('account', {
      name: 'Account',
      description: 'Een nieuwe login op je account',
      importance: high,
    }),
    Notifications.setNotificationChannelAsync('requests', {
      name: 'Verzoeken',
      description: 'Je verzoek is goedgekeurd, afgewezen of staat klaar',
      importance: high,
    }),
    admin
      ? Notifications.setNotificationChannelAsync('admin', {
          name: 'Beheer',
          description: 'De server vraagt aandacht',
          importance: normal,
        })
      : Notifications.deleteNotificationChannelAsync('admin'),
  ]);
}

async function readSeen(): Promise<number[] | undefined> {
  const text = await SecureStore.getItemAsync(SEEN_KEY);
  if (!text) return undefined;
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? list.filter((n): n is number => typeof n === 'number') : undefined;
  } catch {
    return undefined;
  }
}

async function post(n: NotificationDto): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: n.title,
      body: n.body,
      data: { id: n.id, ...(n.itemId && { itemId: n.itemId }), ...(n.path && { path: n.path }) },
    },
    trigger: { channelId: CHANNEL[n.type] ?? 'account' },
  });
}

async function check(background: boolean): Promise<number> {
  const [stored, list, token, enabled] = await Promise.all([
    SecureStore.getItemAsync(SERVER_KEY),
    SecureStore.getItemAsync(SERVERS_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(ENABLED_KEY),
  ]);
  if (!token || enabled !== '1') return 0;
  // In the background too: home or the domain, whichever answers now.
  const server = (await pickServer(readServers(list, stored))) ?? stored;
  if (!server) return 0;
  let shown = 0;
  try {
    const api = createApiClient({ baseUrl: server, token: () => token });
    const { items } = await api.notifications({ limit: 30 });
    const result = pickNew(items, await readSeen());
    // Remembered first: a second check at the same time doesn't show them twice.
    await SecureStore.setItemAsync(SEEN_KEY, JSON.stringify(result.seen));
    for (const n of result.show) await post(n);
    shown = result.show.length;
    if (result.summary) {
      await post({
        ...result.summary.latest,
        title: 'CineVault',
        body: `${result.summary.count} nieuwe meldingen. Nieuwste: ${result.summary.latest.title}`,
        path: '/notifications',
      });
      shown = result.summary.count;
    }
    await writeStatus({ at: new Date().toISOString(), background, shown });
    return shown;
  } catch (error) {
    await writeStatus({
      at: new Date().toISOString(),
      background,
      shown,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function writeStatus(status: CheckStatus): Promise<void> {
  await SecureStore.setItemAsync(LAST_KEY, JSON.stringify(status)).catch(() => undefined);
}

let running: Promise<number> | undefined;

/**
 * Asks the server and shows what is new as Android notifications, once each.
 * One check at a time: the app's own and the background task's.
 */
export function checkNotifications(background = false, force = false): Promise<number> {
  if (service) {
    return phoneNotificationsOn().then((on) => {
      if (!on) return 0;
      // Connected, the service already shows them the moment they come: no need to ask.
      if (!force && service.status()?.connected) return 0;
      return service.check();
    });
  }
  const next = (running ?? Promise.resolve(0)).catch(() => 0).then(() => check(background));
  // Handled here (an offline check is no unhandled rejection); the caller gets `next`.
  const tracked: Promise<number> = next
    .catch(() => 0)
    .finally(() => {
      if (running === tracked) running = undefined;
    });
  running = tracked;
  return next;
}

// Runs when Android wakes the app in the background (also with the app closed).
TaskManager.defineTask(TASK, async () => {
  try {
    await checkNotifications(true);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function phoneNotificationsOn(): Promise<boolean> {
  return (await SecureStore.getItemAsync(ENABLED_KEY)) === '1';
}

/** Switches them on for this phone: asks for permission (Android 13+), and starts the task. */
export async function enablePhoneNotifications(admin: boolean): Promise<boolean> {
  await ensureChannels(admin);
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;
  await SecureStore.setItemAsync(ENABLED_KEY, '1');
  // A fresh start: what is there now counts as seen.
  await SecureStore.deleteItemAsync(SEEN_KEY);
  if (service) {
    await setupService(admin);
    service.enable(true);
  }
  await checkNotifications().catch(() => undefined);
  // With the service too: if Android stopped it, the task looks every 15 minutes and starts it again.
  await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
  return true;
}

export interface PhoneStatus {
  on: boolean;
  /** The service's own account (the app's native side), when there is one. */
  service?: NativeNotifyStatus;
  /** Android lets the app show notifications (Android 13+ asks). */
  permitted: boolean;
  /** The background task is scheduled. */
  scheduled: boolean;
  last?: CheckStatus;
}

export async function phoneNotificationStatus(): Promise<PhoneStatus> {
  const [on, permission, scheduled, last] = await Promise.all([
    phoneNotificationsOn(),
    Notifications.getPermissionsAsync(),
    TaskManager.isTaskRegisteredAsync(TASK),
    SecureStore.getItemAsync(LAST_KEY),
  ]);
  let status: CheckStatus | undefined;
  try {
    status = last ? (JSON.parse(last) as CheckStatus) : undefined;
  } catch {
    status = undefined;
  }
  const native = service?.status();
  return {
    on,
    permitted: permission.granted,
    scheduled,
    ...(status && { last: status }),
    ...(native && { service: native }),
  };
}

/**
 * At start: when notifications are on, the channels exist and the
 * background task is scheduled (again, e.g. after Android cleared it).
 */
export async function ensurePhoneNotifications(admin: boolean): Promise<void> {
  if (Platform.isTV) return;
  // Also when they are off: the service keeps the login current (a new one after logging in).
  await setupService(admin);
  if (!(await phoneNotificationsOn())) return;
  await ensureChannels(admin);
  if (!(await TaskManager.isTaskRegisteredAsync(TASK))) {
    await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
  }
}

export async function disablePhoneNotifications(): Promise<void> {
  await SecureStore.deleteItemAsync(ENABLED_KEY);
  service?.enable(false);
  if (await TaskManager.isTaskRegisteredAsync(TASK)) {
    await BackgroundTask.unregisterTaskAsync(TASK);
  }
}

/** While the app is open: a notification shows as a banner too. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Logged out: the service stops and forgets the login (logging in again starts it). */
export function forgetPhoneNotifications(): void {
  service?.forget();
}

/** Android's list for battery saving: "Niet optimaliseren" keeps the service connected while the phone sleeps. */
export function askBatteryExemption(): boolean {
  return service?.askBattery() ?? false;
}

/** The phone has the always-on service (not a car, a TV or an older build). */
export const hasNotifyService = Boolean(service);
