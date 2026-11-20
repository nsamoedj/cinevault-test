# CineVault

Eigen streamingapp (Plex/Netflix-achtig) voor een persoonlijke mediabibliotheek. Eerst een webapplicatie, later iOS en Android. Hardware-transcoding is onderdeel van de applicatie.

Dit bestand is de overdracht vanuit een planningsgesprek op claude.ai. Lees het volledig voordat je begint. Besluiten onder "Vastgelegde keuzes" zijn genomen door de eigenaar; wijk daar niet zonder overleg van af.

## Vastgelegde keuzes

- **Naam:** CineVault
- **Backend:** Node.js + TypeScript + Fastify
- **Database:** PostgreSQL met Prisma
- **Frontend:** React + Vite, `hls.js` als speler
- **Transcoding:** FFmpeg met Intel QSV (VAAPI als alternatief)
- **Mobiel (later):** Expo (React Native), dezelfde REST API
- **Deployment:** Docker Engine (Compose) op Ubuntu Server voor alles: PostgreSQL, API, Caddy als reverse proxy (HTTPS) en de transcoder, die de Intel-GPU via `/dev/dri` krijgt (besluit eigenaar, 2026-11-17; zie "Linux op de N100"). Tot 2026-11-17 Docker Desktop op Windows met een native transcoder.
- **Server:** mini-pc met Intel N100 (QSV beschikbaar), met Ubuntu Server 26.04 LTS en Docker Engine
- **Metadata:** TMDB is de hoofdbron, TVmaze is de fallback
- **Ondertitels:** OpenSubtitles, lokaal gecachet, omzetten naar WebVTT
- **Themamuziek:** eerst de themadienst van Plex (`tvthemes.plexapp.com`, op TVDB-id, lokaal gecachet), zonder eigen intro of aftiteling (besluit eigenaar, 2026-10-20; eerst de intro en aftiteling uit de eigen bestanden). Voor anime die Plex niet heeft de eerste opening van AnimeThemes (verzoek eigenaar 2026-10-22: "zoek een tweede bron"; de keuze voor AnimeThemes is van Claude, `ANIME_THEMES=false` zet hem uit), en daarna voor elke serie de YouTube-link van ThemerrDB, gedownload met yt-dlp (verzoek eigenaar 2026-10-22, na uitleg dat dat tegen de voorwaarden van YouTube is; `THEMERRDB=false` zet hem uit); zie "Themamuziek"
- **Niet gebruiken:** uNoGS (Netflix-catalogus) en What-Song (soundtrackdata, geen audio)

## Uitgangspunten

- **API-first:** de web-app is een gewone client van de API, zodat de Expo-app later dezelfde API gebruikt.
- **Direct play heeft voorrang.** Transcoden alleen als apparaat, codec of bandbreedte dat vraagt.
- **Externe bronnen via providers.** Metadata, ondertitels en themes zitten achter een interface (`MetadataService`, `SubtitleService`, `ThemeService`), zodat een bron vervangen kan worden zonder de rest aan te passen.
- **Alles wat extern wordt opgehaald, wordt lokaal gecachet** (afbeeldingen, ondertitels, themes), zodat de app niet afhankelijk is van een externe dienst tijdens het afspelen.
- Begin klein en werkend; bouw per fase uit.

## Architectuur

```
Client (web / Expo)
   ↓ REST API + HLS
Fastify API ── Prisma ── PostgreSQL
   ├─ Scanner (ffprobe + metadata)
   ├─ Transcoder (FFmpeg + QSV)
   ├─ SubtitleService
   └─ ThemeService (Plex, AnimeThemes, ThemerrDB/YouTube)
Mediabestanden op schijf
```

## Projectstructuur

```
mediaserver/
├─ docker-compose.yml
├─ apps/
│  ├─ api/      (Fastify, Prisma, scanner, transcoder)
│  └─ web/      (React + Vite)
└─ packages/
   └─ shared/   (types, API-client, hergebruikt in Expo)
```

