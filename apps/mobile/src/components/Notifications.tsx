// The inbox (phone and TV), the bell with the number of unread ones, and the
// notification settings on the phone.

import {
  type NotificationDto,
  type NotificationSettings,
  type NotificationType,
  timeAgoLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { keys } from '../keys';
import {
  askBatteryExemption,
  disablePhoneNotifications,
  checkNotifications,
  enablePhoneNotifications,
  hasNotifyService,
  type PhoneStatus,
  phoneNotificationStatus,
} from '../notifications/phone';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { thisDevice } from '../car';
import { isTV, TvPressable } from '../tv/focus';
import { Icon, type IconName } from './Icon';
import { Button, ServerImage, text } from './ui';

const ICON: Record<NotificationType, IconName> = {
  'new-episodes': 'tv',
  airing: 'calendar',
  recommended: 'sparkle',
  'new-login': 'user',
  'admin-unmatched': 'alert',
  'admin-transcoder': 'alert',
  'admin-health': 'alert',
  'request-new': 'plus',
  'request-update': 'sparkle',
  test: 'bell',
};

/** Where a notification leads in the app: the title, else the inbox. */
export function openNotification(n: { itemId?: string; path?: string }): void {
  if (n.itemId) router.push(`/item/${n.itemId}`);
  else if (n.path === '/profile') router.push('/profile');
  else if (n.path === '/requests') router.push('/requests');
  // Beheer on the phone (not on the TV, which has no admin screens).
  else if (n.path === '/attention' && !isTV) router.push('/attention');
  else if (n.path === '/admin' && !isTV) router.push('/admin');
  else router.push('/notifications');
}

export function useInbox() {
  const { api } = useSession();
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => api.notifications({ limit: 50 }),
    refetchInterval: 60_000,
  });
}

/** The bell: opens the inbox, with the number of unread ones. */
export function NotificationBell() {
  const inbox = useInbox();
  const unread = inbox.data?.unread ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Meldingen, ${unread} nieuw` : 'Meldingen'}
      hitSlop={8}
      onPress={() => router.push('/notifications')}
      style={styles.bell}
    >
      <Icon name="bell" size={24} />
      {unread > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{unread > 9 ? '9+' : unread}</Text>
        </View>
      )}
    </Pressable>
  );
}

function Row({ n, onPress }: { n: NotificationDto; onPress: () => void }) {
  return (
    <TvPressable
      accessibilityRole="button"
      accessibilityLabel={`${n.title}. ${n.body}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}
      focusStyle={{ borderColor: colors.brass, backgroundColor: colors.brassSoft }}
    >
      <View style={styles.image}>
        {n.imageUrl ? (
          <ServerImage path={n.imageUrl} style={StyleSheet.absoluteFill} />
        ) : (
          <Icon name={ICON[n.type] ?? 'bell'} size={22} color={colors.brass} />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {!n.read && <View style={styles.dot} />}
          <Text style={styles.title} numberOfLines={1}>
            {n.title}
          </Text>
        </View>
        <Text style={text.muted} numberOfLines={3}>
          {n.body}
        </Text>
        <Text style={text.small}>{timeAgoLabel(n.createdAt)}</Text>
      </View>
    </TvPressable>
  );
}

/** The list; opening it marks everything as read (after a moment). */
export function NotificationList({ limit }: { limit?: number }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const inbox = useInbox();
  const unread = inbox.data?.unread ?? 0;
  useEffect(() => {
    if (unread === 0) return;
    const timer = setTimeout(() => {
      void api
        .readNotifications()
        .then(() => queryClient.invalidateQueries({ queryKey: keys.notifications }));
    }, 1500);
    return () => clearTimeout(timer);
  }, [api, queryClient, unread]);

  const items = (inbox.data?.items ?? []).slice(0, limit);
  if (inbox.isPending) return null;
  if (items.length === 0) {
    return (
      <Text style={text.muted}>
        Nog geen meldingen. Je hoort het hier als er een nieuwe aflevering is van een serie die je
        volgt.
      </Text>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {items.map((n) => (
        <Row key={n.id} n={n} onPress={() => openNotification(n)} />
      ))}
    </View>
  );
}

const TOGGLES: { key: keyof NotificationSettings; label: string; admin?: boolean }[] = [
  { key: 'newEpisodes', label: 'Nieuwe afleveringen van series die je volgt' },
  { key: 'airing', label: 'De dag dat een nieuwe aflevering uitkomt' },
  { key: 'recommended', label: 'Nieuwe titels die passen bij wat je keek' },
  { key: 'newLogin', label: 'Een nieuwe login op je account' },
  { key: 'requests', label: 'Je verzoeken: goedgekeurd, afgewezen, klaar' },
  { key: 'admin', label: 'Beheer: verzoeken, titels zonder match, transcoder weg', admin: true },
  { key: 'quietHours', label: 'Stille uren (23:00–08:00)' },
];

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggle}>
      <Text style={[text.body, { flex: 1 }]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.brass, false: colors.surface2 }}
        thumbColor={colors.text}
      />
    </View>
  );
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return today
    ? `vandaag ${time}`
    : `${date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} ${time}`;
}

