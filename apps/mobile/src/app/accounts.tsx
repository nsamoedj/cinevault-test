// "Accounts", for admins on a phone or tablet: the household's accounts, to
// add, change (name, role, kids profile, a new password) and remove. On a
// tablet the list and the form sit side by side; on a phone the form slides
// up over the list. Members never get here (the profile has no link, and the
// API refuses them).

import {
  ageLabel,
  ApiError,
  dateLabel,
  KIDS_AGES,
  type UserChanges,
  type UserDto,
  type UserRole,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { type ReactNode, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../components/Icon';
import {
  Avatar,
  Button,
  ErrorView,
  errorText,
  IconButton,
  Input,
  Loading,
  text,
} from '../components/ui';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, gutter, radius } from '../theme';

const COLORS = ['#E0B04F', '#4F9DE0', '#E06C4F', '#5FBF7F', '#B07FE0', '#E04F8F'];
/** From this width the list and the form are side by side. */
const TWO_PANES = 720;

/** The API's English messages, in Dutch. */
function accountError(error: unknown): string {
  if (error instanceof ApiError) {
    if (/at least 10/.test(error.message)) return 'Kies een wachtwoord van minstens 10 tekens.';
    if (/letters, digits/.test(error.message)) {
      return 'Een gebruikersnaam heeft 2 tot 32 letters, cijfers, punten of streepjes.';
    }
    if (/at least one admin/.test(error.message)) return 'Er moet minstens één beheerder zijn.';
    if (/kids profile/.test(error.message)) return 'Een beheerder kan geen kinderprofiel zijn.';
    if (/remove yourself/.test(error.message)) return 'Je kunt jezelf niet verwijderen.';
    if (error.status === 409) return 'Die gebruikersnaam bestaat al.';
    if (error.status === 403) return 'Alleen een beheerder kan accounts beheren.';
  }
  return errorText(error);
}

function roleText(user: UserDto): string {
  if (user.role === 'ADMIN') return 'Beheerder';
  if (user.maxAge !== undefined) return `Kinderprofiel · t/m ${ageLabel(user.maxAge)}`;
  return 'Lid';
}

function Badge({ label, tone }: { label: string; tone: 'brass' | 'kids' | 'plain' }) {
  return (
    <View
      style={[
        styles.badge,
        tone === 'brass' && { backgroundColor: colors.brassSoft },
        tone === 'kids' && { backgroundColor: 'rgba(143,209,158,0.16)' },
      ]}
    >
      <Text
        style={[
          styles.badgeText,
          tone === 'brass' && { color: colors.brass },
          tone === 'kids' && { color: colors.ok },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function AccountCard({
  user,
  self,
  selected,
  onPress,
}: {
  user: UserDto;
  self: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${user.displayName}, ${roleText(user)}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        selected && styles.cardSelected,
        pressed && { opacity: 0.85 },
      ]}
    >
      <Avatar name={user.displayName} color={user.avatarColor} size={48} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {user.displayName}
          </Text>
          {self && <Badge label="Jij" tone="plain" />}
        </View>
        <Text style={text.small} numberOfLines={1}>
          {user.username} ·{' '}
          {user.lastLoginAt
            ? `laatst ingelogd ${dateLabel(user.lastLoginAt)}`
            : 'nog nooit ingelogd'}
        </Text>
        <View style={{ flexDirection: 'row' }}>
          <Badge
            label={roleText(user)}
            tone={user.role === 'ADMIN' ? 'brass' : user.maxAge !== undefined ? 'kids' : 'plain'}
          />
        </View>
      </View>
      <Icon name="chevronRight" size={20} color={colors.text3} />
    </Pressable>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={text.small}>{hint}</Text> : null}
    </View>
  );
}

function Choice<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.choices}>
      {options.map((option) => {
        const on = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.id)}
            style={[styles.choice, on && styles.choiceOn, disabled && { opacity: 0.5 }]}
          >
            <Text style={[styles.choiceText, on && { color: colors.ink }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "none" is a grown-up; a number is a kids profile up to that age. */
type Limit = 'none' | number;

const LIMITS: { id: Limit; label: string }[] = [
  { id: 'none', label: 'Geen' },
  ...KIDS_AGES.map((age) => ({ id: age, label: ageLabel(age) })),
];

/** A new account (no `user`) or the changes to one. */
function AccountForm({
  user,
  self,
  onDone,
  onClose,
}: {
  user?: UserDto;
  self: boolean;
  onDone: (user?: UserDto) => void;
  onClose?: () => void;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>(user?.role ?? 'USER');
  const [limit, setLimit] = useState<Limit>(user?.maxAge ?? 'none');
  const [color, setColor] = useState(user?.avatarColor);
  const [saved, setSaved] = useState<string>();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.users });
  const maxAge = role === 'ADMIN' || limit === 'none' ? null : limit;

  const save = useMutation({
    mutationFn: async () => {
      if (!user) {
        return api.createUser({
          displayName: displayName.trim(),
          username: username.trim(),
          password,
          role,
          maxAge,
        });
      }
      const changes: UserChanges = {};
      if (displayName.trim() !== user.displayName) changes.displayName = displayName.trim();
      if (color && color !== user.avatarColor) changes.avatarColor = color;
      if (!self && role !== user.role) changes.role = role;
      if (maxAge !== (user.maxAge ?? null)) changes.maxAge = maxAge;
      if (password) changes.password = password;
      return api.updateUser(user.id, changes);
    },
    onSuccess: async (result) => {
      await refresh();
      setPassword('');
      if (user) {
        setSaved(
          password ? 'Opgeslagen. Het nieuwe wachtwoord logt alle apparaten uit.' : 'Opgeslagen.',
        );
      }
      onDone(result);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteUser((user as UserDto).id),
    onSuccess: async () => {
      await refresh();
      onDone(undefined);
    },
  });

  const confirmRemove = () =>
    Alert.alert(
      `${user?.displayName} verwijderen?`,
      'Het account, de kijkvoortgang en Mijn lijst van dit profiel verdwijnen. Dit kan niet ongedaan worden gemaakt.',
      [
        { text: 'Annuleren', style: 'cancel' },
        { text: 'Verwijderen', style: 'destructive', onPress: () => remove.mutate() },
      ],
    );

  const ready =
    displayName.trim().length > 0 &&
    (user
      ? password.length === 0 || password.length >= 10
      : username.trim().length >= 2 && password.length >= 10);
  const failed = save.error ?? remove.error;

  return (
    <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
      <View style={styles.formHead}>
        <Avatar name={displayName || '?'} color={color ?? COLORS[0]} size={56} />
        <View style={{ flex: 1 }}>
          <Text style={text.h2} numberOfLines={1}>
            {user ? user.displayName : 'Nieuw account'}
          </Text>
          <Text style={text.small}>
            {user ? `Sinds ${dateLabel(user.createdAt)}` : 'Voor iemand uit het huishouden'}
          </Text>
        </View>
        {onClose && <IconButton icon="close" label="Sluiten" onPress={onClose} />}
      </View>

      <Field label="Naam">
        <Input
          style={styles.input}
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={40}
          placeholder="Bijvoorbeeld Sanne"
          accessibilityLabel="Naam"
        />
      </Field>
      {user ? (
        <Field label="Gebruikersnaam">
          <Text style={[text.body, styles.readOnly]}>{user.username}</Text>
        </Field>
      ) : (
        <Field
          label="Gebruikersnaam"
          hint="Om mee in te loggen: kleine letters, cijfers, . _ of -."
        >
          <Input
            style={styles.input}
            value={username}
            onChangeText={(value) => setUsername(value.toLowerCase())}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={32}
            placeholder="sanne"
            accessibilityLabel="Gebruikersnaam"
          />
        </Field>
      )}
      <Field
        label={user ? 'Nieuw wachtwoord' : 'Wachtwoord'}
        hint={
          user
            ? 'Leeg laten om het te houden. Minstens 10 tekens.'
            : 'Minstens 10 tekens. Geef het door; de ander kan het daarna in de webinterface wijzigen.'
        }
      >
        <Input
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          accessibilityLabel={user ? 'Nieuw wachtwoord' : 'Wachtwoord'}
        />
      </Field>

      <Field
        label="Rol"
        hint={
          self
            ? 'Je eigen rol wijzig je niet hier, zodat je jezelf niet buitensluit.'
            : role === 'ADMIN'
              ? 'Scant, matcht, keurt verzoeken goed en beheert accounts.'
              : 'Kijkt en vraagt titels aan. Ziet niets van het beheer.'
        }
      >
        <Choice
          options={[
            { id: 'USER' as const, label: 'Lid' },
            { id: 'ADMIN' as const, label: 'Beheerder' },
          ]}
          value={role}
          onChange={setRole}
          disabled={self}
        />
      </Field>

      {role === 'USER' && (
        <Field
          label="Kinderprofiel"
          hint={
            limit === 'none'
              ? 'Geen leeftijdsgrens: alles in de bibliotheek.'
              : `Alleen titels met Kijkwijzer ${ageLabel(limit)}${limit === 0 ? '' : ' of lager'}. Titels zonder leeftijd, Ontdekken en verzoeken zijn verborgen.`
          }
        >
          <Choice options={LIMITS} value={limit} onChange={setLimit} />
        </Field>
      )}

      {user && (
        <Field label="Kleur">
          <View style={styles.colors}>
            {COLORS.map((c) => (
              <Pressable
                key={c}
                accessibilityRole="radio"
                accessibilityLabel={`Kleur ${c}`}
                accessibilityState={{ checked: (color ?? user.avatarColor) === c }}
                onPress={() => setColor(c)}
                style={[
                  styles.swatch,
                  { backgroundColor: c },
                  (color ?? user.avatarColor) === c && styles.swatchOn,
                ]}
              />
            ))}
          </View>
        </Field>
      )}

      {failed ? <Text style={styles.error}>{accountError(failed)}</Text> : null}
      {saved && !save.isPending ? <Text style={styles.saved}>{saved}</Text> : null}

      <Button
        label={user ? 'Opslaan' : 'Account toevoegen'}
        icon={user ? 'check' : 'plus'}
        disabled={!ready || save.isPending}
        onPress={() => {
          setSaved(undefined);
          save.mutate();
        }}
      />
      {user && !self && (
        <Pressable
          accessibilityRole="button"
          onPress={confirmRemove}
          disabled={remove.isPending}
          style={({ pressed }) => [styles.remove, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.removeText}>Account verwijderen</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

function Summary({ users }: { users: UserDto[] }) {
  const admins = users.filter((u) => u.role === 'ADMIN').length;
  const kids = users.filter((u) => u.maxAge !== undefined).length;
  const parts = [
    `${users.length} ${users.length === 1 ? 'account' : 'accounts'}`,
    `${admins} ${admins === 1 ? 'beheerder' : 'beheerders'}`,
    ...(kids ? [`${kids} ${kids === 1 ? 'kinderprofiel' : 'kinderprofielen'}`] : []),
  ];
  return <Text style={text.muted}>{parts.join(' · ')}</Text>;
}

/** What the form shows: nothing, a new account, or the account with this id. */
type Editing = undefined | 'new' | string;

function AccountsScreen() {
  const { api, user: me } = useSession();
  const { width } = useWindowDimensions();
  const wide = width >= TWO_PANES;
  const users = useQuery({
    queryKey: keys.users,
    queryFn: api.users,
    enabled: me?.role === 'ADMIN',
  });
  const [editing, setEditing] = useState<Editing>(wide ? 'new' : undefined);
  const list = users.data ?? [];
  const current = editing && editing !== 'new' ? list.find((u) => u.id === editing) : undefined;
  const formOpen = editing === 'new' || current !== undefined;

  if (me?.role !== 'ADMIN') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ErrorView error={new Error('Alleen een beheerder kan accounts beheren.')} />
      </SafeAreaView>
    );
  }

  const form = formOpen ? (
    <AccountForm
      // A new form for each account, so its fields start from that account.
      key={editing}
      user={current}
      self={current?.id === me.id}
      onClose={wide ? undefined : () => setEditing(undefined)}
      onDone={(saved) => {
        if (!saved) setEditing(wide ? 'new' : undefined);
        else if (editing === 'new') setEditing(wide ? saved.id : undefined);
      }}
    />
  ) : null;

  const listView = (
    <ScrollView contentContainerStyle={[styles.page, wide && { paddingRight: 8 }]}>
      <Summary users={list} />
      {users.isPending && <Loading />}
      {users.isError && <ErrorView error={users.error} onRetry={() => void users.refetch()} />}
      {[...list]
        // Admins first, then by name.
        .sort(
          (a, b) =>
            Number(b.role === 'ADMIN') - Number(a.role === 'ADMIN') ||
            a.displayName.localeCompare(b.displayName, 'nl'),
        )
        .map((user) => (
          <AccountCard
            key={user.id}
            user={user}
            self={user.id === me.id}
            selected={wide && editing === user.id}
            onPress={() => setEditing(user.id)}
          />
        ))}
      <Text style={[text.small, { marginTop: 8 }]}>
        Een lid ziet niets van het beheer. Een kinderprofiel ziet alleen titels tot de gekozen
        leeftijd (Kijkwijzer, van TMDB).
      </Text>
    </ScrollView>
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.head}>
        <IconButton icon="back" label="Terug" onPress={() => router.back()} />
        <Text
          style={[text.h1, { flex: 1 }]}
          numberOfLines={1}
          // On a narrow phone next to "Toevoegen": smaller rather than broken in two.
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          Accounts
        </Text>
        <Button
          label="Toevoegen"
          icon="plus"
          kind={wide && editing === 'new' ? 'secondary' : 'primary'}
          onPress={() => setEditing('new')}
          style={{ minHeight: 40, paddingHorizontal: 14 }}
        />
      </View>
      {wide ? (
        <View style={styles.panes}>
          <View style={styles.listPane}>{listView}</View>
          <KeyboardAvoidingView style={styles.formPane} behavior="height">
            {form}
          </KeyboardAvoidingView>
        </View>
      ) : (
        <>
          {listView}
          <Modal
            visible={formOpen}
            animationType="slide"
            transparent
            onRequestClose={() => setEditing(undefined)}
          >
            <View style={styles.sheetBackdrop}>
              <Pressable
                style={StyleSheet.absoluteFill}
                accessibilityLabel="Sluiten"
                onPress={() => setEditing(undefined)}
              />
              <KeyboardAvoidingView behavior="padding" style={styles.sheet}>
                <SafeAreaView edges={['bottom']}>{form}</SafeAreaView>
              </KeyboardAvoidingView>
            </View>
          </Modal>
        </>
      )}
    </SafeAreaView>
  );
}

export default AccountsScreen;

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingRight: gutter,
  },
  page: { padding: gutter, gap: 10, paddingBottom: 40 },
  panes: { flex: 1, flexDirection: 'row', gap: 8, paddingRight: gutter },
  listPane: { width: 380, maxWidth: '45%' },
  formPane: {
    flex: 1,
    marginTop: gutter,
    marginBottom: gutter,
    borderRadius: radius.l,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cardSelected: { borderColor: colors.brass, backgroundColor: colors.surface2 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.glass,
  },
  badgeText: { color: colors.text2, fontSize: 12, fontWeight: '700' },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim },
  sheet: {
    maxHeight: '92%',
    borderTopLeftRadius: radius.l,
    borderTopRightRadius: radius.l,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  form: { padding: 20, gap: 16, paddingBottom: 28 },
  formHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  label: { color: colors.text, fontSize: 14, fontWeight: '700' },
  input: {
    minHeight: 48,
    borderRadius: radius.s,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  readOnly: { color: colors.text2, paddingVertical: 4 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    minHeight: 40,
    minWidth: 52,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceOn: { backgroundColor: colors.brass, borderColor: colors.brass },
  choiceText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  colors: { flexDirection: 'row', gap: 12 },
  swatch: { width: 36, height: 36, borderRadius: 18, borderWidth: 3, borderColor: 'transparent' },
  swatchOn: { borderColor: colors.text },
  error: { color: colors.danger, fontSize: 14 },
  saved: { color: colors.ok, fontSize: 14 },
  remove: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  removeText: { color: colors.danger, fontSize: 15, fontWeight: '700' },
});
