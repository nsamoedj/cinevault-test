import type { ArrServerInfo, ArrTarget, RequestsConfig } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, keys } from '../api.js';
import { ErrorBox } from '../components/common.js';
import { AdminFrame } from './AdminPage.js';

function Connection({ name, info, envKey }: { name: string; info: ArrServerInfo; envKey: string }) {
  if (!info.configured) {
    return (
      <p className="muted">
        {name} is niet gekoppeld. Zet <code>{envKey}</code> in <code>.env</code> (de API-key staat
        in {name} onder Settings → General) en start opnieuw met <code>scripts/up.sh</code>.
      </p>
    );
  }
  if (!info.ok) return <p className="form-error">{info.error}</p>;
  return <p className="muted">Verbonden{info.version ? ` met ${name} ${info.version}` : ''}.</p>;
}

function TargetFields({
  label,
  info,
  value,
  onChange,
}: {
  label: string;
  info: ArrServerInfo;
  value: ArrTarget | undefined;
  onChange: (target: ArrTarget) => void;
}) {
  if (!info.ok) return null;
  const folder = value?.rootFolderPath ?? info.rootFolders[0]?.path ?? '';
  const profile = value?.qualityProfileId ?? info.qualityProfiles[0]?.id ?? 0;
  return (
    <fieldset className="target-fields">
      <legend>{label}</legend>
      <label>
        Map
        <select
          value={folder}
          onChange={(e) => onChange({ rootFolderPath: e.target.value, qualityProfileId: profile })}
        >
          {info.rootFolders.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
              {f.freeSpace ? ` (${Math.round(f.freeSpace / 1e9)} GB vrij)` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Kwaliteit
        <select
          value={profile}
          onChange={(e) =>
            onChange({ rootFolderPath: folder, qualityProfileId: Number(e.target.value) })
          }
        >
          {info.qualityProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

/** Beheer → Verzoeken: the connections with Radarr and Sonarr, and where new titles go. */
export function RequestsAdminPage() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: keys.requestsConfig, queryFn: api.requestsConfig });
  const save = useMutation({
    mutationFn: (changes: Parameters<typeof api.setRequestsConfig>[0]) =>
      api.setRequestsConfig(changes),
    onSuccess: (saved: RequestsConfig) => queryClient.setQueryData(keys.requestsConfig, saved),
  });
  const data = config.data;
  return (
    <AdminFrame title="Verzoeken">
      {config.isError && <ErrorBox error={config.error} />}
      {save.isError && <ErrorBox error={save.error} title="Opslaan lukte niet" />}
      {data && (
        <>
          <section className="panel">
            <h2>Goedkeuren</h2>
            <label className="choice">
              <input
                type="checkbox"
                checked={data.autoApprove}
                onChange={(e) => save.mutate({ autoApprove: e.target.checked })}
              />
              Verzoeken van leden meteen naar Radarr en Sonarr sturen, zonder goedkeuring
            </label>
            <p className="muted">Verzoeken van beheerders gaan altijd meteen.</p>
          </section>
          <section className="panel">
            <h2>Radarr (films)</h2>
            <Connection name="Radarr" info={data.radarr} envKey="RADARR_API_KEY" />
            <TargetFields
              label="Nieuwe films"
              info={data.radarr}
              value={data.movies}
              onChange={(movies) => save.mutate({ movies })}
            />
          </section>
          <section className="panel">
            <h2>Sonarr (series en anime)</h2>
            <Connection name="Sonarr" info={data.sonarr} envKey="SONARR_API_KEY" />
            <TargetFields
              label="Nieuwe series"
              info={data.sonarr}
              value={data.shows}
              onChange={(shows) => save.mutate({ shows })}
            />
            <TargetFields
              label="Nieuwe anime"
              info={data.sonarr}
              value={data.anime}
              onChange={(anime) => save.mutate({ anime })}
            />
          </section>
        </>
      )}
    </AdminFrame>
  );
}