Branding (logo's) hoort in `assets/branding/`. Kleuren: ink `#101C3D`, messing `#E0B04F`, wit `#F2F4FA`.

## Fasen

1. **Fundament:** Docker Desktop op de Windows-N100, QSV controleren met `scripts/check-qsv.ps1`, Docker Compose met API en `postgres:16` (volume + healthcheck), Fastify-skelet, Prisma-schema en eerste migratie.
2. **Scanner en metadata:** mappen doorlopen, titel/jaar/S01E01 herkennen, `ffprobe` voor codec/duur/tracks, TMDB (posters, backdrops, beschrijving, cast), TVmaze als fallback, afbeeldingen cachen, handmatige correctie van een foute match.
3. **Direct play:** streaming-endpoint met HTTP range requests, webinterface met bibliotheek, detailpagina en speler.
4. **Transcoding:** beslislogica (direct play, remux of transcode), HLS met `h264_qsv`, kwaliteitsopties (origineel, 1080p, 720p), seeken, wachtrij met limiet op gelijktijdige transcodes, opschonen van tijdelijke segmenten.
5. **Accounts en voortgang:** JWT-login, profielen, "verder kijken", gezien-status.
6. **Ondertitels:** `SubtitleService`, WebVTT-conversie, ingebouwde tracks uitlezen met FFmpeg, handmatig zoeken, tijdsverschuiving, Whisper als terugval.
7. **Themamuziek:** `ThemeService` met providers; sinds 2026-10-20 de themes van Plex, sinds 2026-10-22 met AnimeThemes voor anime en ThemerrDB (YouTube) voor de rest (zie "Themamuziek").
8. **Mobiel (daarna):** Expo-app met native HLS-speler, hergebruik van `packages/shared`.

## Datamodel (Prisma)

Eerste migratie: `User`, `Library`, `MediaItem`, `Season`, `Episode`, `MediaFile` (pad, codec, duur, tracks), `Subtitle`, `WatchProgress`. Later: een themamodel en een transcode-job-model.

PostgreSQL maakt full-text search of `pg_trgm` mogelijk voor zoeken op titels.

## Transcoding op de N100

- QSV: hardware-decoding voor H.264, HEVC (ook 10-bit) en AV1; hardware-encoding voor H.264 en HEVC.
- AV1-encoding kan niet in hardware. Gebruik H.264 of HEVC als uitvoer.
- Verwacht grofweg 3-5 gelijktijdige 1080p-transcodes. Dit moet op de echte hardware getest worden.
- 4K HDR naar SDR (tone mapping) is zwaarder en geeft minder gelijktijdige streams.
- FFmpeg draait in de container `transcoder` (Ubuntu 26.04, FFmpeg 8 met libvpl), met `/dev/dri` (zie "Linux op de N100"). Gebruik `-hwaccel qsv` met `h264_qsv`.
- Let op het geheugengebruik van FFmpeg en PostgreSQL samen.

## Linux op de N100 (besluit eigenaar, 2026-11-17)

De N100 gaat van Windows met Docker Desktop over naar **Ubuntu Server 26.04 LTS met Docker Engine**. Windows verdwijnt; het blijft als image (Rescuezilla) bewaard tot de overstap geslaagd is. De overstap zelf (exporteren, installeren, terugzetten) staat in de repository `nsamoedj/n100-server` (`linux/bootstrap.sh`, `linux/herstel.sh`, stap `30-cinevault.sh`). Dit vervangt "Windows op de N100" (2026-10-15).

- **Vast (het herstelscript van n100-server rekent erop):** projectnaam `cinevault`; volumes `pgdata`, `cache` en `caddy-data`; diensten `db`, `api` en `web`; de API op `127.0.0.1:3000` (`/api/health`); de webpoorten 80, 443 en 8765. `RADARR_URL` en `SONARR_URL` blijven `host.docker.internal` (de Arr-stack draait in Docker met gepubliceerde poorten; de API heeft `extra_hosts: host-gateway`). Het herstelscript start met `scripts/up.sh` (dat ook `TRANSCODER_URL` van Windows omzet en `RENDER_GID` invult).
- **Paden:** `MEDIA_ROOT=/mnt/media` (de NTFS-schijf die op Windows `D:` was, via `ntfs3`, read-only gekoppeld als `/media` in `api` en `transcoder`), `TRANSCODE_TMP=/srv/cinevault-data/transcode` (als `/transcode`), `BACKUP_DIR=/mnt/media/backups/cinevault`.
- **Transcoder als container** (`apps/transcoder/Dockerfile`, dienst `transcoder`):
  - **Image:** `ubuntu:26.04` met `ffmpeg` (8.0.1, `--enable-libvpl`), `intel-media-va-driver-non-free` (iHD), `libvpl2`, `libmfx-gen1.2` (de oneVPL-runtime voor Gen12, zonder die vindt QSV niets) en `vainfo`; de `node`-binary uit `node:24-bookworm-slim` (Ubuntu 26.04 heeft Node 22). Geen npm-pakketten: `node src/main.ts`. `LIBVA_DRIVER_NAME=iHD`, `TRANSCODER_HWACCEL=qsv`, `TRANSCODER_HOST=0.0.0.0`.
  - **GPU:** `devices: /dev/dri`, `group_add: ${RENDER_GID:-44}`. `RENDER_GID` is het nummer van de groep `render` op de host (`scripts/up.sh` vult het in). Het image kent geen groep `render`, dus de standaard is 44 (`video`, vast op Debian/Ubuntu), anders start de container niet.
  - **Entrypoint** (`docker-entrypoint.sh`): als root maakt hij `TRANSCODE_TMP` van `cinevault` (uid 1000) als dat nodig is (Docker maakt een ontbrekende map als root), en start dan met `setpriv` als `cinevault`, met de groepen van `group_add` plus de groep van `/dev/dri/renderD*` (dus ook bij een verkeerde `RENDER_GID`), en waarschuwt als de render-node niet bruikbaar is. Rechten controleert hij met de `test` van de shell: de `test` van Ubuntu 26.04 (uutils/Rust-coreutils) negeert aanvullende groepen.
  - **Netwerk:** geen gepubliceerde poort; de API bereikt hem via `TRANSCODER_URL=http://transcoder:8766` (nieuwe standaard, ook in `apps/api/src/config.ts`) met dezelfde `TRANSCODER_TOKEN`. `scripts/up.sh` zet een oude `TRANSCODER_URL` met `host.docker.internal` om; met de `.env` van Windows en alleen `docker compose up` bereikt de API de transcoder niet.
  - **`init: true`** ruimt FFmpeg-processen op; een healthcheck vraagt `/health` met de token.
  - **`TRANSCODER_MEDIA_OVER_HTTP=0`** (standaard in compose): de omweg via HTTP was alleen nodig zodat Sonarr en Radarr op Windows bestanden in gebruik konden verwijderen.
  - **Zelftest:** codeert nu met een bitrate (`-b:v`/`-maxrate`, zoals sessies; in low-power-modus vraagt dat op Linux de HuC-firmware), en probeert bij een fout eerst `-low_power 1` (`Capabilities.lowPower`, dan voor elke transcode) en pas daarna de CPU. Meldt nog steeds QSV en tonemapping (`/api/transcoder`, _Gezondheid_, `verify-setup.sh`).
  - **`-readrate` en FFmpeg 7.1+ (gevonden 2026-11-17 met de tests in het image):** vanaf FFmpeg 7.1 leest FFmpeg na een voorsprong (de burst, of een `readrate` die het niet precies haalt) met `-readrate_catchup`, standaard laag. Gemeten met FFmpeg 8.0.1: de burst van 60 s van een sessie kwam op 1,5× (38 s voor de eerste minuut in plaats van 1 s), een vingerafdruk op 20-200× las op 2×. Nu vraagt de transcoder één keer `ffmpeg -h long` (`hasReadrateCatchup`) en geeft dan `-readrate_catchup 10000` (`readrateArgs`). FFmpeg 6 krijgt hetzelfde als eerst. De FFmpeg 9 op Windows heeft die optie ook; vermoedelijk was dit ook de oorzaak van _cancelled after 175 s_ bij het zoeken naar intro's (stap 46).
- **Caddy en Voqa Social:** de dienst `web` zit op zijn eigen netwerk én op het externe netwerk `voqa-intern` (`external: true`), dat het project `voqa-social` maakt (in n100-server vóór CineVault teruggezet). De Caddyfile stuurt `n8n.voqa.nl` naar `voqa-n8n:5678` en `media.voqa.nl/files/*` naar `voqa-render:3000`. `/api` gaat naar `cinevault-api:3000`, een alias van de API op het eigen netwerk, zodat een container `api` op `voqa-intern` nooit kan antwoorden. `scripts/up.sh` stopt met uitleg als `voqa-intern` niet bestaat.
- **Scripts:** bash-versies met dezelfde opties (`--optie`) als de `.ps1`: `up.sh`, `backup.sh` (`--install`: systemd-timer `cinevault-backup`), `restore.sh`, `verify-setup.sh` (Linux-controles), `arr-webhook.sh`, `build-apk.sh` (geeft de bestanden van de bouwcontainer, die als root draait, terug aan de gebruiker; sleutel in `~/CineVault-android` of `ANDROID_KEY_DIR`), `scan.sh`, `public-access.sh` (de controles, zonder firewall) en `android-files.sh` (de Android-bestanden van de laatste build als zip in `downloads/`, die Caddy nu met het type van hun extensie geeft in plaats van altijd als APK). Gedeeld: `scripts/lib/common.sh` en `scripts/lib/public-access.sh`; `scripts/.shellcheckrc`. Ze vragen `jq` en `curl`. Vervallen: `media-watchdog.ps1` en het firewall-deel van `public-access.ps1`. De `.ps1`-scripts blijven voorlopig staan.
- **Meldingen in de app** (`health.ts`, `events.ts`, `format.ts`, de verzoekinstellingen) noemen de Linux-scripts en `docker compose` in plaats van `.ps1`, Docker Desktop en `wsl --shutdown`. De controle `media-folders` zegt nu: de schijf is weg of opnieuw gekoppeld, dan `docker compose restart api transcoder` (een container houdt anders de lege map van vóór het koppelen).
- **Back-ups:** de timer `n100-backup` van n100-server maakt om 03:30 een dump met dezelfde naam in `BACKUP_DIR`, maar meldt die niet aan de API; alleen `scripts/backup.sh` doet dat (`POST /api/admin/health/backup`). Zonder die melding zegt _Gezondheid_ na 48 uur dat de back-up oud is. Sinds 2026-11-18 roept `n100-backup` `scripts/backup.sh` aan. **Besluit eigenaar (2026-11-18): geen nachtelijke back-ups** (`NACHTELIJKE_BACKUP=nee` in n100-server; de timer is weg). Bij verlies van de database zijn accounts, kijkvoortgang en handmatige matches weg; de media blijven. _Gezondheid_ → _Back-up_ staat daardoor op _onbekend_ (de oude melding uit `AppSetting` `health-backup` is gewist).
- **Overgezet op 2026-11-18** (n100-server, stap `30-cinevault`): project in `/srv/cinevault`, `MEDIA_ROOT=/mnt/media`, server `plexserver` op 192.168.0.110, beheer via SSH. `verify-setup.sh`: 0 fouten; QSV en tonemapping werken in de container (iHD 26.1.2, render-groep 991), zonder `-low_power`.
- **Poorten 80/443 op het LAN-adres:** Tailscale Funnel (de Garage-opslag van Faktr, poort 3900) luistert op poort 443 van het Tailscale-adres, waardoor Docker niet op `0.0.0.0:443` kan binden. Daarom staat in `.env` `HTTP_PORT=192.168.0.110:80` en `HTTPS_PORT=192.168.0.110:443`; de router stuurt 80/443 daarheen. `env_number` valt bij zo'n waarde terug op 80/443, en de certificaatcontrole in `scripts/lib/public-access.sh` gebruikt het adres uit `HTTPS_PORT`.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 47.
- **Getest in de cloudsandbox (2026-11-17, zonder GPU):** het transcoder-image (Ubuntu 26.04 en Node 24 bouwen; `deb.debian.org` is geblokkeerd, dus API en web met een kopie van hun Dockerfile zonder `apt`, niet gecommit); de stack met Compose (alle vier healthy; een override zonder `devices`); de zelftest met terugval naar de CPU; een transcode via HTTP; de API die de transcoder bereikt; Caddy op `voqa-intern` met een nep-Voqa; de entrypoint met een nagebootste render-node; alle scripts tegen de stack (back-up met 70 dagen opruimen, terugzetten en een mislukt terugzetten, scan, webhook, publieke toegang, `verify-setup.sh`; `build-apk.sh` met een nep-`docker`); shellcheck; alle bestaande tests (ook de transcoder-tests met FFmpeg 8 in het image).
- **Pas op de N100 te testen:** QSV en tonemapping in de container (render-groep, iHD, HuC, of `-low_power` nodig is), hoeveel transcodes tegelijk gaan, de NTFS-schijf, de systemd-timer, het certificaat, Sonarr en Radarr in Docker, en een Android-build.
- **Eerder op Windows (2026-10-15 tot 2026-11-17):** Docker Desktop kon de Intel-GPU niet aan een container geven, dus de transcoder draaide native (`scripts/transcoder.ps1`, FFmpeg 9.0.2 van gyan.dev), bereikbaar via `host.docker.internal`. Daar werkten H.264- en HEVC-encode en een HEVC → H.264-transcode volledig op de GPU zonder `-low_power`. `hwupload` van CPU-frames naar QSV-frames faalde (`Invalid argument`); de transcoder houdt frames daarom op de GPU (`-hwaccel qsv -hwaccel_output_format qsv`, `vpp_qsv`), wat op Linux zo blijft. `docker compose up --build` faalde daar (Bake-builder), daarom bouwt `up.ps1`/`up.sh` met `docker build`. Shellscripts houden LF (`.gitattributes`).

## Bestaande mediabibliotheek (besluit eigenaar, 2026-10-16)

- De eigenaar heeft al een mediaserver met de mappen `Movies`, `Series` en `Anime`. Die indeling en inhoud blijven zoals ze zijn.
- CineVault leest alleen. `MEDIA_ROOT` is de map die deze drie mappen bevat en wordt read-only gekoppeld. De scanner schrijft nooit in de mediamappen: geen posters, NFO's of hernoemingen. Wat CineVault zelf maakt, zoals posters, ondertitels en themes, gaat naar een eigen cachemap.
- Elke map wordt een eigen `Library`: `Movies` (films), `Series` en `Anime` (allebei series). Anime-namen zonder `SxxEyy`, zoals `[Group] Title - 01 [1080p].mkv` met een absoluut afleveringsnummer, worden herkend als terugval.
- **Steekproef van 2026-10-16** (`scripts/media-sample.ps1`): 122 films, 47 series en 35 anime. In totaal 1962 `.mkv`- en 87 `.mp4`-bestanden, **geen** `.nfo`, `.jpg` of `.srt`.
  - De namen volgen Sonarr en Radarr: `Movies/Titel (Jaar)/Titel (Jaar) Bluray-2160p.mkv` en `Series/Serie [(Jaar)]/[Season N/]Serie - S01E01 - Afleveringstitel WEBDL-1080p.mkv`. Anime volgt hetzelfde patroon, bijvoorbeeld `Anime/Bleach/Season 17/Bleach - S17E01 - … WEBDL-2160p.mkv`.
  - Lastige gevallen: seizoensmappen ontbreken soms, zijn niet altijd met een voorloopnul genummerd (`Season 1`) en series hebben niet altijd een jaar. Filmtitels kunnen ` - ` bevatten; het jaar tussen haakjes is dan het houvast. Het kwaliteitslabel aan het eind (`WEBDL-2160p`, `Bluray-1080p`) hoort niet bij de titel.
  - Sonarr nummert seizoenen zoals TheTVDB. TMDB doet dat bij anime soms anders. Bestaat een seizoen niet bij TMDB, dan haalt de scanner de afleveringen bij TVmaze, dat de TVDB-nummering volgt.
  - Veel bestanden zijn 2160p. Direct play is dus belangrijk, en transcoderen van 4K is het zware geval in fase 4.
- Bevestigd door de eigenaar (2026-10-16): bestaande `.nfo`-bestanden (met TMDB-/TVDB-/IMDb-id) en posters in de mediamappen worden als bron gebruikt, met voorrang op het zoeken bij TMDB. Ze worden alleen gelezen. Lokale posters (`poster.jpg`, `folder.jpg`) en achtergronden (`fanart.jpg`, `backdrop.jpg`) worden in fase 2 ondersteund. Het lezen van `.nfo`-bestanden wordt pas gebouwd als die in de bibliotheek voorkomen; de steekproef vond er geen.
- De huidige server is **Plex**, op dezelfde N100. De eigenaar stopt met Plex zodra CineVault goed werkt. CineVault mag dus nergens van Plex afhangen. Gevolgen zolang Plex nog draait:
  - **Naamconventies.** De scanner volgt die van Plex: `Movies/Titel (Jaar)/Titel (Jaar).ext`, `Series/Serie (Jaar)/Season 01/Serie - s01e01 - Titel.ext`, en id-hints in map- of bestandsnamen zoals `{tmdb-12345}`, `{imdb-tt1234567}` en `{tvdb-12345}`. Een id-hint gaat voor het zoeken op titel.
  - **Geen `.nfo` van Plex.** Plex schrijft zelf meestal geen `.nfo`'s en bewaart artwork in zijn eigen database, niet in de mediamappen. Bestanden die er wel staan, komen van een andere tool of zijn handmatig toegevoegd. De Plex-database wordt niet gelezen.
  - **Gedeelde GPU.** Plex en CineVault delen de QSV-GPU zolang Plex draait. De limiet op gelijktijdige transcodes (fase 4) is instelbaar: eerst voorzichtig, en hoger zodra Plex weg is.
  - **Poorten.** Plex gebruikt poort 32400. CineVault gebruikt 3000 voor de API en 8765 voor de webinterface. 8080 is op de N100 al bezet door een andere dienst.
- Fase 1 is op 2026-10-16 op de N100 afgerond: `scripts/verify-setup.ps1` geeft een volledig groen rapport.
- **Rapport van 2026-10-17** (commit `e3ba9b3`): 39 OK, 1 waarschuwing, 0 fouten.
  - **De waarschuwing:** het netwerk `KPN54B216` (van de KPN-versterkers; de aansluiting is Odido Zakelijk) staat nog op _Openbaar_.
  - **`MEDIA_ROOT`** is `D:/`, de hele schijf. In `/media` staan daardoor ook `$RECYCLE.BIN` en `System Volume Information`. De bibliotheken zijn alleen `Movies`, `Series` en `Anime`, dus de scanner komt daar niet.

## Stand van fase 2 (scanner en metadata, 2026-10-16)

Getest op de N100 (2026-10-16): 2049 bestanden zonder `ffprobe`-fouten. Na `scan.ps1 -Refresh` in het Nederlands zijn 201 van de 202 titels gematcht (35 anime, 120 films, 47 series), 0 mislukt. Eén film is nog ongematcht: "The Legend of Aang - The Last Airbender (2026)". Die wordt met de hand gematcht.

- **Scanner** (`apps/api/src/scanner/`):
  - **Herkenning** (`parse.ts`): titels, jaar, `SxxEyy`, multi-episode-bestanden, `1x01`, absolute anime-nummers en id-hints zoals `{tmdb-…}`. Getest op de steekproef van de eigenaar.
  - **`ffprobe`** (`probe.ts`) leest codec, resolutie, bitdiepte, HDR10, HLG of Dolby Vision, en de sporen. Bij ondertitels houdt hij bij of het tekst of beeld is.
  - **Bestanden** worden alleen gelezen. Ongewijzigde bestanden worden niet opnieuw geprobed. Verdwenen bestanden worden verwijderd, maar **nooit** als een bibliotheekmap leeg of onbereikbaar is (bijvoorbeeld een losgekoppelde schijf).
- **Metadata** (`apps/api/src/metadata/`):
  - **Providers.** `MetadataService` gebruikt TMDB als hoofdbron en TVmaze als fallback voor series. Seizoenen die TMDB niet kent, vult hij aan uit TVmaze.
  - **Matchen.** Hij kiest liever geen match dan een verkeerde (status `UNMATCHED`). Een handmatige match staat vast (`matchLocked`). Gematchte titels worden altijd via hun bekende id vernieuwd, nooit opnieuw gezocht.
  - **Taal (besluit eigenaar, 2026-10-16):** metadata in het **Nederlands** (`METADATA_LANGUAGE=nl-NL`, de standaard). Ontbrekende Nederlandse teksten vallen terug op Engels. Zoeken bij TMDB gaat altijd in `en-US`, omdat Radarr en Sonarr de mappen Engelse titels geven. In het Nederlands zoeken zou bijvoorbeeld Japanse anime laten mislukken: de originele titel is dan Japans en de vertaalde titel Nederlands, zodat geen van beide op de mapnaam lijkt.
  - **Titels in het Engels (besluit eigenaar, 2026-10-16):** titels van films, series en afleveringen, en posters, zijn altijd Engels. Beschrijvingen en genres blijven in `METADATA_LANGUAGE`.
    - **Waarom:** zonder vertaling gaf TMDB in `nl-NL` de originele titel terug, in het Japans, Chinees of Hindi.
    - **Titels.** De TMDB-provider haalt naast de details in `nl-NL` ook `en-US` op, voor de titel en de poster. Lege Nederlandse teksten vallen daarmee ook terug op Engels.
    - **Posters:** een Engelse poster, anders een poster zonder tekst (`include_image_language=en,null`).
    - **Niet-Latijns schrift** (`isLatinScript` in `packages/shared`): heeft een titel dat ook in het Engels, dan neemt `apply.ts` de mapnaam (voor de titel) of de titel uit de bestandsnaam (voor afleveringen). Radarr en Sonarr geven die Engelse namen.
    - **Placeholders.** Namen die TMDB zelf invult, zoals "Episode 5", worden genegeerd.
    - **De originele titel** wordt nog opgeslagen. Staat die in een niet-Latijns schrift, dan toont de detailpagina hem niet.
- **Afbeeldingen** (`apps/api/src/images.ts`):
  - **Refs in de database:** `tmdb:…`, `tvmaze:…` en `media:…`.
  - **Cache.** Externe afbeeldingen worden één keer gedownload naar `CACHE_DIR` (een Docker-volume).
  - **Eigen artwork** (`poster.jpg`, `folder.jpg`, `fanart.jpg`, `backdrop.jpg`) gaat altijd voor.
- **API.** Zie de tabel in `README.md`. Scannen en handmatig corrigeren gaan voorlopig via `scripts/scan.ps1` en `Invoke-RestMethod` (`docs/server-setup.md`, stap 12).
- **Voor fase 3 (UI):**
  - Toon de verplichte bronvermelding van TMDB, en die van TVmaze als `metadataProvider` `tvmaze` bevat (CC BY-SA).
  - Bouw een scherm voor titels met `UNMATCHED` of `FAILED` en het handmatig matchen.
- **Niet gebouwd:**
  - **`.nfo`-bestanden lezen:** er staan er geen in de bibliotheek.
  - **Bij multi-episode-bestanden (`S01E01-E02`)** wordt het bestand alleen aan de eerste aflevering gekoppeld.
- **Testen in de cloudsandbox van Claude.** TMDB, TVmaze en `deb.debian.org` zijn daar geblokkeerd. Providers zijn met nep-`fetch` getest, de scanner met nep-providers tegen een echte PostgreSQL. De `apt-get install ffmpeg`-stap in het Dockerfile wordt pas op de N100 echt uitgevoerd.

## Stand van fase 3 (direct play en webinterface, 2026-10-16)

Gebouwd en getest in de cloudsandbox. Op de N100 werkt de interface (2026-10-16). 4K haperde eerst; na fase 4 niet meer (zie "Haperende 4K" hieronder).

- **Streaming:** `GET/HEAD /api/files/:id/stream` serveert het bestand zoals het is, met HTTP range requests (206/416), zodat spoelen werkt. `GET /api/files/:id` geeft de speler het bestand plus titel en aflevering. `GET /api/stats/codecs` telt de codecs in de bibliotheek, als voorbereiding op fase 4.
- **Direct-play-check** (`packages/shared/src/directPlay.ts`): bouwt RFC 6381-codecstrings uit de `ffprobe`-gegevens en vraagt het apparaat of het die kan afspelen. Het antwoord is `yes`, `maybe` (MKV met ondersteunde codecs; Chromium speelt dat af, maar zegt het niet toe) of `no`, met de reden. De Expo-app kan dezelfde check gebruiken.
- **API-client** (`packages/shared/src/client.ts`), voor web en straks Expo.
- **Webapp** (`apps/web`, React + Vite, React Router, TanStack Query), in het Nederlands en in de huiskleuren:
  - de bibliotheken, een postergrid met zoeken, en een detailpagina met cast, seizoenen, afleveringen en technische details;
  - een speler die vooraf zegt of de browser het bestand direct kan afspelen;
  - een scherm "Aandacht nodig" met handmatig matchen;
  - de bronvermelding van TMDB en TVmaze, in de footer en per titel.
- **Uitrol:**
  - `apps/web/Dockerfile` bouwt de app in een Caddy-image (`apps/web/Caddyfile`). Caddy serveert de app en stuurt `/api` door naar `api:3000`.
  - De interface draait op `WEB_PORT`, standaard 8765 (8080 is op de N100 al bezet door een andere dienst), voorlopig via **HTTP, alleen in het thuisnetwerk**.
  - `scripts/up.ps1` bouwt beide images.
- **TMDB-logo:** `assets/branding/tmdb-logo.svg` (de gestapelde variant), in de footer.
- **Haperende 4K (2026-10-16):** de speler heeft een paneel **Statistieken**. Dat toont de buffer, weggevallen beelden en haperingen, en heeft een snelheidstest. De test haalt een stuk van de stream op en vergelijkt de snelheid met de bitrate van het bestand. Zo is te zien of de verbinding (minder dan 1,5× de bitrate) of de decoder (meer dan 2% weggevallen beelden) de oorzaak is. De API leest streams nu in blokken van 1 MiB in plaats van 64 KiB, vanwege de bind mount via WSL2. Is de N100 zelf (localhost) al te traag, dan kan de native Windows-dienst uit fase 4 ook direct play serveren, zonder de bind mount.
- **hls.js:** volgt in fase 4, met HLS-transcoding. Voor direct play is de `<video>`-speler van de browser genoeg.
- **Tests:** naast de unit- en integratietests draait Playwright in Chromium. Getest zijn afspelen en spoelen van een MKV (VP9/Opus), de weigering van HEVC met E-AC3, en handmatig matchen, zowel via `vite preview` als via de Caddy-container.
- **Open:**
  - **HTTPS en toegang van buitenaf:** gebouwd voor `cine-vault.nl` (zie "Toegang van buitenaf").
  - **Login:** sinds fase 5 is er een login (zie "Stand van fase 5").

## Stand van fase 4 (transcoding, 2026-10-16)

Gebouwd en getest in de cloudsandbox, op de CPU. Op de N100 getest (2026-10-16), `verify-setup.ps1` volledig groen voor de transcoder: de zelftest meldt video op de GPU (QSV) en werkende HDR-tonemapping (`vpp_qsv tonemap=1`, FFmpeg 9.0.2). De API bereikt de transcoder op 127.0.0.1 via `host.docker.internal`, dus `TRANSCODER_HOST` blijft 127.0.0.1. 4K speelt zonder haperingen. De geplande taak draait (Node 24.20).

- **Beslislogica** (`packages/shared/src/playback.ts`, `planPlayback`). Per apparaat, voor de kwaliteiten `original`, `1080p` en `720p`:
  - **direct play** als het apparaat het bestand kan afspelen;
  - **remux** als alleen audio of container niet werkt, of bij een ander audiospoor: de video wordt gekopieerd (4K/HDR blijft) en de audio wordt AAC, of Opus als het apparaat geen AAC heeft;
  - **transcode** naar H.264 als de video niet werkt, of bij een lagere kwaliteit (1080p: 8 Mbit/s, 720p: 4 Mbit/s).
  - Mislukt direct play in de browser toch, dan valt de speler terug op een remux (`noDirect`).
- **Transcoder** (`apps/transcoder`):
  - **Draaien.** Node zonder npm-pakketten, native op Windows: `node src/main.ts` met type stripping (Node 22.18+). `scripts/transcoder.ps1 -Install` maakt `TRANSCODER_TOKEN` en een geplande taak die bij het aanmelden start. De poort is 8766, standaard alleen op 127.0.0.1.
  - **Met de API:** de API praat via `host.docker.internal` met een gedeelde token. De API stuurt het pad ten opzichte van `MEDIA_ROOT`; de transcoder heeft zijn eigen `MEDIA_ROOT` (op de N100 `D:/`, de schijf zelf). Dat is de padvertaling.
  - **HLS:** fMP4-segmenten van 4 s, een EVENT-playlist, in `TRANSCODE_TMP/sessions/<id>`. De API geeft playlists en segmenten door aan de speler (`/api/playback/:id/:file`), zodat de login van fase 5 ook dit deel afschermt.
  - **Op de GPU:** `-hwaccel qsv -hwaccel_output_format qsv`, `vpp_qsv` (schalen, `tonemap=1` voor HDR) en `h264_qsv`.
  - **Formaat (eigenaar, 2026-10-24):** een transcode past binnen een 16:9-vlak van de gekozen hoogte (`outputSize`: 1920×1080 voor 1080p, 1280×720 voor 720p), met de beeldverhouding van de bron. Eerst was alleen de hoogte 1080, zodat een brede film 2580×1080 werd; de H.264-decoder van Google TV (`OMX.MS.AVC.Decoder`) weigerde dat (_NO_EXCEEDS_CAPABILITIES_). Nu 1920×804. Getest met de unittests van de transcoder, nog niet op de tv.
  - **Op de CPU (`libx264`)** gaan bronnen die QSV niet decodeert, zoals 10-bit H.264 (oude anime) en MPEG-4, omdat `hwupload` faalt.
  - **Bestanden blijven verwijderbaar (2026-10-18).** De eigenaar meldde dat Sonarr een net bekeken aflevering niet kon verwijderen: _in gebruik door ffmpeg.exe_. FFmpeg opent een bestand op Windows zonder `FILE_SHARE_DELETE`. Nu leest FFmpeg (en ffprobe) de media via een kleine HTTP-server in de transcoder (`src/source.ts`, 127.0.0.1 op een willekeurige poort, met range requests en links die met een sleutel van die start zijn ondertekend). Node opent bestanden wel met `FILE_SHARE_DELETE`, dus Sonarr en Radarr kunnen een bestand verwijderen, vervangen of verplaatsen terwijl het gelezen wordt. `TRANSCODER_MEDIA_OVER_HTTP=0` zet het uit. Getest in de cloudsandbox (alle transcoder-tests en Playwright via de server), nog niet op Windows.
  - **Zelftest bij de start:** werkt de QSV-pipeline, en werkt `tonemap`? Zo niet, dan valt hij terug op de CPU of op geen tonemapping. Zie `/api/transcoder` en `verify-setup.ps1`.
  - **Remux** begint op de keyframe vóór de gevraagde tijd, en meldt waar hij echt begint (`start`). FFmpeg zoekt bij MKV 3/23 s vóór `-ss`; op de keyframe zelf kwam het gekopieerde beeld daardoor op de keyframe ervóór uit, terwijl het omgezette geluid precies bij `-ss` begon. Beide kregen tijd 0, dus liep het geluid een keyframe-afstand (seconden) vóór op het beeld. De eigenaar zag dat na het kiezen van het Japanse DTS-spoor van Vinland Saga in de Android-app (2026-10-19). Nu zoekt de remux 0,15 s ná de keyframe met `-noaccurate_seek`, zodat beeld en geluid allebei bij de keyframe beginnen (test met een echte FFmpeg in `sessions.test.ts`). **Getest door de eigenaar (2026-10-19):** beeld en geluid lopen nu synchroon.
  - **Geen edit lists (eigenaar, 2026-11-04: op de tv kwam het geluid te laat na spoelen of hervatten, bij een HEVC-bestand omgezet naar H.264 1080p).** FFmpeg zette in het fMP4 per spoor een edit list met waar dat spoor begint; de tijdstempels van beide sporen begonnen op 0. ExoPlayer (Android, tv) en hls.js negeren zo'n edit list (een lege edit plus een tweede). Vanaf het begin scheelde dat weinig, na een start halverwege meer. Nagebootst met flitsen en piepjes in 10-bit HEVC met open GOP en E-AC3: zonder edit list gelezen kwam het geluid 0,15 s te laat (remux) of 0,10 s te vroeg (transcode). Nu `-hls_segment_options use_editlist=0`: waar een spoor begint, staat in zijn eigen tijdstempels; daarmee binnen 0,08 s, voor elke speler (test in `sessions.test.ts`). Getest in de cloudsandbox met FFmpeg 6.1 op de CPU; nog niet met FFmpeg 9 en QSV op de N100. Na de update `scripts\transcoder.ps1 -Restart`; de app hoeft niet opnieuw gebouwd te worden.
  - **Wachtrij:** maximaal `TRANSCODER_MAX_TRANSCODES` transcodes (standaard 2 zolang Plex de GPU deelt) en `TRANSCODER_MAX_SESSIONS` sessies. Remuxes tellen niet mee voor de transcodelimiet.
  - **Opruimen:** een sessie zonder verzoeken stopt na 60 s; de speler stuurt elke 20 s een heartbeat. Segmenten meer dan 10 min achter de nieuwste aanvraag worden verwijderd. `-readrate 1.5` na 60 s voorsprong voorkomt dat een remux de hele film op schijf zet. Na 10 minuten pauze laten de spelers (web en app) hun HLS-sessie los (`PARK_MS`), anders schreef FFmpeg de rest van de film weg; _Afspelen_ start een nieuwe sessie op dezelfde plek. Bij elke start maakt de transcoder `TRANSCODE_TMP/sessions` leeg (met herhalingen, zonder te stoppen als een oud FFmpeg-proces een bestand nog vasthoudt); `transcoder.ps1 -Restart` stopt ook de FFmpeg-processen van de oude transcoder.
- **Speler** (`apps/web/src/components/Player.tsx`):
  - **hls.js** wordt alleen geladen als het nodig is.
  - **Safari en iOS (2026-10-16).** De eigenaar meldde dat 4K "Origineel" in Safari op een MacBook Pro M4 niet in één keer startte; via 1080p en terug lukte het soms.
    - **Geen MKV meer proberen.** Safari speelt geen Matroska. Toch kreeg een MKV met ondersteunde codecs `maybe`, dus probeerde de speler het bestand eerst direct. Nu geeft het apparaat `matroska: false` door (`navigator.vendor` begint met "Apple", dus ook alle browsers op iOS), en gaat een MKV meteen naar een remux. Beeld (HEVC/HDR) en E-AC3 blijven daarbij zoals ze zijn.
    - **Apple's eigen HLS-speler.** In Safari speelt de speler HLS met de speler van de browser zelf, niet met hls.js (MSE). Die kan beter overweg met 4K HEVC, HDR, Dolby Vision, open GOP en grote segmenten.
    - **Begin van de playlist.** De transcoder zet `#EXT-X-START:TIME-OFFSET=0` in de playlist. Anders begint Safari een groeiende EVENT-playlist bij de live-rand.
    - **hls.js** (de andere browsers) buffert bij hoge bitrates minder seconden, zodat een 4K-remux binnen de MSE-limiet blijft (ongeveer 120 MB).
    - **Statistieken** tonen of HLS via de browser of via hls.js loopt.
    - **Getest door de eigenaar (2026-10-17):** 4K "Origineel" speelt nu in Safari op de MacBook. Dolby Vision profiel 5 (zonder HDR10-basis) werd als `hvc1` doorgegeven; sinds 2026-10-18 is dat `dvh1` (zie "Kijken").
  - **Eigen bediening** met de tijdlijn van het hele bestand. Een sessie begint op een tijdpunt en groeit; de tijd in de speler is de `start` van de sessie plus `currentTime`.
  - **Spoelen** binnen het deel dat al gemaakt is, blijft in de stream. Verder weg start een nieuwe sessie op die plek.
  - **Instellingen:** kwaliteit (onthouden per apparaat) en audiospoor, ook tijdens het kijken.
  - **Wachtrij:** de speler toont de plek in de wachtrij.
- **Tests:** unittests met een echte FFmpeg (wachtrij, opruimen, verwijderde segmenten, token). Playwright met de echte transcoder op de CPU: remux van VP9 met E-AC3 naar Opus, afgespeeld met hls.js, spoelen dat een tweede sessie start, en een H.264-transcode die via HTTP gecontroleerd wordt. Sandbox-Chromium kent geen H.264/AAC/HEVC.
- **Nog te doen op de N100:** meten hoeveel gelijktijdige transcodes echt gaan (nu `TRANSCODER_MAX_TRANSCODES=2`, zolang Plex draait).
- **Niet gebouwd:**
  - automatisch een lagere kwaliteit kiezen bij te weinig bandbreedte (de snelheidstest geeft advies);
  - HEVC als uitvoer;
  - inbranden van ondertitels (fase 6).

## Stand van fase 6 (ondertitels, 2026-10-16)

Gekozen door de eigenaar na fase 4, vóór fase 5. Gebouwd en getest in de cloudsandbox; OpenSubtitles is daar geblokkeerd, dus de provider is met nep-`fetch` getest. Op de N100 werken de ondertitels (eigenaar, 2026-10-17).

- **Bronnen**, via `SubtitleService` (`apps/api/src/subtitles/`):
  - **Ingebouwde tekstsporen** (SRT, ASS, mov_text). De transcoder leest ze met FFmpeg uit het bestand (`POST /subtitles`), vanaf de plek waar de kijker is (`-ss`), en sneller dan afspelen. Dat werkt dus ook bij direct play. Een spoor dat vanaf 0 helemaal gelezen is, bewaart de API in `CACHE_DIR/subtitles/embedded/`; de volgende keer is het er meteen.
  - **Losse bestanden** naast de video (`Film.nl.srt`, `Film.en.forced.ass`, `.sdh`), volgens de naamgeving van Plex. De scanner vindt ze (bron `EXTERNAL`) en ze worden alleen gelezen. `.hi` betekent Hindi, niet slechthorend.
  - **OpenSubtitles** (`OpenSubtitlesProvider`). Zoeken gaat op TMDB/IMDb-id; voor afleveringen op de id van de serie plus seizoen en aflevering. De `moviehash` van het bestand komt mee, zodat ondertitels die bij precies deze release horen bovenaan staan. Een download wordt omgezet en bewaard in `CACHE_DIR/subtitles/opensubtitles/`. Is de daglimiet bereikt, dan krijgt de speler 429 met de melding. Een account (`OPENSUBTITLES_USERNAME`/`PASSWORD`) is optioneel en geeft een hogere limiet.
  - **Beeldondertitels** (PGS, VobSub) staan in de lijst als niet ondersteund. Ze zijn alleen te tonen door ze in te branden, en `hwupload` faalt op de N100. Sinds 2026-10-19 leest de server PGS in het Engels of Nederlands als tekst (zie "Beeldondertitels als tekst en recaps").
- **WebVTT:** omzetten van SRT, ASS/SSA en WebVTT gebeurt in `packages/shared/src/subtitles.ts`. Opmaak uit ASS gaat verloren. Losse bestanden kunnen UTF-8, UTF-16 of Windows-1252 zijn.
- **Datamodel:** migratie `phase6_subtitles`. Een `Subtitle` is uniek per bestand, bron en `externalId` (stream-index, pad of id bij de provider). `offsetMs` is de verschuiving per ondertitel, ook voor ingebouwde sporen (die rij ontstaat dan vanzelf). Wordt een bestand opnieuw geprobed, dan verdwijnen de rijen van de ingebouwde sporen.
- **Speler** (`apps/web/src/subtitles/`, `SubtitlePanel`):
  - **CC-knop:** kiezen, verschuiven in stappen van 0,5 s, en zoeken op OpenSubtitles.
  - **Cues** staan in bestandstijd en worden op de eigen text track van de video gezet, min de `start` van de HLS-sessie. Zo passen ze bij direct play en bij sessies die later beginnen.
  - **Automatische keuze:** de taal die eerder op dit apparaat gekozen is. Anders Nederlands of Engels bij audio in een andere taal (anime). Anders geforceerde ondertitels in de taal van de audio.
- **Tests:** omzetting en talen; scanner met losse bestanden; transcoder-jobs met een echte FFmpeg; API-routes tegen PostgreSQL; Playwright met een ingebouwd SRT-spoor, een `.nl.srt`, een download van een nep-OpenSubtitles en de verschuiving.
- **Niet gebouwd:**
  - **Whisper** als terugval. Dat is zwaar voor de N100; later, eventueel met OpenVINO.
  - **Inbranden** van beeldondertitels.

## Stand van fase 5 (accounts en voortgang, 2026-10-16)

Gebouwd en getest in de cloudsandbox. Op de N100 draait het (2026-10-17): de eigenaar heeft het beheerdersaccount gemaakt, en `verify-setup.ps1` meldt 1 account (1 beheerder), 4 migraties en `JWT_SECRET`/`API_TOKEN` van 64 tekens.

- **Accounts** (ontwerpkeuze, de eigenaar kan die nog wijzigen):
  - Eén account per lid van het huishouden: naam, gebruikersnaam en wachtwoord (minstens 10 tekens). Geen aparte pincodeprofielen onder één account.
  - **Het eerste account** maakt de eigenaar via `POST /auth/setup` (het scherm _Welkom bij CineVault_). Dat kan alleen zolang er geen account is, en dat account wordt `ADMIN`.
  - **Beheerders** scannen, matchen, beheren accounts en verwijderen ondertitels. **Leden** kijken alleen.
  - De laatste beheerder kan niet weg of `USER` worden. Je kunt jezelf niet verwijderen.
- **Login** (`apps/api/src/auth/`):
  - **Wachtwoorden:** scrypt (N=2^15).
  - **Token:** een HS256-JWT met `JWT_SECRET`, met daarin een sessie-id. Sessies staan in de tabel `Session`, zodat uitloggen en een nieuw wachtwoord echt werken.
  - **Geldigheid:** 30 dagen, verlengd bij gebruik. De sessie in de database beslist, niet de `exp` van de token: de app en de tv houden hun eerste token, en werden daardoor eerst na 30 dagen uitgelogd (gevonden bij de controle van 2026-10-19).
  - **Web:** een httpOnly-cookie `cinevault_session` (`SameSite=Lax`, `Secure` achter HTTPS via `X-Forwarded-Proto`).
  - **Expo:** dezelfde token als `Authorization: Bearer`; `POST /auth/login` geeft die ook terug.
  - **Scripts:** `API_TOKEN` (`scan.ps1`, `verify-setup.ps1`). Dat geeft beheerrechten, maar geen kijkvoortgang.
  - `scripts/up.ps1` maakt `JWT_SECRET` en `API_TOKEN` aan als ze ontbreken (64 hex-tekens, zonder BOM). Zonder `JWT_SECRET` gebruikt de API een tijdelijk geheim, en is na elke herstart iedereen uitgelogd.
  - Alles onder `/api` vraagt een login, behalve `/health` en `/auth/status|setup|login`. Ook de streams, HLS-segmenten, afbeeldingen en ondertitels vragen een login. Dat werkt omdat de browser de cookie meestuurt.
  - **Te veel pogingen:** na 5 mislukte pogingen per gebruikersnaam moet je wachten, 30 s en steeds het dubbele, tot maximaal 15 min.
    - De drempel is per gebruikersnaam en niet per IP, omdat Docker Desktop de IP-adressen van de apparaten verbergt.
    - Een onbekende naam kost even veel tijd als een bekende.
- **Webapp:**
  - **Wie kijkt er?** Het apparaat onthoudt welke profielen er inlogden (alleen namen, in `localStorage`). Je kiest een profiel en typt je wachtwoord.
  - **Pagina's:** _Profiel_ (naam, kleur, wachtwoord) en _Accounts_ (alleen beheerders). _Aandacht nodig_ en de scanknoppen zie je alleen als beheerder.
- **Voortgang** (`apps/api/src/progress.ts`), per profiel in `WatchProgress`:
  - De speler meldt de positie elke 10 s, bij pauze, aan het eind en bij sluiten (`keepalive`).
  - **Gezien:** in de laatste 8% of de laatste 2 minuten (de aftiteling hoeft niet). Gezien blijft gezien als je opnieuw kijkt.
    - **Alleen door te kijken (2026-10-17):** een melding die meer dan 10 minuten verder ligt dan de vorige positie, telt niet als gezien. Dat is spoelen, of een speler die ten onrechte "einde" meldt.
    - **Aanleiding:** in de eerste Android-build meldde expo-video het einde al voor het laden. Een aflevering stond daardoor na één tik op gezien, en het klokje startte de volgende.
  - Handmatig "gezien" kan per aflevering, seizoen of titel.
  - **Verder kijken** (`GET /continue`, op de startpagina):
    - per titel één regel uit de laatste 90 dagen;
    - halverwege (vanaf 60 s) of de volgende aflevering;
    - specials tellen niet mee voor "volgende".
  - **De speler:**
    - start waar het profiel was, met _Verder vanaf … · Vanaf het begin_;
    - na een aflevering start de volgende na 10 s.
  - Posters en afleveringen tonen een voortgangsbalk of een vinkje.
- **Tests:**
  - **API** tegen PostgreSQL: login, setup, throttling, sessies, rollen, voortgang per profiel, en "volgende".
  - **Web:** unittests voor setup, login en hervatten.
  - **Playwright:** logt in via `e2e/global-setup.ts` en test de volgende aflevering, verder kijken, gezien, en inloggen als lid zonder beheerpagina's.
- **Niet gebouwd:**
  - **Wachtwoord vergeten:** er wordt geen e-mail verstuurd. Een beheerder zet een nieuw wachtwoord.
  - **Kinderprofielen** of leeftijdsgrenzen.
  - **Voortgang van multi-episode-bestanden:** die telt alleen voor de eerste aflevering, net als de koppeling (fase 2).

## Webinterface vernieuwd (verzoek eigenaar, 2026-10-17)

De eigenaar vond de webapp niet professioneel genoeg, en niet geoptimaliseerd voor verschillende apparaten (ook de speler). Gevraagd: een layout zo professioneel mogelijk, naar het voorbeeld van Plex en Netflix, voor smartphones, tablets, laptops en smart-tv's. Gebouwd vóór fase 8; getest in de cloudsandbox (Chromium). De eigenaar vindt het resultaat "super goed" (2026-10-17).

- **API** (`apps/api/src/home.ts`, `routes/home.ts`, `routes/library.ts`):
  - **`GET /home`:**
    - **Billboard:** titels met een backdrop en een beschrijving, elke dag in een andere volgorde. Elke titel heeft `play`: wat _Afspelen_ voor dit profiel start (de film, of de aflevering waar het profiel is).
    - **Rijen:** _Hoog gewaardeerd_ en de zes meest voorkomende genres; sinds 2026-10-17 ook de rijen met wat nieuw is (zie "Nieuw op de startpagina").
  - **`GET /search`:** zoekt in alle bibliotheken. Titels die met de zoekterm beginnen, staan eerst.
  - **Sorteren en filteren:** `sort` (`title`, `added`, `year`, `rating`) en `genre` op `/libraries/:id/items`, plus `GET /libraries/:id/genres`.
  - Lijsten bevatten nu ook `backdropUrl`.
- **Webapp:**
  - **Stijl:**
    - **Kleuren:** de huiskleuren, met een donkerdere ink (`#0A1230`) als achtergrond.
    - **Iconen:** eigen SVG-iconen (`components/Icon.tsx`), geen emoji's meer.
    - **Schaal:** maten schalen mee tussen telefoon en tv (`clamp`).
    - **Laden:** skeletons in plaats van "Laden…".
  - **Navigatie:**
    - **Bovenbalk:** vast, en transparant boven de grote afbeeldingen.
    - **Telefoon (< 760 px):** een tabbalk onderaan (Home, de bibliotheken, Zoeken).
    - **Profielmenu:** Profiel, Beheer, Accounts, Ander profiel.
  - **Pagina's:**
    - **Startpagina:** billboard en rails (`Hero`, `Rail`, `cards.tsx`).
    - **Bibliotheek:** sorteren, genre en automatisch verder laden.
    - **Zoeken:** `/search`.
    - **Detailpagina:** backdrop over de hele breedte, met badges (4K, HDR10, Dolby Vision, 5.1). Een serie start bij de juiste aflevering, er is _Vanaf het begin_ (`?start=0`), de afleveringen staan als kaarten met een seizoenkeuze, en de cast staat in een rail. Matchen staat achter een ⋯-menu.
    - **Beheer:** `/admin`, met tabbladen voor Overzicht, Aandacht nodig en Accounts.
  - **Speler** (`PlayerControls.tsx`):
    - **Bovenbalk:** titel en aflevering.
    - **Tijdlijn:** gebufferd deel en tijd onder de muis.
    - **Laden:** een spinner tijdens het bufferen.
    - **Midden:** grote knoppen op touchschermen.
    - **Gebaren:** tik toont of verbergt de bediening, dubbeltik spoelt 10 s, dubbelklik opent volledig scherm.
    - **Panelen:** _Audio en ondertitels_ en _Instellingen_ (kwaliteit, statistieken), als paneel rechts, op de telefoon onderaan.
    - **Knoppen:** volgende aflevering, beeld-in-beeld, AirPlay (Safari) en volledig scherm (op de iPhone via `webkitEnterFullscreen`, op Android met landscape-lock).
    - **Onthouden:** het volume.
    - **Media Session:** vergrendelscherm, mediatoetsen en afstandsbedieningen.
  - **Smart-tv's** (`device.ts`, `spatialNav.ts`):
    - **Herkenning:** de user agent (Tizen, webOS, Android TV, Fire TV …) zet `html.tv`, met grotere tekst en een duidelijke focus. Onder _Profiel_ → _Weergave op dit apparaat_ is dat te forceren.
    - **Pijltjes:** die verplaatsen de focus naar het dichtstbijzijnde element in die richting. Op een computer pas zodra iets de focus heeft, zodat de pijltjes daar de pagina blijven scrollen.
    - **Terug:** de terugtoets van de afstandsbediening (461 bij webOS, 10009 bij Tizen) gaat terug.
  - **PWA-basis:** `manifest.webmanifest`, iconen en `apple-touch-icon`, zodat de app op het beginscherm kan, met `viewport-fit=cover` en safe areas.
- **Tests:**
  - **Unit:** startpagina, pijltjesnavigatie, Safari, hervatten.
  - **Playwright:** alle bestaande flows, plus de afstandsbediening.
  - **Screenshots:** `E2E_DEMO=1 pnpm e2e screens` maakt een demobibliotheek met getekende posters (`e2e/demo.ts`) en screenshots op telefoon, tablet, laptop en tv in `test-results/screens/`.
- **Niet gebouwd:**
  - **Offline:** geen service worker.
  - **Chromecast:** niet ondersteund.
  - (_Trailers_, _Meer zoals dit_, logo's van titels en backdrops voor 4K-tv's zijn sinds 2026-10-18 gebouwd, zie "Kijken".)

## Back-ups van de database (2026-10-17)

Door de eigenaar gevraagd na de test van de nieuwe interface. Map gekozen door de eigenaar: `C:\Users\nsamo\Documents` (de map `CineVault-backups` daarin).

- **Wat:** alleen de PostgreSQL-database:
  - de accounts, de kijkvoortgang, de handmatige matches en de verschuivingen van ondertitels;
  - de koppeling van titels aan bestanden.
- **Wat niet:**
  - **De media:** CineVault leest die alleen.
  - **De cache:** die wordt opnieuw opgehaald.
  - **`.env`:** de eigenaar bewaart die zelf, er staan sleutels in.
- **`scripts/backup.ps1`:**
  - **Hoe:** `pg_dump --format=custom` in de `db`-container. Het bestand wordt met `docker compose cp` gekopieerd en niet via een PowerShell-pipeline, omdat die binaire gegevens beschadigt.
  - **Controle:** daarna leest `pg_restore --list` het bestand terug.
  - **Bestandsnaam:** `cinevault-YYYY-MM-DD_HHmm.dump` in `BACKUP_DIR`, standaard `Documents\CineVault-backups`.
  - **Bewaren:** `BACKUP_KEEP_DAILY` (14) dagelijkse en `BACKUP_KEEP_WEEKLY` (8) wekelijkse back-ups (de nieuwste per week, met maandag als begin). De net gemaakte back-up en back-ups met een `-Tag` worden nooit verwijderd.
  - **Plannen:** `-Install` maakt een geplande taak (03:30, `StartWhenAvailable`, in de sessie van de gebruiker vanwege Docker Desktop).
  - **Status en logboek:** `-Status`, en `backup.log` in de back-upmap.
- **`scripts/restore.ps1`:**
  - **Kiezen:** standaard de nieuwste nachtelijke back-up, of `-File`; `-List` toont ze.
  - **Bevestigen:** de gebruiker typt `RESTORE`.
  - **Vooraf:** het maakt eerst een back-up met de tag `before-restore`.
  - **Terugzetten:** het stopt de API en zet de back-up in een eigen database (`<db>_restore`, `pg_restore --exit-on-error`). Pas als dat gelukt is, neemt die de plaats van de huidige in (hernoemen); anders blijft alles zoals het was. Daarna start het de API weer; die voert nieuwere migraties uit. (Eerst ging het met `--clean` over de huidige database heen. Dat faalde bij een back-up van vóór een nieuwere migratie, omdat nieuwere tabellen naar de oude verwezen; met de hand nagespeeld, 2026-10-19.)
- **`verify-setup.ps1`:** een sectie _Backups_ (de taak, en een waarschuwing als de laatste back-up ouder is dan 48 uur).
- **Getest in de cloudsandbox:**
  - **Opzet:** Docker met `postgres:16` en pwsh 7, met een tabel met `pg_trgm`-index.
  - **Terugzetten:** een back-up maken, gegevens wijzigen en terugzetten werkt; de gegevens en de index zijn terug.
  - **Opruimen:** getest met 70 dagen aan back-ups. Een eerste versie hield daarbij de oudste in plaats van de nieuwste (`Group-Object` sorteert zelf); dat is opgelost.
  - **Nog te doen:** testen op de N100, met Windows PowerShell 5.1 en de geplande taak.

## Stand van fase 8: Android-app (2026-10-17)

Gevraagd door de eigenaar: eerst Android, iOS later. Gebouwd in de cloudsandbox; de APK bouwt GitHub Actions. De eerste geslaagde build (run 2, 2026-10-17) duurde 32 minuten, waarvan 31 voor Gradle zonder cache, en gaf een APK van 51 MB, nog met de debug-sleutel. **Getest door de eigenaar op de eigen Android-telefoon (2026-10-17, build 7):** de app werkt, het automatische beeldformaat werkt, en de bediening flitst niet meer.

- **App** (`apps/mobile`): Expo SDK 58, React Native 0.88, expo-router (tabs en stack), expo-video (ExoPlayer), expo-image, expo-secure-store. Package `nl.cinevault.app`, minimaal Android 7. Nederlands, in de huiskleuren, alleen donker.
- **Gedeeld met de webapp** (`packages/shared`): de API-client, `planPlayback`, de direct-play-check, de ondertitelconversie, en nu ook `viewing.ts` (hervatten, ondertitelkeuze, cues) en `format.ts`. De webapp gebruikt die nu ook.
- **Login:** dezelfde accounts. De app gebruikt de token als `Authorization: Bearer`, bewaard in SecureStore. Afbeeldingen, streams en HLS krijgen dezelfde header. _Wie kijkt er?_ onthoudt de profielen op het apparaat.
- **Server:** de app praat met Caddy (`WEB_PORT`, 8765), net als de browser. Het adres vult de gebruiker in (LAN of Tailscale). HTTP is toegestaan (`usesCleartextTraffic`), omdat er nog geen domein is.
- **Schermen:** verbinden, profielen en inloggen, Home (billboard, verder kijken, rails), bibliotheek (sorteren, genre, verder laden), zoeken, detailpagina (seizoenen, afleveringen, cast, gezien) en profiel.
- **Direct play** (`modules/cinevault-media`, een eigen Expo-module in Kotlin): vraagt `MediaCodecList` welke hardware- en softwaredecoders er zijn, met profiel (HEVC Main10, VP9 profiel 2, AV1 Main10) en resolutie. `src/playback/device.ts` zet de RFC 6381-codecs om. MKV speelt ExoPlayer zelf af. Anders volgt een remux of transcode via HLS, zoals in de browser.
- **Speler** (`src/player/`): eigen bediening (tik, dubbeltik ±10 s, tijdlijn), kwaliteit en audiospoor, ondertitels met verschuiven en OpenSubtitles, de wachtrij, heartbeat, voortgang elke 10 s, volgende aflevering na 10 s en beeld-in-beeld. Ondertitels tekent de app zelf over het beeld.
- **Speler vernieuwd (eigenaar, 2026-11-04: "Ik vind de player nog niet optimaal. Pas de layout aan zodat het mooi eruit ziet en ook heel gebruiksvriendelijk is").** `src/player/Controls.tsx`, telefoon, tablet en auto (de tv houdt `TvControls`): verlopen boven en onder (`LinearGradient`) in plaats van zwarte balken; de titel en aflevering boven, met Cast en een **slot** (`lock`/`unlock` in `Icon.tsx`: de bediening verdwijnt en tikken, dubbeltikken en knijpen doen niets, behalve _Tik om te ontgrendelen_ tonen, voor kinderen); grotere knoppen in het midden (±10 s 58, afspelen 84 met een witte rand); de tijdlijn met de resterende tijd; een onderbalk met `BarButton`s (_Audio en ondertitels_ in messing als er ondertitels aan staan, _Instellingen · Origineel_, rechts _Volgende aflevering_), op een smal scherm korte labels. _Intro overslaan_ is een witte knop net boven de onderbalk (`bottomHeight` gemeten), net als _Verder vanaf_ en de kaart _Volgende aflevering_ (met een aftelbalk; op een staande telefoon over de hele breedte). Panelen: op een staande telefoon van onderen (hooguit 72%, met een greep), anders rechts; op een tablet of in de auto (liggend, minstens 1000 breed) audio en ondertitels naast elkaar in een paneel van 720. Ondertitels schuiven omhoog als de bediening in beeld is (`onShownChange`, `controlsUp` in `Player.tsx`). Dubbeltik toont _10 seconden_ in een halve cirkel. Gecontroleerd met typecheck, lint, tests, `expo export` en de tijdelijke webversie op een liggende en staande telefoon en een tablet; nog niet op een telefoon.
- **Beeldformaat (verzoek eigenaar, 2026-10-17).** De eigenaar zag zwarte balken rondom een 2.39:1-film. Die film zat in een 16:9-beeld, met de zwarte balken in het bestand zelf.
  - **Balken vinden:** de transcoder draait `cropdetect` op een paar keyframes (`POST /crop`, `src/crop.ts`).
  - **Opslaan:** de API bewaart de uitkomst per bestandsversie (grootte en mtime) in `CACHE_DIR/picture` (`GET /files/:id/picture`).
  - **Keuze in de app** (`src/player/fit.ts`):
    - _Automatisch_ (standaard) zoomt in (`cover`) als daarbij hooguit 3% van het echte beeld wegvalt. Anders blijft het beeld passend (`contain`).
    - _Passend_ en _Vullen_ zijn vaste keuzes onder _Instellingen_.
    - Knijpen met twee vingers wisselt voor deze video.
  - **Niet tijdens het kijken wisselen (2026-10-17).** De eigenaar zag het beeld een paar seconden verspringen. Dat gebeurde toen de uitkomst van de balkendetectie pas binnenkwam terwijl de video al speelde. Nu wacht de eerste stream maximaal 1,5 s op die uitkomst. Daarna ligt de keuze vast voor deze video; een latere uitkomst telt pas de volgende keer. De detailpagina en de vorige aflevering vragen de uitkomst al vooraf op. Een nieuwe keuze (knijpen of instelling) geeft een nieuwe `VideoView`, zodat het beeld niet verkeerd blijft staan.
- **Scherm blijft aan (verzoek eigenaar, 2026-10-19).** Op de telefoon ging het scherm uit tijdens een film. `keepScreenOnWhilePlaying` van expo-video zet de vlag alleen op de `VideoView` van dat moment, en een nieuw beeldformaat geeft een nieuwe `VideoView`. Nu houdt `expo-keep-awake` (`activateKeepAwakeAsync`, tag `cinevault-player`) het scherm aan zolang de video speelt of laadt, ook op de tv. In de browser doet de Wake Lock-API hetzelfde (`useWakeLock` in de webspeler; alleen via HTTPS of localhost). Bij pauze mag het scherm weer uit. Nog niet op een telefoon getest.
- **Flitsende bediening (2026-10-17).** In een schermopname van de eigenaar flitste de bediening in de eerste seconden van een remux snel aan en uit. Het lag niet aan het beeld: ExoPlayer meldde vele keren per seconde "speelt" en "speelt niet", en de bediening volgde elke melding. De bediening reageert nu pas op stilstaan na 0,8 s, en de spinner verschijnt pas na 0,4 s bufferen. Een pauze die de kijker zelf kiest, telt meteen.
- **Chromecast (verzoek eigenaar, 2026-10-17).** Afzender is de Android-app (`react-native-google-cast` 4.9.1, Default Media Receiver `CC1AD845`, geen eigen receiver). Nog niet op een echte Chromecast getest.
  - **Afspelen:** altijd via een HLS-sessie van de transcoder (`src/player/CastPlayer.tsx`). `castDevice()` in `packages/shared` kiest per model: 4K HEVC voor Chromecast Ultra en Google TV, anders 1080p H.264 (`maxHeight` in `PlaybackCapabilities`). Audio wordt AAC. Onder _Profiel_ → _Chromecast_ is 4K of 1080p vast te kiezen.
  - **Links zonder login:** een Chromecast kan de cookie of header niet meesturen. `POST /api/cast/token` geeft links met een token van 12 uur in het pad: `/api/cast/<token>/playback/<sessie>/…`, `subtitles/<id>/track.vtt?shiftMs=` en `poster`, met CORS. Een token opent één sessie en de ondertitels en poster van één bestand. Het pad houdt het token vast voor de relatieve segmentnamen in de playlist. Fastify's `maxParamLength` is daarvoor 600.
  - **Adres:** `CAST_BASE_URL` (bijvoorbeeld `http://192.168.0.110:8765`), anders het adres dat de telefoon gebruikt. Een Tailscale-adres bereikt een Chromecast niet.
  - **Telefoon als afstandsbediening:** pauzeren, spoelen (dichtbij binnen de sessie, verder weg een nieuwe sessie), voortgang elke 10 s, heartbeat elke 20 s, en de volgende aflevering. Na _Stoppen met casten_ speelt de telefoon verder waar de tv was.
  - **Niet gebouwd:** een kleine bediening buiten de speler. (Ondertitels kiezen tijdens het casten is sinds 2026-11-13 gebouwd, zie hieronder. Casten vanuit de browser is sinds 2026-10-20 gebouwd, zie "Casten vanuit de browser en Omdat je … keek".) Onzeker: of de Default Media Receiver HLS van een `http://`-adres laadt (mixed content). Lukt dat niet, dan is HTTPS met een eigen domein nodig, of een eigen receiver.
- **"Casten op een tv lijkt het niet te doen" (eigenaar, 2026-11-13; geen details over het apparaat of de melding).** Niet nagespeeld: er is geen Chromecast in de cloudsandbox, en de documentatie van Google over het laden van http-media was daar niet bereikbaar. Gevonden in de code en opgelost, getest met de API (`cast.test.ts`, `health.test.ts`), de gedeelde logica en Playwright (een nep-tv die niets ophaalt), nog niet met een echte tv:
  - **Stil falen:** geen van beide zenders (app `CastPlayer`, web `CastView`) keek naar een fout van de ontvanger (`idleReason` `ERROR`); de telefoon bleef op _Laden…_. Nu vraagt hij na het laden elke 3 s (90 s lang) `GET /api/cast/status/:session` (`CastStatus`: wat de tv ophaalde, met user agent en de laatste fouten; in het geheugen, `CastWatch` in `apps/api/src/cast.ts`) en zegt `castProblem` (`packages/shared/src/cast.ts`) waarom: niets opgehaald na 20 s (http-adres, niet bereikbaar, of `CAST_BASE_URL` niet gezet), een fout van de server, of de stream opgehaald en niet gespeeld. In dat laatste geval (bij 4K) één keer opnieuw in 1080p H.264 (`hd`, `castIs4k`). `useCastCheck` in `apps/mobile/src/player/castCheck.ts` en `apps/web/src/castCheck.ts`.
  - **Fouten zonder CORS:** een fout van de transcoder (503 _not ready yet_, 404, 410) ging via de gewone foutafhandeling, zonder `Access-Control-Allow-Origin`; de ontvanger zag dan een geblokkeerd verzoek. Nu met CORS en de status.
  - **Log:** de eerste vraag van de tv per sessie als `cast: the TV fetched` (info, met user agent), fouten als `cast: the TV got an error` (de cast-routes loggen verder op `warn`).
  - **Gezondheid → Chromecast** (`HealthService.cast`): `CAST_BASE_URL` niet gezet (onbekend), niet bereikbaar vanaf de server (let op; https: NAT loopback), of via http (let op: de ontvanger van Google draait op https, en HLS via http is gemengde inhoud die hij waarschijnlijk weigert). Advies: `CAST_BASE_URL=https://cine-vault.nl` als de router NAT loopback doet. Uitleg: `docs/server-setup.md`, stap 45.
  - **Nog nodig van de eigenaar:** het apparaat (Chromecast, Google TV, een tv met Chromecast ingebouwd), vanaf de app of de browser, de melding die nu verschijnt, `CAST_BASE_URL`, en of `cast: the TV fetched` in het log staat. Zonder NAT loopback zijn er nog: een eigen ontvanger (Cast Developer Console, mag in ontwikkeling via http) of een https-adres voor thuis.
- **"Er komt geen ondertiteling mee" (eigenaar, 2026-11-13, nadat casten werkte).** De ontvanger laadt één heel WebVTT-bestand (`SubtitleOption.url`) en kan een spoor dat nog gelezen wordt niet volgen. Ingebouwde tekstsporen (de meeste MKV's) hebben pas een `url` als ze ooit vanaf 0 helemaal gelezen zijn; de zenders stuurden ze daarom niet mee, en de cast-route zocht een ingebouwd spoor (`embedded:<index>`) als databaserij op en vond het niet. In de app kon tijdens het casten ook niets gekozen worden. Opgelost, getest met de API (`scanner.test.ts`, `cast.test.ts`), de gedeelde logica en Playwright (nep-tv, ingebouwd SRT-spoor), nog niet met een echte tv:
  - **Klaarzetten** (`POST /files/:id/subtitles/:subtitleId/prepare`, `SubtitleService.prepare`): een ingebouwd tekstspoor wordt op de achtergrond vanaf 0 helemaal gelezen (dezelfde `extract` van de transcoder, de API vraagt elke 2 s, bewaart het dan als het spoor), een beeldspoor gaat naar de tekstherkenning. De zender vraagt elke 3 s opnieuw tot er een `url` is (`readProgress` 0-1 tussendoor; na een fout 30 s wachten). `useCastSubtitle` in `apps/mobile/src/player/castSubtitle.ts` en `apps/web/src/castSubtitle.ts` zet het antwoord in de ondertitellijst.
  - **Cast-route:** `/api/cast/<token>/subtitles/embedded:<index>/track.vtt` geeft het bewaarde spoor van dat bestand (404 met CORS zolang het er niet is).
  - **Opnieuw laden:** wordt de ondertitel klaar, of kiest de kijker een andere (of _Uit_), dan laadt de zender dezelfde sessie opnieuw op de tv, op dezelfde plek en met het spoor (`loaded` in `CastPlayer`/`CastView`).
  - **Kiezen tijdens het casten:** de knop _Ondertitels: …_ met een lijst in de app, een keuzelijst _Ondertitels op de tv_ in de browser (`castSubtitleChoices`: tekst, en beeldsporen die tekst kunnen worden). Onder de status _Ondertitels worden klaargezet voor de tv: 42%…_ (`castSubtitleNote`).
- **Home laadt lang na een tijd niet gebruiken (eigenaar, 2026-11-17).** Niet op een telefoon nagespeeld; gevonden in de code. De app begon met het adres van de vorige keer. Is dat er nu niet (het thuisadres op mobiele data, of de wifi nog niet verbonden na lang slapen), dan hing het verzoek voor Home: de `fetch` van React Native (OkHttp, `OkHttpClientProvider`) heeft geen time-out (`connectTimeout(0)`), dus tot Android de verbinding opgeeft (ongeveer 2 minuten), en met `retry: 1` nog eens. `recheck` vond het andere adres wel binnen 2,5 s, maar `invalidateQueries` hergebruikt een lopend verzoek van een query zonder data (`Query.fetch` breekt alleen af als er al data is), dus Home bleef op het oude adres wachten (nagespeeld met `@tanstack/react-query`). Nu (`src/session.tsx`, `src/server.ts`): bij de start eerst `pickServer` (hooguit 2,5 s, alleen met twee adressen; het opstartscherm blijft zolang staan); bij een ander adres eerst `cancelQueries`, dan `invalidateQueries`; en elk leesverzoek (GET/HEAD) van de API-client geeft het na 30 s op (`withReadTimeout`, `READ_TIMEOUT_MS`; schrijven niet, goedkeuren wacht tot 45 s op Sonarr). Gecontroleerd met typecheck, lint, tests (`server.test.ts`) en `expo export`; nog niet op een telefoon. Nodig: een nieuwe build.
- **Audio die toch niet werkt:** sommige telefoons hebben een Dolby-decoder die E-AC3 toezegt, maar voor apps faalt. Een fout van de audio- of videodecoder zet dat codec op "niet afspeelbaar", en de app gaat verder met een remux of transcode. Audiocodecs onthoudt de telefoon.
- **Omgepakt beeld dat niet laadt (eigenaar, 2026-11-12: Lupin S1E2 op de telefoon bij 18:32, _Source error Unexpected IllegalArgumentException_, remux met het beeld gekopieerd en E-AC3 naar AAC).** De oorzaak is nog niet gevonden: na drie nieuwe sessies op die plek bleef ExoPlayer de stream weigeren bij het laden (geen decoderfout). Nagebootst met 10-bit HEVC met B-frames en open GOP in MKV, halverwege gestart, met FFmpeg 6.1 en `use_editlist=0`: de segmenten zijn in orde (`tfdt` 0, geen edit list); FFmpeg 9 van de N100 kon in de cloudsandbox niet draaien, en de broncode van `movenc`/`hlsenc` doet daar hetzelfde. Vangnet in `Player.tsx`: geeft een remux met gekopieerd beeld na één nieuwe poging nog een _Source error_, dan gaat het videocodec van dit bestand op "mislukt" (`failed`, zoals bij een decoderfout) en zet de server het beeld om naar H.264, verder op dezelfde plek. Nog nodig van de eigenaar: of het bestand vanaf het begin wel speelt, of 1080p werkt, en de technische details (codec, HDR/Dolby Vision).
- **Bouwen** (`.github/workflows/android.yml`): eerst bij elke wijziging in `apps/mobile` of `packages/shared`, sinds 2026-10-19 alleen met de hand (zie "Bouwen op de N100"). Prebuild, release-APK voor `arm64-v8a`, met de run als `versionCode`. Eerst ook `armeabi-v7a`, maar het compileren van de native code kostte zo'n 25 minuten per build. Met alleen 64-bit ongeveer de helft. Oude 32-bit-telefoons en sommige tv-boxen vallen daardoor af. De APK staat bij de pre-release `android-latest` en als artifact. `android/` is gegenereerd en staat niet in git; `plugins/withAndroidRelease.js` zet daarin de ondertekening en de `versionCode`.
- **Bouwen op de N100 (verzoek eigenaar, 2026-10-19).** Build 41 startte niet: de gratis Actions-minuten van de privé-repository waren op (_recent account payments have failed or your spending limit needs to be increased_); een build met drie APK's kostte zo'n 100 minuten. De eigenaar koos voor bouwen op de N100.
  - **`scripts/build-apk.ps1`** bouwt het image `cinevault-android-builder` (`docker/android-builder/Dockerfile`: `node:22-bookworm`, OpenJDK 17, de command-line tools van Android, `sdkmanager --licenses`) en draait `docker/android-builder/build.sh` met `--cpus 3`. Dat kloont de gecommitte code (`HEAD`) van de repository (read-only op `/src`) naar het volume `cinevault-android-work`, installeert alleen `@cinevault/mobile...`, bouwt `packages/shared`, draait `expo prebuild` en `gradlew assembleRelease` voor de tv (`armeabi-v7a,arm64-v8a`) en de telefoon (`arm64-v8a`), en zet de APK's en `build.txt` in `downloads/` (Caddy: `/android` en `/tv`). Gradle installeert SDK-platform, build tools en NDK zelf in het volume `cinevault-android-sdk`. `-Variant phone|tv`, `-Fresh` (nieuw volume), `-Cpus`, `-DebugKey`.
  - **Sleutel:** `Documents\CineVault-android\cinevault-upload.keystore` met het wachtwoord en de alias uit `github-secrets.txt` (`android-key.ps1`), als omgevingsvariabelen, read-only gekoppeld. Zonder sleutel weigert het script, behalve met `-DebugKey`: de `debug.keystore` uit het sjabloon van `expo prebuild`, hetzelfde bestand als in de GitHub-builds. **Die builds hadden nooit een eigen sleutel** (de secrets ontbraken: _No ANDROID_UPLOAD_KEYSTORE secret_, eigenaar 2026-10-19: geen sleutel in `Documents\CineVault-android`). Een build met `-DebugKey` installeert dus over build 40; de overstap naar een eigen sleutel vraagt één keer de app verwijderen. **Besluit eigenaar (2026-10-19):** over naar een eigen sleutel (`android-key.ps1`), met één keer de app verwijderen op telefoon en tv.
  - **Buildnummer** (`versionCode`): het aantal commits (`git rev-list --count HEAD`), ook in de workflow, zodat APK's van beide over elkaar heen installeren (build 40 van GitHub < 114 commits).
  - **De workflows** `android.yml` en `android-smoke.yml` starten alleen nog met de hand (`workflow_dispatch`); er is dus geen automatische rooktest meer.
  - **Getest in de cloudsandbox:** `build.sh` tot vlak voor Gradle (`PREPARE_ONLY=1`), in een container zonder SDK en Java (`dl.google.com` en `deb.debian.org` zijn daar geblokkeerd); een tweede run duurt 10 s. De syntaxis van `build-apk.ps1` met pwsh 7. Gradle en de SDK nog niet: dat gebeurt pas op de N100. **De eerste build op de N100 is geslaagd** (eigenaar, 2026-10-19), met de eigen sleutel. **Tijdens een build (2026-10-20)** laadde de startpagina heel traag: Gradle (`--cpus 3`) deelt de Docker-VM met de API en PostgreSQL. Na de build werkte alles weer (eigenaar). Een build dus liever als er niemand kijkt, of met `-Cpus 2`.
- **Sneller bouwen (verzoek eigenaar, 2026-10-22: "kijk of er een mogelijkheid is om de build apk te optimaliseren en versnellen").** Gecontroleerd in de cloudsandbox: `build.sh` tot vlak voor Gradle (`PREPARE_ONLY=1`, twee keer, en na een wijziging in `app.json`), het `app/build.gradle` van `expo prebuild`, en het nieuwe Groovy-blok met Gradle 8.14; Gradle met de SDK nog niet (geblokkeerd), dus nog niet op de N100:
  - **Eén Gradle-build voor telefoon en tv** (`cinevault.splitApks=true`, `plugins/withAndroidRelease.js`): ABI-splits met `universalApk`. De telefoon-APK is de `arm64-v8a`-split, de tv-APK de universele (`armeabi-v7a` en `arm64-v8a`). Eerst twee builds na elkaar, met twee keer de JavaScript-bundel en R8. Met één `-Variant` zoals eerst.
  - **Android-map bewaren** (`build.sh`): `git clean` laat `apps/mobile/android/` staan, en `expo prebuild --clean` draait alleen als de native opzet veranderde: een hash (`android/.cinevault-native`) van `app.json`, `package.json`, `plugins/`, `modules/`, `assets/`, `pnpm-lock.yaml`, `build.sh` en de Node-versie. Anders houdt Gradle zijn incrementele staat, en compileert het C++ en Kotlin die niet veranderden niet opnieuw. `-Fresh` begint nog steeds helemaal opnieuw.
  - **Geen lint bij release** (`lint { checkReleaseBuilds false }`), `--build-cache --parallel` (de cache in `GRADLE_USER_HOME` op het volume), en `TMPDIR=/work/tmp`, zodat de cache van Metro tussen builds blijft.
- **Build faalde: Cast-bibliotheek 23.0.0 (2026-10-20).** `:app:compileReleaseKotlin` faalde op de N100 met _Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.4.0, expected version is 2.2.0_. Oorzaak: `react-native-google-cast` vraagt `play-services-cast-framework:+`, en Google bracht 23.0.0 uit, gebouwd met Kotlin 2.4; React Native 0.88 compileert met Kotlin 2.2. Nu `androidPlayServicesCastFrameworkVersion: "22.+"` in `app.json` (de plugin zet dat als `castFrameworkVersion` in `android/build.gradle`, ook voor de bibliotheek zelf). Daarmee is de build op de N100 weer gelukt (eigenaar, 2026-10-20). Pas naar 23 als React Native Kotlin 2.4 gebruikt; een wekelijkse routine (_Kotlin 2.4 check_, maandag 08:48) kijkt dat na op npm en meldt het in de sessie. Ook nieuw: `build.sh` bewaart de uitvoer van Gradle in `logs\android-build.log` en herhaalt _What went wrong_ aan het eind.
- **Crash bij het starten (2026-10-18).** Sinds build 20 (meldingen) crashte de app bij het logo. Oorzaak: R8 (`enableMinifyInReleaseBuilds`) haalde `WorkDatabase_Impl` weg, de Room-database van WorkManager (`expo-background-task`), die bij de start via `androidx.startup` op naam wordt aangemaakt. Een `-keep`-regel voor subklassen van `RoomDatabase` staat nu in `extraProguardRules` (`app.json`).
- **Rooktest** (`.github/workflows/android-smoke.yml`, na elke build, of bij een wijziging aan de test met de nieuwste geslaagde build): een telefoon-emulator (Android 11, x86_64) en een tv-emulator (Android TV 11, x86, 1080p) starten `CineVault-x86.apk`, een extra build van dezelfde code die niet gepubliceerd wordt (met de arm64-APK onder ARM-vertaling zoekt React Native zijn bibliotheken in de verkeerde map en stopt hij), met de demobibliotheek (`E2E_DEMO=1`). Op de tv maakt `apps/mobile/e2e/tv.yaml` schermafbeeldingen van elk scherm, gepubliceerd als pre-release `tv-screens` (op te halen met `gh api …/releases/assets/<id>`; artifacts zijn vanuit de sandbox niet bereikbaar). Op de telefoon tegen de API-server van de browsertests, en Maestro (`apps/mobile/e2e/smoke.yaml`) verbindt, logt in, opent Home, Ontdekken en Profiel en start de app opnieuw. Het crashlog staat in het log van de job en in het artifact `smoke-<run>`. De release wacht er niet op.
- **Ondertekening:** met de eigen sleutel van `scripts/android-key.ps1`. Die maakt de sleutel met keytool in Docker, in `Documents\CineVault-android`, en schrijft de drie GitHub-secrets uit. Zonder die secrets gebruikt de build de openbare debug-sleutel van Expo.
- **In de sandbox** is `dl.google.com` (de Maven-repository van Google en de Android SDK) geblokkeerd. Daarom bouwt GitHub Actions de APK, en niet de sandbox. Typecheck, lint, de unittests en `expo export` draaien wel in de sandbox.
- **Uitleg voor de eigenaar:** `docs/android.md`.
- **Android TV (verzoek eigenaar, 2026-10-17).** Gebouwd en in de cloudsandbox gecontroleerd (typecheck, lint, tests, `expo export`). **Getest door de eigenaar (2026-10-17, build 11, op een projector met Android TV):** "alles werkt". Vraag van de eigenaar daarbij: waarom Engelse ondertitels (PGS, "English (SDH)") niet te kiezen zijn. Dat zijn beeldondertitels (zie fase 6).
  - **Eén app.** Op een tv (`Platform.isTV`) toont de app de schermen uit `src/tv/`. De route-bestanden kiezen zelf: `export default isTV ? TvHome : HomeScreen`. De telefoonschermen bleven zoals ze waren.
  - **Geen andere React Native.** Core React Native 0.88 heeft op Android al wat nodig is: `Platform.isTV`, focus met de D-pad, `onFocus`/`onBlur`, `nextFocus*`, en de toetsen als `onHWKeyEvent` (`ReactAndroidHWInputDeviceHelper`). `react-native-tvos` is dus niet nodig.
  - **Manifest** (`plugins/withAndroidTV.js`): `LEANBACK_LAUNCHER`, `leanback` en `touchscreen` niet verplicht, en een banner van 320×180 (`assets/tv-banner.png`).
  - **Focus** (`src/tv/focus.tsx`):
    - **Zichtbaar:** `TvPressable` geeft een messing rand en vergroot een beetje.
    - **Startpunt:** `autoFocus` zet de focus op de eerste knop van een scherm, via `focusView(tag)` in de eigen module (`requestFocus`). `hasTVPreferredFocus` is te vroeg en `focus()` staat achter een feature flag.
    - **Terugkomen:** `FocusMemory` zet de focus terug waar hij was als je terugkomt.
    - **Gedeeld met de telefoon:** `Button` en `IconButton` gebruiken `TvPressable` ook op de telefoon; daar krijgt niets focus.
  - **Schermen:** een menu links (`TvNav`, met `tabBarPosition: 'left'`), en verder Home met billboard en rails, de bibliotheek, zoeken, de detailpagina (seizoen-chips en een rail met afleveringen) en het profiel. Inloggen en verbinden zijn de telefoonschermen, met zichtbare focus.
  - **Bibliotheek vernieuwd (verzoek eigenaar, 2026-10-17).** De eigenaar vond de bibliotheek onoverzichtelijk: drie rijen chips boven het raster.
    - **Volgorde:** overal Films, Series, Anime (`sortLibraries` in `apps/api/src/libraries.ts`, voor `/libraries` en de rijen van `/home`). Een map met "anime" in de naam telt als anime; bij gelijk type op naam.
    - **Menu:** Films, Series en Anime staan elk in het menu links (`TvNav`), met een eigen icoon. Een andere bibliotheek begint in A-Z en alle genres, met de focus op de eerste poster.
    - **Kop** (`TvLibrary`, vaste hoogte): de bibliotheek en het aantal titels, en de titel die de focus heeft, met jaar, waardering, genres, twee regels beschrijving en zacht de backdrop (na 0,35 s rust). Lijsten (`ItemSummary`) bevatten daarvoor nu ook `overview`, `rating` en `genres`. Alleen de kop volgt de focus (een eigen store met `useSyncExternalStore`), niet het raster.
    - **Sorteren en Genre** zijn twee knoppen rechts in de kop. Ze openen een lijst rechts in het scherm (geen `Modal`); links, rechts en de uiteinden houden de focus in de lijst, en terug sluit hem.
    - **Raster:** 7 kolommen met alleen posters; de titel staat in de kop.
  - **Verspringende focus (eigenaar, 2026-10-20: "veel bugs met navigatie die automatisch verspringt").** Gevonden in de code, opgelost en gecontroleerd met typecheck, lint, tests (`test/focusRules.test.ts`) en `expo export`, nog niet op een tv:
    - **Omhoog of omlaag naar een andere rij** kwam op de kaart op dezelfde plek in de layout van die rij: de rijen schuiven met `translateX`, en de focus-zoektocht van Android kijkt naar de layout, niet naar wat getekend is. Van de 8e kaart van een rij ging het naar de 8e van de volgende, die dan wegschoof. Nu neemt een rij de focus op de kaart aan zijn linkerrand, de kaart die hij het laatst had (`TvRow`, `rowFocusTarget`; de kaarten melden zich via `RowContext`).
    - **Weggevallen focus:** verdwijnt de view met de focus (een rij die na een refetch van volgorde wisselt, een knop die verdwijnt), dan geeft Android de focus aan de eerste focusbare view, meestal het menu. Een focuswissel zonder toets in de laatste 0,7 s (`onHWKeyEvent`) en zonder eigen `focusLater` zet de focus nu terug waar hij op het scherm was, anders op het startpunt (`autoFocus`) van dat scherm (`unexplainedFocus`, `restoreFocus`, `FocusMemory`).
    - **Rechts uit het menu** kwam op wat in de layout naast het menu ligt (het billboard of de eerste rij), niet op de rij in beeld. Nu terug naar de laatste plek op de pagina.
    - **Billboard op Home:** elke 12 s een andere titel. Had die geen bestand, dan verdween _Afspelen_ (met de focus) en kreeg _Meer info_ de `autoFocus`. Nu staan er altijd dezelfde drie knoppen (_Afspelen_ heet dan _Bekijken_ en opent de titel).
    - **Verder kijken:** de kaarten hadden de aflevering in hun key; na het kijken van een aflevering werd de kaart vervangen en viel de focus weg. Nu per titel.
    - **`TvBrowse`** houdt de rij met de focus bij op key in plaats van op nummer, zodat een rij die erbij komt (_Verder kijken_ na het kijken) de pagina niet naar een andere rij laat springen.
  - **"Naar beneden verspringt 1 naar rechts" (eigenaar, 2026-10-28).** Omhoog of omlaag naar een rij ging naar de kaart die die rij het laatst had, in de veronderstelling dat die aan de linkerrand staat. Een korte rij (zoals _Verder kijken_) schuift niet, en een lange rij stopt met schuiven aan zijn eind; die kaart stond dan rechts, en de focus sprong er na een tel heen. Nu gaat de focus naar de kaart die getekend recht onder (of boven) de vorige focus staat (`rowFocusTarget` in `focusRules.ts`): elke rij houdt bij hoe ver hij geschoven is, en waar de kaart met de focus getekend staat (`setFocusedCardCenter`); komt de focus van een knop (geen rij), dan de kaart getekend onder waar Android landde. In de speler gaat omlaag vanaf de tijdlijn nu naar _Afspelen/Pauze_ (`nextFocusDown`); Android koos de knop het dichtst bij het midden van het scherm. Gecontroleerd met typecheck, lint, tests en `expo export`, nog niet op een tv.
  - **"De focus springt naar een onbedoelde sectie" (eigenaar, 2026-11-10).** Android zoekt de volgende focus op de plek in de layout; de rijen schuiven (`translateX` in `TvRow`, `translateY` in `TvBrowse`) en dat ziet die zoektocht niet. Gevonden in de code, opgelost en gecontroleerd met typecheck, lint, tests (`test/focusRules.test.ts`) en `expo export`, nog niet op een tv:
    - **Omhoog of omlaag** vanaf een kaart ver rechts in een lange rij sloeg een korte rij over (bijvoorbeeld _Verder kijken_) of ging het menu in, en omhoog vanaf de bovenste knoppen ging het menu in. Nu zijn de regels van een pagina secties (`src/tv/stack.tsx`: `TvStack`, `TvSection` met `order`): elke `TvPressable` in een sectie krijgt `nextFocusUp`/`nextFocusDown` naar de eerste view van de sectie erboven en eronder (`sectionNeighbors` in `focusRules.ts`); bovenaan en onderaan blijft de focus staan. Een `TvRow` zet de focus daarna op de kaart onder de vorige focus (`rowFocusTarget`). Op Home en Ontdekken (`TvBrowse`: het billboard en elke rij), de pagina van een titel (`TvItem`: knoppen, seizoenen, afleveringen, collectie, _Meer zoals dit_, cast) en een titel in Ontdekken (`TvDiscoverTitle`). Seizoenchips die over meer regels lopen (`wraps`) houden binnen zich de zoektocht van Android.
    - **Rechts aan het eind** van een rij, of op de laatste knop of chip van een regel (`lastInLine`), sprong naar een kaart van een andere rij die in de layout rechts ligt; nu blijft de focus staan (`nextFocusRight` naar zichzelf).
    - **Een knop die wegvalt:** na _Aanvragen_ in Ontdekken kwam er een tekst in de plaats van de knop met de focus, en ging de focus naar het menu. Nu is de status dezelfde knop. `FocusMemory` onthoudt ook de laatste 8 views met de focus; is de laatste weg, dan gaat de focus naar de vorige die er nog is, in plaats van waar Android hem neerzette.
    - Het zoekveld van Ontdekken: omhoog blijft in het veld.
  - **"Eén keer omhoog gaat terug naar de top van Home" (eigenaar, 2026-11-10, na de secties).** Nagespeeld met een simulatie van de focus-zoektocht van Android (react-test-renderer, `nextFocus*`, de toetsen en focusmeldingen van React Native; in de scratchpad, niet gecommit), en opgelost:
    - **Hoofdoorzaak:** React Native stuurt op hetzelfde kanaal als de toetsen (`onHWKeyEvent`) ook `focus` en `blur` (met `eventKeyAction` -1). Die overschreven de laatste toets, zodat `TvRow` na omhoog niet meer wist dat het omhoog was (de kaart getekend boven de vorige focus), en de vangnetten voor focus uit het menu en voor een weggevallen view niet werkten. Nu telt alleen een echte toets (`remoteKeyOf` in `focusRules.ts`).
    - **Naar een regel die er niet boven of onder ligt:** Android kan bij omhoog nog op de knoppen van het billboard uitkomen (onzichtbaar, maar focusbaar in de layout). Een `TvPressable` weet nu de regel waar de focus vandaan kwam (`order`, en de `order` erboven en eronder); landt omhoog of omlaag op een andere regel, dan gaat de focus naar de regel erboven of eronder (`wrongLine`). Alleen de view die de app zelf de focus gaf (`focusTag`, `askedFor`) is uitgezonderd, ook vlak na een eigen verplaatsing.
    - Gecontroleerd met de simulatie (o.a. 200 willekeurige toetsen: elke omhoog en omlaag precies één rij), typecheck, lint, tests en `expo export`; nog niet op een tv.
  - **Geen `Modal` op de tv:** een `Modal` is een apart venster, en daar komen de toetsen niet aan. Panelen staan daarom gewoon in het scherm.
  - **Speler** (`src/tv/TvControls.tsx`, in plaats van `Controls`):
    - **Bediening verborgen:** een onzichtbaar vlak houdt de focus, zodat de toetsen aankomen. Links en rechts spoelen. Snel na elkaar of vasthouden gaat sneller (10, 30, 60 en 120 s, `seekStep`). Het spoelen gebeurt pas na 0,8 s rust.
    - **Bediening zichtbaar:** op de tijdlijn spoelen links en rechts. `nextFocusLeft`/`Right` wijzen naar de tijdlijn zelf, zodat de focus daar blijft.
    - **Mediatoetsen:** afspelen/pauze, terug- en vooruitspoelen en _Volgende_ werken altijd.
    - **Terug:** sluit eerst een paneel, verbergt dan de bediening, en verlaat daarna de speler.
    - **Op de tv uit:** casten (`useCastClient` geeft `null`) en beeld-in-beeld. De ondertitels zijn groter.
  - **Bouwen:** de workflow bouwt naast elkaar `CineVault.apk` (arm64, telefoons) en `CineVault-TV.apk` (`armeabi-v7a` en `arm64-v8a`). Veel tv's draaien 32-bit Android, ook op een 64-bit-chip. Een aparte job `publish` zet ze samen in `android-latest`.
  - **Installeren op de tv:** de repository is privé, dus `scripts/get-apk.ps1` haalt de APK's met `gh` naar `downloads/`. Caddy serveert ze op `/tv` en `/android` (`/downloads`, read-only). Op de tv gaat het met de app Downloader. Zie `docs/android.md`, deel 6.
  - **Inloggen met de telefoon (verzoek eigenaar, 2026-10-17):** op de tv begint het inlogscherm met een QR-code en een code van 8 tekens (`BCDF-2345`, zonder klinkers, 0/O en 1/I). Gebouwd en in de cloudsandbox getest (API, Playwright voor `/link`), nog niet op een echte tv.
    - **API** (`apps/api/src/auth/deviceLogin.ts`, routes in `routes/auth.ts`): `POST /auth/device` (zonder login) geeft `code`, een geheim `secret` en `interval` (3 s). De tv vraagt met `POST /auth/device/poll { secret }` tot het antwoord `approved` is, met een eigen sessie (token en gebruiker, zoals `/auth/login`); daarna is de code weg (410). Iemand die is ingelogd, ziet de code met `GET /auth/device/:code` en bevestigt met `POST …/approve`; de tv logt dan in als die persoon. Codes staan in het geheugen, 10 minuten, hoogstens 50 tegelijk.
    - **Tv** (`src/tv/screens/TvLogin.tsx`, `src/tv/QrCode.tsx` met `qrcode-generator` 1.4.4 en react-native-svg): de QR-code is `<server>/link?code=…`, het adres dat de tv zelf gebruikt. Een verlopen code wordt vanzelf vervangen. _Inloggen met wachtwoord_ opent het oude scherm, dat _Inloggen met je telefoon_ terug heeft.
    - **Telefoon:** in de browser `/link` (`LinkPage`, na de gewone login), en in de app _Profiel_ → _Inloggen op een tv_ (`LinkTv`) om de code te typen.
    - **Niet gebouwd:** hetzelfde in de webinterface op smart-tv's (Tizen, webOS), en een QR-code die de telefoon-app zelf opent (de camera opent de browser).
  - **Niet gebouwd:** zoeken met de stem, een rij in het startscherm van Google TV en de HDR-mogelijkheden van het scherm uitlezen.
- **Android Automotive OS (verzoek eigenaar, 2026-11-02: "Maak een CineVault app voor AAOS"; de auto is een Polestar of Volvo, hoe hij erop komt wist de eigenaar nog niet).** Geen aparte app: een video-app ("parked app") mag dezelfde release en hetzelfde pakket als de telefoon gebruiken, met `android.hardware.type.automotive` op `required="false"` (developer.android.com/training/cars/distribute). Gecontroleerd met typecheck, lint, tests, `expo export`, `expo prebuild` (het manifest) en de Kotlin met `kotlinc` 2.2 tegen nagebootste Expo- en Android-klassen; nog niet in een auto of de emulator, en Gradle niet (geblokkeerd in de cloudsandbox).
  - **Manifest** (`plugins/withAndroidAutomotive.js`): `uses-feature` automotive, Wi-Fi, camera en `screen.portrait`/`landscape` niet verplicht; `android:appCategory="video"`; `uses-library android.car` niet verplicht; geen `distractionOptimized` (volgens de richtlijnen van Google niet voor video-apps), behalve in de eigen build van de auto (`build-apk.sh --variant car`, `CINEVAULT_CAR=1`; verzoek eigenaar 2026-11-20, met de plugin die de eigenaar aanleverde): `distractionOptimized` op `MainActivity` en de volledige-schermspeler van expo-video, `sensorLandscape`, en `configChanges` aangevuld. De speler pauzeert video tijdens het rijden nog steeds zelf. Gecontroleerd met `expo prebuild` (met en zonder), nog niet in de auto of in de Play Console. **Guard op de mediasessies (eigenaar, 2026-11-20, eigen ontwerp na correcties van Claude):** afspelen van buiten de app (stuur, mediabediening van de auto, Assistent) ging rechtstreeks naar ExoPlayer, langs de guard in `Player.tsx` heen. Nu weigeren beide mediasessies van expo-video (`buildBasicMediaSession` en `VideoMediaSessionCallback` van de playback-service) `COMMAND_PLAY_PAUSE` met `RESULT_ERROR_INVALID_STATE` en pauzeren ze, zolang video niet mag (`VideoGate` in `patches/expo-video@58.0.11.patch`, `patchedDependencies` in `pnpm-workspace.yaml`; de Dockerfiles van API en web kopiëren `patches/`, anders faalt hun `pnpm install`). De status zet `CinevaultMediaModule` (de enige die de rijbeperkingen leest) in `DrivingGate.videoAllowed` (`@JvmField`, geen video bij `isRequiresDistractionOptimization` of `UX_RESTRICTIONS_NO_VIDEO`; weer `true` als niemand meer luistert); expo-video leest hem via reflectie, met een R8-keep-regel in `app.json`. De listener op `playingChange` in `Player.tsx` blijft: de eigen knoppen, de volgende aflevering en een nieuwe stream gaan niet via een mediasessie. Gecontroleerd: de gepatchte bestanden gecompileerd met Kotlin 2.2 en `-Werror` tegen nagebootste media3-klassen, met een test op de JVM (stilstaan, rijden, spoelen); media3 zelf en Gradle zijn geblokkeerd in de cloudsandbox, dus nog niet in de auto. Nog open: `COMMAND_PREPARE`/`COMMAND_SET_MEDIA_ITEM` (alleen uitbreiden als de auto toch nog een start forceert).
  - **Rijden** (`CinevaultMediaModule`: `isAutomotive`, `drivingRestricted`, event `onDrivingRestrictionChange`): `android.car` via reflectie (`Car.createCar`, `CarUxRestrictionsManager`, een `Proxy` als listener, `isRequiresDistractionOptimization`), zodat de module zonder `useLibrary 'android.car'` bouwt en op telefoon en tv niets doet. `src/car.ts`: `isCar` en `useDrivingRestricted` (één listener, `useSyncExternalStore`). De speler pauzeert bij rijden en bij `AppState` niet actief, en pauzeert meteen weer als iets afspeelt tijdens het rijden (een nieuwe stream, de volgende aflevering); daarover staat _Video speelt alleen als de auto stilstaat_. Hervatten doet de kijker zelf (Google-richtlijn DD-2). Het systeem legt tijdens het rijden ook zelf een scherm over de app.
  - **In de auto:** de telefoon- en tabletschermen (`Platform.isTV` is daar false); geen Cast (`CastIcon`, `useCastClient`) en geen beeld-in-beeld; inloggen begint met de QR-code van de tv (`login.tsx`). De terugknoppen staan al in elk scherm (richtlijn AN-1: een auto heeft niet altijd een systeem-terugknop).
  - **Google Play:** `scripts\build-apk.ps1 -Aab` maakt ook `play\CineVault.aab` (`bundleRelease`, `armeabi-v7a,arm64-v8a`, map `play/` niet in git en niet via Caddy). De weg voor Polestar/Volvo: een interne test in de Play Console (geen review), formfactor Android Automotive OS met het type track _Mobiel_, Play App Signing door Google (onze sleutel wordt de uploadsleutel). Zelf een APK installeren kan alleen als de auto ontwikkelaarsopties/ADB toont; dat bevestigen Polestar en Volvo niet. Uitleg: `docs/android.md`, deel 9.
  - **Indeling voor de Polestar 4 (verzoek eigenaar, 2026-11-02: "Optimaliseer de app voor de Polestar 4").** Liggend scherm van 1920×1200; alles achter `isCar`, telefoon, tablet en tv blijven gelijk. `carLayout` in `src/car.ts` (`rail` 124, `column` 760, `hero` 0,6, `button` 56). Gecontroleerd met typecheck, lint, tests en `expo export`, en met een tijdelijke webversie van de app (react-native-web, `isCar` aan, de demobibliotheek) op 1280×720 bij 1,5× en 1536×864 bij 1,25×; niet gecommit, en nog niet in een auto.
    - **Menu:** links een rail (`tabBarPosition: 'left'`, `tabBarVariant: 'material'`, label onder het icoon), want onderaan zit de balk van de auto. `SideMenuWidth` (context in `components/sizes.ts`, `useContentWidth`) trekt de rail af voor rasters en rijen (`useGrid`, `useCardWidths`); eerst viel het raster van de bibliotheek rechts buiten beeld.
    - **Home:** het billboard is 60% van de schermhoogte, met titel, tekst en knoppen links in een kolom (hooguit 62% breed) en een verloop van links; knoppen houden hun breedte. Kaarten 150 (poster) en 290 (liggend).
    - **Titel:** lagere achtergrond (51%), de info in een kolom van 760, _Afspelen_ en de andere knoppen niet uitgerekt, afleveringen hooguit 1100 breed met een grotere still. Hoogtes op hele pixels (×4), anders een naadje onder de achtergrond.
    - **Knoppen** minstens 56 hoog (`IconButton` 52). **Profiel** in een kolom, zonder Chromecast en _Inloggen op een tv_; teksten zeggen _deze auto_ (`thisDevice`).
    - **Speler:** de melding over rijden staat boven de knoppen in het midden, en geen spinner terwijl de auto rijdt.
  - **Groter in de auto (eigenaar, 2026-11-03, met een foto van de Polestar 4: "pas het inderdaad aan. De ondertitelingen mogen ook groter").** De app stond erop via de interne test van Google Play (mobiele track, formfactor Android Automotive OS actief). Op de foto bleek de Polestar zijn scherm op ongeveer 1× te tekenen (de rail van 124 dp was zo'n 124 pixels), terwijl de layout getest was op 1,4-1,5×: alles een derde kleiner dan bedoeld. Nu:
    - **`carScale`** (`src/car.ts`): `1.4 / PixelRatio`, tussen 1 en 1,6; buiten de auto 1. **`src/carScale.ts`** (als eerste geïmporteerd in `index.ts`) vervangt `StyleSheet.create` en schaalt in elke stijl de maten (`scaleStyle` in `src/scaleStyle.ts`: lettergrootte, regelhoogte, breedte/hoogte, marges, padding, gap, hoeken, posities; niet randen, flex, opaciteit, kleuren of percentages; waarden onder 2 blijven). Dat geldt ook voor bibliotheken zoals de tabbalk. Maten in code gaan via `px()`: `Icon`, `IconButton`, `useGrid`, `useCardWidths`, de rail, de logo's, de speler en `AdminScreen`. Tekststijlen zonder `fontSize` krijgen er een (14, de standaard van React Native), anders bleven ze klein.
    - **Klimaatbalk:** de schermen van de tabs krijgen in de auto `paddingBottom: insets.bottom`, zodat de laatste rij boven de balk uitkomt.
    - **Ondertitels in de auto:** 30 in plaats van 20 (vóór het schalen), halfvet, verder van de randen.
    - Gecontroleerd met typecheck, lint, tests (`test/scaleStyle.test.ts`), `expo export` en de tijdelijke webversie op 1920×1130 bij 1×; nog niet in de auto.
    - **Kijken tijdens het rijden (vraag eigenaar, voor de kinderen achterin):** niet op het middenscherm. De richtlijnen van Google (DD-2) en het systeem van de auto houden video tegen zolang de auto rijdt; geluid tijdens het rijden is een bèta voor uitgekozen partners. Wel: een tablet of telefoon met de app achterin.
  - **Niet gebouwd:** geluid tijdens het rijden (bèta van Google, alleen voor partners), een staande indeling voor auto's met een staand scherm (Polestar 2, Volvo EX30: die krijgen de tabletindeling), en een APK met x86_64 voor de emulator van Android Studio op Windows.
- **Niet gebouwd:**
  - **Chromecast** en downloaden om offline te kijken.
  - **Play Store:** de app wordt als APK geïnstalleerd.
  - **iOS:** volgt later.

## Intro overslaan (verzoek eigenaar, 2026-10-17)

"Dit moet mogelijk zijn in elke app": de knop _Intro overslaan_ zit in de webspeler, de Android-app, de tv-app en in de Chromecast-bediening op de telefoon. Gebouwd en getest in de cloudsandbox, nog niet op de N100.

- **Vingerafdrukken** (`apps/transcoder/src/fingerprint.ts`, `POST /fingerprint`):
  - **Audio:** FFmpeg decodeert het begin van een bestand naar mono 11025 Hz: de eerste 45%, maximaal 10 minuten.
  - **Bits:** elke 0,031 s (tot 2026-10-28 elke 0,124 s) wordt een venster van 4096 samples 32 bits. Dat zijn energieverschillen tussen 33 frequentiebanden (300-2000 Hz) en de verandering ten opzichte van het vorige venster (Haitsma & Kalker).
  - **Eigen code:** de FFT staat in de transcoder zelf, zonder Chromaprint of npm-pakketten. 10 minuten audio kost ongeveer 2 s rekenwerk.
  - **Hoofdstukken** komen mee via `ffprobe -show_chapters`.
  - **Leessnelheid:** `-readrate` begrenst het lezen van de schijf. Een onleesbaar bestand geeft 422; de API slaat het dan over.
- **Vergelijken** (`apps/api/src/intro/match.ts`):
  - **Verschuiving:** gelijke waarden stemmen op een verschuiving tussen twee afleveringen, zoals bij audio-herkenning.
  - **Overeenkomst:** langs de beste verschuivingen tellen frames met hooguit 8 verschillende bits als gelijk, met gaten tot 10 frames.
  - **De intro** is het langste stuk van 12-150 s dat voor minstens 60% overeenkomt. Stilte telt niet mee en breekt het stuk ook niet.
  - **Per aflevering:** de server vergelijkt met de 4 dichtstbijzijnde afleveringen. Hij kiest het stuk waar de meeste het over eens zijn. Bij een seizoen van één of twee afleveringen vergelijkt hij ook met de seizoenen ervoor en erna.
  - **Hoofdstukken gaan voor:** een hoofdstuk _Intro_, _Opening_ of _OP_ wint van de audio.
- **Zoeken** (`apps/api/src/intro/service.ts`, `IntroService`):
  - **Wat:** afleveringen van gewone seizoenen, vanaf 4 minuten.
  - **Wanneer:** op de achtergrond, alleen als er 2 minuten geen stream of HLS-verzoek was (`Activity`, via een `onRequest`-hook).
  - **Voorrang:** een aflevering die geopend wordt (`GET /files/:id` of `/intro`), en de rest van dat seizoen. Dat werk leest langzamer van de schijf.
  - **Volgorde (verzoek eigenaar, 2026-10-21):** daarna de nieuwste bestanden eerst (`MediaFile.addedAt`, dan het pad), ook bij _Alles nu zoeken_. Eerst was het op alfabet van het pad, zodat een nieuwe aflevering achter de hele achterstand aansloot.
  - **Nieuw binnengekomen (eigenaar, 2026-11-12: "Het systeem lijkt niet automatisch de intro, recap en credits te zoeken nadat de media is toegevoegd").** In de code geen fout gevonden die het zoeken stillegt; wel twee gaten. (1) Een nieuwe aflevering kwam pas aan de beurt als er 2 minuten niemand keek; werd er die avond gekeken, dan nog niet, en opende iemand hem, dan begon het zoeken pas dan (bij een nieuw seizoen, waarvan nog geen enkele aflevering gelezen is, duurt dat minuten). (2) De spelers vroegen maar ongeveer 5 minuten of het klaar was. Nu: na elke scan van een bibliotheek (`onLibraryScanned` → `IntroService.scanned`) gaan de bestanden die in die scan binnenkwamen of veranderden en nog open zijn (intro of aftiteling; bij films de aftiteling), de nieuwste eerst, in een eigen rij (`fresh`). Die komt direct na een geopende aflevering aan de beurt, ook als er gekeken wordt (dan op het rustige leestempo van een geopende aflevering, `PRIORITY_READ`; anders op volle snelheid); de recap volgt in de gewone tweede ronde. De spelers (web, telefoon, tv) vragen nu ongeveer 30 minuten (`POLLS` 90). Getest tegen PostgreSQL met een nep-transcoder (`intro.test.ts`), nog niet op de N100. Blijft het uit: _Beheer_ → _Overzicht_ zegt waarop het zoeken wacht (_playback_, _transcoder_), en `docker compose logs api` de regels `intro search`.
  - **Cache:** vingerafdrukken staan in `CACHE_DIR/intro/<id>.json`, per bestandsversie.
  - **Is de transcoder weg,** dan probeert de server het later opnieuw, zonder het bestand te markeren.
- **Datamodel** (migratie `intro`): `MediaFile.introStartMs`, `introEndMs`, `introSource` (`chapter`, `audio`, `manual`) en `introCheckedAt`.
  - **Na een nieuwe probe:** verandert een bestand, dan zoekt de server opnieuw, behalve bij `manual`.
- **API:**
  - **Voor de spelers:** `FileContext.intro` en `introPending`. `GET /files/:id/intro` vragen de spelers opnieuw op zolang het zoeken loopt, elke 20 s, ongeveer 5 minuten lang.
  - **Voor beheerders:** `PUT`/`DELETE /files/:id/intro` (met de hand, ook "geen intro"), `POST …/detect` en `GET /intro/status`.
- **Spelers:**
  - **De knop:** `inIntro()` in `packages/shared` laat hem zien tot 3 s voor het einde van de intro. Hij spoelt naar het einde.
  - **Web:** de knop staat rechtsonder, ook als de bediening verborgen is, en de toets **S** werkt ook. Op een tv krijgt de knop de focus.
  - **Telefoon:** de knop staat rechtsonder.
  - **Tv:** bij verborgen bediening staat _Intro overslaan · OK_ rechtsonder, en OK slaat over. Bij zichtbare bediening staat de knop in de rij.
  - **Chromecast:** de knop staat in de bediening op de telefoon.
  - **Met de hand corrigeren:** in de webspeler, alleen voor beheerders, onder _Instellingen_ → _Intro_ (_Begint hier_, _Eindigt hier_, _Geen intro_, _Opnieuw zoeken_).
  - **Beheer → Overzicht:** toont hoe ver het zoeken is.
- **Tests:**
  - **Transcoder:** vingerafdrukken met een echte FFmpeg, met twee "afleveringen" met dezelfde toon op een ander moment en in AAC en Opus.
  - **API:** vergelijken met nepdata; het hele pad op echte audio (de code van de transcoder via Node); de zoekdienst en de routes tegen PostgreSQL met een nep-transcoder.
  - **Playwright:** de knop en het beheerpaneel.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 21.
- **Niet gebouwd:**
  - (_Aftiteling overslaan_ en _intro automatisch overslaan_ zijn sinds 2026-10-17 gebouwd, zie "Aftiteling en Sonarr/Radarr"; AniSkip voor anime sinds 2026-10-19, zie "AniSkip".)

## Nieuw op de startpagina (verzoek eigenaar, 2026-10-17)

"Ik wil op de startpagina ook kunnen zien welke media recent toegevoegd is en nieuwe releases en dergelijke." Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL, Playwright), nog niet op de N100.

- **Wanneer iets binnenkwam** (migratie `added_dates`):
  - **`MediaFile.addedAt`:** de mtime van het bestand, of het moment van de eerste scan als dat eerder is (een klok in de toekomst). Zo klopt de volgorde ook na de eerste scan, toen CineVault alles tegelijk zag. Een gewijzigd bestand op hetzelfde pad (een upgrade) houdt zijn datum.
  - **`MediaItem.addedAt`:** het nieuwste bestand van de titel, na elke scan bijgewerkt. _Nieuw toegevoegd_ (`sort=added`) sorteert daarop; een serie met een nieuwe aflevering staat dus weer vooraan.
  - **`MediaItem.releaseDate`:** van TMDB (`release_date`/`first_air_date`) of TVmaze (`premiered`). Films die al gematcht waren, haalt de volgende scan één keer opnieuw op.
- **Rijen op `/home`**, in deze volgorde, na _Verder kijken_:
  - **Nieuwe afleveringen** (`HomeRow.episodes`, type `NewEpisodes`): per serie de afleveringen die binnen een week van de nieuwste binnenkwamen, zonder wat het profiel al zag, vanaf de eerste daarvan. Liggende kaarten (still) met _S2 · A1 · 8 nieuwe afleveringen_ en een vlag _Nieuw_ als het binnen twee weken was (`newEpisodesLabel`, `isRecent` in `packages/shared`). De kaart opent de serie. Een begonnen aflevering krijgt een balk voor die aflevering (`fraction`). `items` bevat de series ook, voor oudere apps, maar zonder de voortgang van de hele serie: de eigenaar zag in een oudere app een balk van 3 van 4 afleveringen onder Hell's Kitchen en las die als voortgang van de nieuwe aflevering (2026-10-18).
  - **Recent toegevoegde films** per filmbibliotheek, met _Alles bekijken_. Dit vervangt _Nieuw in …_; series en anime zitten in _Nieuwe afleveringen_.
  - **Nieuwe releases:** films met een releasedatum (anders 1 januari van het jaar) en series met een uitgezonden aflevering die er is, in de laatste 365 dagen.
  - Daarna _Hoog gewaardeerd_ en de genres, zoals eerst.
- **Vanzelf scannen:** `SCAN_INTERVAL_MINUTES` (standaard 60, `0` is uit). Een scan die nog loopt, wordt niet dubbel gestart.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 22.
- **Niet gebouwd:** een kaart die meteen de nieuwe aflevering afspeelt. (_Binnenkort_ is sinds 2026-10-18 gebouwd, zie "Kijken".)

## Aftiteling en Sonarr/Radarr (verzoek eigenaar, 2026-10-17)

"Bouw eerst de aftiteling overslaan en vervolgens meteen zien wat sonarr en radarr gedownload hebben." Gebouwd en getest in de cloudsandbox (transcoder met echte FFmpeg, API tegen PostgreSQL, Playwright), nog niet op de N100.

- **Aftiteling vinden** (zelfde techniek als de intro, `apps/api/src/intro/`):
  - **Transcoder:** `POST /fingerprint` heeft `start` (seconden): FFmpeg zoekt met `-ss` vóór `-i` en decodeert vanaf daar. Het antwoord meldt `start`. Een transcoder zonder `start` in het antwoord is te oud: de API wacht dan (503) en markeert niets.
  - **Venster:** de laatste 40% van een aflevering, maximaal 10 minuten (tot 2026-10-28 7). De vingerafdruk staat in `CACHE_DIR/intro/<id>.end.json`.
  - **Overeenkomst:** `sharedSegment` met eigen grenzen voor de aftiteling, 15-600 s (`CREDITS_LIMITS`; tot 2026-10-28 360 s). Een hoofdstuk _Credits_, _End Credits_, _Ending_, _ED_ of _Outro_ gaat voor (`creditsChapter`, het laatste).
  - **Datamodel** (migratie `credits`): `MediaFile.creditsStartMs`, `creditsEndMs`, `creditsSource`, `creditsCheckedAt`. Na een nieuwe probe opnieuw zoeken, behalve bij `manual`. `IntroService` doet intro en aftiteling per aflevering, alleen wat nog niet gezocht is.
  - **API:** `IntroInfo` heeft `credits`, `creditsSource`, `introPending` en `creditsPending`; `pending` is een van beide (oudere apps vragen zo lang door). `FileContext.credits` en `creditsPending`. `PUT`/`DELETE /files/:id/credits` en `POST …/credits/detect` (tot 15 minuten). `IntroStatus` telt `creditsChecked` en `creditsFound`.
  - **Gezien:** vanaf 5 s voor het begin van de aftiteling, als die in de tweede helft ligt (`reachedEnd`).
- **Spelers** (`inCredits`, `afterCredits` in `packages/shared`):
  - **Met een volgende aflevering:** vanaf het begin van de aftiteling de kaart _Volgende aflevering_ met 10 s aftellen (pauzeert met de video), en _Aftiteling bekijken_. Daarna blijft de kaart aan het eind, met _Stoppen_.
  - **Zonder volgende,** maar met minstens 20 s na de aftiteling: _Aftiteling overslaan_ (dezelfde knop als _Intro overslaan_, toets S).
  - **Web, telefoon en tv;** tijdens het casten een knop op de telefoon. De beheerder corrigeert de aftiteling in de webspeler onder _Instellingen_ → _Aftiteling_.
  - **Intro automatisch overslaan:** per apparaat (`localStorage` op het web, SecureStore in de app), onder _Instellingen_. Eén keer per keer afspelen; wie terugspoelt in de intro, ziet hem.
- **Sonarr en Radarr** (`POST /api/hooks/arr`, `routes/hooks.ts`):
  - **Sleutel:** `WEBHOOK_TOKEN` (`up.ps1` maakt hem, minstens 32 tekens), als `?token=` of als wachtwoord (Basic auth). Zonder login; de sleutel start alleen een scan. Zonder token: 404.
  - **Events:** _Test_ antwoordt meteen. _Grab_, _Health_ en dergelijke doen niets. Alle andere (import, upgrade, rename, delete) vragen een scan.
  - **Welke bibliotheek:** de map in de paden van het bericht (`D:\Anime\Bleach\…` is Anime), anders op soort (Radarr films, Sonarr series en anime), anders alles.
  - **Wachtrij** (`ScanQueue`): 15 s na de laatste melding, per bibliotheek, en na een scan die nog loopt. Ook de scan van elk uur gaat via de wachtrij.
  - **`scripts/arr-webhook.ps1`** toont het adres (voor Sonarr op Windows en in Docker) en test het. `verify-setup.ps1` controleert `WEBHOOK_TOKEN`.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 23 en 24.
- **Niet gebouwd:** Sonarr en Radarr automatisch instellen via hun API (daar is hun API-key voor nodig). (De aftiteling van films is sinds 2026-10-21 gebouwd, uit het beeld, zie "Aftiteling van films".)

## Kijken (verzoek eigenaar, 2026-10-18)

"Bouw alles onder het kopje kijken": vijf voorstellen van Claude, alle vijf gebouwd. Getest in de cloudsandbox (API tegen PostgreSQL, transcoder met echte FFmpeg, Playwright, typecheck en `expo export` van de app), nog niet op de N100.

- **Metadata** (migratie `watching_extras`, op `MediaItem`):
  - **TMDB** haalt in hetzelfde verzoek (`append_to_response`) ook `recommendations`, `images` en `videos` op. Afbeeldingen en video's komen uit de Engelse versie.
  - **`logoPath`:** een PNG-logo (`include_image_language=en,null`), eerst Engels, dan zonder taal, op `w500`.
  - **`trailerKey`:** een YouTube-video: eerst een officiële _Trailer_, dan een andere _Trailer_, dan een _Teaser_.
  - **`recommendedTmdbIds`:** de aanbevelingen van TMDB (tot 40), in hun volgorde.
  - **`nextEpisode*`** (seizoen, nummer, titel, datum): bij TMDB `next_episode_to_air`; bij TVmaze de eerste genummerde aflevering met een datum vanaf vandaag.
  - **Eenmalig verversen:** de volgende scan ververst alle gematchte titels die vóór `EXTRAS_SINCE` gematcht zijn. Een serie waarvan de datum van `nextEpisode` voorbij is, wordt ook ververst. Series worden daarnaast elke week ververst.
- **Binnenkort** (`/home`, rij `upcoming`, na _Nieuwe releases_): series met een nieuwe aflevering binnen 60 dagen, de eerste eerst. `HomeRow.upcoming` (`UpcomingEpisode`). Liggende kaarten met de dag als vlag (`airDateLabel`: _Vandaag_, _Morgen_, _za 24 okt_) en _S4 · A3 · Titel_ (`upcomingLabel`). De kaart opent de serie. De detailpagina van een serie toont _Nieuwe aflevering_ (`ItemDetails.nextEpisode`).
- **Logo's** (`FeaturedItem.logoUrl`, `ItemDetails.logoUrl`): op het billboard en de detailpagina, in plaats van de titel. De titel blijft de toegankelijke naam. Laadt het logo niet, dan komt de tekst terug.
- **Trailer** (`ItemDetails.trailerKey`):
  - **Web:** een laag over de pagina met een iframe van `youtube-nocookie.com` (`trailerEmbedUrl`). Escape, de terugtoets van een afstandsbediening of ✕ sluit hem.
  - **Telefoon en tv:** `Linking.openURL(trailerUrl(key))` opent de YouTube-app. Heeft een tv geen YouTube, dan staat er een melding.
- **Meer zoals dit** (`GET /items/:id/similar`, 12 titels): de aanbevelingen van TMDB die in de bibliotheek staan (zelfde soort, in de volgorde van TMDB), aangevuld met titels met de meeste gedeelde genres, daarna waardering. Een rail onder aan de detailpagina, op web, telefoon en tv.
- **Backdrops voor 4K-tv's** (`largeImage` in `packages/shared`): vervangt `/tmdb/w1280/` door `/tmdb/original/` (de cache haalt elke TMDB-maat op).
  - **Tv-app:** op het billboard en de detailpagina.
  - **Web:** met `html.tv`, of een scherm van minstens 2560 pixels breed (`screen.width × devicePixelRatio`).
  - **Billboard op het web:** laadt een backdrop pas als die (bijna) aan de beurt is, niet alle tegelijk.
- **Dolby Vision in Safari:**
  - **`probe.ts`** leest het profiel uit de `DOVI configuration record` (`MediaFile.dvProfile`, `dvCompatibility`). Bestanden met DV zonder profiel worden één keer opnieuw geprobed; dat wist de intro- en aftitelinggegevens niet.
  - **Direct-play-check:** `videoCodecString` geeft voor profiel 5 `dvh1.05.06` (4K) of `dvh1.05.03`.
  - **Remux:** de transcoder zet bij profiel 5 `-tag:v dvh1`, en bij elk DV-bestand `-strict unofficial`, zodat FFmpeg de `dvcC`-box in het fMP4 schrijft. Profiel 8 blijft `hvc1`; dat speelt overal als HDR10 of HLG.
  - **Niet getest met een echte DV-bron:** in de sandbox is er geen. Een HLS-remux met `dvh1` en `-strict unofficial` werkte wel; `init.mp4` bevat `dvh1`.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 25.
- **Niet gebouwd:**
  - de trailer automatisch afspelen op het billboard;
  - (_Omdat je … keek_ op de startpagina, op basis van wat het profiel kijkt, is sinds 2026-10-20 gebouwd);
  - een melding als een aflevering uit _Binnenkort_ binnenkomt.

## Mijn lijst en meldingen (verzoek eigenaar, 2026-10-18)

"Maak nu maar de mijn lijst functie. Ik wil ook dat er notificaties worden gestuurd als er bijvoorbeeld een nieuwe aflevering uitkomt/uit is gekomen. Bedenk nog meer slimme use cases voor notificaties." Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL, web push tegen een eigen HTTPS-server, Playwright, typecheck en `expo export` van de app), nog niet op de N100 of een telefoon.

- **Mijn lijst** (migratie `my_list_notifications`, `MyListEntry`, per profiel):
  - **API:** `GET /my-list` (de laatst toegevoegde eerst), `PUT`/`DELETE /my-list/:itemId`. `ItemSummary.inMyList` (in `withProgress`) en `ItemDetails.inMyList`.
  - **Startpagina:** de rij `my-list` staat bovenaan de rijen.
  - **Web:** de knop _Mijn lijst_ op de detailpagina en het billboard (`MyListButton`, direct zichtbaar), de pagina `/my-list`, en een link in het hoofdmenu en het profielmenu.
  - **Telefoon:** de knop op de detailpagina en het billboard (`useMyListToggle` in `src/myList.ts`), en het scherm `my-list` (via _Alles_ bij de rij en _Profiel_).
  - **Tv:** de knop op het billboard en de detailpagina; de rij op Home.
- **Meldingen** (`apps/api/src/notifications/`, tabellen `Notification`, `PushSubscription` en `AppSetting`; `User.notificationSettings`):
  - **Wanneer** (`events.ts`, `NotificationEvents`):
    - **Nieuwe afleveringen:** na de scan van een bibliotheek (`Scanner.onLibraryScanned`). Afleveringen waarvan de `Episode`-rij in deze scan ontstond; een upgrade (een nieuw bestand voor een bestaande aflevering) telt niet. Eén melding per serie per scan (`newEpisodesBody`: _Nieuwe aflevering: S2 · A5 · Titel_, _Seizoen 3 staat klaar_, _3 nieuwe afleveringen: S2 · A5–A7_). Niet bij de eerste scan van een bibliotheek.
    - **Wie een serie volgt** (`followers`): wie hem in Mijn lijst heeft, of er de laatste 120 dagen een aflevering van keek.
    - **Vandaag verschijnt:** elk kwartier, vanaf 10:00 lokale tijd, voor gevolgde series met `nextEpisodeAirDate` vandaag.
    - **Aanraders:** een nieuwe titel in deze scan die TMDB aanraadt bij iets wat het profiel het laatste jaar keek, of andersom (`recommendedTmdbIds`). Hooguit 3 per profiel per scan. _Nieuw: X · Omdat je Y keek._
    - **Nieuwe login:** bij `POST /auth/login` en een tv-login met de telefoon, met het apparaat (`deviceLabel` uit de user agent, of de naam van de tv). Niet bij het allereerste account.
    - **Beheerders:** nieuwe titels die `UNMATCHED` of `FAILED` bleven (naar `/attention`), en de transcoder die 3 keer na elkaar (elke 5 minuten) niet antwoordt, één keer per storing.
  - **Opslag** (`service.ts`, `NotificationService`): een melding is uniek per profiel en `key`, zodat iets nooit twee keer komt. Instellingen per profiel (`NotificationSettings` in `packages/shared`): `newEpisodes`, `airing`, `recommended`, `newLogin`, `admin` en `quietHours`, standaard alles aan. Na 60 dagen verdwijnen meldingen.
  - **Stille uren** (`time.ts`, `NOTIFY_TIMEZONE`, standaard `Europe/Amsterdam`): een melding tussen 23:00 en 08:00 krijgt `deliverAt` 08:00. Het belletje en de apps zien hem pas dan. Een nieuwe login en een testmelding gaan meteen.
  - **API:** `GET /notifications` (alleen wat afgeleverd mag worden, met afbeelding van de titel), `POST /notifications/read`, `GET`/`PUT /notifications/settings`, `GET /notifications/push/key`, `POST /notifications/push` en `…/push/remove`, `POST /notifications/test`.
- **Afleveren:**
  - **Het belletje** in de webapp (`NotificationBell`, elke minuut), op de telefoon (op het billboard van Home, het scherm `notifications`) en op de tv (onder _Profiel_).
  - **Web push** (`push.ts`, `WebPushSender`, met `web-push` 3.6.7): VAPID-sleutels die de server zelf maakt en in `AppSetting` bewaart; geen account bij Google, Mozilla of Apple nodig. Elke minuut gaat wat afgeleverd mag worden de deur uit; ouder dan een dag niet meer. Een abonnement dat 404/410 geeft, verdwijnt. De service worker is `apps/web/public/sw.js` (Caddy: `no-cache`), alleen voor push. Werkt alleen via HTTPS (`cine-vault.nl`) of localhost; op iOS alleen vanaf het beginscherm. Een browser krijgt de meldingen van wie er het laatst inlogde (`claimPush`). Als afzender noemt VAPID `https://PUBLIC_DOMAIN` (`PUBLIC_DOMAIN` gaat nu ook naar de API-container).
  - **Android-telefoon** zonder Firebase (`src/notifications/phone.ts`): `expo-background-task` (WorkManager, ongeveer elk kwartier, ook met de app dicht) vraagt `GET /notifications` en toont nieuwe met `expo-notifications`, in de kanalen _Nieuwe afleveringen_, _Aanraders_, _Account_ en _Beheer_. Het ingangspunt is `apps/mobile/index.ts`, zodat de taak bestaat voordat de router laadt. `pickNew` (`pick.ts`) toont niets van vóór het aanzetten of het inloggen, niets ouder dan 2 dagen, en meer dan 4 tegelijk als één samenvatting. Een tik opent de titel.
    - **Geen meldingen (eigenaar, 2026-10-18).** Eerst toonde de telefoon niets zolang de app open was: bij het openen telde alles als gezien, en Android draait de achtergrondtaak niet als de app open is (dan schuift expo-background-task hem op). Een testmelding verscheen daardoor vrijwel nooit. Nu vraagt de app elke minuut zolang hij open is, en bij het openen, en toont nieuwe meldingen ook dan (`checkNotifications`, één tegelijk, met `seen` vóór het tonen bewaard). _Stuur een testmelding_ kijkt meteen. Onder _Profiel_ → _Meldingen_ staat of Android meldingen toestaat, of de taak gepland staat, en wanneer er het laatst gekeken is (op de achtergrond of niet, met de fout als de server onbereikbaar was), plus een knop naar de batterijbesparing van Android. Bij de start plant de app de taak opnieuw als die weg is (`ensurePhoneNotifications`). Aanzetten onder _Profiel_ → _Meldingen_ vraagt de toestemming van Android 13+.
    - **Altijd aan, en mooier (eigenaar, 2026-11-12: "Op de telefoon app krijg ik enkel notificaties van de app als ik de app open heb staan. Ik wil dat de notificaties ook komen wanneer de app gesloten is. Die service moet altijd draaien. Ook wil ik de opmaak van de notificaties mooier en beter maken").** Nog steeds zonder Firebase (geen Google-account); een eigen voorgronddienst in de native module, die de JavaScript-kant niet nodig heeft:
      - **API:** `GET /notifications/wait?after=<id>&since=<ms>&timeout=<s>` (tot 300 s, `NotificationService.waitForNew`): antwoordt meteen met de inbox (`NotificationList`) als er een melding is die de telefoon nog niet had (id groter dan `after`, of afleverbaar geworden na `since`: een melding uit de stille uren heeft een ouder id), anders 204 na `timeout`. `notify` maakt wachtende verzoeken van die gebruiker meteen wakker; anders kijkt het elke 30 s (de ochtend na de stille uren). De header `x-checked-at` (servertijd van die blik) is de volgende `since`. Een opgehangen telefoon (`reply.raw` `close`) stopt het wachten. `NotificationDto` heeft nu ook `posterUrl` en `stillUrl` (het beeld van de aflevering, via `fileId`).
      - **`NotifyService`** (`modules/cinevault-media/android/…/NotifyService.kt`): een foreground service van het type `specialUse` (Android 14+; `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` in het manifest van de module), `START_STICKY`, met één verzoek tegelijk open (`WAIT_S` 170 s, onder de paar minuten dat een mobiel netwerk een stille verbinding openhoudt). Het adres: het eerste dat `/api/health` beantwoordt, het vorige eerst (thuis of het domein, `NotifyHttp.pickServer`). Geen netwerk: opnieuw na 5 s oplopend tot 5 minuten, of meteen als Android een netwerk meldt (`registerDefaultNetworkCallback`; een nieuw netwerk breekt het open verzoek af). 401: gestopt (_Uitgelogd_). 404 (een server van vóór `/wait`): elke minuut `GET /notifications`. De vaste melding van de dienst staat in het kanaal _Verbinding met de server_ (`IMPORTANCE_MIN`, geen icoon in de statusbalk), met de stand (_Verbonden. Nieuwe meldingen komen meteen binnen._).
      - **`NotifyReceiver`:** start de dienst na `BOOT_COMPLETED` en `MY_PACKAGE_REPLACED` (een update), en doet **+ Mijn lijst** (`PUT /my-list/:id`) zonder de app te openen, met een toast.
      - **`NotifyStore`:** adressen, token (AES-GCM met een sleutel in de Android Keystore, dus niet bruikbaar uit een back-up), `seen` (de laatste 200 ids), `since`, en de stand voor _Profiel_. `NotifyPick` doet wat `pick.ts` deed: niets van vóór het aanzetten, niets ouder dan 2 dagen; nu hooguit 6 los (de nieuwste), de rest telt in de groep.
      - **De opmaak** (`NotifyPoster`): de poster met afgeronde hoeken klein naast de tekst (`setLargeIcon`), uitgeklapt het beeld van de aflevering of de backdrop groot in 2:1 (`BigPictureStyle`, zonder poster erboven), anders `BigTextStyle`; messing accent (`setColor`), het monochrome logo van expo-notifications; een label per soort als subtekst (_Nieuwe aflevering_, _Vandaag_, _Aanrader_, _Je verzoek_, _Beheer_); knoppen **▶ Afspelen** (`cinevault://play/<fileId>`), **Bekijken** (`cinevault://item/<id>`), **+ Mijn lijst** (aanrader), **Wachtwoord wijzigen** (nieuwe login), **Verzoeken** (nieuw verzoek); een tik opent de titel of het scherm (`cinevault://…`, expo-router). Alles in één groep met een samenvatting (`InboxStyle`: per melding de titel vet, _+3 meer_), die zelf niet klinkt. Dezelfde kanaal-ids als eerst, dus de instellingen van Android per kanaal blijven.
      - **App** (`src/notifications/phone.ts`): op een telefoon of tablet (niet tv of auto) geeft de app de dienst de login en adressen (`notifySetup`, bij het opstarten en na het wijzigen van de adressen), zet hem aan of uit (`notifyEnable`), en uitloggen stopt hem (`notifyForget`, in `clearLogin`). Is hij verbonden, dan vraagt de app zelf niets meer; de achtergrondtaak (elk kwartier) blijft, en start de dienst zo nodig opnieuw (`notifyCheck`). _Profiel_ → _Meldingen_ toont de stand (groen verbonden, messing verbinden, rood met de reden), wanneer de laatste melding kwam, en zo nodig _Meldingen toestaan_ en _Batterijbesparing uitzetten_ (zonder dat laatste verbreekt Android de verbinding in Doze, en komen meldingen pas bij het ontgrendelen). Een oudere build (zonder de dienst) en de auto werken zoals eerst.
      - **Google Play (de auto):** de AAB bevat de dienst ook; bij het uploaden vraagt de Play Console een verklaring voor `specialUse` (de tekst staat in het manifest). In de auto start de app hem niet.
      - Gecontroleerd: de API tegen PostgreSQL (wachten, meteen wakker, de stille uren, alleen de eigen meldingen, `posterUrl`/`stillUrl`); de Kotlin gecompileerd met `kotlinc` 2.2 en `-Werror` tegen de echte `android.jar` (API 37) met nagebootste Expo-klassen; `NotifyPick` en `NotifyHttp` (tegen een nep-server) op de JVM; typecheck, lint, tests en `expo export`. Nog niet op een telefoon (Gradle is geblokkeerd in de cloudsandbox).
  - **Tv:** geen Android-meldingen, alleen de lijst onder _Profiel_.
- **Tests:** `apps/api/test/notifications.test.ts` (alle aanleidingen, instellingen, stille uren, de routes en push met een nep-pushdienst; `WebPushSender` tegen een HTTPS-server met een eigen certificaat), de scanner-hook, `apps/mobile/test/pick.test.ts`, en Playwright (Mijn lijst, het belletje, de instellingen, de testmelding, de melding over een nieuwe login).
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 26.
- **Niet getest:** of Android de achtergrondtaak op de telefoon van de eigenaar vaak genoeg draait (fabrikanten met agressieve batterijbesparing stellen hem uit), en web push op een echt apparaat (dat kan pas via HTTPS).
- **Niet gebouwd (ideeën):**
  - een melding als een titel in Mijn lijst in betere kwaliteit binnenkomt (4K, HDR), bijvoorbeeld na een upgrade door Radarr;
  - een wekelijks overzicht van wat nieuw is;
  - een herinnering aan een serie die je halverwege liet liggen;
  - (beheer: een volle schijf of een oude back-up is sinds 2026-10-21 gebouwd, zie "Gezondheid en collecties");
  - echte push via Firebase (directer dan elk kwartier, maar met een Google-account en `google-services.json`).

## Ontdekken en verzoeken naar Sonarr en Radarr (verzoek eigenaar, 2026-10-18)

"Maak de verzoeken voor Sonarr en Radarr", na een lijst met ideeën van Claude. De eerste versie begon met zoeken. Daarna vroeg de eigenaar: "een feed van de laatste releases waar je door heen kan browsen. Ook moet hier een zoekfunctie in zijn." Dat is _Ontdekken_ geworden; de lijst met verzoeken is het tweede tabblad. Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL met een nep-Radarr en nep-Sonarr via HTTP, Playwright), nog niet tegen de echte Radarr en Sonarr op de N100.

