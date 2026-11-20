// Who is signed in, for the whole app. The login itself is an httpOnly
// cookie the browser sends along; this only keeps the account details.

import type { UserDto } from '@cinevault/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';
import { api, keys, onUnauthorized } from './api.js';

const PROFILES_KEY = 'cinevault.profiles';

/** Profiles that signed in on this device, for "Wie kijkt er?". Names only, no secrets. */
export interface KnownProfile {
  username: string;
  displayName: string;
  avatarColor?: string;
}

export function knownProfiles(): KnownProfile[] {
  try {
    const list = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '[]') as KnownProfile[];
    return Array.isArray(list) ? list.filter((p) => typeof p.username === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberProfile(user: UserDto): void {
  const profile: KnownProfile = {
    username: user.username,
    displayName: user.displayName,
    ...(user.avatarColor && { avatarColor: user.avatarColor }),
  };
  const list = [profile, ...knownProfiles().filter((p) => p.username !== user.username)].slice(
    0,
    8,
  );
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(list));
  } catch {
    // Not remembered; the name can be typed.
  }
}

export function forgetProfile(username: string): void {
  try {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify(knownProfiles().filter((p) => p.username !== username)),
    );
  } catch {
    // Nothing stored anyway.
  }
}

interface AuthContextValue {
  user?: UserDto;
  isAdmin: boolean;
  /** A kids profile (an age limit): no Ontdekken or requests. */
  isKid: boolean;
  /** After logging in or changing your profile. */
  signedIn: (user: UserDto) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  isAdmin: false,
  isKid: false,
  signedIn: () => {},
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function useAuthStatus() {
  return useQuery({ queryKey: keys.auth, queryFn: api.authStatus, staleTime: 5 * 60_000 });
}

export function AuthProvider({ user, children }: { user: UserDto; children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    // A login that ended elsewhere: back to "Wie kijkt er?".
    onUnauthorized(() => void queryClient.invalidateQueries({ queryKey: keys.auth }));
    return () => onUnauthorized(() => {});
  }, [queryClient]);

  const signedIn = useCallback(
    (next: UserDto) => {
      rememberProfile(next);
      queryClient.setQueryData(keys.auth, { setupRequired: false, user: next });
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    // Nothing of this profile may show for the next one. (The auth query
    // stays: the app is subscribed to it and switches to the login screen.)
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.auth[0] });
    queryClient.setQueryData(keys.auth, { setupRequired: false });
  }, [queryClient]);

  const value = useMemo(
    () => ({
      user,
      isAdmin: user.role === 'ADMIN',
      isKid: user.maxAge !== undefined,
      signedIn,
      logout,
    }),
    [user, signedIn, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