const openBatterySettings = () => {
  // The list of apps; "Alle apps" → CineVault → "Niet optimaliseren".
  if (askBatteryExemption()) return;
  void Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() =>
    Linking.openSettings(),
  );
};

/**
 * The always-on service: connected or not (a dot in green, brass or red), when
 * the last notification came, and what still stands in its way (Android's
 * permission, battery saving).
 */
function ServiceStatus({ status }: { status: PhoneStatus }) {
  const service = status.service;
  if (!service) return null;
  const state = service.connected ? 'ok' : service.running ? 'waiting' : 'off';
  const dot = state === 'ok' ? colors.ok : state === 'waiting' ? colors.brass : colors.danger;
  const headline =
    state === 'ok'
      ? 'Verbonden: nieuwe meldingen komen meteen binnen, ook als de app dicht is.'
      : state === 'waiting'
        ? 'Verbinden met de server…'
        : 'De meldingendienst draait niet.';
  const at = (ms?: number | null) => (ms ? timeLabel(new Date(ms).toISOString()) : undefined);
  const details = [
    service.shownAt && `Laatste melding: ${at(service.shownAt)}`,
    !service.connected && service.error && `${service.error} (${at(service.errorAt) ?? 'net'})`,
  ].filter(Boolean) as string[];
  return (
    <View style={styles.serviceCard}>
      <View style={styles.serviceRow}>
        <View style={[styles.statusDot, { backgroundColor: dot }]} />
        <Text style={[text.body, { flex: 1 }]}>{headline}</Text>
      </View>
      {details.map((line) => (
        <Text key={line} style={text.small}>
          {line}
        </Text>
      ))}
      {!service.permitted && (
        <>
          <Text style={[text.small, { color: colors.brass }]}>
            Android staat meldingen voor CineVault niet toe.
          </Text>
          <Button
            label="Meldingen toestaan"
            kind="secondary"
            icon="settings"
            onPress={() => void Linking.openSettings()}
          />
        </>
      )}
      {service.permitted && !service.batteryExempt && (
        <>
          <Text style={[text.small, { color: colors.brass }]}>
            Zet de batterijbesparing voor CineVault uit, anders verbreekt Android de verbinding als{' '}
            {thisDevice} slaapt en komen meldingen pas bij het ontgrendelen.
          </Text>
          <Button
            label="Batterijbesparing uitzetten"
            kind="secondary"
            icon="settings"
            onPress={openBatterySettings}
          />
        </>
      )}
      {state === 'off' && (
        <Text style={text.small}>
          Zet meldingen hierboven uit en weer aan, of open de app opnieuw.
        </Text>
      )}
    </View>
  );
}

/** Whether it works: the permission, the background task and the last check. */
function PhoneStatusLine({ status }: { status: PhoneStatus }) {
  const warning = !status.permitted
    ? 'Android staat meldingen voor CineVault niet toe. Zet ze aan in de instellingen van Android (Apps → CineVault → Meldingen).'
    : !status.scheduled
      ? 'De controle op de achtergrond staat niet gepland. Zet meldingen uit en weer aan.'
      : undefined;
  const last = status.last;
  return (
    <View style={{ gap: 2 }}>
      {warning && <Text style={[text.small, { color: colors.brass }]}>{warning}</Text>}
      <Text style={text.small}>
        {last
          ? `Laatst gekeken: ${timeLabel(last.at)}${last.background ? ' (op de achtergrond)' : ''}${
              last.error
                ? `, maar de server was niet bereikbaar (${last.error})`
                : `, ${last.shown === 1 ? '1 melding' : `${last.shown} meldingen`} getoond`
            }.`
          : 'Nog niet gekeken.'}
      </Text>
    </View>
  );
}

