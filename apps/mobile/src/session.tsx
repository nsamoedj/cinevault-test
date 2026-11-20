// Who is signed in, and to which server. The server address and the login
// token are kept in SecureStore (the Android Keystore); the profiles that
// signed in on this phone are remembered for "Wie kijkt er?" (names only).
//
// A server can have two addresses: at home (192.168.0.110:8765) and the domain
// (cine-vault.nl). The app uses the first that answers, at start, when it
// comes back to the front, and when a request finds no server; the login
// works on both.

import { createApiClient, type UserDto } from '@cinevault/shared';
import { useQueryClient } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { normalizeServer, pickServer, readServers, withReadTimeout } from './server';
import { forgetPhoneNotifications } from './notifications/phone';
import { NOTIFY_SEEN_KEY, SERVER_KEY, SERVERS_KEY, TOKEN_KEY } from './storageKeys';

export { normalizeServer };
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

/** Not more often than this, however many requests fail at once. */
const RECHECK_MS = 5_000;
/** When the addresses were last tried (one session per app). */
let lastCheck = 0;

const PROFILES_KEY = 'cinevault.profiles';

export interface KnownProfile {
  username: string;
  displayName: string;
  avatarColor?: string;
}

export type Api = ReturnType<typeof createApiClient>;

interface SessionValue {
  /** False until the stored server and token are read. */
  ready: boolean;
  /** The address in use now. */
  server?: string;
  /** All addresses of the server, home first. */
  servers: string[];
  token?: string;
  user?: UserDto;
  /** The server didn't answer while checking the login (e.g. Tailscale off). */
  unreachable: boolean;
  retry: () => void;
  profiles: KnownProfile[];
  api: Api;
  /** Headers for images and video, which load outside the API client. */
  authHeaders: Record<string, string>;
  /** Another server (or none): starts at the login again. */
  setServer: (server: string | string[] | undefined) => Promise<void>;
  /** The addresses of the same server, home first; the login stays. */
  setAddresses: (servers: string[]) => Promise<void>;
  /** Looks again which address answers (e.g. after leaving home). */
  recheck: () => void;
  signedIn: (token: string, user: UserDto) => Promise<void>;
  updateUser: (user: UserDto) => void;
  signOut: () => Promise<void>;
  forgetProfile: (username: string) => Promise<void>;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

function readProfiles(text: string | null): KnownProfile[] {
  try {
    const list = JSON.parse(text ?? '[]') as KnownProfile[];
    return Array.isArray(list) ? list.filter((p) => typeof p.username === 'string') : [];
  } catch {
    return [];
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const queryClient = useQueryClient();
  const [server, setServerState] = useState<string>();
  const [servers, setServersState] = useState<string[]>([]);
  const [token, setToken] = useState<string>();
  const [user, setUser] = useState<UserDto>();
  const [profiles, setProfiles] = useState<KnownProfile[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void (async () => {
      const [storedServer, storedServers, storedToken, storedProfiles] = await Promise.all([
        SecureStore.getItemAsync(SERVER_KEY),
        SecureStore.getItemAsync(SERVERS_KEY),
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(PROFILES_KEY),
      ]);
      const list = readServers(storedServers, storedServer);
      // Two addresses: which one answers, before the first request goes out
      // (at most PICK_TIMEOUT_MS). The one used last may not be there now
      // (the home address on mobile data), and a request to it hangs for
      // minutes; Home would wait for it.
      let active = storedServer ?? undefined;
      if (list.length > 1) {
        lastCheck = Date.now();
        const found = await pickServer(list);
        if (found && found !== active) {
          active = found;
          void SecureStore.setItemAsync(SERVER_KEY, found);
        }
      }
      setServerState(active);
      setServersState(list);
      setToken(storedToken ?? undefined);
      setProfiles(readProfiles(storedProfiles));
      setReady(true);
    })();
  }, []);

  const clearLogin = useCallback(async () => {
    setToken(undefined);
    setUser(undefined);
    // What this profile saw (Verder kijken, Mijn lijst, titles above a kid's age) goes with it.
    queryClient.clear();
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    // The notification service stops too: it used this login.
    forgetPhoneNotifications();
  }, [queryClient]);

  // Which address answers: home first, else the domain.
  const recheck = useCallback(() => {
    if (servers.length < 2 || Date.now() - lastCheck < RECHECK_MS) return;
    lastCheck = Date.now();
    void pickServer(servers).then((found) => {
      if (!found) return;
      setServerState((current) => (current === found ? current : found));
      void SecureStore.setItemAsync(SERVER_KEY, found);
    });
  }, [servers]);

  // At start, and each time the app comes back to the front (maybe elsewhere now).
  useEffect(() => {
    if (!ready || servers.length < 2) return;
    recheck();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') recheck();
    });
    return () => subscription.remove();
  }, [ready, servers, recheck]);

  // On another address, what was loaded is asked again there.
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previous.current && server && previous.current !== server) {
      // What still waits for the old address is dropped first: a query
      // without data (Home at the start) would otherwise keep waiting for it.
      void queryClient.cancelQueries().then(() => queryClient.invalidateQueries());
    }
    previous.current = server;
  }, [server, queryClient]);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: server ?? '',
        // No server at this address (left home, Wi-Fi off): try the other one.
        fetch: (input, init) =>
          fetch(input, withReadTimeout(init)).catch((error: unknown) => {
            recheck();
            throw error;
          }),
        token: () => token,
        // The login ended (logged out elsewhere, new password): back to "Wie kijkt er?".
        onUnauthorized: () => void clearLogin(),
      }),
    [server, token, clearLogin, recheck],
  );

  // Who the token belongs to (also checks that it still works).
  useEffect(() => {
    if (!ready || !server || !token || user) return;
    let cancelled = false;
    api.me().then(
      (me) => {
        if (cancelled) return;
        setUnreachable(false);
        setUser(me);
      },
      (error: unknown) => {
        // 401 is handled by onUnauthorized; anything else: the server is away.
        const status = (error as { status?: number }).status;
        if (!cancelled && status !== 401) setUnreachable(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, server, token, user, api, attempt]);

  // Not reachable at the start (Wi-Fi or Tailscale not up yet): ask again, so
  // that the profile (admin, kids) is known without restarting the app.
  useEffect(() => {
    if (!unreachable) return;
    const timer = setInterval(() => setAttempt((n) => n + 1), 15_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setAttempt((n) => n + 1);
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [unreachable]);

  const retry = useCallback(() => {
    setUnreachable(false);
    lastCheck = 0;
    recheck();
    setAttempt((n) => n + 1);
  }, [recheck]);

  const saveAddresses = useCallback(async (list: string[], active: string | undefined) => {
    setServersState(list);
    setServerState(active);
    if (active) await SecureStore.setItemAsync(SERVER_KEY, active);
    else await SecureStore.deleteItemAsync(SERVER_KEY);
    if (list.length > 0) await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(list));
    else await SecureStore.deleteItemAsync(SERVERS_KEY);
  }, []);

  const setServer = useCallback(
    async (next: string | string[] | undefined) => {
      await clearLogin();
      const list = next === undefined ? [] : Array.isArray(next) ? next : [next];
      await saveAddresses(list, (await pickServer(list)) ?? list[0]);
    },
    [clearLogin, saveAddresses],
  );

  const setAddresses = useCallback(
    async (list: string[]) => {
      lastCheck = 0;
      await saveAddresses(list, (await pickServer(list)) ?? server ?? list[0]);
    },
    [saveAddresses, server],
  );

  const remember = useCallback(async (person: UserDto) => {
    const profile: KnownProfile = {
      username: person.username,
      displayName: person.displayName,
      ...(person.avatarColor && { avatarColor: person.avatarColor }),
    };
    const next = [
      profile,
      ...readProfiles(await SecureStore.getItemAsync(PROFILES_KEY)).filter(
        (p) => p.username !== person.username,
      ),
    ].slice(0, 8);
    setProfiles(next);
    await SecureStore.setItemAsync(PROFILES_KEY, JSON.stringify(next));
  }, []);

  const signedIn = useCallback(
    async (nextToken: string, person: UserDto) => {
      queryClient.clear();
      setToken(nextToken);
      setUser(person);
      await SecureStore.setItemAsync(TOKEN_KEY, nextToken);
      // Notifications start again for this person: their old ones don't pop up.
      await SecureStore.deleteItemAsync(NOTIFY_SEEN_KEY);
      await remember(person);
    },
    [remember, queryClient],
  );

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    await clearLogin();
  }, [api, clearLogin]);

  const forgetProfile = useCallback(async (username: string) => {
    const next = readProfiles(await SecureStore.getItemAsync(PROFILES_KEY)).filter(
      (p) => p.username !== username,
    );
    setProfiles(next);
    await SecureStore.setItemAsync(PROFILES_KEY, JSON.stringify(next));
  }, []);

  const authHeaders = useMemo<Record<string, string>>(
    (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      ...(server && { server }),
      servers,
      ...(token && { token }),
      ...(user && { user }),
      unreachable,
      retry,
      profiles,
      api,
      authHeaders,
      setServer,
      setAddresses,
      recheck,
      signedIn,
      updateUser: setUser,
      signOut,
      forgetProfile,
    }),
    [
      ready,
      server,
      servers,
      token,
      user,
      unreachable,
      retry,
      profiles,
      api,
      authHeaders,
      setServer,
      setAddresses,
      recheck,
      signedIn,
      signOut,
      forgetProfile,
    ],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