- **Ontdekken** (`apps/api/src/requests/discover.ts`, `DiscoverService`):
  - **Rijen van TMDB** (`ROWS`, in deze volgorde; sinds 2026-11-05 de anime-rijen van AniList, zie hieronder): _Nieuw te streamen_ (`/discover/movie`, `with_release_type` 4 en 5, regio US, de laatste 90 dagen), _Trending films_, _Nieuwe series_ (de laatste 120 dagen, zonder animatie), _Trending series_, _Nieuwe anime_ (Japans, Animation, de laatste 180 dagen), _Nu in de bioscoop_ en _Binnenkort in de bioscoop_ (regio NL), _Nu op tv_, _Populaire anime_ en _Populaire films_.
  - **Bladeren:** per rij pagina voor pagina (`GET /discover/rows/:id?page=`, tot 500 pagina's).
  - **Zoeken:** films en series tegelijk (`/search/multi`, zonder personen).
  - **Details:** `GET /discover/:kind/:tmdbId`: genres, lengte of seizoenen, tagline en trailer.
  - **Cache:** wat TMDB antwoordt, staat een uur in het geheugen. Of iets in de bibliotheek staat of gevraagd is (`RequestService.annotate`), wordt elke keer opgezocht.
  - **Filter:** titels zonder poster laten de rijen weg.
- **Schermen van Ontdekken:**
  - **Web:** `/discover` (zoekveld en rails, de titel als laag over de pagina met `?title=movie-123`), `/discover/rows/:id` (een raster dat verder laadt), en de tabbladen _Ontdekken_ | _Verzoeken_ (met het aantal dat wacht).
  - **Telefoon:** het tabblad `discover`, en de schermen `discover-row` en `discover-title`.
  - **Tv:** _Ontdekken_ in het menu links (`TvDiscover`, `TvDiscoverRow`, `TvDiscoverTitle`), met zoeken via het toetsenbord van de tv. _Aanvragen_ heeft daar de focus.

- **Anime van AniList (verzoek eigenaar, 2026-11-05: "Bij ontdekken kan ik anime minder makkelijk vinden omdat het niet bij TMDB staat. Kan je hier een anime source aan toevoegen"; de keuze voor AniList is van Claude).** TMDB's lijsten missen veel van een anime-seizoen, en zijn zoeken kent alleen de Engelse titel (_Kimetsu no Yaiba_ vond niets). Gebouwd en getest in de cloudsandbox (een nep-AniList via `fetch`, tegen PostgreSQL met een nep-TMDB), nog niet tegen de echte AniList (geblokkeerd in de sandbox):
  - **Bron** (`apps/api/src/requests/anilist.ts`): `AniListClient` (GraphQL op `graphql.anilist.co`, zonder sleutel, één verzoek tegelijk met 0,7 s ertussen; AniList staat 90 per minuut toe), `isAdult: false`.
  - **Koppelen aan TMDB** (`AnimeDiscovery`): een verzoek gaat nog steeds op TMDB-id naar Sonarr of Radarr. Eerst de Fribb anime-lists van AniSkip (`AnimeMap.ids`: `anilist_id`, anders `mal_id`, naar `themoviedb_id.tv`/`.movie`); in 2026-11 had ongeveer een derde van de AniList-titels daar een TMDB-id. Anders een TMDB-zoekopdracht op de Engelse, dan de romaji-titel (zonder _Season 2_, _2nd Season_, _Part 2_, _Final Season_: `withoutSeason`), Japanse animatie van ongeveer dat jaar (een later seizoen: van vóór dat jaar). Tot 40 tegelijk per lijst; wat gevonden is, blijft bekend, wat niet, een dag. Een later seizoen wordt zijn serie (één kaart per serie); een titel die TMDB niet kent, valt weg. De kaart heeft de titel (Engels, anders romaji), poster en banner van AniList (beeldschema `anilist:`, gecachet zoals TMDB), en `anime: true`.
  - **Rijen** (`ROWS` in `discover.ts`, met `anilist` en/of `tmdb`): _Anime van dit seizoen_ (`anime-new`, het seizoen volgens AniList, TV/TV_SHORT/ONA), _Trending anime_ (`anime-trending`), _Binnenkort: anime_ (`anime-upcoming`, `NOT_YET_RELEASED`), _Populaire anime_ (`anime-popular`) en _Anime-films_ (`anime-movies`). Faalt AniList, dan vallen `anime-new` en `anime-popular` terug op hun oude TMDB-lijst; de andere vallen weg (een rijpagina geeft 502).
  - **Zoeken** (`DiscoverService.search`, pagina 1): TMDB en AniList (15 titels) tegelijk, samengevoegd met `mergeSearch`: de titel die het best op de zoekterm lijkt eerst (`matchScore`: gelijk, begint ermee, alle woorden, op alle namen van AniList: Engels, romaji, Japans, synoniemen), bij gelijke stand TMDB eerst, elke titel één keer (met de kaart van TMDB). Faalt AniList, dan alleen TMDB.
  - **Instellen:** `ANILIST` (standaard aan, `false` zet het uit). De apps veranderden niet: na de update alleen `scripts\up.ps1`.
  - **Niet gebouwd:** anime aanvragen die TMDB niet kent (op TVDB-id rechtstreeks naar Sonarr), en de beschrijving van AniList in het Nederlands (de kaart toont die in het Engels; de pagina van de titel komt van TMDB, in het Nederlands).
- **Instellen:** `RADARR_API_KEY` en `SONARR_API_KEY` in `.env`; `RADARR_URL` (standaard `http://host.docker.internal:7878`) en `SONARR_URL` (`…:8989`). Zonder key is er geen verzoek voor die soort.
- **Datamodel** (migratie `requests`): `MediaRequest`, uniek per soort (`MOVIE`/`SHOW`) en TMDB-id, met `status` (`PENDING`, `APPROVED`, `AVAILABLE`, `DECLINED`, `FAILED`), `anime`, `reason` en `decidedBy`. `MediaRequestUser`: wie het vroeg. Vraagt iemand iets wat al gevraagd is, dan komt die erbij. Een afgewezen titel opnieuw vragen zet hem terug op `PENDING`.
- **TMDB** (`TmdbProvider.listing`, `searchAll`, `discoverList`, `requestDetails`; `searchForRequest` blijft voor `GET /requests/search`): titels in het Engels, de beschrijving in `METADATA_LANGUAGE`. Anime is Japans (`original_language` `ja`) met het genre Animation (16).
- **Goedkeuren** (`apps/api/src/requests/service.ts`, `RequestService`; `arr.ts` met `RadarrClient` en `SonarrClient`, API v3):
  - **Wanneer:** een beheerder keurt goed. Verzoeken van een beheerder, en met _automatisch goedkeuren_ alle verzoeken, gaan meteen.
  - **Radarr:** `GET /movie/lookup/tmdb`, dan `POST /movie` met de map, het kwaliteitsprofiel, `minimumAvailability: released` en `searchForMovie`.
  - **Sonarr:** de TVDB-id via TMDB (`/tv/:id/external_ids`), `GET /series/lookup?term=tvdb:…`, dan `POST /series` met `seriesType` `anime` of `standard`, `monitor: all` en `searchForMissingEpisodes`. Een `languageProfileId` alleen als Sonarr v3 er een heeft.
  - **Mislukt het,** dan wordt het `FAILED`, met wat Radarr of Sonarr zei. Had Radarr of Sonarr de titel al, dan is het `APPROVED` met die opmerking.
- **Beschikbaar:** na elke scan zet `checkAvailable` verzoeken waarvan de titel (soort en TMDB-id) nu in de bibliotheek staat op `AVAILABLE`. Wie het vroeg, krijgt een melding en de titel in Mijn lijst. Zo meldt een serie ook de volgende afleveringen.
- **Instellingen** (`AppSetting` `requests`, _Beheer_ → _Verzoeken_): per soort (films, series, anime) de map en het kwaliteitsprofiel, en _automatisch goedkeuren_. Zonder keuze neemt CineVault de map die `Movies`, `Series` of `Anime` heet, en het eerste profiel.
- **Meldingen:** `request-new` voor beheerders (instelling `admin`), en `request-update` voor wie het vroeg: goedgekeurd, afgewezen (met de reden) of klaar (instelling `requests`). Op Android in het kanaal _Verzoeken_.
- **API:** `GET /discover`, `/discover/rows/:id`, `/discover/search`, `/discover/:kind/:tmdbId`, `GET /requests/search`, `GET`/`POST /requests`, `POST /requests/:id/approve` en `…/decline` (beheerders), `DELETE /requests/:id` (je eigen verzoek dat nog wacht; beheerders elk verzoek), `GET`/`PUT /requests/config` (beheerders).
- **De lijst met verzoeken:** op het web `/requests` (goedkeuren, afwijzen met een reden, intrekken) en `/admin/requests`; op de telefoon en de tv het scherm `requests` (afwijzen zonder reden). _Aanvragen_ onder een zoekopdracht in de bibliotheek gaat naar Ontdekken met die zoekterm.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 27.
- **Niet gebouwd:**
  - de voortgang van de download (de wachtrij van Radarr en Sonarr; zie het idee _Wordt gedownload_);
  - (per seizoen of aflevering aanvragen is sinds 2026-10-20 gebouwd, zie hieronder);
  - een limiet op het aantal verzoeken per persoon.

### Acteurs en seizoenen of afleveringen aanvragen (verzoek eigenaar, 2026-10-20)

"Ik wil bij elke film, serie en anime ook de acteurs kunnen zien. Ook wil ik voor series alleen seizoenen of episodes kunnen aanvragen in plaats van de hele serie." Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL met een nep-TMDB en nep-Sonarr via HTTP, Playwright, typecheck, lint en `expo export`), nog niet tegen de echte Sonarr.

