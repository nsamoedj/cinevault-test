// "Agenda": new episodes of the shows the profile follows. On top a strip of
// the coming two weeks (tap a day to jump to it), then one block per day with a
// date tile, and a card per episode. Linking the calendar to Google Calendar or
// another app is a sheet, from the button at the top or the card at the end.

import {
  addDays,
  type CalendarEpisode,
  type CalendarScope,
  calendarDay,
  calendarSummary,
  groupByDay,
  premiereLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { px, thisDevice } from '../car';
import { Icon } from '../components/Icon';
import { Button, ErrorView, IconButton, Loading, ServerImage, text } from '../components/ui';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, gutter, radius } from '../theme';

/** The days in the strip at the top, from today. */
const STRIP_DAYS = 14;
/** Wider than this (a tablet, a car), the page is a column in the middle. */
const COLUMN = 760;

type Section = { date: string; data: CalendarEpisode[] };

/** Today on this device, until the server says what today is. */
function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export default function CalendarScreen() {
  const { api } = useSession();
  const params = useLocalSearchParams<{ scope?: string }>();
  const [scope, setScope] = useState<CalendarScope>(params.scope === 'all' ? 'all' : 'following');
  const [showPast, setShowPast] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const listRef = useRef<SectionList<CalendarEpisode, Section>>(null);
  const { width } = useWindowDimensions();
  const side = Math.max(px(gutter), (width - px(COLUMN)) / 2);

  const list = useQuery({ queryKey: keys.calendar(scope), queryFn: () => api.calendar(scope) });
  const today = list.data?.today ?? localToday();
  const episodes = list.data?.episodes ?? [];
  const days = groupByDay(episodes);
  const past = days.filter((day) => day.date < today);
  const pastCount = past.reduce((sum, day) => sum + day.entries.length, 0);
  const sections: Section[] = days
    .filter((day) => showPast || day.date >= today)
    .map((day) => ({ date: day.date, data: day.entries }));
  const perDay = new Map(days.map((day) => [day.date, day.entries.length]));

  function jumpTo(date: string) {
    const sectionIndex = sections.findIndex((section) => section.date === date);
    if (sectionIndex < 0) return;
    listRef.current?.scrollToLocation({ sectionIndex, itemIndex: 0, viewOffset: 0 });
  }

  const top = (
    <View style={[styles.top, { paddingHorizontal: side }]}>
      <View style={styles.head}>
        <IconButton icon="back" label="Terug" onPress={() => router.back()} />
        <View style={{ flex: 1 }}>
          <Text style={text.h1}>Agenda</Text>
          {list.data && (
            <Text style={text.muted} numberOfLines={2}>
              {calendarSummary(episodes, today)}
            </Text>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Agenda koppelen"
          hitSlop={8}
          onPress={() => setConnecting(true)}
          style={({ pressed }) => [styles.connectButton, pressed && { opacity: 0.7 }]}
        >
          <Icon name="calendar" size={16} color={colors.brass} />
          <Text style={styles.connectButtonText}>Koppelen</Text>
        </Pressable>
      </View>

      <View style={styles.segmented} accessibilityRole="radiogroup">
        {(
          [
            ['following', 'Die ik volg'],
            ['all', 'Alle series'],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ checked: scope === value }}
            onPress={() => setScope(value)}
            style={[styles.segment, scope === value && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, scope === value && { color: colors.ink }]}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {Array.from({ length: STRIP_DAYS }, (_, i) => addDays(today, i)).map((date) => {
          const parts = calendarDay(date, today);
          const count = perDay.get(date) ?? 0;
          const isToday = parts.offset === 0;
          return (
            <Pressable
              key={date}
              accessibilityRole="button"
              accessibilityLabel={`${parts.full}, ${count === 0 ? 'niets' : `${count} ${count === 1 ? 'aflevering' : 'afleveringen'}`}`}
              disabled={count === 0}
              onPress={() => jumpTo(date)}
              style={({ pressed }) => [
                styles.stripDay,
                isToday && styles.stripToday,
                count === 0 && !isToday && styles.stripEmpty,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={[styles.stripWeekday, isToday && { color: colors.ink }]}>
                {parts.weekday}
              </Text>
              <Text style={[styles.stripNumber, isToday && { color: colors.ink }]}>
                {parts.day}
              </Text>
              <View style={styles.dots}>
                {Array.from({ length: Math.min(count, 3) }, (_, i) => (
                  <View
                    key={i}
                    style={[styles.dot, { backgroundColor: isToday ? colors.ink : colors.brass }]}
                  />
                ))}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {top}
      {list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <SectionList
          ref={listRef}
          sections={sections}
          keyExtractor={(e) => `${e.item.id}-${e.seasonNumber}-${e.episodeNumber}`}
          stickySectionHeadersEnabled
          contentContainerStyle={[styles.list, { paddingHorizontal: side }]}
          onScrollToIndexFailed={() => {}}
          ListHeaderComponent={
            pastCount > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showPast }}
                onPress={() => setShowPast((open) => !open)}
                style={({ pressed }) => [styles.pastToggle, pressed && { opacity: 0.7 }]}
              >
                <Icon
                  name={showPast ? 'chevronUp' : 'chevronDown'}
                  size={18}
                  color={colors.text2}
                />
                <Text style={styles.pastText}>
                  {showPast ? 'Afgelopen week verbergen' : 'Afgelopen week'} · {pastCount}{' '}
                  {pastCount === 1 ? 'aflevering' : 'afleveringen'}
                </Text>
              </Pressable>
            ) : undefined
          }
          renderSectionHeader={({ section }) => (
            <DayHeader date={section.date} today={today} count={section.data.length} />
          )}
          renderItem={({ item, section }) => (
            <Entry entry={item} past={section.date < today} isToday={section.date === today} />
          )}
          ListEmptyComponent={
            list.isPending ? (
              <Loading />
            ) : (
              <View style={styles.empty}>
                <View style={styles.emptyIcon}>
                  <Icon name="calendar" size={34} color={colors.brass} />
                </View>
                <Text style={text.h2}>Geen afleveringen gepland</Text>
                <Text style={[text.muted, { textAlign: 'center' }]}>
                  {scope === 'following'
                    ? 'Je volgt een serie als hij in Mijn lijst staat, of als je er de laatste vier maanden een aflevering van keek. Zodra er een datum bekend is, staat hij hier.'
                    : 'Van geen enkele serie in de bibliotheek is al een datum bekend.'}
                </Text>
                {scope === 'following' && (
                  <Button
                    label="Alle series bekijken"
                    kind="secondary"
                    onPress={() => setScope('all')}
                  />
                )}
              </View>
            )
          }
          ListFooterComponent={
            list.data ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setConnecting(true)}
                style={({ pressed }) => [styles.connectCard, pressed && { opacity: 0.8 }]}
              >
                <View style={styles.connectIcon}>
                  <Icon name="calendar" size={22} color={colors.brass} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.title}>In je eigen agenda</Text>
                  <Text style={text.muted}>
                    Google Agenda, Apple of Outlook: altijd bijgewerkt.
                  </Text>
                </View>
                <Icon name="chevronRight" size={20} color={colors.text2} />
              </Pressable>
            ) : undefined
          }
        />
      )}
      {connecting && <ConnectSheet onClose={() => setConnecting(false)} />}
    </SafeAreaView>
  );
}

/** Above a day: the date tile, "Morgen" or the weekday, the date, and how many. */
function DayHeader({ date, today, count }: { date: string; today: string; count: number }) {
  const parts = calendarDay(date, today);
  const isToday = parts.offset === 0;
  const isPast = parts.offset < 0;
  return (
    <View style={styles.dayHead} accessibilityRole="header">
      <View style={[styles.tile, isToday && styles.tileToday, isPast && { opacity: 0.6 }]}>
        <Text style={[styles.tileMonth, isToday && { color: colors.ink }]}>{parts.month}</Text>
        <Text style={[styles.tileNumber, isToday && { color: colors.ink }]}>{parts.day}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.dayName, isToday && { color: colors.brass }]}>{parts.relative}</Text>
        <Text style={text.small}>{parts.detail}</Text>
      </View>
      <Text style={styles.dayCount}>
        {count} {count === 1 ? 'aflevering' : 'afleveringen'}
      </Text>
    </View>
  );
}

