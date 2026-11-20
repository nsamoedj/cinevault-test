import { ApiError, type UserDto } from '@cinevault/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, keys } from '../api.js';
import { forgetProfile, type KnownProfile, knownProfiles, rememberProfile } from '../auth.js';
import { Avatar } from '../components/Avatar.js';

/** The API's English messages, in Dutch for the login screens. */
export function authErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Er ging iets mis. Is de server bereikbaar?';
  if (error.status === 401) return 'Verkeerde naam of wachtwoord.';
  if (error.status === 429) {
    const seconds = /(\d+) s/.exec(error.message)?.[1];
    return `Te veel pogingen. Probeer het ${seconds ? `over ${seconds} seconden` : 'zo'} opnieuw.`;
  }
  if (/at least 10/.test(error.message)) return 'Kies een wachtwoord van minstens 10 tekens.';
  if (/letters, digits/.test(error.message)) {
    return 'Een gebruikersnaam heeft 2 tot 32 letters, cijfers, punten of streepjes.';
  }
  if (error.status === 409) return 'Die gebruikersnaam bestaat al.';
  return error.message;
}

function Brand() {
  return (
    <div className="auth-brand">
      Cine<span>Vault</span>
    </div>
  );
}

/** "Wie kijkt er?": the profiles that signed in here before, then the password. */
export function LoginPage() {
  const queryClient = useQueryClient();
  const [profiles, setProfiles] = useState<KnownProfile[]>(knownProfiles);
  const [chosen, setChosen] = useState<KnownProfile | 'other' | undefined>(
    profiles.length === 0 ? 'other' : undefined,
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const name = chosen && chosen !== 'other' ? chosen.username : username;
      const { user } = await api.login(name, password);
      signedIn(user);
    } catch (e) {
      setError(authErrorText(e));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  function signedIn(user: UserDto) {
    rememberProfile(user);
    queryClient.setQueryData(keys.auth, { setupRequired: false, user });
  }

  if (!chosen) {
    return (
      <div className="auth-page">
        <Brand />
        <h1>Wie kijkt er?</h1>
        <ul className="profile-tiles">
          {profiles.map((profile) => (
            <li key={profile.username}>
              <button type="button" className="profile-tile" onClick={() => setChosen(profile)}>
                <Avatar name={profile.displayName} color={profile.avatarColor} size="large" />
                <span>{profile.displayName}</span>
              </button>
              <button
                type="button"
                className="text-button forget"
                aria-label={`${profile.displayName} vergeten op dit apparaat`}
                onClick={() => {
                  forgetProfile(profile.username);
                  setProfiles(knownProfiles());
                }}
              >
                ×
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="profile-tile other" onClick={() => setChosen('other')}>
              <span className="avatar large add" aria-hidden="true">
                +
              </span>
              <span>Iemand anders</span>
            </button>
          </li>
        </ul>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <Brand />
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        {chosen === 'other' ? (
          <>
            <h1>Inloggen</h1>
            <label>
              Gebruikersnaam
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                required
              />
            </label>
          </>
        ) : (
          <div className="chosen-profile">
            <Avatar name={chosen.displayName} color={chosen.avatarColor} size="large" />
            <h1>{chosen.displayName}</h1>
          </div>
        )}
        <label>
          Wachtwoord
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus={chosen !== 'other'}
            required
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button primary large" disabled={busy}>
          {busy ? 'Bezig…' : 'Inloggen'}
        </button>
        {profiles.length > 0 && (
          <button type="button" className="text-button" onClick={() => setChosen(undefined)}>
            Ander profiel
          </button>
        )}
      </form>
    </div>
  );
}

/** The first visit: make the first account, which becomes the admin. */
export function SetupPage() {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== repeat) {
      setError('De wachtwoorden zijn niet gelijk.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { user } = await api.setup({ displayName, username, password });
      rememberProfile(user);
      queryClient.setQueryData(keys.auth, { setupRequired: false, user });
    } catch (e) {
      setError(authErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <Brand />
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <h1>Welkom bij CineVault</h1>
        <p className="muted">
          Maak het eerste account. Dat wordt de beheerder: die maakt straks de accounts voor de rest
          van het huishouden.
        </p>
        <label>
          Naam
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
        <label>
          Gebruikersnaam
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </label>
        <label>
          Wachtwoord (minstens 10 tekens)
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
          Wachtwoord nog een keer
          <input
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button primary large" disabled={busy}>
          {busy ? 'Bezig…' : 'Account maken'}
        </button>
      </form>
    </div>
  );
}