- **Acteurs:** `DiscoverDetails.cast` (`CastMemberDto`, uit de `credits` die `requestDetails` al ophaalde). Web: een rail _Cast_ onder de titel in Ontdekken. Telefoon: `CastRail` (`components/CastRail.tsx`, ook op de detailpagina). Tv: `CastRow` uit `TvItem`, de pagina van Ontdekken scrolt nu.
- **Seizoenen:** `DiscoverDetails.seasonList` (`DiscoverSeason`: aantal afleveringen, `inLibrary`, `requested`; zonder specials) en `GET /discover/show/:tmdbId/season/:n` (`DiscoverSeasonDetails`, via `TmdbProvider.requestSeason`: titels Engels, beschrijving in `METADATA_LANGUAGE`; `inLibrary`, `requested`, `upcoming`).
- **Datamodel** (migratie `request_parts`): `MediaRequest.seasons` (hele seizoenen, TMDB-nummers) en `episodes` (JSON: elke aflevering die het dekt, met `airDate`; `null` is de hele serie). Niet meer uniek per soort en TMDB-id: een serie kan meer verzoeken hebben.
- **Aanvragen** (`POST /requests` met `seasons` en `episodes`, `RequestService.create`): van een heel seizoen de afleveringen die uit zijn (anders de eerste), plus de losse; wat al in de bibliotheek staat valt weg (niets over: 409). Gedekt door een open verzoek (hele serie, of alle afleveringen en seizoenen): je komt erbij. Een wachtend deelverzoek van dezelfde serie wordt aangevuld. Ook voor een serie die al in de bibliotheek staat.
- **Sonarr** (`SonarrClient.addUnmonitored`, `episodesSoon`, `monitorParts`): de serie toevoegen met `monitor: none` en alle seizoenen niet gevolgd, wachten tot Sonarr de afleveringen heeft (tot 30 s), dan de seizoenen volgen (`PUT /series/:id`), de afleveringen volgen (`PUT /episode/monitor`) en zoeken (`POST /command` `EpisodeSearch`). Stond de serie er al: alleen het volgen en zoeken.
- **Seizoenen aanvragen werkte niet (eigenaar, 2026-10-21).** Het verzoek werd goedgekeurd, maar Sonarr downloadde niets. Oorzaak: na `POST /series` vult Sonarr de afleveringen in, scant de map en past pas daarna `addOptions` toe (`monitor: none` zet alle afleveringen op niet gevolgd). CineVault volgde de afleveringen zodra ze er waren, dus vóór dat moment, en Sonarr zette ze daarna weer uit. Bij een grote serie kwam het er soms niet eens aan toe: na 30 s zonder afleveringen werd het `FAILED`. Opgelost en getest in de cloudsandbox (een nep-Sonarr die dat nadoet), nog niet tegen de echte Sonarr:
  - **Wachten tot Sonarr klaar is** (`SonarrClient.whenAdded`): tot `GET /series/:id` geen `addOptions` meer heeft, hooguit 45 s tijdens het goedkeuren. Duurt het langer, dan is het verzoek `APPROVED` met _Sonarr voegt de serie nog toe…_ en volgt CineVault de afleveringen op de achtergrond zodra Sonarr klaar is (tot 15 minuten, `sonarrWaitMs`; anders `FAILED` met de reden).
  - **Controle** (`followParts`, `SonarrClient.monitored`): na het volgen kijkt CineVault of Sonarr de afleveringen echt volgt, en probeert het zo nodig één keer opnieuw; anders `FAILED` met hoeveel er niet gevolgd worden.
  - **De serie zelf** staat in Sonarr nu altijd op gevolgd (`monitorParts`), ook bij losse afleveringen; anders pakt Sonarr een latere release niet zelf op.
  - Een `FAILED` verzoek gaat met _Opnieuw proberen_ (web) of _Opnieuw_ (app) nog eens naar Sonarr.
