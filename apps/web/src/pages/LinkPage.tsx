// /link?code=…: the page the TV's QR code opens on a phone. Whoever is signed
// in here confirms the code, and the TV logs in as them.

import { ApiError } from '@cinevault/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { Icon } from '../components/Icon.js';

const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

function problem(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'Deze code bestaat niet (meer). Kies op de tv opnieuw "Inloggen met je telefoon".';
  }
  if (error instanceof ApiError && error.status === 409) return 'Deze code is al gebruikt.';
  return error instanceof Error ? error.message : String(error);
}

export function LinkPage() {
  const { user } = useAuth();
  const name = user?.displayName ?? 'jou';
  const [params, setParams] = useSearchParams();
  const code = normalize(params.get('code') ?? '');
  const [typed, setTyped] = useState(code);
  const ready = code.length === 8;

  const info = useQuery({
    queryKey: ['device-login', code],
    queryFn: () => api.deviceLogin(code),
    enabled: ready,
    retry: false,
  });
  const approve = useMutation({ mutationFn: () => api.approveDeviceLogin(code) });

  function submit(event: FormEvent) {
    event.preventDefault();
    approve.reset();
    setParams({ code: normalize(typed) });
  }

  return (
    <div className="page narrow link-page">
      <h1>Inloggen op de tv</h1>
      {approve.isSuccess ? (
        <div className="panel">
          <p className="link-done">
            <Icon name="check" /> Klaar. De tv is ingelogd als {name}.
          </p>
          <Link to="/" className="button secondary">
            Naar de startpagina
          </Link>
        </div>
      ) : (
        <>
          <form className="panel" onSubmit={submit}>
            <label>
              De code op de tv
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="BCDF-2345"
                autoCapitalize="characters"
                autoComplete="off"
                inputMode="text"
                maxLength={12}
                className="code-input"
              />
            </label>
            {!ready && (
              <button
                type="submit"
                className="button primary"
                disabled={normalize(typed).length !== 8}
              >
                Verder
              </button>
            )}
          </form>
          {ready && info.isPending && <p className="muted">Even kijken…</p>}
          {ready && info.isError && (
            <p className="form-error" role="alert">
              {problem(info.error)}
            </p>
          )}
          {info.data && (
            <div className="panel">
              <p>
                <strong>{info.data.deviceName}</strong> vraagt om in te loggen met code{' '}
                <strong>{info.data.code}</strong>.
              </p>
              <button
                type="button"
                className="button primary"
                disabled={approve.isPending || info.data.approved}
                onClick={() => approve.mutate()}
              >
                Inloggen als {name}
              </button>
              {approve.isError && (
                <p className="form-error" role="alert">
                  {problem(approve.error)}
                </p>
              )}
              <p className="muted small">
                Is dit niet jouw profiel? Kies eerst onder je profiel &quot;Ander profiel&quot; en
                log in als jezelf. Alleen een tv waar je zelf voor staat, moet je zo inloggen.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
