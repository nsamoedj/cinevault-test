// What the app keeps in SecureStore, shared with the background task (which
// runs without the screens).

/** The address in use now (the one that answered last). */
export const SERVER_KEY = 'cinevault.server';
/** All addresses of the server, home first (JSON list): the app picks the one that answers. */
export const SERVERS_KEY = 'cinevault.servers';
export const TOKEN_KEY = 'cinevault.token';
/** The notification ids already shown on this phone (JSON). */
export const NOTIFY_SEEN_KEY = 'cinevault.notify.seen';