- **Nummering** (`requests/parts.ts`, `matchEpisode`): TMDB- en TVDB-nummers verschillen soms (anime). Een aflevering koppelt op de uitzenddatum (bij meer die dag op de nummers), anders op de nummers; zo ook met de bibliotheek.
- **Klaar** (`checkAvailable`): een deelverzoek is `AVAILABLE` als alle afleveringen die het dekt in de bibliotheek staan. Meldingen noemen het deel (`requestPartsLabel` in `packages/shared`: _Seizoen 2_, _S1 · A1–A3_).
- **Clients:** web `SeasonPicker` (vinkjes per seizoen, uitklappen per aflevering) en _Hele serie aanvragen_; telefoon hetzelfde (`components/SeasonPicker.tsx`); tv alleen hele seizoenen als chips. Onder _Verzoeken_ staat het deel bij elk verzoek. Een kaart in Ontdekken zegt _aangevraagd_ alleen voor de hele titel.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 27.
- **Niet gebouwd:** losse afleveringen kiezen op de tv; deelverzoeken van films (die bestaan niet).

### Collectie en Meer zoals dit in Ontdekken (verzoek eigenaar, 2026-10-21)

"Als een film onderdeel is van een collectie wil ik dit ook kunnen zien op de detailpagina van de film. Ook wil ik op de detailpagina een sectie hebben waarin meer films zoals de gekozen film worden aangeboden." Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL met een nep-TMDB via HTTP, Playwright, typecheck, lint en `expo export`), nog niet tegen de echte TMDB of op een telefoon of tv.

