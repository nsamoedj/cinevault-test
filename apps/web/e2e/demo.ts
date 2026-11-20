// A fuller library for screenshots (E2E_DEMO=1): movies and shows with
// posters, backdrops and Dutch descriptions, so the layout can be judged on
// phones, tablets, laptops and TVs. The images are drawn with FFmpeg.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface DemoTitle {
  id: number;
  title: string;
  year: number;
  genres: string[];
  rating: number;
  runtime: number;
  overview: string;
  tagline?: string;
  /** Shows: episodes per season. */
  seasons?: number[];
}

const OVERVIEWS = [
  'Een jonge cartograaf ontdekt dat de kaarten van haar grootvader plekken tonen die niet bestaan, en begint aan een reis die haar hele familiegeschiedenis op zijn kop zet.',
  'Wanneer een stille havenstad wordt opgeschrikt door een reeks verdwijningen, moet een uitgebluste rechercheur samenwerken met de enige getuige: een meisje dat niet praat.',
  'Twee broers erven een vervallen bioscoop aan zee en proberen die met hun laatste geld en veel te veel ideeën weer tot leven te brengen.',
  'In een nabije toekomst waarin herinneringen te koop zijn, ontdekt een handelaar dat iemand zijn eigen verleden heeft gestolen.',
  'Een bergbeklimmer raakt in een sneeuwstorm de weg kwijt en vindt onderdak bij een kluizenaar die meer weet dan hij laat merken.',
];

export const DEMO_MOVIES: DemoTitle[] = [
  ['The Last Harbour', 2024, ['Thriller', 'Drama'], 7.8, 128],
  ['Paper Moons', 2023, ['Animatie', 'Familie', 'Avontuur'], 8.3, 97],
  ['Northern Lights', 2022, ['Drama', 'Romantiek'], 7.1, 116],
  ['Iron Meridian', 2025, ['Actie', 'Sciencefiction'], 6.9, 142],
  ['Quiet Valley', 2019, ['Drama'], 7.6, 104],
  ['Starfall Express', 2021, ['Animatie', 'Avontuur', 'Komedie'], 7.4, 92],
  ['The Clockmaker', 2018, ['Fantasy', 'Drama'], 8.1, 121],
  ['Neon Rain', 2024, ['Actie', 'Thriller', 'Sciencefiction'], 7.2, 133],
  ['Summer of Kites', 2020, ['Komedie', 'Familie'], 6.8, 99],
  ['Glass Garden', 2023, ['Mysterie', 'Thriller'], 7.7, 111],
  ['Red Desert', 2017, ['Avontuur', 'Actie'], 6.5, 125],
  ['Little Lanterns', 2022, ['Animatie', 'Familie'], 8.0, 88],
  ['The Long Winter', 2016, ['Drama', 'Geschiedenis'], 7.9, 150],
  ['Velvet Static', 2025, ['Komedie', 'Romantiek'], 6.7, 101],
].map(([title, year, genres, rating, runtime], i) => ({
  id: 100 + i,
  title: title as string,
  year: year as number,
  genres: genres as string[],
  rating: rating as number,
  runtime: runtime as number,
  overview: OVERVIEWS[i % OVERVIEWS.length] as string,
  ...(i % 3 === 0 && { tagline: 'Sommige wegen leiden alleen terug.' }),
}));

export const DEMO_SHOWS: DemoTitle[] = [
  {
    id: 200,
    title: 'Harbor Lights',
    year: 2021,
    genres: ['Drama', 'Mysterie'],
    rating: 8.4,
    runtime: 52,
    overview: OVERVIEWS[1] as string,
    seasons: [6, 6],
  },
  {
    id: 201,
    title: 'Sky Pirates',
    year: 2023,
    genres: ['Animatie', 'Avontuur', 'Komedie'],
    rating: 8.1,
    runtime: 24,
    overview: OVERVIEWS[2] as string,
    seasons: [8],
  },
  {
    id: 202,
    title: 'The Archive',
    year: 2024,
    genres: ['Sciencefiction', 'Thriller'],
    rating: 7.5,
    runtime: 45,
    overview: OVERVIEWS[3] as string,
    seasons: [5],
  },
];