/** Profiel → Meldingen: on this phone, and which ones. */
export function NotificationSettingsPanel() {
  const { api, user } = useSession();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: keys.notificationSettings,
    queryFn: api.notificationSettings,
  });
  const [changed, setChanged] = useState<Partial<NotificationSettings>>({});
  const save = useMutation({
    mutationFn: (change: Partial<NotificationSettings>) => api.setNotificationSettings(change),
    onSuccess: (saved) => queryClient.setQueryData(keys.notificationSettings, saved),
    onSettled: () => setChanged({}),
  });
  const [status, setStatus] = useState<PhoneStatus>();
  const phone = status?.on;
  const [message, setMessage] = useState<string>();
  const refresh = () => void phoneNotificationStatus().then(setStatus);
  useEffect(() => {
    refresh();
    // The service's state changes by itself (connecting, a lost network).
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  const togglePhone = async (on: boolean) => {
    setMessage(undefined);
    if (!on) {
      await disablePhoneNotifications();
      refresh();
      return;
    }
    const granted = await enablePhoneNotifications(user?.role === 'ADMIN').catch(() => false);
    refresh();
    if (!granted) {
      setMessage('Sta meldingen voor CineVault toe in de instellingen van Android.');
    }
  };

  const test = async () => {
    setMessage(undefined);
    const sent = Date.now();
    await api.testNotification();
    void queryClient.invalidateQueries({ queryKey: keys.notifications });
    if (!phone) {
      setMessage('Verstuurd. Kijk onder het belletje.');
      return;
    }
    // Connected, the service shows it itself within a moment.
    if (status?.service?.connected) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const now = await phoneNotificationStatus();
      setStatus(now);
      if ((now.service?.shownAt ?? 0) >= sent - 1000) {
        setMessage('Verstuurd. Hij staat nu bij de meldingen van Android.');
        return;
      }
    }
    const shown = await checkNotifications(false, true).catch(() => -1);
    refresh();
    setMessage(
      shown > 0
        ? 'Verstuurd. Hij staat nu ook bij de meldingen van Android.'
        : shown === 0
          ? `Verstuurd, maar ${thisDevice} toonde hem niet. Staat hij al als gelezen onder het belletje?`
          : `Verstuurd, maar ${thisDevice} kon de server niet bereiken.`,
    );
  };

  return (
    <View style={styles.panel}>
      <Text style={text.h2}>Meldingen</Text>
      <Toggle
        label={`Meldingen op ${thisDevice}`}
        value={phone ?? false}
        onChange={(on) => void togglePhone(on)}
      />
      {hasNotifyService ? (
        <Text style={text.small}>
          CineVault houdt een verbinding met de server open, zodat een melding meteen komt, ook als
          de app dicht is. Android toont daarvoor een stille melding onderaan (
          <Text style={{ fontWeight: '600' }}>Meldingen staan aan</Text>); die mag je wegvegen of
          verbergen.
        </Text>
      ) : (
        <Text style={text.small}>
          De app kijkt ongeveer elk kwartier of er iets nieuws is, ook als hij dicht is, en elke
          minuut als hij open is. Android kan dat uitstellen als de batterij bespaard wordt.
        </Text>
      )}
      {phone && status?.service && <ServiceStatus status={status} />}
      {phone && status && !status.service && <PhoneStatusLine status={status} />}
      {phone && !status?.service && (
        <Button
          label="Batterijbesparing voor CineVault uitzetten"
          kind="secondary"
          icon="settings"
          onPress={openBatterySettings}
        />
      )}
      {message && <Text style={[text.small, { color: colors.brass }]}>{message}</Text>}
      {settings.data &&
        TOGGLES.filter((t) => !t.admin || user?.role === 'ADMIN').map((t) => (
          <Toggle
            key={t.key}
            label={t.label}
            value={changed[t.key] ?? settings.data[t.key]}
            onChange={(value) => {
              setChanged((c) => ({ ...c, [t.key]: value }));
              save.mutate({ [t.key]: value });
            }}
          />
        ))}
      <Button
        label="Stuur een testmelding"
        kind="secondary"
        icon="bell"
        onPress={() => void test().catch(() => setMessage('De testmelding is niet verstuurd.'))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  serviceCard: {
    gap: 8,
    padding: 12,
    borderRadius: radius.m,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.line,
  },
  serviceRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  bell: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  row: {
    flexDirection: 'row',
    gap: 12,
    padding: 10,
    borderRadius: radius.m,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
  },
  image: {
    width: 96,
    aspectRatio: 16 / 9,
    borderRadius: radius.s,
    overflow: 'hidden',
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brass },
  title: { color: colors.text, fontWeight: '700', fontSize: 15, flexShrink: 1 },
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 10,
  },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
});