- **API** (`DiscoverService.details`):
  - `DiscoverDetails.collection` (`DiscoverCollection`: id, naam, beschrijving, poster, backdrop, `parts` als `DiscoverItem[]` met `itemId`/`request`, en `owned`): uit `belongs_to_collection` van de film (`RequestDetails.collection`) en `TmdbProvider.collection`, vanaf 2 films.
  - `DiscoverDetails.similar`: `TmdbProvider.recommendations` (`/{movie|tv}/:id/recommendations` via `listing`: Engelse titels, de beschrijving in `METADATA_LANGUAGE`), zonder titels zonder poster, hooguit 20. Ook voor series.
  - Beide een uur in het geheugen (`extras`); een fout van TMDB laat de rij weg, niet de pagina. `recommendations` en `collection` zijn optioneel in `RequestTmdb`.
- **Clients:** onder de cast een rij met de collectie (de open film is _Deze film_ en niet aan te tikken; `discoverPartLabel` in `packages/shared`: jaar, _Verschijnt 2027_, _Aangekondigd_) en een rij _Meer zoals dit_. Een kaart opent die titel in Ontdekken.
  - **Web:** in de laag van `DiscoverDialog` (`onOpen` zet `?title=` in het adres, zodat Terug naar de vorige titel gaat); _Alles bekijken_ naar `/collections/:id` als er een film van in de bibliotheek staat. Een link `?title=movie-<id>` naar een titel die in geen rij staat, opent die nu ook (`fromKey`); eerst gebeurde er niets, ook niet bij de ontbrekende films van een collectie.
  - **Telefoon:** `CollectionRail` en `SimilarRail` in `discover-title.tsx` (`DiscoverCard` met `sub` en `current`), _In bibliotheek_ naar `collection/[id]`.
  - **Tv:** `CollectionRow` en `SimilarRow` in `TvDiscoverTitle` (`TvDiscoverCard` met `sub` en `current`).
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 27.

## Kinderprofielen, accounts in de app en "Wordt gedownload" (verzoek eigenaar, 2026-10-18/19)

"Bouw het wordt gedownload en kinderprofiel in het systeem", uit de lijst met ideeën van Claude, en daarna: "Zorg ervoor dat als ik met een beheerdersaccount inlog op de app dat ik ook gebruikers kan toevoegen en verwijderen. Maak de layout hiervan ook slim. Dit hoeft niet voor de tv app, enkel voor de telefoon/tablet apps. Als je op een normale account inlog mag je niks van beheerders zien functies zien." Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL met een nep-Radarr, Playwright, typecheck, lint en `expo export` van de app), nog niet op de N100 of een telefoon.

- **Kinderprofielen** (migratie `kids_profiles`):
  - **Datamodel:** `User.maxAge` (0 is AL); `MediaItem.ageRating` en `certification` (bijvoorbeeld `NL 12`).
  - **Leeftijd van TMDB** (`metadata/age.ts`, `pickAgeRating`): `release_dates` (films) en `content_ratings` (series), in hetzelfde verzoek. Eerst NL (Kijkwijzer), dan DE, GB en US, omgerekend naar een leeftijd. De eerste scan na `AGE_RATINGS_SINCE` haalt het één keer op voor gematchte titels zonder leeftijd.
  - **Filter** (`kids.ts`, `ageFilter`): een kinderprofiel ziet alleen titels met `ageRating <= maxAge`; titels zonder leeftijd niet. Overal: bibliotheken (ook het aantal), lijsten, genres, zoeken, details, _Meer zoals dit_, `/home`, _Verder kijken_, Mijn lijst en meldingen.
  - **Afscherming** (`installKidsGuard`): 404 voor bestanden, streams, voortgang, playback en cast van een titel die niet mag; 403 voor `/discover`, `/requests` en `/downloads`.
  - **Accounts:** `maxAge` bij `POST`/`PATCH /users`; een beheerder met een leeftijd geeft 400.
  - **Clients:** geen Ontdekken, verzoeken of _Aanvragen_ voor een kinderprofiel (web, telefoon, tv-menu); het profiel zegt _Kinderprofiel · t/m 9_. De leeftijd staat bij de feiten van een titel (`AL`, `12+`).
- **Accounts in de app** (`apps/mobile/src/app/accounts.tsx`, alleen telefoon en tablet): _Profiel_ → _Accounts_, alleen voor beheerders. Lijst met rol, kinderprofiel en laatste login; toevoegen, wijzigen (naam, kleur, rol, leeftijd, nieuw wachtwoord) en verwijderen met bevestiging. Vanaf 720 dp breed staan lijst en formulier naast elkaar, op een telefoon schuift het formulier omhoog. De eigen rol is daar niet te wijzigen en jezelf verwijderen kan niet. Leden zien geen beheer: ook het Android-kanaal _Beheer_ bestaat alleen bij beheerders.
- **Het hele beheer in de app (verzoek eigenaar, 2026-10-20: "Bouw het hele beheer in de app enkel voor beheerders").** Alleen telefoon en tablet, alleen voor beheerders; niet op de tv. Gecontroleerd met typecheck, lint, tests en `expo export`, nog niet op een telefoon.
  - **_Profiel_ → _Beheer_** (`src/app/admin.tsx`, bouwstenen in `src/admin/ui.tsx`: `AdminScreen` met een kolom van hooguit 760 dp op een tablet, `Panel`, `AdminLink`, `useAttention`): links naar _Aandacht nodig_ (met het aantal), _Accounts_ en _Verzoeken_; scannen (`/scan`, _Scannen_ en _Alles vernieuwen_), de bibliotheken, de codecs (`/stats/codecs`), de stand van intro, recap en aftiteling (`/intro/status`) en van de themamuziek (`/themes/status`), zoals `AdminPage` op het web.
  - **_Aandacht nodig_** (`src/app/attention.tsx`): `UNMATCHED` en `FAILED` per bibliotheek, met `MatchPanel` (`src/admin/MatchPanel.tsx`: titel en jaar, kandidaten van `/items/:id/candidates`, _Kiezen_). Een melding met `path` `/attention` of `/admin` opent het scherm (niet op de tv).
  - **_Verzoeken_** (`src/app/request-settings.tsx`): automatisch goedkeuren, en per soort de map en het kwaliteitsprofiel (`/requests/config`), als keuzelijsten.
  - **Pagina van een titel** (`src/admin/ItemAdmin.tsx`, in het blok _Beheer_): _Match corrigeren_, _Match ongedaan maken_ (`matchLocked`), _Themamuziek uitzetten/aanzetten_.
  - **Speler** (`src/admin/IntroEditor.tsx`, via `introEditor` in `Controls`): onder _Instellingen_ de intro, recap en aftiteling, zoals de webspeler.
- **Wordt gedownload** (`requests/downloads.ts`, `DownloadService`): de wachtrij van Radarr en Sonarr (`/api/v3/queue`), per titel samengevoegd (voortgang, grootte, resterende tijd, afleveringen, status), 10 s in het geheugen. `GET /downloads`; `download` op verzoeken, Ontdekken en `ItemDetails` (wacht hooguit 1,5 s op Radarr/Sonarr). De clients tonen het bovenaan _Verzoeken_ (elke 10 s), bij elk verzoek en op de pagina van een titel (elke 15 s zolang er een download is).
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 28.
- **Niet gebouwd:** een pincode op een profiel, leeftijden met de hand per titel, en de download pauzeren of verwijderen vanuit CineVault.

## Verwijderen via Radarr en Sonarr (verzoek eigenaar, 2026-10-19)

"Ik wil de mogelijkheid hebben dat de beheerder ook films kan verwijderen via de app. De app moet de media verwijderen middels Sonarr en Radarr." Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL met een nep-Radarr en nep-Sonarr via HTTP, Playwright), nog niet tegen de echte Radarr en Sonarr op de N100.

- **CineVault blijft alleen-lezen:** Radarr of Sonarr verwijdert de bestanden; daarna scant CineVault de bibliotheek (`ScanQueue`), en die laat weg wat verdwenen is.
- **API** (`apps/api/src/requests/remove.ts`, `RemoveService`; `routes/remove.ts`, alleen beheerders): `GET /items/:id/remove?scope=title|season|episode&seasonId=&episodeId=` geeft wat er weggaat (`RemovePreview`: dienst, label, aantal bestanden, grootte, bestanden die Sonarr niet kent); `POST /items/:id/remove` met hetzelfde doel doet het (`RemoveResult`). Een fout van Radarr of Sonarr wordt 502 met hun melding.
- **Wie is wie:** Radarr's film op TMDB-id, Sonarr's serie op TVDB-id of TMDB-id, anders op de mapnaam (Radarr en Sonarr kunnen andere paden zien, bijvoorbeeld in Docker). Afleveringsbestanden op het pad binnen de seriemap (`relativePath`), anders op de bestandsnaam.
- **Wat er gebeurt:**
  - **Film:** `DELETE /movie/:id?deleteFiles=true&addImportExclusion=false`.
  - **Serie:** `DELETE /series/:id?deleteFiles=true&addImportListExclusion=false`.
  - **Seizoen of aflevering:** de afleveringen op niet gevolgd (`PUT /episode/monitor`), dan `DELETE /episodefile/:id` per bestand.
  - Bij een hele titel verdwijnt ook het `MediaRequest`, zodat hij opnieuw aangevraagd kan worden.
- **Clients:** telefoon en tablet (onderaan de detailpagina onder _Beheer_, het prullenbakje bij een seizoen, lang indrukken bij een aflevering; `RemoveSheet` met de voorvertoning) en web (⋯ → _Film/Serie verwijderen…_, `RemovePanel`, alleen de hele titel). Niet op de tv. Leden zien niets ervan.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 29.
- **Niet gebouwd:** losse bestanden verwijderen die Radarr of Sonarr niet kent (CineVault schrijft nooit in de mediamappen), en een prullenbak om iets terug te zetten.

## Agenda (verzoek eigenaar, 2026-10-19)

"Bouw de agenda maar", zodra `https://cine-vault.nl` werkte. Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL, Playwright, typecheck, lint en `expo export` van de app), nog niet met de echte Google Agenda.

- **Uitzendschema** (migratie `calendar`, tabel `ScheduledEpisode`, uniek per titel, seizoen en aflevering):
  - **TMDB:** de afleveringen van het seizoen van `last_episode_to_air` en van `next_episode_to_air` (ook zonder bestanden; die seizoenen worden alleen daarvoor opgehaald). **TVmaze:** alle genummerde afleveringen binnen een jaar terug of vooruit.
  - **Opslaan** (`applySchedule` in `scanner/apply.ts`): bij elke metadata-update van een serie vervangen, van 30 dagen terug tot 365 dagen vooruit, plus `nextEpisode`. Geen specials (seizoen 0); titels in een niet-Latijns schrift vallen weg.
  - **Eenmalig verversen:** series die vóór `SCHEDULE_SINCE` gematcht zijn, bij de volgende scan.
- **API** (`apps/api/src/calendar.ts`, `routes/calendar.ts`):
  - `GET /calendar?scope=following|all` (`CalendarList`): vanaf 7 dagen terug, met `available` (er is al een bestand). _Gevolgd_ is zoals bij de meldingen: Mijn lijst, of de laatste 120 dagen een aflevering gekeken (`followedShows`). Een kinderprofiel ziet alleen titels voor zijn leeftijd.
  - `GET /calendar/link` maakt zo nodig `User.calendarToken` (24 willekeurige bytes, base64url) en geeft `CalendarLink`: `url`, `webcalUrl`, `googleUrl` (`calendar.google.com/calendar/r?cid=webcal://…`) en `secure`. `POST /calendar/link` maakt een nieuwe; de oude geeft dan 404.
  - **Het adres** is `https://PUBLIC_DOMAIN` (`publicBaseUrl`), anders het adres van het verzoek (`X-Forwarded-Proto`/`Host`).
  - `GET /calendar/ics/<token>.ics` zonder login (iCalendar, RFC 5545): hele dagen, `UID` per aflevering (`<itemId>-s<s>e<e>@cinevault`), _Serie · S2 · A5 · Titel_, de beschrijving en een link naar `/items/:id`, `REFRESH-INTERVAL` 6 uur, regels gevouwen op 75 octets. Vanaf 30 dagen terug, alleen gevolgde series, met de leeftijd van het profiel. "Vandaag" volgt `NOTIFY_TIMEZONE`.
- **Web:** `/calendar` (_Agenda_ in het profielmenu, en _Alles bekijken_ bij _Binnenkort_), per dag, _Die ik volg_ | _Alle series_, _Staat klaar_. **Agenda koppelen:** _Google Agenda_, _Agenda-app_ (webcal, Apple/Outlook), _Link kopiëren_, _Nieuwe link maken_, en een waarschuwing bij een `http://`-link.
- **Telefoon en tablet:** het scherm `calendar` (_Profiel_ → _Agenda_, en _Agenda_ bij _Binnenkort_ op Home), met de stappen voor Google Agenda, _Link naar je computer sturen_ (delen) en _Andere agenda-app_ (webcal; anders een melding over ICSx⁵). Niet op de tv.
- **Vernieuwd in de app (eigenaar, 2026-11-04: "Ik vind het agenda gedeelte in de app er niet goed uitzien. Maak de agenda visueel mooi en overzichtelijk").** `src/app/calendar.tsx`, telefoon, tablet en auto: een vaste kop met _Agenda_, een samenvatting (`calendarSummary`: _8 afleveringen deze week · 7 daarna_) en de knop _Koppelen_; daaronder _Die ik volg_ | _Alle series_ over de hele breedte en een strook met de komende 14 dagen (weekdag, dag, een stip per aflevering; tikken springt naar die dag, vandaag in messing). Per dag een datumtegel met de maand en de dag, _Vandaag_/_Morgen_/de weekdag en de datum eronder zonder herhaling (`calendarDay` in `packages/shared`: `relative`, `detail`, `offset`), en het aantal. Per aflevering een kaart met de still, `S2 · A5` als label, de titel van de aflevering en labels _Nieuwe serie_/_Nieuw seizoen_ (`premiereLabel`), _Staat klaar_ (met een afspeelknopje op de still), _Vandaag_ of _Nog niet binnen_. De afgelopen week zit achter _Afgelopen week · 6 afleveringen_. Koppelen staat in een paneel van onderen (genummerde stappen voor Google Agenda), ook via een kaart onderaan. Op een tablet of in de auto een kolom van hooguit 760. Eerst viel elke kaart uit elkaar tot een kolom: de stijlfunctie van `Pressable` ging verloren binnen `Link asChild`; nu `router.push`. Gecontroleerd met typecheck, lint, tests (`format.test.ts`), `expo export` en de tijdelijke webversie op telefoon- en tabletformaat met demo-afleveringen; nog niet op een telefoon.
- **Getest door de eigenaar (2026-10-19):** de link met `cid=` opende de Android-app van Google Agenda, die _Agenda is toegevoegd_ meldde maar niets toevoegde. Via calendar.google.com → _Andere agenda's_ → _Via URL_ werkt het; de agenda staat nu in Google Agenda. De app toont daarom stappen in plaats van die knop; het web noemt ze onder de knop.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 30.
- **Niet gebouwd:**
  - releasedata van films uit Mijn lijst (nog te vragen aan de eigenaar);
  - het tijdstip van uitzenden (de agenda heeft hele dagen; TMDB geeft alleen een datum).

## AniSkip voor anime (verzoek eigenaar, 2026-10-19)

"Bouw de intros van animes via aniskip functie", uit de lijst met ideeën van Claude. Gebouwd en getest in de cloudsandbox (nep-AniSkip en nep-lijst via `fetch`, de zoekdienst tegen PostgreSQL); AniSkip, GitHub (raw) en MyAnimeList zijn daar geblokkeerd, dus nog niet tegen de echte AniSkip.

- **AniSkip** (`apps/api/src/intro/aniskip.ts`, `AniSkip`): `GET https://api.aniskip.com/v2/skip-times/<malId>/<aflevering>?types=op&types=ed&types=mixed-op&types=mixed-ed&episodeLength=<s>`, met de lengte van het bestand (AniSkip geeft dan tijden van een release met ongeveer die lengte). 404 is "niet bekend". `pickSkipTimes`: `op` (anders `mixed-op`) wordt de intro, `ed` (anders `mixed-ed`) de aftiteling; tijden buiten het bestand of korter dan 5 s vallen weg. Eén verzoek per 0,5 s.
- **Van TVDB-seizoen naar MyAnimeList** (`AnimeMap`): de Fribb anime-lists (`anime-list-mini.json` van `raw.githubusercontent.com/Fribb/anime-lists`, ongeveer 6 MB): per entry `mal_id`, `tvdb_id` met `season.tvdb` en `episode_offset.tvdb` (TVDB-aflevering = MAL-aflevering + offset), en hetzelfde voor TMDB (`themoviedb_id.tv`, `season.tmdb`). Een seizoen in cours heeft een entry per cour; de aflevering hoort bij de laatste cour die ervóór begint. Eerst TVDB (zo nummert Sonarr), dan TMDB. Geen specials (seizoen 0). De lijst staat in `CACHE_DIR/aniskip/anime-list.json` en wordt na 7 dagen opnieuw opgehaald; lukt dat niet, dan blijft de oude.
- **In de zoekdienst** (`IntroService`, optie `aniskip`):
  - **Volgorde per aflevering:** AniSkip (geen schijf), dan een hoofdstuk, dan de audio. Bron `aniskip` (`IntroInfo.source`/`creditsSource`); de webspeler zegt _van AniSkip_.
  - **`MediaFile.aniskipCheckedAt`** (migratie `aniskip`): wanneer AniSkip gevraagd is, of dat de serie geen anime is. Na een nieuwe probe weer leeg.
  - **`aniskipPass`** (in `runOnce`, na de voorrang, ook als er gekeken wordt): per keer 25 afleveringen die al doorzocht zijn en waarvan de intro of aftiteling uit de audio komt of ontbreekt, als AniSkip nog nooit gevraagd is, of als de aflevering minder dan 60 dagen binnen is en AniSkip 3 dagen geleden gevraagd is. Wat AniSkip heeft, vervangt `audio` of niets; `chapter` en `manual` blijven.
  - **AniSkip of de lijst onbereikbaar:** 15 minuten met rust laten; de aflevering wordt niet gemarkeerd en de audio zoekt verder.
  - De zoekdienst draait nu ook zonder transcoder (alleen AniSkip).
- **Instellen:** `ANISKIP` (standaard aan, `false` zet het uit).
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 31.
- **Niet gebouwd:** tijden naar AniSkip insturen (een eigen correctie van de beheerder delen). (Recaps overslaan is sinds 2026-10-19 gebouwd, zie "Beeldondertitels als tekst en recaps".)

## Controle van de code (verzoek eigenaar, 2026-10-19)

"Check voor andere verbeteringen." Claude liet de API, de webapp, de transcoder met de scripts en de Android-app doorlichten op echte fouten, controleerde elke bevinding in de code en loste deze op (met tests waar dat kon):

- **Scanner:** een map of bestand dat even niet te lezen is (bind mount, Sonarr die verplaatst), telt niet meer als verwijderd; eerst verdwenen daarmee de kijkvoortgang en handmatige matches. Bij een upgrade met een nieuwe bestandsnaam (`WEBDL-1080p` → `Bluray-2160p`) gaat de kijkvoortgang naar het nieuwe bestand van dezelfde aflevering of film (`keepProgress`).
- **Login:** tokens van de app en de tv blijven geldig zolang de sessie loopt (zie fase 5). Hooguit 2 wachtwoordcontroles tegelijk en 1 per naam (429), zodat een stoot pogingen de drempel niet omzeilt en scrypt de streams niet ophoudt; `/auth/setup` kijkt eerst of er al een account is.
- **Verwijderen:** Radarr's of Sonarr's titel moet ook in een map met dezelfde naam staan; een verkeerde match in CineVault verwijdert zo geen andere titel.
- **Afbeeldingen:** `media:` serveert alleen `poster.jpg`, `fanart.jpg` en de andere namen van eigen artwork, niet elke foto op de schijf (`MEDIA_ROOT` is op de N100 `D:/`).
- **Logs:** de agendalink en de webhook-token komen niet meer in de toegangslog. `IntroService.prioritize` gooit geen fout meer (een onafgevangen fout kon de API laten stoppen).
- **Spelers:** een HLS-sessie die tijdens het starten overbodig werd, wordt gestopt (web, telefoon, Chromecast); de tijd springt niet meer terug bij een nieuwe sessie; na 10 minuten pauze laat de speler de sessie los (zie fase 4); een video blijft op zijn adres als de app wisselt tussen thuis en het domein; themamuziek speelt niet meer door na het verlaten van de pagina.
- **Ondertitels:** `<font>`-tags uit SRT-bestanden verdwijnen in plaats van als tekst te verschijnen; een gedownloade ondertitel onthoudt zijn taal.
- **App:** een ander profiel ziet niets meer van het vorige (de cache wordt geleegd); is de server bij de start onbereikbaar, dan vraagt de app het profiel later opnieuw (eerst bleven beheerfuncties dan weg, en weigerde _Adressen wijzigen_ elk adres: mogelijk de oorzaak van _een andere CineVault_ in build 37).
- **Web:** een zoekterm loopt niet meer mee naar een andere bibliotheek.
- **Transcoder en scripts:** afgebroken segmentverzoeken sluiten hun bestand; zie ook fase 4 en de back-ups.

## Toegang van buitenaf (besluit eigenaar, 2026-10-16)

- **Gekozen:** een eigen domein met HTTPS via Caddy, met een automatisch Let's Encrypt-certificaat. Tailscale is overwogen en niet gekozen.
- **Stand (2026-10-16):** de eigenaar had nog geen domein. Sinds 2026-10-17 is dat `cine-vault.nl` (zie hieronder); sinds 2026-10-19 bereikbaar via HTTPS.
- **Gezien op de N100 (2026-10-16):** de eigenaar opent CineVault op de telefoon via een Tailscale-adres (100.x). Tailscale draait dus al op de N100. Het Wi-Fi/LAN-netwerk staat in Windows nog op _Openbaar_.
- **Gebruikers:** de eigenaar en het huishouden van de eigenaar. Geen mensen van buiten het huishouden; dat blijft buiten het plan, ook vanwege de licenties van TMDB en TVmaze.
- **Voorwaarde:** poort 80 en 443 gaan pas open in de router als er een login is (fase 5). Zonder login zou iedereen met het adres de bibliotheek kunnen zien en instellingen kunnen wijzigen. De login is er sinds fase 5; sinds 2026-10-19 staan 80 en 443 open.
- **Nodig van de eigenaar:**
  - een (sub)domein (een eigen domein of bijvoorbeeld DuckDNS);
  - een publiek IPv4-adres, dus geen CGNAT;
  - port forwarding van 80/443 naar de N100;
  - de Windows Firewall voor 80/443.
- **Domein (2026-10-17):** de eigenaar heeft `cine-vault.nl`. Gebouwd en in de cloudsandbox getest, nog niet op de N100:
  - **Caddy** (`apps/web/Caddyfile`) heeft twee sites:
    - `:8765`, HTTP voor thuis en Tailscale, zoals eerst;
    - `PUBLIC_DOMAIN` uit `.env` (in de container `PUBLIC_SITE`), via HTTPS met een certificaat van Let's Encrypt. Caddy haalt het zelf op (HTTP-01 op 80 of TLS-ALPN op 443) en vernieuwt het zelf.
  - **Certificaten** staan in het volume `caddy-data`. Bewaar dat volume, want Let's Encrypt beperkt het aantal nieuwe certificaten.
  - **Zonder domein** is de tweede site `http://localhost:8765`, die niets toevoegt. Caddy accepteert geen lege site.
  - **Headers:** HSTS (1 jaar, zonder subdomeinen) alleen op het domein; `nosniff`, `Referrer-Policy` en `X-Frame-Options` op beide sites.
  - **Alleen HTTP/1.1 en HTTP/2:** HTTP/3 zou ook UDP 443 in de router vragen.
  - **De container** publiceert `WEB_PORT` (8765), `HTTP_PORT` (80) en `HTTPS_PORT` (443). `up.ps1` waarschuwt als een ander programma op 80 of 443 luistert.
  - **De API-poort 3000** is nu alleen op 127.0.0.1 gepubliceerd (`API_BIND`), voor de scripts. Browsers en apps gaan via Caddy.
  - **`scripts/public-access.ps1`:**
    - `-Install` (als beheerder) maakt firewallregels voor TCP 80/443 op elk profiel, omdat het netwerk op _Openbaar_ staat.
    - Zonder switch controleert het of het A-record naar het publieke IP wijst (via api.ipify.org en 1.1.1.1), of er een AAAA-record is, en of er blokkerende firewallregels voor Docker zijn. Het controleert ook wie op 80/443 luistert, en of `https://domein/` vanaf de N100 zelf werkt (NAT loopback).
    - **Het certificaat** leest het script met SNI op 127.0.0.1:443. Een certificaat van Let's Encrypt bewijst dat de poorten van buitenaf bereikbaar zijn.
    - **De checks** staan in `scripts/lib/public-access.ps1`; `verify-setup.ps1` gebruikt ze in de sectie _Public access_.
  - **Android-app:** een domein zonder poort wordt `https://`, en een IP-adres, een poort of een lokale naam wordt `http://` (`src/server.ts`).
  - **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 20 (DNS, router, firewall, controle, NAT loopback, foutmeldingen van Let's Encrypt).
  - **Thuis en onderweg in de app (verzoek eigenaar, 2026-10-19):** de app kent twee adressen van dezelfde server (`SERVERS_KEY`, thuis eerst: een `http://`-adres telt als thuis) en gebruikt het eerste dat `/api/health` beantwoordt (`pickServer` in `src/server.ts`, 2,5 s per adres, tegelijk gevraagd). Opnieuw bij de start, als de app weer op de voorgrond komt, en als een API-verzoek geen server vindt (de `fetch` van de client); daarna worden de queries opnieuw gevraagd. De achtergrondtaak voor meldingen kiest ook zo. Zo werkt het domein onderweg zonder NAT loopback thuis. Instellen bij _Verbinden_ (_Tweede adres_) of onder _Profiel_ → _Server_ → _Adressen wijzigen_ (zonder uit te loggen; controleert dat de login op het andere adres dezelfde gebruiker geeft). Een video die al speelt, blijft op zijn adres. **Getest door de eigenaar (2026-10-19):** met build 37 weigerde de app het thuisadres (_een andere CineVault_; de oorzaak is niet gevonden). Build 40 zegt waarom een adres geweigerd wordt (HTTP-status, `commit` per adres) en wacht hooguit 6 s per adres; daarmee werken beide adressen.
  - **Port forwarding (2026-10-19):** Odido had eerst `192.168.0.1` (de router) en de reeks 80–443 ingesteld; nu twee regels, TCP 80 en 443 naar `192.168.0.110`. Canyouseeme ziet beide poorten. Er is één router (geen dubbele NAT) en geen CGNAT (`tracert`: `192.168.0.1`, dan `217.16.43.229`). Het certificaat wachtte op de limiet van Let's Encrypt (5 mislukte pogingen per uur). **Sinds 2026-10-19 werkt `https://cine-vault.nl`** met een certificaat van Let's Encrypt (eigenaar); de app gebruikt het als serveradres.
  - **De router (eigenaar, 2026-10-17):** de internetaansluiting is **Odido Zakelijk**. De router wordt door Odido beheerd; de eigenaar kan er niet op inloggen. De wifinaam `KPN54B216` komt van versterkers van KPN; er is geen KPN Box. De eigenaar belt Odido (2026-10-18) en vraagt om port forwarding van 80/443 naar `192.168.0.110`, een vast adres voor de N100, en of het IPv4-adres publiek (geen CGNAT) en vast is.
    - **Als Odido dat niet doet:** een kleine VPS (bijvoorbeeld Hetzner, ongeveer € 4–5 per maand) waar `cine-vault.nl` naar wijst. Die stuurt TCP 80/443 ongewijzigd via Tailscale door naar Caddy op de N100. Het certificaat blijft dan op de N100.
    - **Cloudflare Tunnel is afgeraden:** de DNS moet naar Cloudflare, Cloudflare ontsleutelt het verkeer, en de voorwaarden verbieden veel video via het gratis netwerk.
  - **Nog open:**
    - **Dynamic DNS:** de checks melden een gewijzigd IP-adres. Automatisch bijwerken hangt af van de registrar.
    - **Casten vanuit de browser:** gebouwd sinds 2026-10-20, zie "Casten vanuit de browser en Omdat je … keek".
    - **Agenda koppelen (Google Calendar):** gebouwd sinds 2026-10-19, zie "Agenda".
    - **`CAST_BASE_URL`** blijft het LAN-adres. `https://cine-vault.nl` werkt alleen als de router NAT loopback doet.

## Metadata en licenties

- **TMDB:** gratis API-key nodig. Toon het TMDB-logo en de tekst "This product uses the TMDB API but is not endorsed or certified by TMDB". Gratis gebruik geldt voor niet-commercieel gebruik.
- **TVmaze:** geen key nodig, limiet van minstens 20 calls per 10 seconden per IP. Data valt onder CC BY-SA 4.0, dus bronvermelding is verplicht.
- **Eigen cover:** een `poster.jpg` in de map gaat voor op externe bronnen.
- **OpenSubtitles:** API-key nodig; de gratis downloadlimiet is laag en wordt verschillend gemeld. Controleer de actuele plannen. Cache alles lokaal.

## Themamuziek (besluit eigenaar, 2026-10-20)

"Bouw de Plex-themes maar, doe geen eigen intro en doe de themes enkel via plex." Daarmee vervalt de eerdere keuze (2026-10-19: de intro als theme, en daarna ook de aftiteling uit de eigen bestanden). De Plex-dienst stond eerst bij _niet gekozen_ (onofficieel); de eigenaar koos hem na uitleg over de nadelen. Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL met een nep-Plex, Playwright met een nep-Plex en een echte MP3); `tvthemes.plexapp.com` is daar geblokkeerd (403), dus nog niet tegen de echte dienst.

- **Bron** (`apps/api/src/themes/service.ts`, `PlexThemeProvider`, de enige provider): `GET http(s)://tvthemes.plexapp.com/<TVDB-id>.mp3`, de dienst die Plex-servers zelf gebruiken. Geen Plex-server nodig, dus geen afhankelijkheid van de Plex op de N100 (zie "Bestaande mediabibliotheek"). Alleen series (en anime); Plex heeft geen films, dus films hebben geen themamuziek.
  - **TVDB-id:** `MediaItem.tvdbId`; ontbreekt die, dan via TMDB (`TmdbProvider.tvdbId`) en bewaard.
  - **Antwoorden:** 404/403 of geen MP3 (kleiner dan 10 KB, geen audio): geen theme, een week niet opnieuw (`NoThemeError` met `retryMs`). Geen verbinding, 5xx of 429: 15 minuten pauze voor alles (`ThemeUnavailableError`). Groter dan 15 MB: fout.
  - **Onofficieel:** Plex kan de dienst veranderen of stoppen; wat in de cache staat, blijft werken.
  - **Uit:** `PLEX_THEMES=false`.
