// Database rows → API response shapes (@cinevault/shared).

import type {
  AudioTrack,
  CastMemberDto,
  EpisodeDto,
  HdrFormat,
  ItemDetails,
  ItemSummary,
  MatchCandidate,
  MediaFileDto,
  SeasonDto,
  SubtitleTrack,
} from '@cinevault/shared';
import type { Episode, MediaFile, MediaItem, Season } from './generated/prisma/client.js';
import { imageUrl } from './images.js';
import type { Candidate, CastMember } from './metadata/types.js';

type Optional<T> = { [K in keyof T]?: T[K] };

/** Drops null/undefined values so optional fields are absent rather than null. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined),
  ) as T;
}

export function toItemSummary(item: MediaItem): ItemSummary {
  return compact({
    id: item.id,
    libraryId: item.libraryId,
    type: item.type,
    title: item.title,
    year: item.year ?? undefined,
    posterUrl: imageUrl(item.posterPath),
    backdropUrl: imageUrl(item.backdropPath),
    overview: item.overview ?? undefined,
    rating: item.rating ?? undefined,
    genres: item.genres.length > 0 ? item.genres : undefined,
    logoUrl: imageUrl(item.logoPath),
    runtimeMinutes: item.runtimeMinutes ?? undefined,
    ageRating: item.ageRating ?? undefined,
    metadataStatus: item.metadataStatus,
    metadataError: item.metadataError ?? undefined,
  });
}

export function toFileDto(file: MediaFile): MediaFileDto {
  return compact({
    id: file.id,
    path: file.path,
    size: Number(file.size),
    container: file.container ?? undefined,
    videoCodec: file.videoCodec ?? undefined,
    width: file.width ?? undefined,
    height: file.height ?? undefined,
    bitDepth: file.bitDepth ?? undefined,
    hdrFormat: (file.hdrFormat as HdrFormat | null) ?? undefined,
    dvProfile: file.dvProfile ?? undefined,
    dvCompatibility: file.dvCompatibility ?? undefined,
    durationMs: file.durationMs ?? undefined,
    bitrate: file.bitrate ?? undefined,
    audioTracks: file.audioTracks as unknown as AudioTrack[],
    subtitleTracks: file.subtitleTracks as unknown as SubtitleTrack[],
    probeError: file.probeError ?? undefined,
  });
}

type EpisodeRow = Episode & { files: MediaFile[] };
type SeasonRow = Season & { episodes: EpisodeRow[] };
export type ItemRow = MediaItem & { files: MediaFile[]; seasons: SeasonRow[] };

function toEpisodeDto(episode: EpisodeRow): EpisodeDto {
  return compact({
    id: episode.id,
    episodeNumber: episode.episodeNumber,
    absoluteNumber: episode.absoluteNumber ?? undefined,
    title: episode.title ?? undefined,
    overview: episode.overview ?? undefined,
    airDate: episode.airDate?.toISOString().slice(0, 10),
    runtimeMinutes: episode.runtimeMinutes ?? undefined,
    stillUrl: imageUrl(episode.stillPath),
    files: episode.files.map(toFileDto),
  });
}

function toSeasonDto(season: SeasonRow): SeasonDto {
  return compact({
    id: season.id,
    seasonNumber: season.seasonNumber,
    title: season.title ?? undefined,
    overview: season.overview ?? undefined,
    posterUrl: imageUrl(season.posterPath),
    episodes: [...season.episodes]
      .sort((a, b) => a.episodeNumber - b.episodeNumber)
      .map(toEpisodeDto),
  });
}

export function toItemDetails(item: ItemRow): ItemDetails {
  const cast = (item.cast as unknown as CastMember[]).map((c): CastMemberDto =>
    compact({ name: c.name, character: c.character, profileUrl: imageUrl(c.profileRef) }),
  );
  const ids: Optional<ItemDetails['ids']> = compact({
    tmdb: item.tmdbId ?? undefined,
    tvmaze: item.tvmazeId ?? undefined,
    tvdb: item.tvdbId ?? undefined,
    imdb: item.imdbId ?? undefined,
  });
  return {
    ...toItemSummary(item),
    ...compact({
      originalTitle: item.originalTitle ?? undefined,
      overview: item.overview ?? undefined,
      tagline: item.tagline ?? undefined,
      rating: item.rating ?? undefined,
      runtimeMinutes: item.runtimeMinutes ?? undefined,
      status: item.status ?? undefined,
      backdropUrl: imageUrl(item.backdropPath),
      metadataProvider: item.metadataProvider ?? undefined,
      logoUrl: imageUrl(item.logoPath),
      trailerKey: item.trailerKey ?? undefined,
    }),
    ...(item.nextEpisodeAirDate &&
      item.nextEpisodeSeason !== null &&
      item.nextEpisodeNumber !== null && {
        nextEpisode: {
          seasonNumber: item.nextEpisodeSeason,
          episodeNumber: item.nextEpisodeNumber,
          ...(item.nextEpisodeTitle && { title: item.nextEpisodeTitle }),
          airDate: item.nextEpisodeAirDate.toISOString().slice(0, 10),
        },
      }),
    genres: item.genres,
    cast,
    ids,
    matchLocked: item.matchLocked,
    files: item.files.map(toFileDto),
    seasons: [...item.seasons].sort((a, b) => a.seasonNumber - b.seasonNumber).map(toSeasonDto),
  };
}

export function toCandidateDto(candidate: Candidate): MatchCandidate {
  return compact({
    provider: candidate.provider,
    id: candidate.id,
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    overview: candidate.overview,
    posterUrl: imageUrl(candidate.posterRef),
  });
}

export const itemInclude = {
  files: true,
  seasons: { include: { episodes: { include: { files: true } } } },
} as const;
