import { createApiClient } from '@cinevault/shared';

let unauthorized: () => void = () => {};

/** What to do when the server says the login is gone (expired, logged out elsewhere). */
export function onUnauthorized(handler: () => void): void {
  unauthorized = handler;
}

/** Same origin: in Docker, Caddy serves the app and forwards /api. The login travels as a cookie. */
export const api = createApiClient({ onUnauthorized: () => unauthorized() });

export const keys = {
  libraries: ['libraries'] as const,
  // Everything with progress on it starts with "items", so one invalidation refreshes it all.
  items: (libraryId: string, search: string, sort: string, genre: string) =>
    ['items', libraryId, search, sort, genre] as const,
  home: ['items', 'home'] as const,
  search: (q: string) => ['items', 'search', q] as const,
  genres: (libraryId: string) => ['genres', libraryId] as const,
  attention: (libraryId: string, status: string) => ['items', libraryId, 'status', status] as const,
  item: (id: string) => ['item', id] as const,
  similar: (id: string) => ['items', 'similar', id] as const,
  collections: ['items', 'collections'] as const,
  collection: (id: number) => ['items', 'collections', id] as const,
  file: (id: string) => ['file', id] as const,
  intro: (fileId: string) => ['intro', fileId] as const,
  /** Admins: with the parts too uncertain for the players. */
  introAll: (fileId: string) => ['intro', fileId, 'all'] as const,
  seasonMarkers: (seasonId: string) => ['season-markers', seasonId] as const,
  skipSettings: ['skip-settings'] as const,
  theme: (itemId: string) => ['theme', itemId] as const,
  thumbnails: (fileId: string) => ['thumbnails', fileId] as const,
  candidates: (id: string, title: string, year?: number) =>
    ['candidates', id, title, year] as const,
  scan: ['scan'] as const,
  codecStats: ['codecStats'] as const,
  introStatus: ['introStatus'] as const,
  themeStatus: ['themeStatus'] as const,
  health: ['health'] as const,
  auth: ['auth'] as const,
  users: ['users'] as const,
  continue: ['continue'] as const,
  myList: ['items', 'my-list'] as const,
  calendar: (scope: string) => ['calendar', scope] as const,
  calendarLink: ['calendar-link'] as const,
  notifications: ['notifications'] as const,
  requests: ['requests'] as const,
  requestsConfig: ['requests', 'config'] as const,
  notificationSettings: ['notifications', 'settings'] as const,
  subtitles: (fileId: string) => ['subtitles', fileId] as const,
};