- **Geen muziek bij het bladeren (eigenaar, 2026-10-20).** Na de overstap op Plex hoorde de eigenaar op de tv niets meer bij het bladeren (dat speelt alleen wat al opgehaald is). Waarschijnlijke oorzaak: alleen `https://` werd geprobeerd, terwijl de agents van Plex (en de themaplugins van andere mediaservers) `http://tvthemes.plexapp.com` gebruiken; zonder verbinding pauzeerde de dienst steeds 15 minuten. Nu eerst HTTPS en zonder verbinding HTTP (`PLEX_THEMES_URLS`, wat antwoordde gaat daarna eerst), een eigen `User-Agent`, en een MP3 herkend aan de eerste bytes (`isMp3`: ID3 of een MPEG-frame) in plaats van aan het content-type. 50 series per keer in plaats van 20. _Beheer_ → _Overzicht_ → _Themamuziek_ toont `GET /themes/status` (`ThemeStatus`: series, opgehaald, geen bij Plex, mislukt, pauze, laatste fout). Nog niet tegen de echte dienst getest (geblokkeerd in de cloudsandbox).
- **Weinig gevonden (eigenaar, 2026-10-22: 34 van 81 series, 46 _geen bij Plex_).** De code bleek te kloppen: alle 81 series hebben een TVDB-id, en de 46 zijn antwoorden van Plex (404/403 of geen MP3); Plex heeft weinig anime en nieuwe series. Wel nieuw: een 404 of 403 via HTTPS vraagt ook HTTP (`missing` per adres, bijvoorbeeld `404 https, 404 http`), pas dan is het _geen_. `ThemeStatus.missing` (`ThemeMissing`: titel, jaar, TVDB-id, `none`, `reason`) toont in _Beheer_ (web en app) welke series er geen hebben, met links naar TheTVDB en het MP3-adres bij Plex, zodat de eigenaar een verkeerde match of een ontbrekend nummer zelf ziet. `POST /themes/retry` (_Nu opnieuw proberen_) vergeet wat mislukte en vraagt meteen opnieuw. Getest in de cloudsandbox (API tegen PostgreSQL, Playwright), nog niet tegen de echte dienst.
- **Tweede bron: AnimeThemes (verzoek eigenaar, 2026-10-22: "Zoek een tweede bron voor de ontbrekende themamuziek").** Bekeken: ThemerrDB (LizardByte; YouTube-links per TMDB-id, dus downloaden met yt-dlp van YouTube: tegen de voorwaarden van YouTube en vaak stuk na een wijziging bij YouTube), televisiontunes.com (scrapen, weinig anime), en AnimeThemes (een open API met audiobestanden van openings en endings, per MyAnimeList-id). Gekozen: AnimeThemes, omdat de ontbrekende series vooral anime zijn en er geen YouTube nodig is. Gebouwd en getest in de cloudsandbox (nep-Plex en nep-AnimeThemes tegen PostgreSQL, een echte FFmpeg), nog niet tegen de echte dienst (geblokkeerd in de sandbox):
  - **Provider** (`apps/api/src/themes/animethemes.ts`, `AnimeThemesProvider`, na Plex): de TVDB-id (anders TMDB-id) wordt een MyAnimeList-id via de Fribb anime-lists van AniSkip (`AnimeMap.first`: de eerste cour van het eerste seizoen; de lijst wordt ook geladen met `ANISKIP=false`). `GET https://api.animethemes.moe/anime?filter[has]=resources&filter[site]=MyAnimeList&filter[external_id]=<id>&include=animethemes.animethemeentries.videos.audio`; `pickOpening` neemt OP1 (anders de laagste), een versie zonder spoiler of nsfw, en de `audio.link` (Ogg). FFmpeg in de API-container (`FFMPEG_PATH`) maakt er een MP3 van (`toMp3`), zodat Safari hem ook speelt. Geen anime of geen opening: een week niet opnieuw. Alleen series die in de anime-lists staan.
  - **ThemeService:** een bron die niet bereikbaar is, pauzeert alleen zichzelf (`pausedUntil` per bron, `ThemeStatus.pausedSource`); de volgende bron wacht dan (Plex gaat voor). Wat er al in de cache staat, speelt ook als een eerdere bron (nog) niet opnieuw gevraagd is, bijvoorbeeld na een herstart (`existing`). Per serie bewaart hij wat elke bron antwoordde (`outcomes`): `ThemeMissing.reason` is bijvoorbeeld `Plex: 404 https, 404 http · AnimeThemes: geen opening`; een serie met een nummer van AnimeThemes staat niet meer in de lijst.
  - **Instellen:** `ANIME_THEMES` (standaard aan, `false` zet het uit).
  - **Onofficieel, net als Plex:** de nummers op AnimeThemes zijn fragmenten van uitzendingen; wat in de cache staat, blijft werken.
  - **_AnimeThemes answered 503_ (eigenaar, 2026-11-12, schermafbeelding van _Beheer_).** Een 503 is AnimeThemes zelf (druk of onderhoud); de server pauzeert de bron 15 minuten en probeert het dan opnieuw. Wel een zwakke plek gevonden: de nieuwste serie komt steeds als eerste aan de beurt, dus één audiobestand dat 503 blijft geven, hield AnimeThemes voor alle series op pauze (en de anime die erop wachtten, kwamen ook niet bij ThemerrDB). Nu zegt de fout welk verzoek het was (`list` of `audio file`, met het MAL-id), en telt een serie die de bron 3 keer na elkaar "onbereikbaar" maakt als mislukt voor die serie (`MAX_STRIKES` in `themes/service.ts`, 6 uur, dan opnieuw): de pauze gaat eraf en die serie gaat naar de volgende bron. Bij een lange storing van AnimeThemes schuift zo elke 45 minuten één anime door naar ThemerrDB; komt AnimeThemes terug, dan vervangt de opening van AnimeThemes dat nummer zodra de titel weer geopend wordt. Getest tegen PostgreSQL met een nep-AnimeThemes; AnimeThemes zelf is geblokkeerd in de cloudsandbox.
  - (Een bron voor gewone series is sinds 2026-10-22 ThemerrDB, zie hieronder.)
- **Derde bron: ThemerrDB met YouTube (verzoek eigenaar, 2026-10-22: "Bouw ook ThemerrDB met YouTube voor de gewone series").** Gebouwd en getest in de cloudsandbox (een nep-ThemerrDB en een nep-yt-dlp die antwoordt zoals de echte, een echte FFmpeg; de echte yt-dlp 2026.10.21 tegen een lokale server, voor de opties), nog niet tegen ThemerrDB of YouTube (geblokkeerd in de sandbox):
  - **Provider** (`apps/api/src/themes/themerr.ts`, `ThemerrDbProvider`, na Plex en AnimeThemes, voor elke serie met een TMDB-id): `GET https://app.lizardbyte.dev/ThemerrDB/tv_shows/themoviedb/<id>.json`, het veld `youtube_theme_url`. 404: _niet in ThemerrDB_, een week niet opnieuw. De audio wordt een MP3 van hooguit 180 s met een fade aan het eind (`toMp3` in `themes/audio.ts`, ook voor AnimeThemes).
  - **yt-dlp** (`YtDlp`): de standalone build (`yt-dlp_linux`, met eigen Python) in het API-image (`/usr/local/bin/yt-dlp`, opgehaald bij het bouwen). De API kopieert hem naar `CACHE_DIR/bin/yt-dlp` en draait daar elke dag `yt-dlp -U`, en na een onbekende fout (YouTube veranderd) vóór de volgende download. YouTube vraagt een JavaScript-runtime: de Node van de API (`--js-runtimes node:<pad>`). `-f bestaudio/best`, `--max-filesize 60M`, `--match-filters "!is_live & duration <=? 900"`, één download tegelijk, timeout 180 s. `YTDLP_PATH` neemt een eigen yt-dlp zonder bijwerken.
  - **Fouten:** een video die weg, privé, geblokkeerd, te lang of live is: `NoThemeError` (een week niet opnieuw, de reden in _Beheer_, bijvoorbeeld `ThemerrDB: YouTube: Private video…`). _Sign in to confirm you're not a bot_, 429 of geen verbinding: 15 minuten pauze voor YouTube (`pausedSource` `themerrdb`). Ontbreekt yt-dlp: ook pauze.
  - **Instellen:** `THEMERRDB` (standaard aan, `false` zet het uit).
  - **Voorwaarden:** downloaden van YouTube is tegen de voorwaarden van YouTube; de eigenaar koos het na die uitleg. Wat in de cache staat, blijft werken.
  - **Niet gebouwd:** themamuziek voor films (ThemerrDB heeft ook films, `movies/themoviedb`), en cookies voor YouTube als het om een login vraagt.
- **Cache:** `CACHE_DIR/themes/<itemId>-plex-tvdb-<id>.mp3`, `<itemId>-animethemes-mal-<id>.mp3` en `<itemId>-themerrdb-tmdb-<id>.mp3`. Bij de start ruimt `ThemeService.cleanUp` de oude, zelf geknipte nummers op (andere providers in de naam) en `themes/end-credits/`.
- **Vooraf:** elke 10 minuten hooguit 50 series zonder theme, de nieuwste eerst, één verzoek per seconde. Niet meer alleen als er niemand kijkt (er wordt niets van de schijf gelezen).
- **API** (`routes/themes.ts`): `GET /items/:id/theme` (`ThemeInfo`: `url` met `?v=tvdb-<id>`, `pending`, `off`, `from: { source: 'plex' }`; wacht hooguit 6 s), `?ready=1` (alleen wat er al is), `GET /items/:id/theme.mp3` (range requests), `PUT /items/:id/theme` (beheerders, alleen `{ off }`). Een kinderprofiel krijgt 404 voor titels boven zijn leeftijd.
- **Weg:** de providers voor de intro, de aftiteling, een gekozen stuk en de aftiteling van films; de transcoderroutes `POST /theme` en `POST /end-credits` (`theme.ts`, `endcredits.ts`); in de webspeler _Instellingen_ → _Themamuziek_ (_Gebruik deze intro_, _Gebruik vanaf hier_, _Automatisch kiezen_). De kolommen `MediaItem.themeFileId` en `themeStartMs` staan nog in de database, ongebruikt.
- **Clients** (zoals eerst): web (`apps/web/src/themeMusic.ts`, `useThemeMusic`: zacht, eenmaal, fade in en uit, stopt bij _Afspelen_, de trailer en het luidsprekertje; _Profiel_ → _Themamuziek op dit apparaat_, standaard aan, 30%), app (`apps/mobile/src/themeMusic.ts`, een `expo-video`-speler zonder beeld, `duckOthers`; _Uit_, _Zacht_, _Normaal_, _Luider_, standaard _Normaal_ op de tv en _Uit_ op de telefoon). Beheerders: ⋯ → _Themamuziek uitzetten/aanzetten_.
- **Tv: al bij het bladeren (verzoek eigenaar, 2026-10-20).** Na 0,8 s focus op een poster speelt de themamuziek (`useBrowseThemeMusic`, `SpotThemeMusic`, `FocusThemeMusic`), alleen wat er al is (`?ready=1`). Eén speler voor de hele app: een scherm dat loslaat, laat het nummer nog 2,5 s lopen, zodat de pagina van de titel het overneemt. Nog niet op een tv getest.
- **Doorspelen op de achtergrond en te late overgangen (eigenaar, 2026-10-20).** Met de app op de achtergrond speelde het nummer door tot de app dicht ging: Android pauzeert de timers van de app op de achtergrond, en het stoppen liep via de fade (een interval) en de overdracht (een timeout van 2,5 s). Nu stopt een `AppState`-luisteraar alles meteen zonder timers (`stopAtOnce`, ook nummers die nog aan het uitfaden waren). Bij het verlaten van de pagina van een titel stopt het nummer meteen (fade van 350 ms, `letGo(…, 'stop')`), en bladeren begint het niet opnieuw zolang de focus op dezelfde poster blijft (`dismissed`); de pagina opnieuw openen speelt het wel. Bij het bladeren stopt het nummer zodra de focus verder gaat (`fade`), en het volgende begint na 0,8 s rust; alleen op weg naar de pagina van de titel loopt het 2,5 s door (`handoff`). Gecontroleerd met typecheck, lint en `expo export`, nog niet op een tv.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 32. Na de update `scripts\up.ps1`; de app alleen opnieuw bouwen voor de nieuwe tekst onder _Profiel_.
- **Niet getest:** de echte Plex-dienst (welke series hij heeft, en of hij 404 of 403 geeft voor een onbekende), een `expo-video`-speler zonder `VideoView` op een echt toestel, en de Web Audio-weg op een iPhone.
- **Niet gebouwd:** themamuziek voor films (Plex heeft die niet), herhalen, en themamuziek op het billboard van de startpagina.

## Audio en ondertitels per serie, en voorbeeldbeelden (verzoek eigenaar, 2026-10-19)

"Maak optie 1 en 2 van jouw top 3", uit de ideeën van Claude. Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL, transcoder met echte FFmpeg, Playwright met de echte transcoder, typecheck, lint en `expo export` van de app), nog niet op de N100, een telefoon of een tv.

- **Audio en ondertitels per serie** (migratie `track_preferences`, tabel `TrackPreference`, per profiel en titel):
  - **Opslaan:** kiest de kijker een audiospoor of ondertitel, dan stuurt de speler `PUT /items/:id/tracks` (`audioLanguage`, `subtitle`: een taal of `off`; `null` vergeet het). Talen worden ISO 639-2 (`languageCode`). Web, telefoon en tv.
  - **Toepassen:** `FileContext.tracks` (`TrackChoice`, `source` `saved` of `anime`). `chooseAudioTrack` in `packages/shared` kiest het spoor in die taal (geen commentaar, het standaardspoor eerst); is dat het standaardspoor, dan blijft het direct play. `chooseSubtitle` heeft `forShow`, dat voor de keuze van het apparaat gaat; een taal die de aflevering niet heeft, valt door.
  - **Anime** (bibliotheek met `libraryRank` 2): zonder eigen keuze Japans, als dat spoor er is.
  - **Volledige ondertitels eerst:** sporen die `forced` zijn of _Signs & Songs_ heten, komen na de volledige (Vinland Saga heeft twee Engelse ASS-sporen zonder `forced`).
- **Voorbeeldbeelden op de tijdlijn** (trickplay):
  - **Transcoder** (`src/thumbnails.ts`, `POST /thumbnails` met `path`, `times`, `width`, `height`, `columns`, `hdr`): per tijd een FFmpeg-run met `-skip_frame nokey -noaccurate_seek -ss`, die alleen het keyframe ervóór decodeert (een paar MB lezen in plaats van het hele bestand), en `-fps_mode passthrough` (anders valt dat keyframe weg, omdat het vóór `-ss` ligt). HDR via `zscale` en `tonemap=hable`; lukt dat niet, dan zonder. Daarna `tile` naar één JPEG. Een tijd zonder beeld krijgt het vorige; geen enkel beeld geeft 422. Eén blad tegelijk.
  - **API** (`src/thumbnails.ts`, `ThumbnailService`): 320 pixels breed, elke 10 s (hooguit ongeveer 400 per bestand), bladen van 5 × 5, vanaf 2 minuten. Alleen als er 2 minuten niet gekeken is (`intro.activity`), nieuwste bestanden eerst, blad voor blad; een onderbroken bestand gaat later verder. In `CACHE_DIR/thumbnails/<fileId>/<versie>/` (`0.jpg` …, `index.json`, `failed` bij 422). De versie volgt grootte en mtime; oude versies en verdwenen bestanden worden opgeruimd. Transcoder weg of te oud (503): 15 minuten pauze.
  - **Routes:** `GET /files/:id/thumbnails` (`ThumbnailInfo`) en `GET /files/:id/thumbnails/:versie/:n.jpg` (`immutable`). Een kinderprofiel krijgt 404 zoals bij de andere `/files/:id`-routes.
  - **Spelers:** `thumbnailAt` in `packages/shared`. Web: boven de tijdlijn bij muis of slepen (`TimelinePreview`). Telefoon: tijdens het slepen (`SeekPreview`). Tv: bij links en rechts, ook met verborgen bediening.
  - **Ruimte:** ongeveer 5 MB per uur video in het cachevolume.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 33. Na de update `scripts\transcoder.ps1 -Restart`; de app heeft een nieuwe build nodig.
- **Niet getest:** de snelheid op de N100 (verwacht een halve minuut tot een paar minuten per uur video), Dolby Vision profiel 5 (zonder HDR10-basis zullen de kleuren van de beelden niet kloppen), en de voorbeelden op een echte telefoon en tv.
- **Niet gebouwd:** voorbeeldbeelden tijdens het casten, en de voortgang van het maken in _Beheer_.

## Beeldondertitels als tekst en recaps (verzoek eigenaar, 2026-10-19)

"Maak optie 1 en 4" uit de ideeën van Claude, en: "Bij de tv app is me opgevallen dat Anime en Ontdekken dezelfde icoon hebben." Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL met een echte FFmpeg en tesseract.js, een nep-transcoder voor de recaps, Playwright, typecheck, lint en `expo export` van de app), nog niet op de N100, een telefoon of een tv.

- **Icoon:** _Ontdekken_ heeft nu een kompas (`compass`) in het tv-menu, de tabbalk van de telefoon en het profielmenu van het web. Anime houdt de ster (`sparkle`).
- **PGS als tekst** (`apps/api/src/subtitles/pgs.ts`, `ocr.ts`, `PgsOcr`):
  - **Waar:** in de API-container, niet in de transcoder: FFmpeg haalt het spoor als `.sup` uit het bestand (`-map 0:<index> -c copy -f sup`, via de read-only mount; dat leest het hele bestand), `readPgs` maakt van elke ondertitel een grijs plaatje (PCS, PDS, ODS, RLE; de lichte letters worden donker op wit), en Tesseract leest het.
  - **Tesseract:** tesseract.js 7.0.0 (WebAssembly, geen Windows-installatie of apt-pakket) met de taaldata uit `@tesseract.js-data/eng` en `/nld` 1.0.0, dus zonder internet. Ongeveer 50 ms per regel. Eén worker per taal, pas als die nodig is.
  - **Welke sporen** (`ocrLanguage`): `hdmv_pgs_subtitle` in het Engels of Nederlands; zonder taal als Engels. VobSub en andere talen niet.
  - **Uitkomst:** WebVTT (`toVtt`: gelijke regels na elkaar worden één, losse `|` wordt `I`), opgeslagen als de ingebouwde tekstsporen (`storeEmbedded`, `CACHE_DIR/subtitles/embedded/<fileId>-<index>.vtt`). Daarna is het spoor `supported` met een `url`, met `ocr: 'done'`. Een spoor dat mislukt, krijgt een markering in `CACHE_DIR/subtitles/ocr-failed/`.
  - **Wanneer:** op verzoek (`POST /files/:id/subtitles/ocr { streamIndex }`, voorrang), en op de achtergrond als er 2 minuten niet gekeken is (`intro.activity`): het nieuwste bestand met een PGS-spoor in een van die talen, niet geforceerd, zonder tekstondertitel in die taal.
  - **`SubtitleOption`:** `ocr` (`possible`, `queued`, `running`, `failed`, `done`), `ocrProgress` en `streamIndex`; `canReadAsText`, `readingAsText` en `pictureSubtitleNote` in `packages/shared`.
  - **Spelers:** web: _Omzetten naar tekst_ naast het spoor, met het percentage; telefoon en tv: het spoor kiezen zet het om. De lijst wordt elke 3 s gevraagd zolang er iets wordt omgezet, en het spoor wordt vanzelf gekozen als het klaar is.
  - **Instellen:** `SUBTITLE_OCR` (standaard aan), `FFMPEG_PATH`.
- **Recap overslaan** (migratie `recap`: `MediaFile.recapStartMs`, `recapEndMs`, `recapSource`, `recapCheckedAt`; na een nieuwe probe weer leeg, behalve `manual`):
  - **Bronnen, in deze volgorde:** AniSkip (`recap`), een hoofdstuk (`recapChapter`: _Recap_, _Previously_, _Previously on …_, _Vorige keer_ …), anders de audio.
  - **Audio** (`sharedClips`, `pickRecap` in `intro/match.ts`): de vingerafdruk van het begin van de aflevering (die van de intro, de eerste 6 minuten) tegen het begin en het eind van de vorige aflevering (in het seizoen, anders de laatste van het vorige). Vensters van 6 s stemmen elk op hun eigen verschuiving; stukjes van minstens 2 s die voor 60% overeenkomen, zijn clips. Weg vallen: de eigen intro en aftiteling, de intro van de vorige, en alles van de vorige vanaf het begin van zijn aftiteling (een vooruitblik op deze aflevering). Clips met hooguit 15 s ertussen vormen een groep; de recap is de eerste groep die binnen 90 s van het begin of van het einde van de intro begint, 15-300 s lang, voor 40% clip, met clips van minstens twee plekken of 30 s samen. Begint hij binnen 5 s, dan vanaf 0; eindigt hij hooguit 8 s voor de intro, dan tot de intro.
  - **Zoekdienst:** `IntroService.analyze` doet de recap na de intro en de aftiteling (`open` telt `recapCheckedAt` mee; bestaande afleveringen komen dus vanzelf aan de beurt, met vingerafdrukken uit de cache). De eerste aflevering leest niets. `aniskipPass` neemt ook de recap van AniSkip over (in plaats van `audio` of niets).
  - **API:** `IntroInfo.recap`, `recapSource`, `recapPending` (telt mee in `pending`); `FileContext.recap`; `PUT`/`DELETE /files/:id/recap` en `POST …/recap/detect`; `IntroStatus.recapChecked` en `recapFound`.
  - **Spelers** (`inRecap` in `packages/shared`): _Recap overslaan_ in de knop van _Intro overslaan_ (de intro gaat voor), op web, telefoon en tv; een knop op de telefoon tijdens het casten. Beheerders corrigeren hem in de webspeler onder _Instellingen_ → _Recap_.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 34. Na de update `scripts\up.ps1`; de app heeft een nieuwe build nodig.
- **Niet getest:** tekstherkenning op echte Blu-ray-ondertitels (cursief, gekleurd, twee regels op verschillende plekken), de snelheid op de N100, en de recap op echte afleveringen (een recap met veel nieuwe voice-over, of muziek die elke aflevering terugkomt).
- **Niet gebouwd:** VobSub en andere talen lezen, en de recap automatisch overslaan.
- **"Recaps werken niet en intro overslaan werkt niet overal" (eigenaar, 2026-10-20).** Twee gaten in de zoekdienst, opgelost en getest in de cloudsandbox (nep-transcoder tegen PostgreSQL), nog niet op de N100:
  - **De recap zag te weinig:** alleen het begin (10 min) en het eind (7 min) van de vorige aflevering, terwijl "Previously on" vooral uit het midden komt, en ook uit oudere afleveringen. Nu de hele vorige aflevering (het middenstuk als `<id>.mid<k>.json`, stukken van hooguit 1500 s, `middleSpans`) en het begin en eind van de twee daarvoor (`RECAP_EPISODES` 3). `RecapClip.episode` en `RecapInput.earlier` houden per aflevering de intro en aftiteling apart; dezelfde plek in meer afleveringen telt één keer (de langste).
  - **Eén keer zoeken was voor altijd:** een aflevering zonder buren (de eerste van een nieuwe serie, of een seizoen dat per week binnenkomt) of zonder vorige aflevering kreeg "niets gevonden" en werd nooit opnieuw bekeken. Nu zet `reopenAround` bij elke aflevering die binnenkomt de afleveringen van dat seizoen zonder intro of aftiteling, en de volgende zonder recap, weer open, als ze vóór die aflevering (`createdAt`) bekeken zijn. Dat gebeurt één keer.
  - **Migratie `intro_recheck`:** zet alles zonder intro, aftiteling of recap (en recaps uit de audio) eenmalig weer open.
  - **Beheer → Overzicht** toont nu ook de recap (`IntroStatus.recapChecked`).
  - **Nog nodig van de eigenaar:** welke series of afleveringen geen _Intro overslaan_ hebben, als het na het opnieuw zoeken nog zo is.
- **Alles in één keer zoeken (verzoek eigenaar, 2026-10-21).** "Een script waarin de intro, recap en aftiteling allemaal in 1x gezocht worden." `IntroService.searchAll` (`POST /intro/run`, `{ all }` zet eerst alles behalve `manual` weer open) zet `rush` aan: de zoekdienst neemt aflevering na aflevering zonder pauze en zonder te wachten tot er niemand kijkt (`IntroStatus.rush`), tot er niets meer open is; dan weer de gewone dienst. `DELETE /intro/run` stopt het. Komt dezelfde aflevering twee keer achter elkaar terug (hij kan niet gemarkeerd worden), dan stopt `rush` met een waarschuwing in het log. **`scripts/intro-search.ps1`** (`-All`, `-Stop`, `-NoWait`) start het met `API_TOKEN` en toont elke 10 s de voortgang en een schatting van de resterende tijd; Ctrl+C laat de server doorgaan. Ook de knop _Nu alles zoeken_ / _Stoppen_ in _Beheer_ → _Overzicht_ (web en app). Getest in de cloudsandbox (API tegen PostgreSQL, Playwright), nog niet op de N100. Uitleg: `docs/server-setup.md`, stap 37.
  - **Bleef hangen (eigenaar, 2026-10-21):** op Devil May Cry (2025) S02E01, en na 5:33 _Done_ zonder dat er iets bij was gekomen. De `fetch` van Node geeft het na 300 s zonder antwoord op (503, _waiting for the transcoder_). De transcoder las dan toch door, ook de opdrachten die daarna in de rij kwamen, zodat de rij vol bleef. En de volgende ronde kwam dezelfde aflevering terug, wat `rush` als "kan niet afgerond worden" zag. Opgelost:
    - **De transcoder** (`FingerprintJobs`) laat een opdracht vallen als de API niet meer wacht: een opdracht die nog in de rij staat, start niet, en FFmpeg wordt gestopt (499). `/health` meldt `fingerprintQueue`.
    - **De API** leest één stuk in hooguit 150 s (`MAX_READ_SECONDS`: de read rate is minstens `seconds / 150`). Elk verzoek heeft een timeout van 60 s plus twee keer de leestijd, hooguit 280 s. Na een timeout (408) is dat stuk onleesbaar: een buur of eerdere aflevering wordt overgeslagen, en voor de aflevering zelf blijft dat deel leeg. Een stuk dat langer dan 60 s duurt, komt in het log (_slow fingerprint_).
    - **`rush`** stopt pas na 10 keer na elkaar geen transcoder (`rushStopped: 'transcoder'`), en niet meer bij dezelfde aflevering na een 503. `IntroStatus` heeft `currentSince`, `reading` (pad, `start`/`middle`/`end`, sinds) en `rushStopped`; `introSearchLines` in `packages/shared` maakt er tekst van voor _Beheer_ (web en app).
    - **Het script** meldt elke minuut _still on_ en _reading …_ als de getallen gelijk blijven, en zegt waarom het stopte. Getest met pwsh 7.4 tegen een nep-API; Windows PowerShell 5.1 nog niet.
    - **Waarom het lezen zo lang duurde,** is niet bekend: `logs\transcoder.log` (de regels `fingerprint …` met de duur) moet dat laten zien.
  - **Sneller (verzoek eigenaar, 2026-10-22: "zoek uit of er een snellere manier is").** Het zoeken leest elk bestand één keer helemaal: het begin (intro), het eind (aftiteling) en, voor de recap van de volgende aflevering, het midden. De schijf bepaalt dus de duur. Vier wijzigingen, getest in de cloudsandbox (API tegen PostgreSQL met een nep-transcoder, de transcoder met een echte FFmpeg), nog niet op de N100:
    - **Eerst intro en aftiteling, dan de recaps** (`openFirst`, `openRecap` in `runOnce`; `analyze(…, { recap: 'after' })`): de eerste ronde leest van elke aflevering alleen het begin en het eind (ongeveer een derde van het bestand), zodat _Intro overslaan_ en de aftiteling overal staan voordat de recaps (de rest van elk bestand) aan de beurt zijn. Een geopende aflevering krijgt alle drie meteen. `rush` ziet een bestand dat voor zijn recap terugkomt niet als vastgelopen (`lastRushed` per ronde).
    - **Geen recaps in een seizoen** (`recapsInSeason`, `NO_RECAP_SEASON` 3): zijn 3 afleveringen van een seizoen (niet de eerste) bekeken zonder recap, dan leest de volgende van de aflevering ervoor alleen nog het begin en het eind (wat al gelezen is), niet het midden. De meeste recaps tonen het eind van de vorige aflevering; die worden dan nog gevonden.
    - **Op volle snelheid als niemand kijkt** (`print`): dan mag FFmpeg tot 200× real time lezen (`IDLE_READRATE`, doel `IDLE_READ` 8 Gbit/s; eerst 100× en 960 Mbit/s), en de timeout gaat uit van de schijf (`DISK_BYTES_PER_SECOND` 60 MB/s). Wordt er gekeken, dan blijft het zoals het was.
    - **Aftiteling van films** (`filmWindow`, `COARSE_EVERY` 3): eerst elk derde keyframe-moment; alleen tussen twee momenten die niet allebei film zijn (aftiteling, zwart, of een wissel) alle momenten. De transcoder neemt `jobs` (1-4) aan en grijpt dan zoveel keyframes tegelijk (`FrameStatsJobs`); de API vraagt er 3 als niemand kijkt (`IDLE_FRAME_JOBS`). Een oudere transcoder negeert `jobs`.

