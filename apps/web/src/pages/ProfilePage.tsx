import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, keys } from '../api.js';
import { useAuth } from '../auth.js';
import { Avatar } from '../components/Avatar.js';
import { NotificationSettingsPanel } from '../components/NotificationSettings.js';
import { looksLikeTv, setTvSetting, type TvSetting, tvSetting } from '../device.js';
import { saveThemeMusic, savedThemeMusic, type ThemeMusicSettings } from '../themeMusic.js';
import type { CastQuality, SkipSettings } from '@cinevault/shared';
import { castPossible, saveCastQuality, savedCastQuality } from '../cast.js';
import { authErrorText } from './LoginPage.js';

const COLORS = ['#E0B04F', '#4F9DE0', '#E06C4F', '#5FBF7F', '#B07FE0', '#E04F8F'];

/** The 10-foot layout for TVs: automatic, or forced on this device. */
function DisplaySetting() {
  const [value, setValue] = useState<TvSetting>(tvSetting);
  const choose = (next: TvSetting) => {
    setValue(next);
    setTvSetting(next);
  };
  const options: [TvSetting, string][] = [
    ['auto', `Automatisch (${looksLikeTv() ? 'tv herkend' : 'geen tv herkend'})`],
    ['on', 'Tv-weergave: grotere tekst, bediening met de afstandsbediening'],
    ['off', 'Gewone weergave'],
  ];
  return (
    <fieldset className="panel choice-list">
      <legend>Weergave op dit apparaat</legend>
      {options.map(([id, label]) => (
        <label key={id} className="choice">
          <input type="radio" name="display" checked={value === id} onChange={() => choose(id)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/** Theme music on the page of a show: on or off, and how loud, on this device. */
function ThemeMusicSetting() {
  const [value, setValue] = useState<ThemeMusicSettings>(savedThemeMusic);
  const change = (next: ThemeMusicSettings) => {
    setValue(next);
    saveThemeMusic(next);
  };
  return (
    <fieldset className="panel choice-list">
      <legend>Themamuziek op dit apparaat</legend>
      <label className="choice">
        <input
          type="checkbox"
          checked={value.on}
          onChange={(e) => change({ ...value, on: e.target.checked })}
        />
        Speel zacht de titelmuziek (van Plex) op de pagina van een serie
      </label>
      <label className="theme-volume">
        Volume
        <input
          type="range"
          min={5}
          max={100}
          step={5}
          disabled={!value.on}
          value={Math.round(value.volume * 100)}
          onChange={(e) => change({ ...value, volume: Number(e.target.value) / 100 })}
          aria-valuetext={`${Math.round(value.volume * 100)}%`}
        />
        <span className="muted">{Math.round(value.volume * 100)}%</span>
      </label>
    </fieldset>
  );
}

/** What the players skip by themselves for this profile (on every device). */
function SkipSetting() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: keys.skipSettings, queryFn: () => api.skipSettings() });
  const save = useMutation({
    mutationFn: (change: Partial<SkipSettings>) => api.setSkipSettings(change),
    onSuccess: (next) => queryClient.setQueryData(keys.skipSettings, next),
  });
  const options: [keyof SkipSettings, string][] = [
    ['intro', 'De intro'],
    ['recap', 'De recap ("Previously on…")'],
    ['credits', 'De aftiteling: de volgende aflevering begint meteen'],
    ['preview', 'De preview van de volgende aflevering'],
  ];
  if (!settings.data) return null;
  const value =
    save.isPending && save.variables ? { ...settings.data, ...save.variables } : settings.data;
  return (
    <fieldset className="panel choice-list">
      <legend>Automatisch overslaan</legend>
      {options.map(([kind, label]) => (
        <label key={kind} className="choice">
          <input
            type="checkbox"
            checked={value[kind]}
            onChange={(e) => save.mutate({ [kind]: e.target.checked })}
          />
          {label}
        </label>
      ))}
      <p className="muted small">
        Voor dit profiel, in elke speler. Spoel je terug, dan zie je de knop weer.
      </p>
    </fieldset>
  );
}

/** What a Chromecast gets from this browser: the browser can't ask which model it is. */
function CastSetting() {
  const [value, setValue] = useState<CastQuality>(savedCastQuality);
  if (!castPossible()) return null;
  const choose = (next: CastQuality) => {
    setValue(next);
    saveCastQuality(next);
  };
  const options: [CastQuality, string][] = [
    ['auto', 'Automatisch (1080p, tenzij de Chromecast als 4K bekendstaat)'],
    ['4k', '4K (Chromecast Ultra, Chromecast met Google TV 4K)'],
    ['1080p', '1080p (andere Chromecasts)'],
  ];
  return (
    <fieldset className="panel choice-list">
      <legend>Casten naar een Chromecast</legend>
      {options.map(([id, label]) => (
        <label key={id} className="choice">
          <input type="radio" name="cast" checked={value === id} onChange={() => choose(id)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/** Your own name, colour and password. */
export function ProfilePage() {
  const { user, signedIn } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  if (!user) return null;

  async function save(changes: Parameters<typeof api.updateMe>[0], done: string) {
    setError(undefined);
    setMessage(undefined);
    try {
      signedIn(await api.updateMe(changes));
      setMessage(done);
    } catch (e) {
      setError(
        /current password/.test(String(e)) ? 'Je huidige wachtwoord klopt niet.' : authErrorText(e),
      );
    }
  }

  function saveName(event: FormEvent) {
    event.preventDefault();
    void save({ displayName }, 'Naam opgeslagen.');
  }

  function savePassword(event: FormEvent) {
    event.preventDefault();
    void save(
      { password: next, currentPassword: current },
      'Wachtwoord gewijzigd. Je andere apparaten zijn uitgelogd.',
    ).then(() => {
      setCurrent('');
      setNext('');
    });
  }

  return (
    <div className="page narrow">
      <div className="profile-header">
        <Avatar name={user.displayName} color={user.avatarColor} size="large" />
        <div>
          <h1>{user.displayName}</h1>
          <p className="muted">
            {user.username} · {user.role === 'ADMIN' ? 'Beheerder' : 'Lid'}
          </p>
        </div>
      </div>

      {message && <p role="status">{message}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <form className="panel" onSubmit={saveName}>
        <h2>Naam en kleur</h2>
        <label>
          Naam
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
        <div className="color-choice" role="group" aria-label="Kleur">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`swatch${user.avatarColor === color ? ' chosen' : ''}`}
              style={{ background: color }}
              aria-label={`Kleur ${color}`}
              aria-pressed={user.avatarColor === color}
              onClick={() => void save({ avatarColor: color }, 'Kleur opgeslagen.')}
            />
          ))}
        </div>
        <button type="submit" className="button primary">
          Opslaan
        </button>
      </form>

      <form className="panel" onSubmit={savePassword}>
        <h2>Wachtwoord</h2>
        <label>
          Huidig wachtwoord
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          Nieuw wachtwoord (minstens 10 tekens)
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </label>
        <button type="submit" className="button primary">
          Wachtwoord wijzigen
        </button>
      </form>

      <NotificationSettingsPanel />

      <SkipSetting />
      <ThemeMusicSetting />
      <CastSetting />

      <DisplaySetting />
    </div>
  );
}
