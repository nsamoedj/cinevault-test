// Query keys; everything with progress on it starts with "items", so one
// invalidation refreshes it all (as in the web app).

export const keys = {
  libraries: ['libraries'] as const,
  home: ['items', 'home'] as const,
  continue: ['continue'] as const,
  items: (libraryId: string, sort: string, genre: string) =>
    ['items', libraryId, sort, genre] as const,
  genres: (libraryId: string) => ['genres', libraryId] as const,
  search: (q: string) => ['items', 'search', q] as const,
  item: (id: string) => ['item', id] as const,
  similar: (id: string) => ['items', 'similar', id] as const,
  myList: ['items', 'my-list'] as const,
  collections: ['items', 'collections'] as const,
  collection: (id: number) => ['items', 'collections', id] as const,
  calendar: (scope: string) => ['calendar', scope] as const,
  calendarLink: ['calendar-link'] as const,
  notifications: ['notifications'] as const,
  requests: ['requests'] as const,
  users: ['users'] as const,
  downloads: ['downloads'] as const,
  notificationSettings: ['notifications', 'settings'] as const,
  file: (id: string) => ['file', id] as const,
  subtitles: (fileId: string) => ['subtitles', fileId] as const,
  picture: (fileId: string) => ['picture', fileId] as const,
  intro: (fileId: string) => ['intro', fileId] as const,
  /** Admins: with the parts too uncertain for the players. */
  introAll: (fileId: string) => ['intro', fileId, 'all'] as const,
  seasonMarkers: (seasonId: string) => ['season-markers', seasonId] as const,
  skipSettings: ['skip-settings'] as const,
  theme: (itemId: string) => ['theme', itemId] as const,
  thumbnails: (fileId: string) => ['thumbnails', fileId] as const,
  scan: ['scan'] as const,
  codecStats: ['codec-stats'] as const,
  introStatus: ['intro-status'] as const,
  themeStatus: ['theme-status'] as const,
  health: ['health'] as const,
  attention: (libraryId: string, status: string) =>
    ['items', 'attention', libraryId, status] as const,
  candidates: (id: string, title: string, year?: number) =>
    ['candidates', id, title, year ?? null] as const,
  requestsConfig: ['requests-config'] as const,
};