- **"Vindt recaps, intros en credits nog steeds heel zelden" (eigenaar, 2026-10-28; de laatste afleveringen van VisionQuest hebben alle drie, en lieten niets zien).** Vier oorzaken, opgelost en getest in de cloudsandbox (API tegen PostgreSQL met een nep-transcoder, de transcoder met een echte FFmpeg, een proef met echte muziek), nog niet op de N100:
  - **Hoofdoorzaak: een time-out die geen heel getal was.** Sinds 2026-10-21 (`60_000 + 2_000 * seconds / readrate`, met een `readrate` als 63,1) en sinds 2026-10-22 bij bijna elke bitrate (`DISK_BYTES_PER_SECOND`) gaf `print` een gebroken time-out aan `TranscoderClient.fingerprint`. `AbortSignal.timeout` gooit dan een `RangeError` voordat er iets verstuurd wordt; `find` ving elke fout op en zette de aflevering op _niets gevonden_ (log: _intro search: file not readable_). Nu `Math.round` in `print` en `Math.ceil` in `TranscoderClient`. Alleen een fout van het bestand zelf (`fileProblem`: een `TranscoderError` onder 500, zoals 404, 408 en 422) markeert nog een aflevering; een andere fout niet, en een bestand dat 3 keer zo faalt, slaat `runOnce` over tot een herstart (`failures`, `MAX_FAILURES`).
  - **Fijner raster** (`apps/transcoder/src/fingerprint.ts`, `HOP` 341 in plaats van 1365: elke 0,031 s). Gemeten met echte muziek (`librosa/data`): het themalied 62 ms verschoven (een halve stap van 0,124 s) gaf 29% verschillende bits en 46% van de frames binnen 8 bits, onder de grens van 60%; bij 0,031 s hooguit 15 ms verschoven, 11% en 97%. Proef met zes afleveringen in zes codecs: paren met de intro 14/30 → 30/30; een korte, zachte intro van 16 s 6/30 → 26/30. `match.ts` rekent nu in seconden (`framesFor`: gat 1,24 s, `COMMON` 3,72 s, vensters van 6/3 s), kiest per treffer één verschuiving (geen buren die de 12 plaatsen vullen), en knipt de randen bij tot waar een halve seconde voor de helft overeenkomt (`tighten`; anders begon een intro tot 1,2 s te vroeg door toevallige treffers in het gat). Vingerafdrukken met een andere stap worden opnieuw gelezen (`FINGERPRINT_HOP`), en een transcoder die nog de oude maakt, geeft 503 (_restart it_), zodat er niets gemarkeerd wordt.
  - **De transcoder rekent tijdens het lezen** (`Fingerprinter`): FFmpeg's uitvoer gaat per stuk (ongeveer 3 s audio, ~20 ms rekenen) door de FFT, in plaats van één blok op de hoofdthread (dat hield bij 4× zoveel frames de streams een halve minuut op). Twee vensters per FFT (reëel en imaginair deel): dezelfde bits, de helft van het werk (227 s audio: 2,8 → 1,5 s).
  - **Lange aftiteling:** `CREDITS_LIMITS.max` 360 → 600 s en het eindvenster 420 → 600 s (Marvel-series hebben 7-9 minuten aftiteling).
  - **Aftiteling uit het beeld voor afleveringen** (`pictureCredits`): vindt het geluid niets (een ander nummer per aflevering), dan `filmWindow`/`filmCredits` op het eindvenster, bron `picture`, met de delen na een scène in `creditsMore`. De kaart _Volgende aflevering_ start nog steeds bij het begin van de aftiteling.
  - **Migratie `intro_fine_step`:** afleveringen zonder intro, aftiteling of recap worden opnieuw bekeken; wat gevonden was, blijft. De oude vingerafdrukken in `CACHE_DIR/intro` worden opnieuw gelezen (de hele bibliotheek opnieuw van de schijf). Uitleg: `docs/server-setup.md`, stap 41. Na de update `scripts\up.ps1`, `scripts\transcoder.ps1 -Restart` en `scripts\intro-search.ps1`; de app hoeft niet opnieuw gebouwd te worden.

- **"Veel media heeft dit wel maar krijgt het niet toegewezen" (eigenaar, 2026-11-12).** Drie zwakke plekken in het vergelijken (`match.ts`), opgelost en getest met nagebootste vingerafdrukken en de echte-audiotest (`intro.test.ts`), nog niet op de N100:
  - **Onderbroken themalied:** praten, effecten of een stilte over het lied braken het gedeelde stuk (gat hooguit 1,24 s) in stukjes korter dan 12 s. Nu (`sharedSegments`) worden stukjes langs dezelfde verschuiving (elk minstens 1,5 s en 60% gelijk) samengevoegd als ze hooguit 6 s uit elkaar liggen (`BRIDGE_SECONDS`), met minstens 40% gelijk over het geheel (`BRIDGED_SHARE`).
  - **Te lang gedeeld stuk:** `sharedSegment` nam het langste stuk over alle verschuivingen en gaf niets als dat buiten de grenzen viel (een herhaalde scène van 200 s). Nu per verschuiving het langste stuk binnen de grenzen.
  - **Stemmen over alle stukken:** per buur alle gedeelde stukken (overlappende samengevoegd), en `pickShared` kiest het stuk dat de meeste buren hebben (zelfde begin en eind binnen 5 s, of 75% overlap), bij gelijke stand het langste. Eerst deed per buur alleen het langste stuk mee.
  - **Hoofdstukken:** ook _OP2_, _Opening Song_, _Theme Song_, _ED 1_, _Ending Theme_, _Ending Credits_.
  - **Log:** vindt het geluid niets, dan `intro search: no shared audio` of `no other episode to compare with`, met pad, deel en het aantal vergeleken afleveringen.
  - **Migratie `intro_bridged`:** afleveringen waar het geluid niets vond (intro of aftiteling) worden opnieuw bekeken; de vingerafdrukken staan in de cache, dus dat leest niets van de schijf. De recap is niet veranderd. Uitleg: `docs/server-setup.md`, stap 43. Na de update `scripts\up.ps1` en `scripts\intro-search.ps1`.

- **Recaps beter vinden (verzoek eigenaar, 2026-11-12).** Gebouwd en getest met nagebootste vingerafdrukken tegen PostgreSQL (`recap.test.ts`), nog niet op de N100:
  - **Oudere afleveringen:** een recap mag nu clips tonen van tot 12 afleveringen terug (`RECAP_CACHED_EPISODES`; ook het vorige seizoen voor een premiere), maar na de eerste 3 alleen wat al in `CACHE_DIR/intro` staat (`cachedPrint`): het begin en eind (gelezen voor hun eigen intro en aftiteling) en het midden (gelezen als vorige aflevering van een andere). Ook het midden van de vorige aflevering uit de cache als `recapsInSeason` het lezen ervan overslaat. Niets extra van de schijf.
  - **Kortere clips:** vanaf 1,5 s (`MIN_CLIP_SECONDS`, was 2 s); een recap knipt snel.
  - **Verteller ertussen:** clips van minstens 3 plekken mogen 25% van de recap dekken (anders 40%), want een verteller, titelkaart of muziek ertussen dekt de rest.
  - **Migratie `recap_older`:** afleveringen zonder recap worden opnieuw bekeken, vooral uit de cache. Uitleg: `docs/server-setup.md`, stap 43.

- **_cancelled after 175.7 s_ (eigenaar, 2026-11-15, `logs\transcoder.log`: Reacher S02, Bluray-2160p Remux, elke aflevering twee keer).** De API gaf een vingerafdruk op na een geschatte tijd: 60 s plus twee keer wat de schijf bij 60 MB/s nodig zou hebben (`DISK_BYTES_PER_SECOND`); 10 minuten van een remux van ongeveer 46 Mbit/s is 3,5 GB, dus 176 s. De schijf haalde dat niet, en dan telde het begin en het eind als onleesbaar (408): de aflevering kreeg geen intro en geen aftiteling, en het werk van 3 minuten ging weg. Opgelost, getest met een echte FFmpeg (transcoder) en een nagebootste transcoder (`fingerprintClient.test.ts`), nog niet op de N100:
  - **De transcoder meldt hoe ver hij is** (`POST /fingerprint` met `progress: true`): meteen de headers, elke 5 s een regel `{"progress":{"queued","read"}}` (NDJSON), aan het eind `{"result":…}` of `{"error","status"}`. Zonder `progress` zoals eerst. Het log noemt de snelheid (_…x real time_), en bij afbreken hoeveel er gelezen was.
  - **De API wacht zolang er gelezen wordt** (`TranscoderClient.fingerprint` met `watch`): pas na 120 s zonder iets nieuws (`FINGERPRINT_STALL_MS`) of 30 minuten in totaal (`FINGERPRINT_MAX_MS`) een 408; wachten in de rij telt als voortgang. Een oudere transcoder (antwoordt met JSON) krijgt de oude time-out. De regels houden ook de 5 minuten van Node's `fetch` open. _Beheer_ → _Overzicht_ toont _… % gelezen_ (`IntroStatus.reading.read`/`seconds`); _slow fingerprint_ in het log van de API noemt `mbPerSecond`.
  - **Migratie `intro_slow_disk`:** afleveringen zonder intro of aftiteling (en zonder intro ook de recap) worden opnieuw bekeken; wat gelezen was, staat in de cache. Uitleg: `docs/server-setup.md`, stap 46.
- **Skip-markers vergeleken met een eigen plan (eigenaar, 2026-11-13: "Bouw punt 1 tot en met 4, 6 en 7").** De eigenaar gaf een plan (`CLAUDE-skip-markers.md`: een Python-worker met Chromaprint, een tabel `media_markers`); vergeleken met wat er was, en daarvan gebouwd: betrouwbaarheid, de preview, automatisch overslaan per soort en profiel, de knop na 8 s weg, een beheerscherm per seizoen met kopiëren, en een seizoen opnieuw zoeken. Niet overgenomen: de Python-worker en `fpcalc` (de eigen vingerafdruk is fijner en heeft geen installatie nodig), de aparte tabel, de strengere getallen, en markers uit Plex (botst met "nergens van Plex afhangen"; de eigenaar besliste nog niet). Getest in de cloudsandbox (API tegen PostgreSQL met een nep-transcoder in `markers.test.ts`, de gedeelde logica in `packages/shared/test/intro.test.ts`, Playwright voor de webspeler en het beheerscherm, typecheck, lint, tests en `expo export` van de app); nog niet op de N100, een telefoon of een tv.
  - **Betrouwbaarheid** (migratie `skip_markers`: `MediaFile.introConfidence`, `creditsConfidence`, `recapConfidence`, `previewConfidence`, 0-1; null is met de hand of van vóór de migratie): uit het geluid `sharedConfidence` (de buren die het stuk hebben, gedeeld door de vergeleken buren, minstens 2: één buur geeft hooguit 0,5), een hoofdstuk 0,95, AniSkip 0,9, beeld van een film 0,7, beeld van een aflevering 0,5, een recap naar plekken en dekking (`scoreRecap`: 0,5-0,85), een preview 0,5-0,8. Onder `MIN_MARKER_CONFIDENCE` (0,5) laten `FileContext` en `GET /files/:id/intro` het deel weg (`IntroInfo.hidden`); een beheerder vraagt `?all=1` (de editors in de spelers, `keys.introAll`). `IntroStatus.uncertain` telt ze. De migratie zet wat het geluid of beeld vond eenmalig weer open (uit de cache), zodat het een zekerheid krijgt.
  - **Preview** (`MediaFile.previewStartMs`/`EndMs`/`Source`/`CheckedAt`; `findPreview`, `pickPreview`, `previewChapter` in `match.ts`): clips van de volgende aflevering (zijn begin, en het midden en eind als die in de cache staan) in het eindvenster, in of na de aftiteling, vlak ervóór of tot het eind; niet wat de volgende in zijn recap (de laatste scène) of intro en aftiteling speelt. Alleen uit de cache (`cachedPrint`): leest niets. Zonder volgende aflevering of vóór die gelezen is niets; als de volgende zijn intro krijgt, gaat de preview van de vorige weer open (`reopenPreviewBefore`, alleen als die eerder bekeken was). De aftiteling eindigt waar de preview begint (niet met de hand). In de tweede ronde, met de recap (`openRecap`). `PUT`/`DELETE /files/:id/preview` en `…/preview/detect`; `IntroStatus.previewChecked`/`previewFound`.
  - **Spelers** (`skipChoice`, `autoSkip`, `SKIP_BUTTON_MS` in `packages/shared/src/intro.ts`): één knop tegelijk (intro, recap, preview, zonder volgende aflevering de aftiteling), 8 s in beeld als zijn deel begint, daarna alleen met de bediening (web `PlayerControls` `skipKey`; app `useSkipFresh` in `src/player/skip.ts`; tv: OK slaat over zolang de knop in beeld is, daarna toont OK de bediening met de knop). Automatisch overslaan volgens `SkipSettings` (`User.skipSettings`, `GET`/`PUT /skip-settings`, ook in `FileContext.skip`): eens per deel per keer afspelen; de aftiteling met een volgende aflevering start die meteen. Ook in de Chromecast-bediening (web `CastView`, app `CastPlayer`). _Profiel_ → _Automatisch overslaan_ op web, telefoon en tv, en in de spelers onder _Instellingen_. De oude instelling per apparaat (`cinevault.autoSkipIntro`) gaat één keer over naar het profiel (`forgetDeviceAutoSkip`).
  - **Per seizoen in _Beheer_** (`IntroService.seasonMarkers`, `copyMarker`, `detectSeason`; `GET /admin/seasons/:id/markers`, `POST …/markers/copy { fileId, kind: intro|credits }`, `POST …/markers/detect`): web `/admin/markers/:seasonId` (`MarkersPage`, via ⋯ op de pagina van een serie), app `markers` (via _Beheer_ op de pagina van een serie): een tijdlijn per aflevering met de delen, bron en zekerheid (onzeker vaag), _Aanpassen in de speler_, _Intro/Aftiteling naar alle afleveringen_ (met de hand; de aftiteling gerekend vanaf het einde van elk bestand), _Seizoen opnieuw zoeken_ (niet wat met de hand is). De editors in de spelers hebben ook de preview en tonen de zekerheid. Uitleg: `docs/server-setup.md`, stap 44.

## Aftiteling van films (verzoek eigenaar, 2026-10-21)

"Kan je ook aftiteling van films overslaan. Let op voor post credit scenes", na de uitleg hoe Plex het doet (Plex vergelijkt bij afleveringen het geluid en kijkt bij films naar het beeld; een recap kent Plex niet). Gebouwd en getest in de cloudsandbox (transcoder met een echte FFmpeg en een testfilm met rollende aftiteling, een scène ertussen en erna; de beslissing en de zoekdienst tegen PostgreSQL met een nep-transcoder; Playwright, typecheck, lint en `expo export`), nog niet op de N100 of met echte films.

- **Transcoder** (`src/frames.ts`, `POST /frames { path, times, hdr }`, hooguit 120 tijden): per tijd een korte FFmpeg-run op het keyframe ervóór (`-skip_frame nokey -noaccurate_seek -ss`, zoals de voorbeeldbeelden), grijs 320×180 met `flags=neighbor` (dunne letters houden hun helderheid), HDR eerst naar SDR (`HDR_TO_SDR` uit `thumbnails.ts`, anders zonder). Per beeld: `dark` (< 50), `mid`, `bright` (> 150), `rows` (rijen met ≥ 3 heldere pixels) en `perRow`, plus `at`: waar het keyframe echt is (de tijd plus de eerste `pts_time` van `showinfo`), zodat een scène na de aftiteling op zijn eerste beeld gevonden wordt. Een opdracht vervalt als de API niet meer wacht (499). Geen hoofdstukken: een hoofdstuk _End Credits_ bevat vaak de scène erna.
- **Beslissen** (`apps/api/src/intro/film.ts`):
  - **`frameKind`:** _credits_ als `dark` ≥ 0,8, `bright` tussen 0,15% en 15%, `mid` ≤ 2 × `bright` + 3% (letters zijn scherp; een donkere scène heeft tinten), minstens 2 rijen en 4 heldere pixels per rij (regels tekst, geen lamp of sterren); _black_ bij `dark` ≥ 99,5%; anders _other_. Gemeten op de testfilm: aftiteling 98% donker, 1-2% helder, 0,5% ertussen, ongeveer 20 per rij.
  - **`filmCredits`:** per keyframe; een deel is minstens 3 aftitelingbeelden over 20 s, met zwart ertussen; een fade naar zwart vlak ervóór (≤ 10 s) hoort erbij. _Other_ op 2 keyframes of 6 s lang is een scène: het deel stopt op dat keyframe. Eén los beeld (een logo, verkeerd gelezen) blijft binnen het deel. Een deel tot het eind loopt tot de lengte van het bestand.
  - **Venster** (`windowStart`): de laatste 20%, tussen 5 en 20 minuten, nooit vóór de helft; elke 4 s. Begint het eerste deel bij het eerste beeld, dan nog twee keer 10 minuten terug (tot de helft).
- **Zoekdienst** (`IntroService`): films (`episodeId` null, `MediaItem.type` `MOVIE`, vanaf 20 minuten, geprobed) met `creditsCheckedAt` null, samen met de afleveringen de nieuwste eerst. Eerste deel in `creditsStartMs`/`EndMs` met bron `picture`, de volgende in `MediaFile.creditsMore` (migratie `film_credits`, JSON `[{ startMs, endMs }]`). Beelden in `CACHE_DIR/intro/<id>.film.json` per bestandsversie. 40 tijden per verzoek, timeout 60 s + 3 s per tijd (hooguit 280 s); een geopende film met 5 s pauze tussen de verzoeken (`filmPauseMs`). `IntroStatus.films`, `filmsChecked`, `filmsFound`; `searchAll({ all })` en het script nemen films mee. Een te oude transcoder (404 op `/frames`) is 503: later opnieuw.
- **API en spelers:** `IntroInfo`/`FileContext` hebben `creditsSource` (`picture`) en `moreCredits`; met de hand instellen of opnieuw zoeken wist `creditsMore`; met de hand mag de aftiteling nu 30 minuten lang zijn. `skipCreditsTo` in `packages/shared` (web, Chromecast vanuit de browser, telefoon, tv en de Chromecast-bediening): zonder volgende aflevering springt _Aftiteling overslaan_ naar het einde van het deel waarin je zit, als er daarna nog iets komt (bij `picture` minstens 4 s, anders 20 s); loopt de aftiteling tot het eind, dan is er geen knop. Gezien vanaf het begin van de aftiteling (`reachedEnd`, zoals bij afleveringen). De editor in de speler noemt de extra delen. _Beheer_ → _Overzicht_ toont _Aftiteling van films_.
- **Afleveringen** zijn niet veranderd: daar start bij de aftiteling de kaart _Volgende aflevering_, ook als er nog een scène komt.
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 38. Na de update `scripts\transcoder.ps1 -Restart` en `scripts\up.ps1`; de app heeft een nieuwe build nodig.
- **Niet getest:** echte films (aftiteling op een gekleurde of bewegende achtergrond wordt niet herkend; een donkere ruimte- of nachtscène met tekst zou het kunnen verwarren), 4K HDR en Dolby Vision profiel 5, en de snelheid op de N100 (verwacht een paar minuten per film: ongeveer 300 losse FFmpeg-runs).
- **Niet gebouwd:** het geluid erbij gebruiken (dialoog na de aftiteling), en hetzelfde voor de scène na de aftiteling van afleveringen.

## Casten vanuit de browser en Omdat je … keek (verzoek eigenaar, 2026-10-20)

"Doe maar punt 4 en 8" uit de ideeën van Claude. Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL, Playwright met een nagebootste Cast-SDK en de echte transcoder), nog niet met een echte Chromecast.

- **Omdat je … keek** (`apps/api/src/home.ts`, `becauseYouWatched`; `similar.ts`, `similarItems`, nu ook voor `GET /items/:id/similar`):
  - **Waarvan:** de titels die het profiel de laatste 120 dagen keek (afgekeken, of minstens 10 minuten), de laatste eerst.
  - **Wat:** per titel _Meer zoals dit_ (de aanbevelingen van TMDB in de bibliotheek, dan gedeelde genres), zonder wat het profiel al zag of begon, en zonder titels die in de andere rij al staan. Hooguit 2 rijen, elk met minstens 4 titels; een kinderprofiel alleen titels voor zijn leeftijd.
  - **Waar:** de eerste rij na _Recent toegevoegde films_, de tweede na _Binnenkort_. `HomeRow.because` (`itemId`, `title`); web, telefoon en tv tonen het als gewone rij.
- **Casten vanuit de browser** (`apps/web/src/cast.ts`, `components/CastView.tsx`):
  - **SDK:** de Web Sender van Google (`cast_sender.js?loadCastFramework=1` van `www.gstatic.com`), alleen in Chrome en Edge via HTTPS of localhost (`castPossible`), en pas als een speler opent. Default Media Receiver, zoals de Android-app.
  - **Knop:** _Casten naar een Chromecast_ in de bovenbalk van de speler, als Chrome een Chromecast in het netwerk ziet.
  - **Afspelen:** zoals de Android-app (`CastPlayer.tsx`): een HLS-sessie van de transcoder voor de Chromecast (`castDevice`), een cast-link (`POST /cast/token`), en `loadMedia` met titel, poster en de gekozen ondertitel (alleen een ondertitel met een `url`).
  - **Model:** de browser kent het model van de Chromecast niet; _Profiel_ → _Casten naar een Chromecast_ kiest _Automatisch_ (1080p), _4K_ of _1080p_ (`localStorage`).
  - **De pagina als afstandsbediening** (`RemotePlayer`): pauzeren, spoelen (dichtbij binnen de sessie, verder weg een nieuwe sessie), _Intro_, _Recap_ en _Aftiteling overslaan_, de volgende aflevering, voortgang elke 10 s en een heartbeat elke 20 s. Na _Stoppen met casten_ speelt de browser verder waar de tv was.
  - **Test:** `e2e/fake-cast.ts` bootst de SDK na (één Chromecast "Woonkamer").
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 35. Na de update `scripts\up.ps1`; de app hoeft niet opnieuw gebouwd te worden.
- **Niet getest:** met een echte Chromecast; ook hier is onzeker of de Default Media Receiver HLS van `CAST_BASE_URL` (een `http://`-adres) laadt.
- **Niet gebouwd:** casten vanuit Safari (geen Cast-SDK; AirPlay bestaat al) en Firefox, en _Omdat je … keek_ op basis van meer dan één titel tegelijk.

## Gezondheid en collecties (verzoek eigenaar, 2026-10-21)

"Maak de gezondheid functie en de collectie functie", uit de ideeën van Claude. Gebouwd en getest in de cloudsandbox (API tegen PostgreSQL met een nep-transcoder, nep-Radarr en nep-TMDB, Playwright, typecheck, lint en `expo export`), nog niet op de N100, een telefoon of een tv.

- **Gezondheid** (`apps/api/src/health.ts`, `HealthService`; `routes/adminHealth.ts`):
  - **Controles,** elke 15 minuten, in deze volgorde (`HealthCheck.id`): `media-disk` (de schijf van `MEDIA_ROOT`, gemeten door de transcoder op Windows, anders `statfs` in de container), `cache-disk`, `transcode-disk` (`TRANSCODE_TMP`, alleen als de transcoder antwoordt), `transcoder` (bereikbaar, GPU of CPU, tonemapping), `backup`, `scan` (ouder dan 3× `SCAN_INTERVAL_MINUTES` of fouten), `certificate` (TLS naar `web:443` met SNI `PUBLIC_DOMAIN`), `radarr` en `sonarr` (`/system/status` en hun eigen `/health`), `attention` (`UNMATCHED`/`FAILED`).
  - **Grenzen:** mediaschijf _let op_ onder 5% of 200 GB, _probleem_ onder 2% of 50 GB; cache en segmenten 10%/20 GB en 3%/5 GB; back-up 48 uur en 7 dagen; certificaat 14 en 3 dagen (of niet vertrouwd).
  - **Elk punt** heeft `level` (`ok`, `warning`, `error`, `unknown`), een Nederlandse `detail`, een `hint` (wat te doen) en `since`.
  - **Meldingen** (type `admin-health`, instelling `admin`): een punt dat nieuw misgaat of erger wordt. De incidenten staan in `AppSetting` `health-incidents` (`{ id: { since, level } }`); de key van een melding is `admin-health:<id>:<since>:<level>`, dus één keer per probleem. Opgelost en later weer mis is een nieuw probleem. `attention` geeft nooit een melding.
  - **Mediamappen (eigenaar, 2026-10-30: _Anime/Movies/Series is empty or unavailable_ terwijl alles werkte, en geen nieuwe media).** Docker Desktop was de koppeling van `D:` met de container kwijt (zoals eerder: _mkdir /run/desktop/mnt/host/d: file exists_ bij een herstart van de API). De transcoder op Windows ziet de schijf wel, dus afspelen werkt; de scanner houdt de bekende bestanden (geen verlies) maar ziet niets nieuws. Nieuwe controle `media-folders` (eerste in de lijst, `mediaFolders`): per bibliotheek met bekende bestanden leest de API de map (`readdir`, hooguit 5 s, want een kapotte koppeling kan blijven hangen); leeg of onleesbaar is _probleem_ (dus een melding aan beheerders), met als hint Docker Desktop sluiten, `wsl --shutdown`, starten en `scripts\up.ps1`. Eén lege map noemt die map. De `scan`-controle verwijst bij _is empty or unavailable_ naar deze controle in plaats van naar onleesbare bestanden. Getest tegen PostgreSQL. Uitleg: `docs/server-setup.md`, stap 42.
  - **Zelf herstellen (verzoek eigenaar, 2026-11-02: "Bouw het script dat Docker Desktop zelf herstart").** `scripts/media-watchdog.ps1`, met `-Install` een geplande taak (_CineVault Media Watchdog_, elke 10 minuten en 5 minuten na het aanmelden, in de sessie van de gebruiker). Het vergelijkt de mappen in `MEDIA_ROOT` met inhoud op Windows (zonder `$RECYCLE.BIN` en dergelijke) met `docker compose exec -T api ls -A /media/<map>`. Ziet de container er twee checks na elkaar geen enkele, dan: Docker Desktop stoppen (`docker desktop stop`, anders de processen), `wsl --shutdown`, starten (`Docker Desktop.exe`, anders `docker desktop start`), wachten op `docker info` (5 min), `docker compose up -d`, wachten op `/api/health`, opnieuw kijken, en `POST /api/scan` met `API_TOKEN`. Niet als Windows `MEDIA_ROOT` zelf niet ziet, niet als de API-container niet antwoordt, niet terwijl de transcoder sessies speelt (`/health`, hooguit `-MaxWaitMinutes` 60), hooguit één keer per uur; helpt het niet, dan 6 uur pauze. Docker Desktop dat twee checks niet draait, wordt gestart. Staat in `logs/media-watchdog.json` (ook bij geen enkele map: `,$folders`, anders maakt PowerShell er `$null` van), log in `logs/media-watchdog.log`. `-Status`, `-CheckOnly`, `-Force`, `-Uninstall`. `verify-setup.ps1` waarschuwt zonder de taak; de hint in _Gezondheid_ noemt het script. Getest met pwsh 7.4 op Linux met een nep-`docker`, nep-`wsl.exe`, nep-API en nep-transcoder (herstel, wachten op een stream, mislukte herstart met pauze, Docker uit, schijf weg, `-Force`); de geplande taak en Windows PowerShell 5.1 nog niet, en nog niet op de N100.
  - **Back-ups:** de API ziet de back-upmap op Windows niet. `scripts/backup.ps1` meldt na een geslaagde back-up `{ file, size, at }` aan `POST /api/admin/health/backup` (`API_TOKEN`, 10 s); mislukt dat, dan een `WARN` in `backup.log`, en de back-up blijft geslaagd. Opgeslagen in `AppSetting` `health-backup`.
  - **Transcoder:** `/health` meldt `disks: { tmp, media }` (`statfs`), en `TranscoderClient.health` heeft een timeout.
  - **API:** `GET /admin/health` (beheerders; een rapport van minder dan 60 s oud, of nieuw met `?fresh=1`).
  - **Clients:** het blok _Gezondheid_ bovenaan _Beheer_ → _Overzicht_ op het web (`HealthPanel` in `AdminPage`) en in de app (`Health` in `src/app/admin.tsx`), met _Opnieuw kijken_. Niet op de tv.
- **Collecties** (`apps/api/src/collections.ts`, `CollectionService`; `routes/collections.ts`; migratie `collections`):
  - **Datamodel:** `MediaItem.collectionTmdbId` en `collectionName` (TMDB `belongs_to_collection`, uit het Engelse antwoord), en de tabel `Collection` (`tmdbId`, naam, beschrijving, poster, backdrop, `parts` als JSON, `fetchedAt`).
  - **TMDB** (`TmdbProvider.collection`): `/collection/:id`, namen in het Engels, de beschrijving in `METADATA_LANGUAGE`; de films op releasedatum, zonder datum achteraan.
  - **Ophalen:** na elke scan van een bibliotheek, 30 s na de start en elke 6 uur: collecties die nog niet bestaan of een week oud zijn, hooguit 40 per keer. Films die vóór `COLLECTIONS_SINCE` gematcht zijn, haalt de volgende scan één keer opnieuw op.
  - **Tonen:** vanaf 2 films in de bibliotheek (`MIN_OWNED`). Een kinderprofiel ziet alleen de films die er zijn en voor zijn leeftijd mogen.
  - **API:** `GET /collections` (`CollectionSummary[]`: `owned`, `total`, `watched`), `GET /collections/:id` (`CollectionDetails`: elke film met `item` en voortgang, of `requested`/`released`, en `next`: de film na de laatst gekeken, anders de eerste; 404 als er geen film van in de bibliotheek staat), `ItemDetails.collection`.
  - **Startpagina:** `collection-next` (_Volgende in de reeks_, na Mijn lijst: per reeks waarvan het profiel een film zag, de volgende, zonder een die al begonnen is) en `collections` (_Collecties_, na _Hoog gewaardeerd_; `HomeRow.collections`, en in `items` een film per collectie voor oudere apps).
  - **Labels** in `packages/shared` (`format.ts`): `collectionLabel` (_2 van 3 films · 1 gezien_), `missingPartLabel` (_Aangevraagd_, _Aangekondigd_, _Verschijnt 2027_, _Niet in de bibliotheek_) en `canRequestPart`.
  - **Web:** `/collections` (profielmenu, _Alles bekijken_), `/collections/:id` (backdrop, _Begin met_/_Verder met_, de films op volgorde), een rij op de pagina van een film; een ontbrekende film opent Ontdekken (`/discover?title=movie-<id>`).
  - **Telefoon en tablet:** de rij op Home (met _Alles_), `collections` (_Profiel_ → _Collecties_), `collection/[id]`, en een rij op de pagina van een film (`CollectionCard`, `MissingPartCard` in `components/ui.tsx`); een ontbrekende film opent `discover-title`.
  - **Tv:** de rij op Home (`TvCollectionCard`, `collectionSpot`), `TvCollection` (een raster van 6 met _Begin met_), en een rij op `TvItem` (`TvMissingPartCard`; OK op een ontbrekende film opent `TvDiscoverTitle`).
- **Uitleg voor de eigenaar:** `docs/server-setup.md`, stap 39 en 40. Na de update `scripts\up.ps1`, `scripts\transcoder.ps1 -Restart` en één keer `scripts\backup.ps1`; de app heeft een nieuwe build nodig.
- **Niet getest:** de echte schijven, Radarr en Sonarr en het certificaat op de N100, en de schermen op een telefoon en tv.
- **Niet gebouwd:** een gezondheidspagina op de tv, meldingen voor een volle schijf buiten de API om (als de API zelf niet draait), en een hele collectie in één keer aanvragen.

## Omgevingsvariabelen (voorstel)

```
DATABASE_URL=
MEDIA_ROOT=
TRANSCODE_TMP=
TRANSCODER_TOKEN=
RENDER_GID=
TMDB_API_KEY=
OPENSUBTITLES_API_KEY=
JWT_SECRET=
API_TOKEN=
```

Commit nooit secrets; lever een `.env.example` mee.

## Open punten

- Welke apparaten ondersteund worden (browser, iOS, Android, tv).
- Of de app ooit publiek of commercieel wordt; dat raakt de licenties van TMDB en TVmaze.
- Het is een privé-library voor eigen gebruik; publiek delen valt buiten dit plan.

## Eerste taak

Begin met **fase 1**: Docker Compose, Fastify-skelet in TypeScript, Prisma-schema en een eerste migratie. Controleer eerst of QSV werkt met `vainfo`. Werk stap voor stap en leg uit wat je doet voordat je grote wijzigingen maakt.

## Taal

De eigenaar communiceert in het Nederlands. Antwoord in het Nederlands; houd code, commit-berichten en identifiers in het Engels.