function Entry({
  entry,
  past,
  isToday,
}: {
  entry: CalendarEpisode;
  past: boolean;
  isToday: boolean;
}) {
  const code = `S${entry.seasonNumber} · A${entry.episodeNumber}`;
  const premiere = premiereLabel(entry);
  const status = entry.available
    ? 'Staat klaar'
    : past
      ? 'Nog niet binnen'
      : isToday
        ? 'Vandaag'
        : undefined;
  return (
    // A plain Pressable: inside Link (asChild) its style function was lost, and the
    // card fell apart into a column.
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push(`/item/${entry.item.id}`)}
      accessibilityLabel={[entry.item.title, code, entry.title, premiere, status]
        .filter(Boolean)
        .join(', ')}
      style={({ pressed }) => [
        styles.entry,
        past && !entry.available && { opacity: 0.65 },
        pressed && { opacity: 0.6 },
      ]}
    >
      <View style={styles.thumb}>
        <ServerImage
          path={entry.item.backdropUrl ?? entry.item.posterUrl}
          style={styles.image}
          fallback={entry.item.title}
        />
        {entry.available && (
          <View style={styles.thumbReady}>
            <Icon name="play" size={14} color={colors.ink} />
          </View>
        )}
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={styles.title} numberOfLines={1}>
          {entry.item.title}
        </Text>
        <View style={styles.line}>
          <Text style={styles.code}>{code}</Text>
          {entry.title ? (
            <Text style={[text.muted, { flex: 1 }]} numberOfLines={1}>
              {entry.title}
            </Text>
          ) : null}
        </View>
        {(premiere || status) && (
          <View style={styles.line}>
            {premiere && (
              <View style={[styles.badge, styles.badgeBrass]}>
                <Icon name="sparkle" size={11} color={colors.brass} />
                <Text style={[styles.badgeText, { color: colors.brass }]}>{premiere}</Text>
              </View>
            )}
            {status && (
              <View style={[styles.badge, entry.available && styles.badgeOk]}>
                {entry.available && <Icon name="check" size={11} color={colors.ok} />}
                <Text style={[styles.badgeText, entry.available && { color: colors.ok }]}>
                  {status}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
      <Icon name="chevronRight" size={18} color={colors.text3} />
    </Pressable>
  );
}

/** "Agenda koppelen": Google Calendar, another calendar app, or the link to share. */
function ConnectSheet({ onClose }: { onClose: () => void }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const link = useQuery({ queryKey: keys.calendarLink, queryFn: api.calendarLink });
  const reset = useMutation({
    mutationFn: api.resetCalendarLink,
    onSuccess: (data) => queryClient.setQueryData(keys.calendarLink, data),
  });
  const data = link.data;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Sluiten" onPress={onClose} />
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={styles.sheetHead}>
            <View style={styles.connectIcon}>
              <Icon name="calendar" size={22} color={colors.brass} />
            </View>
            <Text style={[text.h2, { flex: 1 }]}>Agenda koppelen</Text>
            <IconButton icon="close" label="Sluiten" onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={{ gap: 12 }}>
            {link.isPending && <Loading label="Link maken…" />}
            {link.isError && <ErrorView error={link.error} onRetry={() => void link.refetch()} />}
            {data && (
              <>
                {!data.secure && (
                  <View style={styles.warning}>
                    <Icon name="alert" size={18} color={colors.brass} />
                    <Text style={[text.muted, { flex: 1, color: colors.text }]}>
                      Deze link begint met http://. Google Agenda kan hem dan niet ophalen. Verbind
                      via je domein (https://) voor een link die overal werkt.
                    </Text>
                  </View>
                )}
                {/* Google's phone app can't subscribe to a link; its website can. */}
                <View style={styles.steps}>
                  <Text style={styles.title}>Google Agenda</Text>
                  <Text style={text.muted}>
                    De app van Google Agenda kan geen agenda via een link toevoegen. Doe het één
                    keer op een computer:
                  </Text>
                  {[
                    'Open calendar.google.com.',
                    "Kies links bij Andere agenda's + → Via URL.",
                    'Plak de link en kies Agenda toevoegen.',
                    `Zet op ${thisDevice} in Google Agenda → Instellingen → CineVault het synchroniseren aan.`,
                  ].map((step, i) => (
                    <View key={step} style={styles.step}>
                      <View style={styles.stepNumber}>
                        <Text style={styles.stepNumberText}>{i + 1}</Text>
                      </View>
                      <Text style={[text.muted, { flex: 1 }]}>{step}</Text>
                    </View>
                  ))}
                </View>
                <Button
                  label="Link naar je computer sturen"
                  icon="share"
                  onPress={() => void Share.share({ message: data.url })}
                />
                <Button
                  label="Andere agenda-app"
                  kind="secondary"
                  icon="calendar"
                  onPress={() =>
                    void Linking.openURL(data.webcalUrl).catch(() =>
                      Alert.alert(
                        'Geen agenda-app gevonden',
                        `Geen app op ${thisDevice} opent een agenda-link. Voeg de agenda toe via de website van Google Agenda, of installeer ICSx⁵ en deel de link daarnaar.`,
                      ),
                    )
                  }
                />
                <View style={styles.urlBox}>
                  <Text style={text.small} selectable numberOfLines={2}>
                    {data.url}
                  </Text>
                </View>
                <Text style={text.small}>
                  Google Agenda ververst een gekoppelde agenda zelf, meestal een paar keer per dag.
                  Iedereen met deze link ziet welke series je volgt; deel hem dus niet met anderen.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={reset.isPending}
                  hitSlop={8}
                  onPress={() =>
                    Alert.alert(
                      'Nieuwe link maken?',
                      'De oude link werkt dan niet meer; koppel de agenda daarna opnieuw.',
                      [
                        { text: 'Annuleren', style: 'cancel' },
                        { text: 'Nieuwe link', onPress: () => reset.mutate() },
                      ],
                    )
                  }
                >
                  <Text style={styles.linkText}>
                    {reset.isSuccess ? 'Nieuwe link gemaakt' : 'Nieuwe link maken'}
                  </Text>
                </Pressable>
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  top: { gap: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.line },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: -8, paddingTop: 4 },
  connectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(224,176,79,0.5)',
    backgroundColor: colors.brassSoft,
  },
  connectButtonText: { color: colors.brass, fontSize: 13, fontWeight: '800' },
  segmented: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 999,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.line,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentOn: { backgroundColor: colors.brass },
  segmentText: { color: colors.text2, fontWeight: '700', fontSize: 14 },
  strip: { gap: 8, paddingVertical: 2 },
  stripDay: {
    width: 52,
    paddingVertical: 8,
    borderRadius: radius.m,
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  stripToday: { backgroundColor: colors.brass, borderColor: colors.brass },
  stripEmpty: { opacity: 0.45 },
  stripWeekday: {
    color: colors.text2,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  stripNumber: { color: colors.text, fontSize: 19, fontWeight: '800' },
  dots: { flexDirection: 'row', gap: 3, height: 5 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  list: { paddingTop: 4, paddingBottom: 40 },
  pastToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  pastText: { color: colors.text2, fontSize: 13, fontWeight: '700' },
  dayHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 18,
    paddingBottom: 10,
    backgroundColor: colors.bg,
  },
  tile: {
    width: 48,
    height: 52,
    borderRadius: radius.m,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.line,
  },
  tileToday: { backgroundColor: colors.brass, borderColor: colors.brass },
  tileMonth: {
    color: colors.brass,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  tileNumber: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: -1 },
  dayName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  dayCount: { color: colors.text3, fontSize: 12, fontWeight: '700' },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    marginBottom: 8,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  thumb: { width: 120, height: 68, borderRadius: radius.s, overflow: 'hidden' },
  image: { width: 120, height: 68 } as ViewStyle,
  thumbReady: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    paddingLeft: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brass,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  code: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: colors.surface3,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.glass,
  },
  badgeBrass: { backgroundColor: colors.brassSoft },
  badgeOk: { backgroundColor: 'rgba(143,209,158,0.16)' },
  badgeText: { color: colors.text2, fontSize: 11, fontWeight: '800' },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 48, paddingHorizontal: 8 },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brassSoft,
  },
  connectCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 24,
    padding: 16,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  connectIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brassSoft,
  },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim },
  sheet: {
    width: '100%',
    maxWidth: 600,
    maxHeight: '88%',
    alignSelf: 'center',
    padding: 20,
    gap: 14,
    borderTopLeftRadius: radius.l,
    borderTopRightRadius: radius.l,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  warning: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderRadius: radius.s,
    backgroundColor: colors.brassSoft,
  },
  steps: { gap: 10, padding: 14, borderRadius: radius.m, backgroundColor: colors.surface2 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  stepNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brass,
  },
  stepNumberText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  urlBox: { padding: 10, borderRadius: radius.s, backgroundColor: colors.bg },
  linkText: { color: colors.brass, fontWeight: '700', fontSize: 14 },
});