const COLORS = [
  ['0x1b2b58', '0xe06c4f'],
  ['0x101c3d', '0xe0b04f'],
  ['0x0f3b4a', '0x5fbf7f'],
  ['0x2a1745', '0xb07fe0'],
  ['0x14304f', '0x4f9de0'],
  ['0x3b1420', '0xe04f8f'],
];

function draw(file: string, width: number, height: number, i: number, text?: string) {
  if (existsSync(file)) return;
  const [c0, c1] = COLORS[i % COLORS.length] as [string, string];
  const label = text
    ? `,drawtext=text='${text.replace(/'/g, '')}':fontcolor=white:fontsize=${Math.round(width / 11)}:x=(w-tw)/2:y=h*0.74`
    : '';
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `gradients=s=${width}x${height}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${width}:y1=${height}:nb_colors=2:seed=${i}${label}`,
    '-frames:v',
    '1',
    file,
  ]);
}

/** Posters ("p<id>.jpg"), backdrops ("b<id>.jpg") and stills ("s<id>.jpg"). */
export function drawDemoArt(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [i, title] of [...DEMO_MOVIES, ...DEMO_SHOWS].entries()) {
    draw(path.join(dir, `p${title.id}.jpg`), 500, 750, i, title.title);
    draw(path.join(dir, `b${title.id}.jpg`), 1280, 720, i + 2);
  }
  for (let i = 0; i < 6; i++) draw(path.join(dir, `s${i}.jpg`), 400, 225, i + 1);
  draw(path.join(dir, 'face.jpg'), 185, 278, 4);
}

/** Copies one tiny video to every demo path (all the scanner needs). */
export function placeDemoFiles(media: string, sample: string): void {
  for (const movie of DEMO_MOVIES) {
    const name = `${movie.title} (${movie.year})`;
    const file = path.join(media, 'Movies', name, `${name} WEBDL-2160p.mkv`);
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(sample, file);
  }
  for (const show of DEMO_SHOWS) {
    for (const [s, count] of (show.seasons ?? []).entries()) {
      for (let e = 1; e <= count; e++) {
        const code = `S${String(s + 1).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
        const file = path.join(
          media,
          'Series',
          show.title,
          `Season ${s + 1}`,
          `${show.title} - ${code} - Episode ${e} WEBDL-1080p.mkv`,
        );
        mkdirSync(path.dirname(file), { recursive: true });
        copyFileSync(sample, file);
      }
    }
  }
}

export function demoByTitle(title: string): DemoTitle | undefined {
  return [...DEMO_MOVIES, ...DEMO_SHOWS].find((t) => t.title === title);
}

export function demoById(id: number): DemoTitle | undefined {
  return [...DEMO_MOVIES, ...DEMO_SHOWS].find((t) => t.id === id);
}

const EPISODE_TITLES = [
  'Het begin',
  'Laag water',
  'De vuurtoren',
  'Stemmen in de mist',
  'Wat de zee meeneemt',
  'Terug naar de haven',
  'Het archief',
  'Afscheid',
];

export function demoSeasons(show: DemoTitle) {
  return (show.seasons ?? []).map((count, s) => ({
    season: s + 1,
    episodeCount: count,
    episodes: Array.from({ length: count }, (_, e) => ({
      season: s + 1,
      episode: e + 1,
      title: EPISODE_TITLES[e % EPISODE_TITLES.length] as string,
      overview: OVERVIEWS[(e + s) % OVERVIEWS.length] as string,
      runtimeMinutes: show.runtime,
      stillRef: `tmdb:w300/s${(e + s) % 6}.jpg`,
    })),
  }));
}
