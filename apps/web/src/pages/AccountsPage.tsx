import { ageLabel, KIDS_AGES, type UserDto, type UserRole } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, keys } from '../api.js';
import { useAuth } from '../auth.js';
import { Avatar } from '../components/Avatar.js';
import { ErrorBox, Loading } from '../components/common.js';
import { dateLabel } from '../format.js';
import { AdminFrame } from './AdminPage.js';
import { authErrorText } from './LoginPage.js';

const COLORS = ['#E0B04F', '#4F9DE0', '#E06C4F', '#5FBF7F', '#B07FE0', '#E04F8F'];

const roleLabel: Record<UserRole, string> = { ADMIN: 'Beheerder', USER: 'Lid' };

function accountLabel(user: UserDto): string {
  if (user.role === 'ADMIN') return roleLabel.ADMIN;
  return user.maxAge !== undefined
    ? `Kinderprofiel · t/m ${ageLabel(user.maxAge)}`
    : roleLabel.USER;
}

/** The age limit of a member: "" is none (a grown-up), else a kids profile. */
function AgeSelect({
  value,
  onChange,
  label,
}: {
  value: number | undefined;
  onChange: (value: number | null) => void;
  label?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">Geen leeftijdsgrens</option>
      {KIDS_AGES.map((age) => (
        <option key={age} value={age}>
          Kinderprofiel: {age === 0 ? 'AL (alle leeftijden)' : `t/m ${age} jaar`}
        </option>
      ))}
    </select>
  );
}

function NewAccount() {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('USER');
  const [maxAge, setMaxAge] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const create = useMutation({
    mutationFn: () =>
      api.createUser({
        displayName,
        username,
        password,
        role,
        maxAge: role === 'ADMIN' ? null : maxAge,
      }),
    onSuccess: () => {
      setDisplayName('');
      setUsername('');
      setPassword('');
      setRole('USER');
      setMaxAge(null);
      setError(undefined);
      void queryClient.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setError(authErrorText(e)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <form className="panel account-form" onSubmit={submit}>
      <h2>Account toevoegen</h2>
      <div className="form-row">
        <label>
          Naam
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
        <label>
          Gebruikersnaam
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            required
          />
        </label>
        <label>
          Wachtwoord
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </label>
        <label>
          Rol
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="USER">Lid (kijken)</option>
            <option value="ADMIN">Beheerder (ook scannen, matchen, accounts)</option>
          </select>
        </label>
        {role === 'USER' && (
          <label>
            Leeftijd
            <AgeSelect value={maxAge ?? undefined} onChange={setMaxAge} />
          </label>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button primary" disabled={create.isPending}>
        Toevoegen
      </button>
    </form>
  );
}

function AccountRow({ user, self }: { user: UserDto; self: boolean }) {
  const queryClient = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.users });
  const update = useMutation({
    mutationFn: (changes: Parameters<typeof api.updateUser>[1]) => api.updateUser(user.id, changes),
    onSuccess: () => {
      setError(undefined);
      void refresh();
    },
    onError: (e) =>
      setError(
        /at least one admin/.test(String(e))
          ? 'Er moet minstens één beheerder zijn.'
          : authErrorText(e),
      ),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteUser(user.id),
    onSuccess: () => void refresh(),
    onError: (e) => setError(authErrorText(e)),
  });

  return (
    <li className="account-row">
      <Avatar name={user.displayName} color={user.avatarColor} />
      <div className="account-main">
        <strong>{user.displayName}</strong>
        <span className="muted">
          {user.username} · {accountLabel(user)}
          {user.lastLoginAt
            ? ` · laatst ingelogd ${dateLabel(user.lastLoginAt)}`
            : ' · nog nooit ingelogd'}
        </span>
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        {done && <span className="muted">{done}</span>}
        {resetting && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate(
                { password },
                {
                  onSuccess: () => {
                    setResetting(false);
                    setPassword('');
                    setDone('Nieuw wachtwoord ingesteld; andere apparaten zijn uitgelogd.');
                  },
                },
              );
            }}
          >
            <input
              type="password"
              aria-label={`Nieuw wachtwoord voor ${user.displayName}`}
              placeholder="Nieuw wachtwoord"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={10}
              autoComplete="new-password"
              required
            />
            <button type="submit" className="button secondary">
              Opslaan
            </button>
          </form>
        )}
      </div>
      <div className="account-actions">
        <select
          aria-label={`Kleur van ${user.displayName}`}
          value={user.avatarColor ?? COLORS[0]}
          onChange={(e) => update.mutate({ avatarColor: e.target.value })}
        >
          {COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          aria-label={`Rol van ${user.displayName}`}
          value={user.role}
          onChange={(e) => {
            const role = e.target.value as UserRole;
            // An admin has no age limit.
            update.mutate(role === 'ADMIN' ? { role, maxAge: null } : { role });
          }}
        >
          <option value="USER">Lid</option>
          <option value="ADMIN">Beheerder</option>
        </select>
        {user.role === 'USER' && (
          <AgeSelect
            label={`Leeftijdsgrens van ${user.displayName}`}
            value={user.maxAge}
            onChange={(value) => update.mutate({ maxAge: value })}
          />
        )}
        <button type="button" className="button secondary" onClick={() => setResetting((r) => !r)}>
          Wachtwoord
        </button>
        {!self && (
          <button
            type="button"
            className="button secondary danger"
            onClick={() => {
              if (
                window.confirm(`${user.displayName} verwijderen? Ook de kijkvoortgang verdwijnt.`)
              ) {
                remove.mutate();
              }
            }}
          >
            Verwijderen
          </button>
        )}
      </div>
    </li>
  );
}

/** Accounts of the household (admins). */
export function AccountsPage() {
  const { user } = useAuth();
  const users = useQuery({ queryKey: keys.users, queryFn: api.users });
  if (users.isPending) {
    return (
      <AdminFrame title="Accounts">
        <Loading />
      </AdminFrame>
    );
  }
  if (users.isError) {
    return (
      <AdminFrame title="Accounts">
        <ErrorBox error={users.error} />
      </AdminFrame>
    );
  }
  return (
    <AdminFrame title="Accounts">
      <p className="muted lead">
        Iedereen in het huishouden heeft een eigen account, met eigen kijkvoortgang. Beheerders
        kunnen ook scannen, matchen en accounts beheren. Een kinderprofiel ziet alleen titels tot de
        gekozen leeftijd (Kijkwijzer, via TMDB), en geen Ontdekken of verzoeken.
      </p>
      <ul className="account-list">
        {users.data.map((u) => (
          <AccountRow key={u.id} user={u} self={u.id === user?.id} />
        ))}
      </ul>
      <NewAccount />
    </AdminFrame>
  );
}
