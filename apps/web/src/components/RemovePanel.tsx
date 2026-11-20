// Removing a film or a show (admins): Radarr or Sonarr deletes it from the
// disk, and the scan afterwards drops it here.

import { ApiError, type ItemDetails, sizeLabel } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { ErrorBox } from './common.js';
import { Icon } from './Icon.js';

const RESCAN_AFTER_MS = 25_000;

export function RemovePanel({ item, onClose }: { item: ItemDetails; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const target = { scope: 'title' as const };
  const preview = useQuery({
    queryKey: ['remove', item.id, 'title'],
    queryFn: () => api.removePreview(item.id, target),
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => api.remove(item.id, target),
    onSuccess: () => {
      setTimeout(
        () => void queryClient.invalidateQueries({ queryKey: ['items'] }),
        RESCAN_AFTER_MS,
      );
    },
  });
  const data = preview.data;
  const tool = data?.service === 'radarr' ? 'Radarr' : 'Sonarr';
  const what = item.type === 'SHOW' ? 'de serie' : 'de film';

  return (
    <section className="panel remove-panel" aria-label="Verwijderen">
      <header className="section-head">
        <h2>
          <Icon name="trash" /> Verwijderen
        </h2>
        <button type="button" className="icon-button" aria-label="Sluiten" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {preview.isPending && (
        <p className="muted">Bij {item.type === 'SHOW' ? 'Sonarr' : 'Radarr'} navragen…</p>
      )}
      {preview.isError && <ErrorBox error={preview.error} />}
      {data && !remove.isSuccess && (
        <>
          <p>
            <strong>{data.label}</strong>: {tool} verwijdert {what} met{' '}
            {data.files === 1 ? '1 bestand' : `${data.files} bestanden`} (
            {sizeLabel(data.sizeBytes)}) en de map van de schijf, en volgt de titel niet meer.
          </p>
          <p className="remove-warning">Dit kan niet ongedaan worden gemaakt.</p>
          {remove.isError && (
            <p className="form-error" role="alert">
              {remove.error instanceof ApiError && remove.error.status === 502
                ? `Radarr of Sonarr gaf een fout: ${remove.error.message}`
                : remove.error.message}
            </p>
          )}
          <div className="detail-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              Annuleren
            </button>
            <button
              type="button"
              className="button remove-confirm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              <Icon name="trash" /> {data.label} verwijderen
            </button>
          </div>
        </>
      )}
      {remove.isSuccess && (
        <>
          <p>
            {tool} heeft <strong>{data?.label}</strong> verwijderd. CineVault werkt de bibliotheek
            over een halve minuut bij.
          </p>
          <div className="detail-actions">
            <button type="button" className="button primary" onClick={() => void navigate('/')}>
              Naar de startpagina
            </button>
          </div>
        </>
      )}
    </section>
  );
}
