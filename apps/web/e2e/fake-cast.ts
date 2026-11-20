// A stand-in for Google's Cast SDK (the parts CineVault uses), put on the
// page before it loads: one Chromecast "Woonkamer" that "plays" what it gets
// (its time goes up while it plays). window.__fakeCast keeps what was loaded.

export function installFakeCast() {
  type Listener = () => void;
  interface Player {
    currentTime: number;
    duration: number;
    isPaused: boolean;
    isConnected: boolean;
    playerState: string | null;
  }
  const players: Player[] = [];
  const controllers: { listeners: Set<Listener> }[] = [];
  const shared = {
    time: 0,
    paused: false,
    state: null as string | null,
    idleReason: undefined as string | undefined,
  };
  const fake = {
    loads: [] as {
      contentId: string;
      contentType: string;
      metadata: Record<string, unknown>;
      tracks: Record<string, unknown>[];
    }[],
    ended: 0,
  };
  const emitRemote = () => {
    for (const player of players) {
      player.currentTime = shared.time;
      player.isPaused = shared.paused;
      player.playerState = shared.state;
    }
    for (const controller of controllers) for (const listener of controller.listeners) listener();
  };
  setInterval(() => {
    if (shared.state === 'PLAYING') shared.time += 0.5;
    emitRemote();
  }, 500);

  let castState = 'NOT_CONNECTED';
  let session: object | null = null;
  const contextListeners = new Map<string, Set<Listener>>();
  const emit = () => {
    for (const set of contextListeners.values()) for (const listener of set) listener();
  };
  const makeSession = () => ({
    getCastDevice: () => ({ friendlyName: 'Woonkamer' }),
    getMediaSession: () => ({ playerState: shared.state, idleReason: shared.idleReason }),
    loadMedia: async (request: {
      media: {
        contentId: string;
        contentType: string;
        metadata: Record<string, unknown>;
        tracks: Record<string, unknown>[];
      };
    }) => {
      fake.loads.push({
        contentId: request.media.contentId,
        contentType: request.media.contentType,
        metadata: { ...request.media.metadata },
        tracks: request.media.tracks ?? [],
      });
      shared.time = 0;
      shared.paused = false;
      // window.__fakeCastBroken: a TV that fetches nothing and gives up (as when it doesn't reach the address).
      if ((window as unknown as { __fakeCastBroken?: boolean }).__fakeCastBroken) {
        shared.state = 'IDLE';
        shared.idleReason = 'ERROR';
        return undefined;
      }
      shared.state = 'PLAYING';
      return undefined;
    },
  });
  const context = {
    setOptions: () => {},
    addEventListener: (type: string, listener: Listener) => {
      const set = contextListeners.get(type) ?? new Set();
      set.add(listener);
      contextListeners.set(type, set);
    },
    getCastState: () => castState,
    getCurrentSession: () => session,
    requestSession: async () => {
      session = makeSession();
      castState = 'CONNECTED';
      emit();
    },
    endCurrentSession: () => {
      session = null;
      castState = 'NOT_CONNECTED';
      shared.state = 'IDLE';
      fake.ended++;
      emit();
    },
  };

  class RemotePlayer implements Player {
    currentTime = shared.time;
    duration = 0;
    isPaused = shared.paused;
    isConnected = true;
    playerState = shared.state;
    constructor() {
      players.push(this);
    }
  }
  class RemotePlayerController {
    listeners = new Set<Listener>();
    constructor(private player: Player) {
      controllers.push(this);
    }
    addEventListener(_type: string, listener: Listener) {
      this.listeners.add(listener);
    }
    removeEventListener(_type: string, listener: Listener) {
      this.listeners.delete(listener);
    }
    playOrPause() {
      shared.paused = !shared.paused;
      shared.state = shared.paused ? 'PAUSED' : 'PLAYING';
      emitRemote();
    }
    seek() {
      shared.time = this.player.currentTime;
      emitRemote();
    }
  }
  class Plain {
    [key: string]: unknown;
  }
  class MediaInfo extends Plain {
    constructor(
      public contentId: string,
      public contentType: string,
    ) {
      super();
    }
  }
  class LoadRequest extends Plain {
    constructor(public media: object) {
      super();
    }
  }
  class Track extends Plain {
    constructor(
      public trackId: number,
      public type: string,
    ) {
      super();
    }
  }
  class Image {
    constructor(public url: string) {}
  }

  const w = window as unknown as Record<string, unknown> & {
    chrome?: Record<string, unknown>;
  };
  w.__fakeCast = fake;
  w.cast = {
    framework: {
      CastContext: { getInstance: () => context },
      CastContextEventType: {
        CAST_STATE_CHANGED: 'caststatechanged',
        SESSION_STATE_CHANGED: 'sessionstatechanged',
      },
      CastState: { NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE', CONNECTED: 'CONNECTED' },
      RemotePlayer,
      RemotePlayerController,
      RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
    },
  };
  w.chrome = w.chrome ?? {};
  w.chrome.cast = {
    AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
    Image,
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
      MediaInfo,
      LoadRequest,
      Track,
      MovieMediaMetadata: Plain,
      TvShowMediaMetadata: Plain,
      TrackType: { TEXT: 'TEXT' },
      TextTrackType: { SUBTITLES: 'SUBTITLES' },
      StreamType: { BUFFERED: 'BUFFERED' },
      HlsSegmentFormat: { FMP4: 'fmp4' },
      HlsVideoSegmentFormat: { FMP4: 'fmp4' },
    },
  };
}
