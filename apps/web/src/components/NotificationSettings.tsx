import type { NotificationSettings } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, keys } from '../api.js';
import { useAuth } from '../auth.js';
import { disablePush, enablePush, type PushState, pushState } from '../push.js';
import { ErrorBox } from './common.js';

const TOGGLES: { key: keyof NotificationSettings; label: string; admin?: boolean }[] = [
  {
    key: 'newEpisodes',
    label: 'Nieuwe afleveringen van series die je volgt (in Mijn lijst, of waar je in kijkt)',
  },
  { key: 'airing', label: 'De dag dat een nieuwe aflevering van zo’n serie uitkomt' },
  { key: 'recommended', label: 'Nieuwe films en series die passen bij wat je keek' },
  { key: 'newLogin', label: 'Een nieuwe login op je account' },
  { key: 'requests', label: 'Je verzoeken: goedgekeurd, afgewezen of klaar om te kijken' },
  {
    key: 'admin',
    label:
      'Beheer: nieuwe verzoeken, titels zonder match, en een transcoder die niet bereikbaar is',
    admin: true,
  },
  {
    key: 'quietHours',
    label: 'Stille uren: tussen 23:00 en 08:00 wachten meldingen tot de ochtend',
  },
];

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: 'Deze browser kan geen meldingen ontvangen.',
  insecure:
    'Meldingen in de browser werken alleen via https:// (bijvoorbeeld https://cine-vault.nl). Via dit adres zie je ze onder het belletje.',
  denied:
    'Je hebt meldingen voor CineVault in deze browser geblokkeerd. Sta ze toe in de instellingen van de browser.',
  off: 'Krijg meldingen ook als CineVault niet open is.',
  on: 'Deze browser krijgt meldingen, ook als CineVault niet open is.',
};

/** Which notifications this profile gets, and push in this browser. */
export function NotificationSettingsPanel() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: keys.notificationSettings,
    queryFn: api.notificationSettings,
  });
  const save = useMutation({
    mutationFn: (changes: Partial<NotificationSettings>) => api.setNotificationSettings(changes),
    onSuccess: (saved) => queryClient.setQueryData(keys.notificationSettings, saved),
    onSettled: () => setChanged({}),
  });
  const test = useMutation({
    mutationFn: api.testNotification,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.notifications }),
  });
  // What was just clicked, until the server answers: the box changes at once.
  const [changed, setChanged] = useState<Partial<NotificationSettings>>({});
  const [push, setPush] = useState<PushState>();
  const [pushError, setPushError] = useState<unknown>();

  useEffect(() => {
    let alive = true;
    void Promise.resolve(pushState()).then((state) => {
      if (alive) setPush(state);
    });
    return () => {
      alive = false;
    };
  }, []);

  const togglePush = async () => {
    setPushError(undefined);
    try {
      setPush(push === 'on' ? await disablePush() : await enablePush());
    } catch (error) {
      setPushError(error);
    }
  };

  return (
    <section className="panel" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading">Meldingen</h2>
      {settings.isError && <ErrorBox error={settings.error} />}
      {settings.data && (
        <div className="choice-list plain">
          {TOGGLES.filter((t) => !t.admin || isAdmin).map((toggle) => (
            <label key={toggle.key} className="choice">
              <input
                type="checkbox"
                checked={changed[toggle.key] ?? settings.data[toggle.key]}
                onChange={(e) => {
                  const change = { [toggle.key]: e.target.checked };
                  setChanged((c) => ({ ...c, ...change }));
                  save.mutate(change);
                }}
              />
              {toggle.label}
            </label>
          ))}
        </div>
      )}
      <h3>In deze browser</h3>
      {push && <p className="muted">{PUSH_TEXT[push]}</p>}
      {pushError ? <ErrorBox error={pushError} title="Aanzetten lukte niet" /> : null}
      <div className="button-row">
        {(push === 'on' || push === 'off') && (
          <button type="button" className="button glass" onClick={() => void togglePush()}>
            {push === 'on' ? 'Meldingen in deze browser uit' : 'Meldingen in deze browser aan'}
          </button>
        )}
        <button
          type="button"
          className="button glass"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          Stuur een testmelding
        </button>
      </div>
      {test.isSuccess && <p role="status">Verstuurd. Kijk onder het belletje.</p>}
    </section>
  );
}
