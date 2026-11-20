// The skip buttons of the players (phone, tablet, car, TV, the Chromecast
// remote): which one shows (skipChoice in packages/shared), for 8 s when its
// part starts and after that with the controls, and what this profile skips
// by itself (SkipSettings, kept on the server for every device).

import { autoSkip, SKIP_BUTTON_MS, type SkipParts, type SkipSettings } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { keys } from '../keys';
import { forgetDeviceAutoSkip } from '../preferences';
import { useSession } from '../session';

/** autoSkip in render: what was skipped already is checked in the effect (a ref). */
const NOTHING_SKIPPED: ReadonlySet<string> = new Set();

/**
 * This profile's SkipSettings, from the file (FileContext.skip), and
 * changing them. "Intro automatisch overslaan" used to be per device: on
 * this device that moves to the profile, once.
 */
export function useSkipSettings(
  initial: SkipSettings | undefined,
): [SkipSettings | undefined, (change: Partial<SkipSettings>) => void] {
  const { api } = useSession();
  const [settings, setSettings] = useState(initial);
  useEffect(() => {
    if (initial && !initial.intro && forgetDeviceAutoSkip()) {
      void api.setSkipSettings({ intro: true }).then(setSettings, () => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const change = useCallback(
    (next: Partial<SkipSettings>) => {
      setSettings((current) => current && { ...current, ...next });
      void api.setSkipSettings(next).then(setSettings, () => {});
    },
    [api],
  );
  return [settings, change];
}

/** True for SKIP_BUTTON_MS after the button for `key` (a part) appears. */
export function useSkipFresh(key: string | undefined): boolean {
  const [expired, setExpired] = useState<string | undefined>();
  const fresh = key !== undefined && key !== expired;
  useEffect(() => {
    if (!fresh) return;
    const timer = setTimeout(() => setExpired(key), SKIP_BUTTON_MS);
    return () => clearTimeout(timer);
  }, [fresh, key]);
  return fresh;
}

/**
 * Skips by itself what the profile chose: past the part, or (the credits,
 * with a next episode) to that episode. Once per part per play.
 */
export function useAutoSkip(
  parts: SkipParts,
  position: number,
  duration: number,
  hasNext: boolean,
  settings: SkipSettings | undefined,
  actions: { seek: (seconds: number) => void; playNext: () => void },
): void {
  const done = useRef(new Set<string>());
  const action = autoSkip(parts, position, duration, hasNext, settings, NOTHING_SKIPPED);
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    if (!action || done.current.has(action.key)) return;
    done.current.add(action.key);
    const { next, to } = action;
    // Out of the effect: seeking starts a new stream (state).
    const timer = setTimeout(() => {
      if (next) latest.current.playNext();
      else if (to !== undefined) latest.current.seek(to);
    }, 0);
    return () => clearTimeout(timer);
  }, [action?.key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** "Automatisch overslaan" under Profiel: the profile's SkipSettings, and changing one. */
export function useProfileSkipSettings(): {
  settings: SkipSettings | undefined;
  toggle: (kind: keyof SkipSettings) => void;
} {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: keys.skipSettings, queryFn: () => api.skipSettings() });
  const save = useMutation({
    mutationFn: (change: Partial<SkipSettings>) => api.setSkipSettings(change),
    onSuccess: (next) => queryClient.setQueryData(keys.skipSettings, next),
  });
  const settings =
    query.data && save.isPending && save.variables
      ? { ...query.data, ...save.variables }
      : query.data;
  return {
    settings,
    toggle: (kind) => settings && save.mutate({ [kind]: !settings[kind] }),
  };
}

/** The parts under "Automatisch overslaan", in words. */
export const SKIP_LABELS: { kind: keyof SkipSettings; label: string }[] = [
  { kind: 'intro', label: 'De intro' },
  { kind: 'recap', label: 'De recap ("Previously on…")' },
  { kind: 'credits', label: 'De aftiteling: de volgende aflevering begint meteen' },
  { kind: 'preview', label: 'De preview van de volgende aflevering' },
];
