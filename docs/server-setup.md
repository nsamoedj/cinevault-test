# Server inrichten (Intel N100)

> **Linux (vanaf 2026-11-17).** De N100 gaat over naar Ubuntu Server 26.04 LTS met Docker
> Engine; Windows verdwijnt. Hoe CineVault daar draait, staat in
> [stap 47](#47-ubuntu-server-op-de-n100-linux). De Windows-stappen hieronder blijven gelden tot
> de overstap geslaagd is (Windows blijft zo lang als image bewaard). Waar een stap een
> `.ps1`-script noemt, is er op Linux een `.sh` met dezelfde naam (zie 47.4).

Stappen om CineVault op de mini-pc te zetten. De uitgangssituatie was Windows 10/11 met
Docker Desktop.

**Opzet:**

- **API en PostgreSQL** draaien in Docker Desktop.
- **Hardware-transcoding (fase 4)** draait native op Windows (stap 14), omdat Docker
  Desktop de Intel-GPU niet aan containers kan doorgeven. Zie "Windows op de N100" in
  [CLAUDE.md](../CLAUDE.md).

Alle commando's zijn voor **PowerShell**. Open die via Start → "PowerShell", als normale
gebruiker. Staat er "(als administrator)" bij een stap, gebruik dan rechtermuisklik →
_Als administrator uitvoeren_.

---

## 1. Windows klaarmaken als server

1. **Windows bijwerken.** Ga naar _Instellingen → Windows Update_ en installeer alles.
   Herstart.
2. **Slaapstand uit** (als administrator):

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   ```

3. **Vast IP-adres.** Geef de N100 een DHCP-reservering in je router.
4. **Netwerkprofiel op _Privé_.** Zet dit onder _Instellingen → Netwerk en internet →
   (je verbinding)_. Andere apparaten in huis kunnen de server anders niet bereiken.
5. **Herstarts beperken.** Stel bij _Windows Update → Geavanceerde opties → Actieve uren_
   de uren in waarop je kijkt, zodat Windows dan niet zomaar herstart.
6. **Aanmelden na een herstart.** Docker Desktop start pas als je bent aangemeld.
   Wil je dat CineVault na een herstart vanzelf terugkomt? Zet dan automatisch aanmelden
   aan:
   - Druk op Win+R, typ `netplwiz` en vink "Gebruikers moeten een gebruikersnaam en
     wachtwoord opgeven" uit.
   - Zie je die optie niet? Zet dan eerst _Instellingen → Accounts →
     Aanmeldingsopties → "Alleen Windows Hello-aanmelding toestaan"_ uit.
   - Dit is een afweging tussen gemak en beveiliging. Doe het alleen als de N100 thuis
     staat.

## 2. Intel-grafische driver

QSV hangt af van een recente Intel-driver.

1. Installeer **Intel Driver & Support Assistant** (intel.com/dsa) en laat die de
   grafische driver bijwerken. Lukt dat niet, gebruik dan de driver van de fabrikant van
   de mini-pc.
2. Controleer het resultaat. Ga in _Taakbeheer → Prestaties_ naar **GPU 0**. Daar moet
   "Intel(R) UHD Graphics" (of iets vergelijkbaars) staan.

## 3. Docker Desktop controleren

1. Controleer onder _Docker Desktop → Settings → General_:
   - **Use the WSL 2 based engine** staat aan;
   - **Start Docker Desktop when you sign in** staat aan.
2. Test daarna in PowerShell:

   ```powershell
   wsl --update
   docker version
   docker compose version      # verwacht v2.24 of nieuwer
   docker run --rm hello-world
   ```

   Bij `docker version` moeten **twee** blokken verschijnen: `Client` én `Server`.
   Ontbreekt `Server`? Dan draait de Docker-engine niet. Zie hieronder.

**Foutmelding `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`?**
Dan werkt de `docker`-opdracht wel, maar draait de engine van Docker Desktop niet.
Loop deze punten na:

1. **Start Docker Desktop** via het Startmenu en wacht tot linksonder in het venster
   **Engine running** staat. Dat kan een minuut duren.
2. **Linux-containers.** Klik met rechts op het Docker-icoon naast de klok. Staat daar
   _Switch to Linux containers…_, kies die dan. CineVault draait op Linux-containers.
3. **Context controleren.** Voer `docker context ls` uit. Er moet een `*` achter
   `desktop-linux` staan. Zo niet, voer dan `docker context use desktop-linux` uit.
4. **Start Docker Desktop niet, of meldt het een fout over WSL of virtualisatie?**
   - Kijk in _Taakbeheer → Prestaties → CPU_ of **Virtualisatie: Ingeschakeld** er staat.
     Staat het uit, zet dan Intel VT-x aan in het BIOS.
   - Voer als administrator `wsl --install --no-distribution` uit en daarna
     `wsl --update`. Herstart de pc en start Docker Desktop opnieuw.

**Geheugen (optioneel, aanbevolen).** Docker Desktop neemt standaard tot de helft van je
RAM. De transcoder draait straks náást Docker, dus begrens dat geheugen:

1. Maak het bestand `C:\Users\<jouw naam>\.wslconfig` aan:

   ```ini
   [wsl2]
   memory=4GB
   ```

   Neem `4GB` bij 8 GB RAM en `6GB` bij 16 GB RAM.

2. Voer daarna `wsl --shutdown` uit en start Docker Desktop opnieuw.

## 4. Git en FFmpeg installeren

```powershell
winget install --id Git.Git -e
winget install --id Gyan.FFmpeg -e
```

Sluit PowerShell en open een **nieuw** venster, zodat het `PATH` is bijgewerkt. Controleer:

```powershell
git --version
ffmpeg -hide_banner -version
```

## 5. Code ophalen

```powershell
git clone https://github.com/nsamoedj/CineVault.git C:\CineVault
cd C:\CineVault
git checkout claude/elegant-mayer-ng3gsm   # zolang de PR nog niet gemerged is
```

Is de repository privé? Dan opent Git een browservenster om bij GitHub in te loggen.

## 6. QSV-check

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-qsv.ps1
```

Het script controleert drie dingen:

- of er een Intel-GPU met driver is;
- of je FFmpeg-build `h264_qsv` en `hevc_qsv` heeft;
- of vier tests slagen:
  - een H.264-encode;
  - een HEVC-encode;
  - een volledige HEVC → H.264 transcode op de GPU;
  - dezelfde transcode, maar dan op de GPU geschaald van 1080p naar 720p.

  De laatste twee zijn de routes die CineVault straks gebruikt.

Faalt de eerste test? Dan probeert het script automatisch de low-power-encoder
(`-low_power 1`). Op de N100 is dat de enige hardware-encoder.

Bij een fout toont het script de regels met de echte foutmelding. Het volledige
FFmpeg-log komt in `qsv-check.log`, in de map waar je het script start. Dat bestand komt
niet in Git.

Kijk tijdens de test in _Taakbeheer → Prestaties → GPU 0_. De grafieken **Video Encode**
en **Video Decode** moeten dan uitslaan.

## 7. Je bestaande mediamappen

CineVault gebruikt je bestaande mappen `Movies`, `Series` en `Anime` zoals ze zijn:

- **Alleen-lezen.** De container koppelt de map met `:ro` en kan dus niets wijzigen,
  verplaatsen of verwijderen.
- **Naast je huidige mediaserver.** Die kan gewoon blijven draaien.
- **`MEDIA_ROOT`** wordt de map **waarin** `Movies`, `Series` en `Anime` staan, bijvoorbeeld
  `D:\Media` als je `D:\Media\Movies` hebt.

Maak alleen een map aan voor tijdelijke transcodebestanden, bij voorkeur op een SSD:

```powershell
New-Item -ItemType Directory -Force C:\CineVault-data\transcode
```

**Media op een NAS?** Een netwerkschijf met een stationsletter (bijvoorbeeld `Z:`) is
**niet** zichtbaar voor Docker Desktop. Laat het weten, dan koppelen we de NAS via SMB in
Docker Compose.

**Steekproef van je mapindeling.** Dit script wijzigt niets. Het toont per map hoeveel
titels er zijn, een paar voorbeeldpaden, en welke bestandstypen er voorkomen (zoals
`.mkv`, `.srt`, `.nfo` of `.jpg`):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\media-sample.ps1 -Root D:\Media
```

Vervang `D:\Media` door je eigen pad. Bij een grote bibliotheek kan het tellen van de
bestandstypen even duren.

## 8. `.env` invullen

**Je hoeft zelf geen PostgreSQL-account aan te maken.** De database draait in de
`db`-container. Bij de **eerste** start maakt die container de gebruiker, het wachtwoord
en de database aan met de waarden uit `.env`. Je verzint ze dus zelf:

- `POSTGRES_USER` en `POSTGRES_DB` mogen `cinevault` blijven.
- Voor `POSTGRES_PASSWORD` genereer je een nieuw wachtwoord.

```powershell
Copy-Item .env.example .env
# Wachtwoord van 32 tekens (letters en cijfers):
-join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
notepad .env
```

Vul in:

| Variabele                 | Waarde                                                                        |
| ------------------------- | ----------------------------------------------------------------------------- |
| `POSTGRES_USER`           | mag `cinevault` blijven                                                       |
| `POSTGRES_PASSWORD`       | het gegenereerde wachtwoord                                                   |
| `POSTGRES_DB`             | mag `cinevault` blijven                                                       |
| `MEDIA_ROOT`              | de map met `Movies`, `Series` en `Anime`, **met forward slashes**: `D:/Media` |
| `TRANSCODE_TMP`           | `C:/CineVault-data/transcode`                                                 |
| `DATABASE_URL`            | mag zo blijven; alleen nodig buiten Docker                                    |
| `TMDB_API_KEY`            | zie stap 10; mag nu nog leeg                                                  |
| `OPENSUBTITLES_API_KEY`   | nu nog leeg laten (stap 10)                                                   |
| `JWT_SECRET`, `API_TOKEN` | leeg laten: `scripts\up.ps1` vult ze zelf in (stap 16)                        |

Plak deze sleutels en wachtwoorden **nooit** in een chat of in een commit.

**Let op: het wachtwoord wordt maar één keer gebruikt.** De database wordt aangemaakt bij
de eerste start, en daarna leest Docker het wachtwoord uit `.env` niet opnieuw.

Pas je `POSTGRES_PASSWORD` later aan, of zie je in `docker compose logs api` de fout
`password authentication failed`? Zolang er nog geen gegevens in de database staan, kun
je hem dan zo opnieuw aanmaken. Dit **wist de database**:

```powershell
docker compose down -v
docker compose up -d
```

## 9. Starten en controleren

**Je maakt de containers niet met de hand aan.** Dat doet het script `scripts\up.ps1`, op
basis van `docker-compose.yml` in de projectmap en jouw `.env`. Bij de eerste keer gebeurt
dit:

1. Het image voor de **API** wordt gebouwd, volgens `apps/api/Dockerfile`. Dat duurt de
   eerste keer een paar minuten.
2. Het image `postgres:16` voor de **database** wordt gedownload.
3. Docker maakt twee containers aan: `cinevault-db-1` en `cinevault-api-1`. Daarnaast
   maakt het een netwerk en een volume `pgdata` voor de databasegegevens.
4. De database-container maakt bij deze eerste start het account aan uit `.env` (zie
   stap 8). Daarna richt de API de tabellen in.

```powershell
cd C:\CineVault             # of waar je de repository hebt gekloond
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
```

Het script bouwt het image, start de containers en wacht tot de API antwoordt. Daarna zie
je de containers ook in Docker Desktop onder _Containers_, in de groep **cinevault**.

**Waarom een script en niet `docker compose up -d --build`?** Op Windows weigert de
Bake-builder van Docker Compose ons Dockerfile, met de melding `additional privileges
requested: pass "--allow=fs.read=apps\\api\\Dockerfile"`. Het script bouwt het image
daarom met `docker build`, en die gebruikt Bake niet. Zonder `--build` werkt
`docker compose up -d` gewoon: Compose gebruikt dan het image dat al gebouwd is.

Controleer daarna:

```powershell
docker compose ps
curl.exe http://localhost:3000/api/health
docker compose exec api ls /media
```

Gebruik `curl.exe` en niet `curl`. In Windows PowerShell is `curl` een alias voor een
ander commando.

**Verwacht:**

- Bij `docker compose ps` staan `db` en `api` allebei op **(healthy)**. Dit duurt
  ongeveer 30 seconden.
- `curl.exe` geeft `{"status":"ok","version":"0.1.0","database":"up"}`.
- `ls /media` toont je mappen `Movies`, `Series` en `Anime`.

**Vanaf een ander apparaat** gaat alles via de webinterface (poort 8765, stap 13). Poort
3000 is sinds stap 20 alleen op de N100 zelf bereikbaar, voor de scripts.

**Bij problemen:**

```powershell
docker compose logs api
docker compose logs db
```

**Poort 3000** zet je **nooit** open in je router. Van buitenaf gaat alles via HTTPS
(stap 20).

**Bijwerken naar een nieuwe versie:**

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
```

Database-migraties worden bij het starten automatisch uitgevoerd.

## 10. API-sleutels voor latere fasen

**TMDB (nodig voor fase 2)**

1. Maak een account op <https://www.themoviedb.org/signup>.
2. Ga naar _Settings → API → Create → Developer_. Kies persoonlijk, niet-commercieel
   gebruik.
3. Zet de **API Key (v3)** in `.env` als `TMDB_API_KEY`.
4. Start de API opnieuw met `docker compose up -d`.

**OpenSubtitles (pas fase 6)**

1. Maak een account op <https://www.opensubtitles.com>.
2. Maak onder _API consumers_ een key aan.
3. Kijk wat het actuele gratis downloadlimiet is.

## 11. Alles controleren en terugsturen

Dit script loopt de hele handleiding na en wijzigt niets:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-setup.ps1
```

Het controleert:

- **Systeem:** Windows, RAM, de Intel-driver, slaapstand, het netwerkprofiel en je
  IP-adres.
- **Tools:** Git, FFmpeg en Docker.
- **Docker Desktop:** of de engine draait en de context klopt.
- **`.env`:** de waarden, en of je mappen `Movies`, `Series` en `Anime` bestaan.
- **Containers:** of ze healthy zijn en `/api/health` antwoordt, of `/media` alleen-lezen
  is en `/transcode` beschrijfbaar, en of de database-migraties zijn uitgevoerd.

Elke regel krijgt `[OK]`, `[WARN]` of `[FAIL]`, met waar nodig de stap waar je de oplossing
vindt. Het resultaat komt in **`setup-report.txt`** in de projectmap.

**Het rapport bevat geen wachtwoorden of API-sleutels.** Van `POSTGRES_PASSWORD`,
`TMDB_API_KEY` en dergelijke staat er alleen of ze zijn ingevuld.

Stuur Claude:

1. De inhoud van `setup-report.txt`. Plakken of een screenshot is allebei goed. Je opent
   het met `notepad setup-report.txt`.
2. De uitvoer van `check-qsv.ps1` (stap 6). Faalt er iets, stuur dan ook `qsv-check.log`
   mee.
3. De uitvoer van `media-sample.ps1` (stap 7), en of je media op een lokale schijf of een
   NAS staan.

## 12. Bibliotheek scannen (fase 2)

De scanner leest je mappen `Movies`, `Series` en `Anime`, alleen-lezend. Per bestand haalt
hij met `ffprobe` de codec, resolutie, HDR, audio- en ondertitelsporen op. Daarna zoekt hij
metadata: TMDB voor films en series, en TVmaze als terugval voor series. Posters en
achtergronden bewaart hij in een eigen cache.

1. **Werk de code bij en bouw opnieuw.** Het API-image heeft nu FFmpeg aan boord:

   ```powershell
   git pull
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   ```

   De eerste build na deze update duurt langer, omdat FFmpeg wordt geïnstalleerd. Bij het
   starten maakt CineVault vanzelf de bibliotheken `Movies`, `Series` en `Anime` aan.

2. **Controleer `.env`.**
   - `TMDB_API_KEY` moet ingevuld zijn (stap 10). Zonder sleutel blijven films
     ongematcht en gebruiken series alleen TVmaze.
   - Titels en beschrijvingen zijn standaard **Nederlands** (`METADATA_LANGUAGE=nl-NL`).
     Ontbreekt een Nederlandse tekst, dan valt de scanner terug op Engels. Liever Engels?
     Zet `METADATA_LANGUAGE=en-US` in `.env`.
   - Zoeken gaat altijd in het Engels, omdat je mappen Engelse namen hebben (Radarr en
     Sonarr). Een film als "Inside Out" wordt dus gevonden en heet daarna
     "Binnenstebuiten".
   - Taal veranderd na een eerdere scan? Draai dan `scan.ps1 -Refresh`, zodat bestaande
     titels opnieuw worden opgehaald.
   - Na een wijziging in `.env`: `docker compose up -d`.

3. **Scan:**

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\scan.ps1
   ```

   - Je ziet de voortgang per bibliotheek.
   - De **eerste** scan van je hele bibliotheek kan lang duren, omdat elk bestand via
     Docker Desktop gelezen wordt.
   - Daarna gaat het snel: ongewijzigde bestanden worden overgeslagen.
   - Eén bibliotheek scannen: `-Library Movies`.
   - Alles opnieuw ophalen: `-Refresh`. Gematchte titels worden dan via hun bekende id
     vernieuwd, niet opnieuw gezocht.

4. **Titels die aandacht nodig hebben.** Aan het eind toont het script:
   - **UNMATCHED:** er is geen overtuigend resultaat gevonden. De scanner kiest liever
     niets dan iets verkeerds.
   - **FAILED:** de lookup zelf mislukte, bijvoorbeeld door een netwerkfout. Bij de
     volgende scan probeert hij het vanzelf opnieuw.

   Alleen de lijst tonen, zonder te scannen: `-ListOnly`.

**Een match met de hand corrigeren.** Dat gaat het makkelijkst in de webinterface, onder
_Aandacht nodig_ (stap 13). Met PowerShell kan het ook. Neem het `id` uit de lijst van
`scan.ps1`. Sinds fase 5 vraagt de API een login; scripts gebruiken `API_TOKEN` uit `.env`:

```powershell
$token = ((Select-String -Path .env -Pattern '^API_TOKEN=').Line -split '=', 2)[1]
$PSDefaultParameterValues['Invoke-RestMethod:Headers'] = @{ Authorization = "Bearer $token" }
$id = '<id van de titel>'
# Kandidaten zoeken (optioneel met een andere titel of jaar):
Invoke-RestMethod "http://localhost:3000/api/items/$id/candidates?title=The Punisher&year=2026" | Format-Table provider, id, title, year
# De juiste kiezen. Voor films alleen tmdb; voor series tmdb of tvmaze:
Invoke-RestMethod -Method Put "http://localhost:3000/api/items/$id/match" -ContentType 'application/json' -Body '{"provider":"tmdb","id":12345}'
# Ongedaan maken (zoekt opnieuw op de naam van de map):
Invoke-RestMethod -Method Delete "http://localhost:3000/api/items/$id/match"
```

Een gekozen match staat **vast**: volgende scans vernieuwen alleen de gegevens en zoeken
niet opnieuw.

**Een eigen poster.** Zet een `poster.jpg` (of `folder.jpg`) in de map van een film of
serie. Die gaat voor op de poster van TMDB of TVmaze. Voor de achtergrond kan dat met
`fanart.jpg` of `backdrop.jpg`. CineVault leest deze bestanden alleen.

**Is een schijf even niet aangekoppeld?** Is een bibliotheekmap leeg of onbereikbaar
terwijl CineVault er wel bestanden van kent, dan verwijdert de scanner **niets** en meldt
hij dat.

## 13. De webinterface (fase 3)

CineVault heeft nu een webinterface: je bibliotheken, posters, details, cast, seizoenen en
een speler. Een tweede container (`web`, met Caddy) serveert de interface en stuurt `/api`
door naar de API.

1. **Werk bij en start opnieuw:**

   ```powershell
   git pull
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   ```

   Het script bouwt nu twee images (`cinevault-api` en `cinevault-web`). Aan het eind toont
   het het adres van de webinterface.

2. **Open de interface:**
   - Op de N100 zelf: <http://localhost:8765>.
   - Op een ander apparaat in huis: `http://<IP-van-de-N100>:8765`. `up.ps1` toont het
     adres. Vraagt Windows Firewall of _Docker Desktop Backend_ het netwerk op mag? Sta dat
     alleen toe voor **privénetwerken**.
   - Poort 8765 is gekozen omdat 8080 op de N100 al door een andere dienst wordt gebruikt.
     Is 8765 ook bezet? Zet dan een andere poort in `.env`, bijvoorbeeld `WEB_PORT=8790`,
     en draai `up.ps1` opnieuw. Of een poort vrij is, zie je zo (geen uitvoer = vrij):

     ```powershell
     Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
     ```

3. **Afspelen.** De interface speelt bestanden af zoals ze zijn (_direct play_). Per bestand
   staat erbij of je browser dat kan:
   - **▶ Afspelen:** je browser speelt het bestand af. Spoelen werkt.
   - **Transcoding nodig:** je browser kent de video- of audiocodec niet, bijvoorbeeld
     Dolby (E-AC3, TrueHD) of DTS. De speler laat zien waarom. Zulke bestanden zet
     CineVault in fase 4 zelf om.
   - **Edge** speelt op Windows vaker Dolby-audio af dan Chrome. Bij **HEVC** hangt het af
     van hardware-ondersteuning in je apparaat.
   - Op de startpagina zie je onder _Wat zit er in je bibliotheek_ hoeveel bestanden welke
     codecs gebruiken.

4. **Hapert het afspelen?** Klik in de speler rechtsboven op **Statistieken** en daarna op
   **Snelheidstest**. De test pauzeert de video een paar seconden, downloadt een stuk van het
   bestand zo snel mogelijk en vergelijkt die snelheid met de bitrate van het bestand.
   - **Snelheid** onder ongeveer 1,5× de bitrate: de verbinding is de beperking, vaak wifi.
     Een 4K-Blu-ray vraagt gemiddeld 40-80 Mbit/s en piekt hoger.
   - **Weggevallen beelden** boven 2%: het apparaat kan de video niet snel genoeg
     decoderen, bijvoorbeeld 4K HEVC zonder hardware-decoding.
   - Doe de test op het apparaat dat hapert, en ook één keer op de N100 zelf
     (<http://localhost:8765>). Is de N100 zelf al traag, dan zit het probleem in de server
     en niet in je netwerk.

5. **Aandacht nodig.** Onder _Aandacht nodig_ staan titels zonder match. Klik _Match zoeken_,
   pas zo nodig titel of jaar aan, en kies de juiste. Op elke detailpagina staat ook _Match
   corrigeren_. De PowerShell-commando's van stap 12 zijn daarvoor niet meer nodig.

**Let op: er is nog geen login.** Iedereen in je thuisnetwerk die het adres kent, kan de
interface openen. Accounts komen in fase 5. Zet poort 8765 dus **niet** open in je router.
Toegang van buitenaf, met HTTPS, regelen we apart.

## 14. Transcoding (fase 4)

Kan een browser een bestand niet zelf afspelen, of kies je een lagere kwaliteit, dan zet
de N100 het om. Dat doet de **transcoder**, een klein programma dat naast Docker Desktop
draait. In een container kan het niet: alleen op Windows zelf ziet FFmpeg de Intel-GPU
(QSV).

Wat er per bestand gebeurt:

| Situatie                                                | CineVault doet                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Browser speelt het bestand                              | **direct play**: het bestand zoals het is                       |
| Alleen de audio werkt niet (Dolby E-AC3, TrueHD, DTS)   | **remux**: beeld blijft origineel (ook 4K/HDR), audio wordt AAC |
| Andere audiotaal gekozen                                | **remux** met dat audiospoor                                    |
| Video werkt niet (bijv. HEVC in Firefox), of 1080p/720p | **transcode** naar H.264 op de GPU, HDR wordt omgezet naar SDR  |

1. **Node.js installeren** (eenmalig). De transcoder heeft Node.js 22.18 of nieuwer nodig:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

   Sluit PowerShell en open een nieuw venster. `node --version` toont dan `v24…` of
   nieuwer. FFmpeg heb je al (stap 4).

2. **Bijwerken en de transcoder installeren:**

   ```powershell
   cd C:\Users\nsamo\documents\CineVault
   git pull
   powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1 -Install
   ```

   Dit script:
   - zet een geheime sleutel `TRANSCODER_TOKEN` in `.env` (API en transcoder gebruiken
     die om elkaar te herkennen; deel hem met niemand);
   - maakt een **geplande taak** _CineVault Transcoder_ die de transcoder start als je je
     aanmeldt, net als Docker Desktop, en hem herstart als hij stopt;
   - start de transcoder en laat zien wat hij kan: _video on the GPU (QSV)_ en of _HDR
     tone mapping_ werkt. Dat test hij zelf bij elke start.

3. **De API opnieuw starten**, zodat die de sleutel kent:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   ```

   Aan het eind staat `[OK] Transcoder reachable, video on the GPU (QSV)`.

4. **Controleren:**

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\verify-setup.ps1
   ```

   Onder _Transcoder_ hoort alles groen te zijn. Staat er _the API does not reach the
   transcoder_, terwijl de transcoder zelf wel antwoordt? Dan komt Docker niet bij
   `127.0.0.1`. Zet in `.env` `TRANSCODER_HOST=0.0.0.0`, draai
   `scripts\transcoder.ps1 -Restart` en sta het in de Windows Firewall alleen toe voor
   **privénetwerken**. De sleutel blijft nodig, dus anderen in je netwerk kunnen er niets
   mee.

5. **Uitproberen:**
   - Speel een film met Dolby-audio (E-AC3) af in Chrome. In _Statistieken_ staat dan
     _Beeld origineel, omgepakt door de server_.
   - Kies rechtsonder **1080p** of **720p** bij een 4K-film die hapert. In
     _Statistieken_ staat dan _Omgezet naar H.264 1080p_. Doe daarna de snelheidstest
     nog eens.
   - Spoelen werkt ook tijdens het omzetten. Spring je ver vooruit, dan begint de server
     op die plek opnieuw; dat duurt een paar seconden.

**Goed om te weten:**

- **Plex deelt de GPU** zolang het draait. `TRANSCODER_MAX_TRANSCODES` (standaard 2)
  bepaalt hoeveel films tegelijk worden omgezet. Wie daarna komt, ziet _In de wachtrij_.
  Remuxen telt niet mee, dat kost de GPU bijna niets. Zet het getal hoger als Plex weg is
  (3 tot 5 voor 1080p), en draai dan `scripts\transcoder.ps1 -Restart`.
- **Tijdelijke bestanden** staan in `TRANSCODE_TMP`. De transcoder ruimt ze op als je
  stopt met kijken, verwijdert stukken die ver achter je liggen, en maakt de map leeg
  bij elke start.
- **Bestanden blijven verwijderbaar.** FFmpeg leest de media via de transcoder zelf
  (een lokaal adres op 127.0.0.1). Zo kunnen Sonarr en Radarr een bestand verwijderen,
  vervangen of verplaatsen, ook terwijl iemand het kijkt of de transcoder er een intro in
  zoekt. Zonder dat zegt Sonarr dat het bestand _in gebruik is door ffmpeg.exe_. Gaat er
  iets mis met afspelen, zet dan `TRANSCODER_MEDIA_OVER_HTTP=0` in `.env` en herstart de
  transcoder: dan leest FFmpeg de bestanden weer zelf.
- **Na een `git pull`** met wijzigingen aan de transcoder: `scripts\transcoder.ps1 -Restart`.
- **Problemen?** `scripts\transcoder.ps1 -Status` laat de status en de laatste regels
  van `logs\transcoder.log` zien.
- **HDR naar SDR** gebeurt alleen bij een transcode. Lukt dat niet op de GPU (zie de
  zelftest), dan zien omgezette HDR-films er flets uit. Direct play en remux houden HDR
  zoals het is.

## 15. Ondertitels (fase 6)

De speler heeft nu een knop **CC** (of de toets **c**). Daar kies je de ondertitels,
verschuif je ze als ze niet goed lopen, en zoek je ze op OpenSubtitles.

Waar ondertitels vandaan komen:

| Bron                                                          | Wat CineVault doet                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **In het bestand**, als tekst (SRT, ASS)                      | de transcoder leest ze uit het bestand, vanaf waar je kijkt; ook bij direct play |
| **In het bestand**, als beeld (PGS, VobSub, vaak bij Blu-ray) | staan in de lijst, maar kunnen nog niet getoond worden                           |
| **Los bestand** naast de video, bijv. `Film (2020).nl.srt`    | de scanner vindt ze; CineVault leest ze alleen                                   |
| **OpenSubtitles**                                             | zoeken in de speler; een download wordt bewaard, dus maar één keer opgehaald     |

1. **Bijwerken en opnieuw starten:**

   ```powershell
   cd C:\Users\nsamo\documents\CineVault
   git pull
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1 -Restart
   ```

   `up.ps1` voert ook de nieuwe database-migratie uit. De transcoder moet opnieuw starten,
   omdat hij nu ook ondertitels leest.

2. **OpenSubtitles.** Je API-sleutel staat al in `.env` (`OPENSUBTITLES_API_KEY`). Zonder
   account mag je maar een paar ondertitels per dag downloaden. Met een gratis account op
   opensubtitles.com zijn dat er meer: zet dan ook `OPENSUBTITLES_USERNAME` en
   `OPENSUBTITLES_PASSWORD` in `.env` en draai `up.ps1` opnieuw. Is de limiet bereikt, dan
   zegt de speler dat; wat je al hebt gedownload, blijft werken.

3. **Uitproberen:**
   - Open een anime met Japanse audio. CineVault kiest dan zelf Nederlandse of anders
     Engelse ondertitels, als het bestand die heeft.
   - Klik **CC** en kies een ander spoor. De eerste keer staat er even _De server leest de
     ondertitels uit het bestand_. Daarna is dat spoor bewaard en meteen klaar.
   - Lopen ze voor of achter? Gebruik **−0,5 s** / **+0,5 s**. De verschuiving wordt per
     ondertitel bewaard.
   - **Zoeken op OpenSubtitles…** toont eerst ondertitels die _past bij dit bestand_ zijn:
     die zijn voor precies deze versie gemaakt, dus de timing klopt meestal meteen.

**Goed om te weten:**

- CineVault onthoudt per apparaat welke taal je kiest, of dat je ondertitels uitzet.
- Bij ASS-ondertitels (veel anime) blijft de tekst over, zonder opmaak, kleur of positie.
- Beeldondertitels (PGS) tonen kan alleen door ze in het beeld te branden; dat kan de GPU
  van de N100 niet zonder omweg. Dat komt later, net als Whisper (ondertitels maken uit
  de audio).

## 16. Accounts en kijkvoortgang (fase 5)

CineVault heeft nu een login. Iedereen in het huishouden krijgt een eigen account, met
eigen kijkvoortgang: _Verder kijken_ op de startpagina, waar je gebleven was, en wat je al
gezien hebt.

1. **Bijwerken en opnieuw starten:**

   ```powershell
   cd C:\Users\nsamo\documents\CineVault
   git pull
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   ```

   - `up.ps1` zet de eerste keer twee geheimen in `.env`: `JWT_SECRET` (ondertekent de
     logins) en `API_TOKEN` (voor de scripts). Het toont ze niet. Deel ze niet en zet ze
     niet in git.
   - Het voert ook de nieuwe database-migratie uit.
   - De transcoder hoeft niet opnieuw te starten.

2. **Het eerste account.** Open <http://localhost:8765/>. Je ziet _Welkom bij CineVault_.
   - Kies je naam, een gebruikersnaam en een wachtwoord van minstens 10 tekens.
   - Dit eerste account is de **beheerder**. Alleen beheerders kunnen scannen, matchen en
     accounts beheren.
   - Dit scherm verschijnt maar één keer, zolang er nog geen account is. Doe het dus meteen
     na de update; tot dan kan iedereen in het netwerk dat eerste account maken.

3. **Accounts voor het huishouden.** Klik rechtsboven op je profiel en kies **Accounts**.
   - Voeg per persoon een account toe, als _Lid_ (alleen kijken) of _Beheerder_.
   - Vergeet iemand het wachtwoord? Kies daar **Wachtwoord** en stel een nieuw in. Die
     persoon wordt dan op andere apparaten uitgelogd.
   - Je eigen naam, kleur en wachtwoord pas je aan onder **Profiel**.

4. **Inloggen op een ander apparaat** (bijvoorbeeld je telefoon via Tailscale):
   - De eerste keer typ je je gebruikersnaam en wachtwoord.
   - Daarna toont dat apparaat _Wie kijkt er?_ met de profielen die er eerder inlogden. Je
     kiest je profiel en typt alleen je wachtwoord.
   - Een login blijft 30 dagen geldig, en wordt verlengd zolang je CineVault gebruikt.
   - Via **Ander profiel / uitloggen** wissel je van persoon.

5. **Controleren:**

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\verify-setup.ps1
   ```

   Het rapport meldt nu ook `JWT_SECRET`, `API_TOKEN` en het aantal accounts. Namen en
   wachtwoorden staan er niet in.

**Goed om te weten:**

- **Voortgang.** De speler bewaart elke 10 seconden waar je bent, en ook bij pauzeren en
  sluiten.
  - Open je de titel later, dan gaat de speler daar verder. Je kunt kiezen voor **Vanaf het
    begin**.
  - Een film of aflevering telt als _gezien_ in de laatste 8%, of in de laatste 2 minuten
    (de aftiteling).
  - Aan het eind van een aflevering start de volgende na 10 seconden.
  - Met **Markeer als gezien** zet je dat zelf, ook voor een heel seizoen of een hele serie.
- **Te vaak een verkeerd wachtwoord?** Na 5 pogingen moet je even wachten: eerst 30
  seconden, en steeds langer, tot maximaal 15 minuten. Dat geldt per gebruikersnaam, omdat
  Docker Desktop de echte IP-adressen van apparaten niet aan de API doorgeeft.
- **Scripts** (`scan.ps1`, `verify-setup.ps1`) loggen in met `API_TOKEN`. Krijg je
  _does not accept API_TOKEN_? Draai dan `up.ps1`, zodat de API `.env` opnieuw leest.
- **Iedereen uitloggen**, bijvoorbeeld als een apparaat kwijt is: verwijder de regel
  `JWT_SECRET` uit `.env` en draai `up.ps1`. Dat maakt een nieuw geheim.
- **Toegang van buitenaf.** Met de login is aan de voorwaarde voor poort 80/443 voldaan. Er
  is nog wel een domein nodig (zie CLAUDE.md, _Toegang van buitenaf_). Tot die tijd: alleen
  thuis en via Tailscale.

## 17. De vernieuwde interface (2026-10-17)

De webinterface is opnieuw ontworpen, in de stijl van Netflix en Plex, voor telefoon,
tablet, laptop en smart-tv.

1. **Bijwerken:**

   ```powershell
   cd C:\Users\nsamo\documents\CineVault
   git pull
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   ```

   Er is geen nieuwe migratie en de transcoder hoeft niet opnieuw te starten.

2. **Wat er nieuw is:**
   - **Startpagina:** bovenaan een grote uitgelichte titel met _Afspelen_ en _Meer info_.
     Daaronder rijen: _Verder kijken_, _Nieuw in …_, _Hoog gewaardeerd_ en de meest
     voorkomende genres.
   - **Zoeken** in alle bibliotheken tegelijk, via het zoekveld rechtsboven of de tab
     _Zoeken_ op de telefoon.
   - **Bibliotheken:** sorteren (titel, nieuw toegevoegd, jaar, waardering) en filteren op
     genre. De lijst laadt vanzelf verder bij het scrollen.
   - **Beheer** (scannen, bibliotheken, statistieken, _Aandacht nodig_, _Accounts_) staat
     nu onder je profiel → _Beheer_, niet meer op de startpagina.
   - **De speler:**
     - **Telefoon en tablet:** tik om de bediening te tonen, en dubbeltik links of rechts
       om 10 seconden te spoelen.
     - **Panelen:** _Audio en ondertitels_ en _Instellingen_ (kwaliteit, statistieken).
     - **Knoppen:** volgende aflevering, beeld-in-beeld, en AirPlay in Safari.
     - **Toetsen:** spatie, ← →, F, M en C. Ook de mediatoetsen werken, en het
       vergrendelscherm van een telefoon.

3. **Op de telefoon als app:** open CineVault in Safari of Chrome en kies _Zet op
   beginscherm_. Dan opent het zonder adresbalk, met een eigen icoon.

4. **Op een smart-tv:**
   - **Openen:** open CineVault in de browser van de tv.
   - **Tv-weergave:** CineVault herkent de meeste tv's zelf en schakelt dan de
     tv-weergave in, met grotere tekst en bediening met de pijltjes van de
     afstandsbediening.
   - **Bedienen:** _OK_ opent en speelt af, _Terug_ gaat terug.
   - **Niet herkend?** Zet de tv-weergave dan aan onder _Profiel_ → _Weergave op dit
     apparaat_.

## 18. Back-ups van de database

De back-up bevat alleen de **database** van CineVault:

- de accounts;
- de kijkvoortgang en wat gezien is;
- de handmatige matches;
- de verschuivingen van ondertitels;
- de koppeling van titels aan je bestanden.

Dat zijn een paar MB.

Wat er niet in zit:

- **Je media.** CineVault verandert daar niets aan.
- **Posters en ondertitels uit de cache.** Die worden opnieuw opgehaald.
- **`.env`.** Bewaar daar zelf een kopie van, bijvoorbeeld in een wachtwoordmanager. Er
  staan sleutels in.

1. **Bijwerken:** `git pull`. De API hoeft niet opnieuw gebouwd te worden.

2. **Elke nacht een back-up:**

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\backup.ps1 -Install
   ```

   - **De taak:** een geplande taak _CineVault Backup_ maakt elke nacht om 03:30 een
     back-up in `C:\Users\nsamo\Documents\CineVault-backups`. Hij maakt er meteen ook
     een.
   - **Gemist?** Stond de N100 uit, dan haalt Windows de back-up in zodra het kan.
   - **Docker Desktop** moet draaien. Dat doet het, zolang je aangemeld bent.
   - **Bewaard:** de laatste 14 dagen, en daarnaast één per week voor 8 weken. Oudere
     ruimt hij zelf op.
   - **Andere map of tijd:** zet `BACKUP_DIR` in `.env`, of gebruik
     `-Install -At 02:00`.

3. **Controleren:**

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\backup.ps1 -Status
   ```

   Je ziet de taak, de laatste back-ups en het logboek (`backup.log` in de map).
   `verify-setup.ps1` waarschuwt als de laatste back-up ouder is dan 2 dagen.

4. **Zelf een back-up maken**, bijvoorbeeld vóór een grote update:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\backup.ps1 -Tag voor-update
   ```

   Back-ups met een naam worden nooit vanzelf opgeruimd.

**Terugzetten**, als het misgaat:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1 -List
powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1 -File C:\Users\nsamo\Documents\CineVault-backups\cinevault-2026-10-17_0330.dump
```

- **Welke back-up:** zonder `-File` neemt hij de nieuwste back-up van de nacht.
- **Bevestigen:** je moet eerst `RESTORE` typen.
- **Vooraf:** het script maakt eerst een back-up van de huidige database
  (`…-before-restore.dump`). Zo kun je een verkeerde keuze ongedaan maken.
- **Daarna:** het stopt de API, zet de back-up in één keer terug (lukt het niet, dan
  blijft alles zoals het was) en start de API weer.
- **Oudere back-up:** een back-up van vóór een update werkt ook. De API voert bij het
  starten de nieuwere migraties uit.
- **Opnieuw inloggen:** apparaten moeten misschien opnieuw inloggen.

**Een kopie elders** is extra veilig: bijvoorbeeld een synchronisatiemap van OneDrive of
een NAS. Zet daarvoor `BACKUP_DIR` op die map, of kopieer de map zo nu en dan.

## 19. De Android-app (fase 8)

De app installeer je op de telefoon zelf; op de N100 hoeft niets te veranderen. Zie
[android.md](android.md): downloaden bij de release `android-latest`, installeren,
verbinden met `192.168.0.110:8765` (thuis) of `100.119.127.18:8765` (Tailscale), en
eenmalig een eigen sleutel met `scripts\android-key.ps1`.

**Chromecast:** zet in `.env` `CAST_BASE_URL=https://cine-vault.nl` als dat adres thuis werkt
(NAT loopback), anders `http://192.168.0.110:8765` (het adres van de N100 in het thuisnetwerk), en
start `scripts\up.ps1` opnieuw. Zie stap 45 en [android.md](android.md), deel 5.

**Android TV:** de tv haalt de app van de N100, omdat de repository privé is. Zet de APK's
daarvoor in de map `downloads` met `scripts\get-apk.ps1`, na `scripts\up.ps1`. Op de tv open je
dan `http://192.168.0.110:8765/tv` in de app Downloader. Zie [android.md](android.md), deel 6.

## 20. Toegang van buitenaf met HTTPS (cine-vault.nl)

Caddy (de container `web`) serveert CineVault dan ook op `https://cine-vault.nl`, met een
certificaat van Let's Encrypt. Caddy haalt het certificaat zelf op en vernieuwt het ook
zelf. Thuis blijft `http://192.168.0.110:8765` gewoon werken, net als Tailscale.

**Wat er open gaat:** alleen poort 80 en 443, en alleen naar Caddy. Poort 80 is nodig voor
Let's Encrypt en stuurt verder door naar HTTPS. Alles vraagt een login (fase 5). De API
(3000), de transcoder (8766) en de database zet je **nooit** open in de router.

### 20.1 Een vast adres voor de N100 in huis

De router moet de poorten altijd naar hetzelfde apparaat sturen. Geef de N100 in de router
een vast IP-adres (_DHCP-reservering_ of _vast IP_, op `192.168.0.110`).

**Odido Zakelijk:** de router wordt door Odido beheerd; je kunt er zelf niet op inloggen. Vraag
de zakelijke klantenservice dan om de reservering (20.1) en de port forwarding (20.3), en om te
bevestigen dat je een publiek IPv4-adres hebt (geen CGNAT) en of dat vast is.

### 20.2 DNS bij je domeinregistrar

1. Zoek je publieke IP-adres op. Open op de N100 <https://api.ipify.org>, of voer
   `scripts\verify-setup.ps1` uit (sectie _Public access_).
2. Maak bij de registrar van `cine-vault.nl` een **A-record**:
   - naam: `@` (het domein zelf), soms leeg gelaten;
   - waarde: je publieke IPv4-adres;
   - TTL: 1 uur (3600) is prima.
3. **Verwijder** een AAAA-record (IPv6) en een _parkeerpagina_ of _doorsturing_ van de
   registrar, als die er standaard op staan. Let's Encrypt en telefoons proberen IPv6 eerst,
   en dat komt dan niet bij de N100 uit.

Een DNS-wijziging is meestal binnen een uur overal zichtbaar.

**Eén ding om te controleren:** het WAN-adres van de router moet hetzelfde zijn als het
adres van api.ipify.org. Is het WAN-adres een `100.64.x.x`-adres of een privéadres, dan zit
je achter CGNAT. Dan werkt port forwarding niet, en moet je je provider om een publiek adres
vragen. Kun je niet in de router, vraag het dan aan de provider (zie 20.1).

**Verandert je IP-adres?** Bij een zakelijke aansluiting is het adres vaak vast; vraag het na.
`verify-setup.ps1` en `public-access.ps1` melden een fout als het A-record niet meer naar
je verbinding wijst. Pas het record dan aan. Een automatische update (dynamic DNS) kan
later; dat hangt af van je registrar.

### 20.3 Port forwarding in de router

Stuur in de router (_port forwarding_ of _NAT_, de naam verschilt per model) twee poorten
door naar `192.168.0.110`. Bij Odido Zakelijk doet Odido dat voor je (zie 20.1):

| Extern | Intern | Protocol |
| ------ | ------ | -------- |
| 80     | 80     | TCP      |
| 443    | 443    | TCP      |

### 20.4 Windows Firewall

Open PowerShell **als administrator** in de CineVault-map:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\public-access.ps1 -Install
```

Dat maakt de regels _CineVault HTTP_ en _CineVault HTTPS_ voor TCP 80 en 443, op elk
netwerkprofiel. Het netwerk van de N100 staat op _Openbaar_, en port forwarding komt daar
binnen. Ongedaan maken kan met `-Uninstall`.

### 20.5 Starten

1. Zet in `.env`:

   ```
   PUBLIC_DOMAIN=cine-vault.nl
   ```

2. Start opnieuw (als normale gebruiker):

   ```powershell
   git pull
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   ```

   Meldt het script dat poort 80 of 443 al in gebruik is, dan moet dat programma eerst
   stoppen. Staat er `System`, dan is het een Windows-dienst, bijvoorbeeld IIS.

3. Wacht een minuut. Caddy vraagt dan het certificaat aan.

### 20.6 Controleren

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\public-access.ps1
```

Het script controleert:

- of het domein naar je verbinding wijst;
- de firewall en de poorten;
- het certificaat. Een certificaat van Let's Encrypt betekent dat poort 80/443 van buitenaf
  bereikbaar is;
- of `https://cine-vault.nl/` vanaf de N100 zelf werkt.

Zet daarna op je telefoon **wifi uit** en open `https://cine-vault.nl`. Dat is de echte
test van buitenaf.

**Werkt het buitenshuis wel, maar thuis niet?** Dan stuurt de router verkeer naar je eigen
publieke adres niet terug naar binnen (_NAT loopback_). Gebruik thuis dan
`http://192.168.0.110:8765`.

**Geen certificaat?** Het script toont de laatste fout van Caddy. Meestal is het een van
deze:

| Fout van Caddy               | Oorzaak                                           |
| ---------------------------- | ------------------------------------------------- |
| `Timeout during connect`     | port forwarding of firewall (20.3, 20.4)          |
| `NXDOMAIN` of `no valid A`   | het A-record ontbreekt nog (20.2)                 |
| een IPv6-adres in de melding | er staat nog een AAAA-record (20.2)               |
| een pagina van de registrar  | parkeerpagina of doorsturing staat nog aan (20.2) |

Caddy probeert het zelf opnieuw, met steeds langere pauzes. Wil je na een aanpassing niet
wachten, voer dan `docker compose restart web` uit.

### 20.7 De apps

- **Browser:** `https://cine-vault.nl`. Je logt daar één keer opnieuw in, want het is een
  ander adres dan thuis.
- **Android-app:** _Profiel_ → _Server_ → `cine-vault.nl`. Dat werkt thuis en onderweg, als
  de router NAT loopback doet. Anders kies je thuis het thuisadres.
- **Chromecast:** `CAST_BASE_URL=https://cine-vault.nl` als `https://cine-vault.nl` thuis
  werkt (NAT loopback); anders `http://192.168.0.110:8765`. Zie stap 45.

**Veiligheid:** iedereen op internet ziet nu het loginscherm. Geef elk account een sterk
wachtwoord. Na 5 mislukte pogingen moet je steeds langer wachten (fase 5).

## 21. Intro overslaan

Tijdens de intro van een aflevering tonen alle apps de knop **Intro overslaan**: de browser,
de telefoon, de tv en de telefoon tijdens het casten.

**Bijwerken** (de transcoder doet het zware werk, dus die moet opnieuw starten):

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1 -Restart
```

**Hoe de server de intro vindt:**

- **Hoofdstukken:** heeft het bestand een hoofdstuk _Intro_ of _Opening_ (veel anime), dan is
  dat de intro.
- **Titelmuziek:** anders vergelijkt de server het geluid van de eerste minuten met dat van
  de afleveringen ernaast. De titelmuziek klinkt in elke aflevering, ook als de intro in de ene
  aflevering na 1 minuut begint en in de andere na 5. Wat ze samen delen (12 seconden tot
  2,5 minuut) is de intro.
- **Films** krijgen geen intro, en een aflevering zonder herkenbare titelmuziek ook niet.

**Wanneer:** de server zoekt alleen als niemand kijkt, want hij leest daarvoor veel van de
schijf. De nieuwste afleveringen gaan eerst, zodat wat net binnenkwam meestal al _Intro
overslaan_ heeft voordat je gaat kijken. Een aflevering die je opent, gaat nog daarvoor, met de
rest van dat seizoen. De eerste keer
duurt het voor de hele bibliotheek ongeveer een nacht. Daarna gaat het alleen om nieuwe
afleveringen. Hoe ver hij is, zie je in de webinterface onder _Beheer_ → _Overzicht_.

**Klopt een intro niet?** Open de aflevering in de browser, als beheerder, en kies
_Instellingen_ → _Intro_:

- _Begint hier_ en _Eindigt hier_ zetten het begin of het einde op de plek waar je bent;
- _Geen intro_ zet de knop uit voor die aflevering;
- _Opnieuw zoeken_ laat de server opnieuw zoeken.

Wat je met de hand instelt, verandert de server niet meer.

## 22. Nieuw op de startpagina

Bovenaan de startpagina staat nu wat er nieuw is, in de browser, op de telefoon en op de tv:

- **Nieuwe afleveringen:** series en anime met nieuwe afleveringen, de nieuwste eerst. Kwam
  er een heel seizoen tegelijk binnen, dan staat er één kaart, bijvoorbeeld
  _S2 · A1 · 8 nieuwe afleveringen_. Afleveringen die jij al gezien hebt, tellen niet mee.
  Een kaart opent de serie.
- **Recent toegevoegde films:** de films die het laatst binnenkwamen. _Alles bekijken_ opent
  de bibliotheek, gesorteerd op _Nieuw toegevoegd_.
- **Nieuwe releases:** films die in het afgelopen jaar uitkwamen, en series waarvan een
  aflevering in het afgelopen jaar werd uitgezonden.

**Bijwerken:**

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
```

De API voert daarbij een nieuwe migratie uit. Daarna een nieuwe scan, zodat de films hun
releasedatum krijgen (één keer, de scanner haalt die zelf op bij TMDB):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scan.ps1
```

**Wat telt als "nieuw":** de datum van het bestand op de schijf, het moment waarop Radarr of
Sonarr het neerzette. Zo klopt de volgorde ook voor alles wat er al stond toen CineVault de
bibliotheek voor het eerst scande. Een bestand dat in de plaats van een oud bestand komt met
dezelfde naam, telt niet opnieuw als nieuw.

**Vanzelf scannen:** de API kijkt nu elk uur of er bestanden bij zijn gekomen
(`SCAN_INTERVAL_MINUTES` in `.env`, standaard 60; `0` zet het uit). Alleen nieuwe en
gewijzigde bestanden worden gelezen, dus een scan zonder nieuwe bestanden kost weinig.
Wil je iets meteen zien, start dan zelf een scan onder _Beheer_.

## 23. Aftiteling

Begint de aftiteling van een aflevering, dan verschijnt rechtsonder **Volgende aflevering**,
met een aftelling van 10 seconden. Doe je niets, dan start de volgende aflevering. Met
**Aftiteling bekijken** blijft de aftiteling gewoon doorlopen. Dit werkt in de browser, op de
telefoon en op de tv; tijdens het casten staat de knop _Volgende aflevering_ op de telefoon.

- **Laatste aflevering of een scène na de aftiteling:** is er geen volgende aflevering, maar
  komt er na de aftiteling nog iets, dan staat er **Aftiteling overslaan**.
- **Gezien:** wie tot de aftiteling kijkt, heeft de aflevering gezien.
- **Intro automatisch overslaan:** onder _Instellingen_ in de speler kies je per apparaat of
  de intro vanzelf wordt overgeslagen, of alleen met de knop.

**Bijwerken** (de transcoder leest nu ook het einde van een aflevering):

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1 -Restart
```

**Hoe de server de aftiteling vindt:** net als de intro (stap 21). Een hoofdstuk _Credits_,
_Ending_ of _ED_ gaat voor. Anders vergelijkt de server het geluid van de laatste minuten met
dat van de afleveringen ernaast: de muziek onder de aftiteling klinkt in elke aflevering. Dat
zoeken gebeurt weer als niemand kijkt, en duurt de eerste keer ongeveer een nacht. Hoe ver hij
is, zie je onder _Beheer_ → _Overzicht_.

**Klopt de aftiteling niet?** In de browser, als beheerder, onder _Instellingen_ →
_Aftiteling_: _Begint hier_, _Eindigt hier_, _Geen aftiteling_ of _Opnieuw zoeken_.

## 24. Sonarr en Radarr: meteen zien wat er binnenkomt

CineVault zoekt elk uur naar nieuwe bestanden (stap 22). Met deze koppeling laten Sonarr en
Radarr het CineVault direct weten als er iets is gedownload, en staat een nieuwe aflevering of
film binnen een halve minuut in de app.

1. **Bijwerken:** `git pull` en `scripts\up.ps1`. Dat maakt ook `WEBHOOK_TOKEN` in `.env`.
2. **Het adres:**

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\arr-webhook.ps1
   ```

   Het script toont het adres en controleert of CineVault het beantwoordt. Draaien Sonarr en
   Radarr gewoon op de N100, neem dan het adres met `127.0.0.1`. Draaien ze in Docker, neem dan
   het adres met `host.docker.internal`.

3. **In Sonarr:** _Settings_ → _Connect_ → **+** → _Webhook_.
   - **Name:** CineVault
   - **Notification Triggers:** _On Import_ (of _On Download_), _On Upgrade_, _On Rename_,
     _On Series Delete_ en _On Episode File Delete_.
   - **URL:** het adres van het script. **Method:** POST. Laat _Username_ en _Password_ leeg.
   - Klik op **Test**: er verschijnt een groen vinkje. Daarna **Save**.
4. **In Radarr** hetzelfde, met _On Movie Delete_ en _On Movie File Delete_.

**Wat er gebeurt:** na een download scant CineVault alleen de bibliotheek waar het bestand in
staat (Films, Series of Anime). Een heel seizoen tegelijk wordt één scan, 15 seconden na de
laatste melding. Loopt er al een scan, dan volgt de nieuwe daarna.

**Het adres** bevat een sleutel. Die kan alleen een scan starten, maar houd hem toch voor
jezelf.

## 25. Kijken: binnenkort, logo's, trailers en meer zoals dit

- **Binnenkort:** op de startpagina een rij met series waarvan binnen 60 dagen een nieuwe
  aflevering uitkomt, met de dag (_Vandaag_, _Morgen_, _za 24 okt_). Op de pagina van de serie
  staat _Nieuwe aflevering_ met de datum. De datum komt van TMDB, of van TVmaze als TMDB de
  serie niet kent.
- **Logo's:** de titel staat als logo van TMDB op de grote afbeelding van de startpagina en de
  detailpagina. Zonder logo blijft het de tekst.
- **Trailer:** een knop op de detailpagina. In de browser speelt de trailer in de pagina (van
  YouTube); op de telefoon en de tv opent de YouTube-app.
- **Meer zoals dit:** onder aan de detailpagina titels uit je eigen bibliotheek die TMDB
  aanraadt, aangevuld met titels uit dezelfde genres.
- **Scherpere achtergronden op een 4K-tv:** de tv-app en de browser op een tv of een groot
  scherm halen de achtergrond op ware grootte op, niet 1280 pixels breed.
- **Dolby Vision in Safari:** bestanden met alleen Dolby Vision (profiel 5, zonder HDR10-basis)
  krijgt Safari nu als Dolby Vision door, zodat de kleuren kloppen.

**Bijwerken:**

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1 -Restart
powershell -ExecutionPolicy Bypass -File .\scripts\scan.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\get-apk.ps1
```

- `up.ps1` voert de databasemigratie uit.
- `transcoder.ps1 -Restart` is voor Dolby Vision.
- De **scan** haalt bij alle gematchte titels één keer de nieuwe gegevens op (logo, trailer,
  aanbevelingen, volgende aflevering) en leest de Dolby Vision-bestanden opnieuw uit. Dat kost
  bij ruim 200 titels een paar minuten. Zonder `scan.ps1` gebeurt het bij de scan van het
  volgende uur.
- `get-apk.ps1` haalt de nieuwe Android-apps op, voor de telefoon en de tv.

**Daarna:** de datums van _Binnenkort_ blijven vanzelf bij. Is de datum voorbij, dan haalt de
eerstvolgende scan de nieuwe datum op. Series worden ook elke week ververst, zodat een nieuw
aangekondigd seizoen er vanzelf bij komt.

## 26. Mijn lijst en meldingen

- **Mijn lijst:** bewaar een film of serie met de knop **Mijn lijst** (op de detailpagina en de
  grote afbeelding van de startpagina). De lijst staat bovenaan de startpagina, en in de browser
  ook in het menu. Iedereen in huis heeft een eigen lijst.
- **Meldingen** krijg je bij:
  - **een nieuwe aflevering** van een serie die je volgt. Je volgt een serie als hij in Mijn lijst
    staat, of als je er de laatste vier maanden een aflevering van keek. Komt een heel seizoen
    tegelijk binnen, dan is het één melding (_Seizoen 3 staat klaar_);
  - **de dag dat een aflevering uitkomt** (vanaf 10:00, _Vandaag verschijnt …_). Zodra Sonarr hem
    heeft gedownload, volgt de melding hierboven;
  - **een aanrader:** een nieuwe film of serie die TMDB aanraadt bij iets wat je keek;
  - **een nieuwe login op je account** (met welk apparaat). Was jij dat niet, kies dan een nieuw
    wachtwoord;
  - **voor beheerders:** nieuwe titels die niet gematcht konden worden, en een transcoder die
    ongeveer een kwartier niet bereikbaar is.
- **Stille uren:** tussen 23:00 en 08:00 wachten meldingen tot 08:00. Een nieuwe login komt wel
  meteen.
- **Waar:**
  - **Het belletje** in de browser, op de telefoon (rechtsboven op Home) en op de tv (onder
    _Profiel_).
  - **Op de telefoon als Android-melding:** zet ze aan onder _Profiel_ → _Meldingen_ →
    _Meldingen op deze telefoon_. Sinds 12 november 2026 houdt de app daarvoor een verbinding met
    de server open (zonder Google Firebase): een melding komt **meteen**, ook als de app dicht is,
    na een herstart van de telefoon en na een update van de app. Android vraagt daarvoor een
    vaste, stille melding onderaan (_Meldingen staan aan_ · _Verbonden_); die mag je wegvegen, of
    verbergen met lang indrukken → _Verbinding met de server_ uit. De verbinding blijft dan.
    - **Batterij:** zet CineVault onder _Instellingen_ → _Apps_ → _CineVault_ → _Batterij_ op
      _Onbeperkt_ (de knop _Batterijbesparing uitzetten_ opent die lijst). Anders verbreekt Android
      de verbinding als de telefoon slaapt, en komen meldingen pas bij het ontgrendelen.
    - **Hoe ze eruitzien:** de poster van de titel klein naast de tekst; uitgeklapt het beeld van de
      aflevering (of de achtergrond van de titel) groot; een label per soort (_Nieuwe aflevering_,
      _Aanrader_, _Je verzoek_); en knoppen: **▶ Afspelen** (de nieuwe aflevering meteen),
      **Bekijken** (de titel), **+ Mijn lijst** (bij een aanrader, zonder de app te openen) en
      **Wachtwoord wijzigen** (bij een nieuwe login). Meer meldingen tegelijk staan in één groep
      met een overzicht.
    - Onder de schakelaar staat of de app verbonden is (groen), aan het verbinden (messing) of
      niet (rood, met de reden), en wanneer de laatste melding kwam.
  - **In de browser als pushmelding:** onder _Profiel_ → _Meldingen in deze browser aan_. Dat werkt
    alleen via `https://cine-vault.nl` (stap 20), niet via `http://192.168.0.110:8765`. Op een
    iPhone of iPad moet CineVault dan eerst op het beginscherm staan (_Deel_ → _Zet op
    beginscherm_).
- **Per soort aan of uit:** onder _Profiel_ → _Meldingen_. Met **Stuur een testmelding** zie je
  of ze aankomen.

**Bijwerken:**

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\get-apk.ps1
```

`up.ps1` voert de databasemigratie uit. Installeer daarna de nieuwe app op de telefoon en de tv.
De meldingen die meteen komen, vragen de server en de app van 12 november 2026 of later; een
oudere server krijgt van de nieuwe app elke minuut een vraag.
Een andere tijdzone dan Nederland? Zet `NOTIFY_TIMEZONE` in `.env` (bijvoorbeeld
`Europe/Brussels`).

## 27. Ontdekken en verzoeken: nieuwe films en series aanvragen

Onder **Ontdekken** (in het menu van de browser, als tabblad op de telefoon en in het menu op de
tv) staan rijen met wat er nieuw is: _Nieuw te streamen_, _Trending films_, _Nieuwe series_,
_Trending series_, _Anime van dit seizoen_, _Trending anime_, _Nu in de bioscoop_, _Binnenkort in
de bioscoop_, _Binnenkort: anime_, _Nu op tv_, _Populaire anime_, _Anime-films_ en _Populaire
films_. Met **Alles bekijken** blader je verder door een rij, en bovenaan zoek je films, series en
anime tegelijk. Een titel opent met de beschrijving, de trailer en de knop **Aanvragen**. Wat er
al is, staat er als _In bibliotheek_; wat aangevraagd is, met de stand.

**Anime komt van AniList.** De anime-rijen komen van [AniList](https://anilist.co), en een
zoekopdracht vraagt AniList ook. Zo vind je anime ook op de Japanse of romaji-titel
(_Kimetsu no Yaiba_, _Sousou no Frieren_), en staat het hele seizoen erin. Elke anime wordt
gekoppeld aan zijn titel bij TMDB, zodat de pagina en het aanvragen werken zoals bij elke serie;
een tweede seizoen opent de serie, waar je dat seizoen kiest. Een anime die TMDB (nog) niet kent,
staat er niet bij: die kan Sonarr niet vinden. Antwoordt AniList niet, dan komen _Anime van dit
seizoen_ en _Populaire anime_ van TMDB, zoals eerst. Uitzetten: `ANILIST=false` in `.env`.

Na goedkeuring door een beheerder zet CineVault de titel in Radarr of Sonarr. Die zoeken en
downloaden hem. Zodra hij binnen is, krijgt wie hem aanvroeg een melding, en staat hij in diens
Mijn lijst. Een film die nog in de bioscoop draait, kun je al aanvragen: Radarr downloadt hem
zodra hij digitaal uitkomt.

1. **De API-keys:** in Radarr en in Sonarr onder _Settings_ → _General_ → _API Key_.
2. **In `.env`** op de N100:

   ```
   RADARR_API_KEY=…
   SONARR_API_KEY=…
   ```

   Draaien Radarr en Sonarr gewoon op Windows (poort 7878 en 8989), dan hoeft er verder niets.
   Anders zet je ook `RADARR_URL` en `SONARR_URL`, zoals de API-container ze bereikt
   (bijvoorbeeld `http://host.docker.internal:7878`).

3. **Bijwerken:**

   ```powershell
   git pull
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   powershell -ExecutionPolicy Bypass -File .\scripts\get-apk.ps1
   ```

4. **In de browser,** als beheerder: _Beheer_ → _Verzoeken_. Daar staat of Radarr en Sonarr
   verbonden zijn. Kies per soort (films, series, anime) de map en de kwaliteit. CineVault kiest
   zelf de map die `Movies`, `Series` of `Anime` heet, en het eerste kwaliteitsprofiel.
5. **Goedkeuren:** een nieuw verzoek geeft beheerders een melding. Onder _Ontdekken_ →
   _Verzoeken_ staan **Goedkeuren** (bij een serie met het vinkje _Anime_) en **Afwijzen** (met een
   reden als je wilt). Verzoeken van een beheerder gaan meteen. Met _Verzoeken van leden meteen naar Radarr en
   Sonarr sturen_ is goedkeuren niet meer nodig.

**Mislukt een verzoek,** dan staat erbij wat Radarr of Sonarr zei. Kies dan **Opnieuw proberen**.
Een serie die TheTVDB niet kent, kan Sonarr niet toevoegen.

**Acteurs.** Bij elke film, serie en anime in _Ontdekken_ staat de cast, met foto en rol (van
TMDB), in de browser, op de telefoon en op de tv.

**Seizoenen of afleveringen aanvragen.** Bij een serie hoef je niet de hele serie aan te vragen:

- **In de browser en op de telefoon:** onder _Seizoenen of afleveringen aanvragen_ vink je hele
  seizoenen aan, of klap je een seizoen open en vink je losse afleveringen aan. Daarna
  bijvoorbeeld **Seizoen 2 aanvragen** of **S1 · A1–A3 aanvragen**. _Hele serie aanvragen_ kan
  nog steeds.
- **Op de tv:** kies hele seizoenen (losse afleveringen gaan via de telefoon of de browser).
- **Een serie die al in de bibliotheek staat:** vraag zo de ontbrekende seizoenen of
  afleveringen aan. Wat er al is, of al gevraagd is, kun je niet nog eens kiezen.
- **Sonarr:** CineVault voegt de serie toe zonder iets te volgen, en laat Sonarr daarna alleen
  de gevraagde afleveringen volgen en zoeken. Bij een heel seizoen volgt Sonarr ook de
  afleveringen die later nog uitkomen. Staat de serie al in Sonarr, dan gaat het om dezelfde
  serie; Sonarr volgt dan alleen de gevraagde delen erbij.
- **Nummering:** CineVault toont seizoenen zoals TMDB ze nummert. Nummert Sonarr ze anders
  (vaak bij anime), dan koppelt CineVault de afleveringen op de datum van uitzending.
- **Klaar:** het verzoek staat op _Staat klaar_ zodra alle gevraagde afleveringen in de
  bibliotheek staan. Onder _Verzoeken_ staat bij elk verzoek welk deel het is.
- Vraagt iemand iets bij een verzoek dat nog wacht, dan komt het bij dat verzoek.
- **Een grote serie** heeft Sonarr soms meer dan een halve minuut nodig om toe te voegen. Het
  verzoek staat dan op _Wordt gezocht_ met _Sonarr voegt de serie nog toe_; CineVault volgt de
  afleveringen zodra Sonarr klaar is. Staat een verzoek op _Mislukt_, dan staat de reden erbij;
  _Opnieuw proberen_ stuurt het nog eens naar Sonarr. Verzoeken die eerder goedgekeurd zijn en
  niets downloadden, kun je in Sonarr zelf aanzetten (de afleveringen volgen), of het verzoek
  intrekken en opnieuw doen.

**Collectie en Meer zoals dit.** Op de pagina van een titel in Ontdekken staan onder de cast
nog twee rijen:

- **De collectie** (alleen films): alle films van de reeks op volgorde van verschijnen, ook
  die nog niet uit zijn (_Verschijnt 2027_, _Aangekondigd_). De film die open is, heet _Deze
  film_. Een vlag zegt of een film al in de bibliotheek staat of aangevraagd is, en een tik opent
  de pagina van die film, om hem aan te vragen. Staat er een film van in de bibliotheek, dan
  opent _Alles bekijken_ (app: _In bibliotheek_) de collectie daar.
- **Meer zoals dit** (films en series): de aanbevelingen van TMDB, ook titels die nog niet in
  de bibliotheek staan.

Dit staat in de browser, op de telefoon en op de tv. Na deze update: `.\scripts\up.ps1`; de app
heeft een nieuwe build nodig.

## 28. Kinderprofielen, accounts in de app en "Wordt gedownload"

**Kinderprofielen.** Een lid kan een leeftijdsgrens krijgen: AL, 6, 9, 12, 14 of 16 (Kijkwijzer).
Zo'n kinderprofiel ziet alleen titels met die leeftijd of lager. CineVault haalt de leeftijd bij
TMDB op: eerst de Nederlandse (Kijkwijzer), anders de Duitse, Britse of Amerikaanse, omgerekend
naar een leeftijd. Een titel zonder leeftijd ziet een kinderprofiel niet. Ontdekken en
verzoeken zijn voor een kinderprofiel verborgen. Een beheerder kan geen kinderprofiel zijn.

1. **Bijwerken:**

   ```powershell
   git pull
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   powershell -ExecutionPolicy Bypass -File .\scripts\get-apk.ps1
   ```

2. **De leeftijden ophalen:** de eerstvolgende scan (binnen een uur, of `scan.ps1`) haalt bij
   TMDB één keer de leeftijd op van alle gematchte titels. Tot dan ziet een kinderprofiel nog
   niets.
3. **Een kinderprofiel maken:** in de browser onder _Accounts_ (kies bij _Leeftijd_ een
   kinderprofiel), of in de app (zie hieronder). Een bestaand account zet je met de keuzelijst
   naast de rol op een leeftijd.

**Accounts in de app.** Wie als beheerder inlogt in de Android-app (telefoon of tablet), heeft
onder _Profiel_ → **Accounts** de accounts van het huishouden: toevoegen (naam,
gebruikersnaam, wachtwoord, rol en eventueel een kinderprofiel), wijzigen (naam, kleur, rol,
leeftijd en een nieuw wachtwoord) en verwijderen. Op een tablet staan de lijst en het formulier
naast elkaar. Je eigen rol wijzig je daar niet, zodat je jezelf niet buitensluit, en jezelf
verwijderen kan niet. Een lid ziet niets van het beheer; ook het meldingskanaal _Beheer_ staat
alleen bij beheerders in de Android-instellingen. Op de tv zit dit niet.

**Wordt gedownload.** Bovenaan _Verzoeken_ (browser, telefoon en tv) staat wat Radarr en Sonarr
nu downloaden: per titel de voortgang, de tijd die nog nodig is en bij een serie de afleveringen.
Een aangevraagde titel toont dat ook bij het verzoek, en de pagina van een titel (in de
bibliotheek of in Ontdekken) toont het terwijl hij binnenkomt, zoals nieuwe afleveringen van een
serie die er al is. Het werkt met de API-keys uit stap 27; zonder keys staat er niets.

## 29. Titels verwijderen via Radarr en Sonarr

Een beheerder kan een film, een serie, een seizoen of een aflevering verwijderen. CineVault
verwijdert zelf niets, want de mediamappen zijn voor CineVault alleen-lezen. Het vraagt Radarr
of Sonarr, die de bestanden beheren, om ze van de schijf te halen. Daarna scant CineVault de
bibliotheek opnieuw, en na ongeveer een halve minuut is de titel ook uit CineVault weg.

Het werkt met de API-keys uit stap 27; verder is er niets in te stellen.

- **Telefoon of tablet:** open de titel en kies onderaan onder _Beheer_ **Film verwijderen** of
  **Serie verwijderen**. Een seizoen verwijder je met het prullenbakje naast de seizoenkeuze,
  een aflevering door hem lang ingedrukt te houden.
- **Browser:** op de pagina van de titel ⋯ → **Film verwijderen…** of **Serie verwijderen…**.
- **Tv:** daar kan het niet, zodat er niet per ongeluk iets met de afstandsbediening verdwijnt.

Eerst toont CineVault wat er weggaat (hoeveel bestanden, hoeveel GB) en welke dienst het doet.
Verwijderen kan niet ongedaan worden gemaakt.

- **Een film:** Radarr verwijdert de film met de map en de bestanden, en volgt hem niet meer.
- **Een serie:** Sonarr verwijdert de serie met de map en alle afleveringen.
- **Een seizoen of aflevering:** Sonarr verwijdert die bestanden en zoekt de afleveringen daarna
  niet opnieuw (ze staan op _niet gevolgd_). De serie zelf blijft in Sonarr.

Een titel die weg is, kan later gewoon opnieuw worden aangevraagd onder _Ontdekken_. Kent Radarr
of Sonarr een titel niet (bijvoorbeeld een film die je met de hand in de map zette), dan zegt
CineVault dat en gebeurt er niets.

## 30. Agenda: nieuwe afleveringen in Google Agenda

CineVault weet wanneer de volgende afleveringen van je series uitkomen (van TMDB, of TVmaze).
Die staan onder **Agenda**: in de browser via het profielmenu (rechtsboven) → _Agenda_, en in
de app onder _Profiel_ → _Agenda_. Ook _Alles bekijken_ bij de rij _Binnenkort_ op Home gaat
erheen.

- **Die ik volg:** series in je _Mijn lijst_, en series waarvan je de laatste vier maanden een
  aflevering keek (dezelfde als bij de meldingen). **Alle series:** alles in de bibliotheek.
- Per dag, vanaf een week terug. Een aflevering die al binnen is, krijgt _Staat klaar_.
- Een kinderprofiel ziet alleen series voor zijn leeftijd.

De datums komen bij de volgende scan binnen (elk uur, of meteen met
`.\scripts\scan.ps1`). Daarna ververst CineVault series elke week, en zodra de volgende
aflevering is uitgezonden.

### Koppelen met Google Agenda

Elk profiel heeft een eigen, geheime link naar een agenda (`https://cine-vault.nl/api/calendar/ics/…`).
Google haalt die zelf op, vanaf zijn eigen servers; daarom werkt het alleen via het domein met
HTTPS (stap 20). CineVault gebruikt daarvoor `PUBLIC_DOMAIN` uit `.env`, ook als je thuis via
`192.168.0.110:8765` werkt.

**Google Agenda** (eenmalig, op een computer: de app van Google Agenda op je telefoon kan geen
agenda via een link toevoegen):

1. Kopieer de link: in de browser _Agenda_ → **Koppelen** → **Link kopiëren**, of in de app
   _Agenda koppelen_ → **Link naar je computer sturen**.
2. Open calendar.google.com en kies links bij _Andere agenda's_ **+** → **Via URL**.
3. Plak de link en kies **Agenda toevoegen**. De agenda heet _CineVault – jouw naam_.
4. Op je telefoon: Google Agenda → ☰ → _Instellingen_ → _CineVault – jouw naam_ →
   **Synchroniseren** aan.

Open het gedownloade `.ics`-bestand niet met _Importeren_: dan komen de afleveringen er één keer
in en wordt de agenda nooit bijgewerkt.

Op een iPhone, iPad of Mac opent **Agenda-app** (browser) of **Andere agenda-app** (app) de link
in de agenda van Apple als abonnement.

Google ververst een gekoppelde agenda zelf, meestal een paar keer per dag; een nieuwe datum
staat er dus niet meteen in. Op Android zonder Google Agenda werkt de app **ICSx⁵**: kies
_Link delen_ en deel de link naar ICSx⁵.

Iedereen met de link ziet welke series je volgt (alleen titels, afleveringen en datums), zonder
in te loggen. Is de link uitgelekt, kies dan **Nieuwe link maken**: de oude werkt dan niet meer,
en je koppelt de agenda opnieuw.

## 31. Intro's van anime via AniSkip

Voor anime haalt CineVault de opening en de ending eerst bij **AniSkip** (api.aniskip.com).
Daar zetten kijkers de tijden van elke aflevering in. Dat is vaak preciezer dan wat CineVault
zelf in de audio vindt, en het hoeft het bestand niet te lezen. Voor series die geen anime zijn
verandert er niets.

- **Welke serie is anime?** Die in de _anime-lists_ van Fribb staat: een lijst die TheTVDB- en
  TMDB-seizoenen koppelt aan MyAnimeList, waar AniSkip mee werkt. CineVault haalt die lijst
  (ongeveer 6 MB) één keer per week op en bewaart hem in de cache.
- **Seizoenen in delen:** Sonarr telt zoals TheTVDB (_Bleach S17E14_), MyAnimeList per cour
  (_Thousand-Year Blood War – The Separation, aflevering 1_). De lijst weet waar elk deel begint.
- **Wat AniSkip niet heeft,** zoekt CineVault zoals eerst: hoofdstukken in het bestand, of de
  audio die de afleveringen delen.
- **Later opnieuw:** AniSkip krijgt nieuwe tijden als mensen kijken. Een recente aflevering
  (laatste 60 dagen) waarvan alleen de audio iets vond, vraagt CineVault na een paar dagen opnieuw.
  Afleveringen die al vóór deze versie doorzocht waren, vraagt het één keer.
- **Wat je met de hand instelde,** en hoofdstukken uit het bestand, blijven altijd staan.
- **In de speler** (beheerder, _Instellingen_ → _Intro_) staat bij de tijden _van AniSkip_.

Er is niets in te stellen. Wil je het uit, zet dan in `.env`:

```
ANISKIP=false
```

en start opnieuw met `.\scripts\up.ps1`.

## 32. Themamuziek op de pagina van een serie

Op de pagina van een serie (ook anime) speelt zacht de titelmuziek, **dezelfde als in Plex**. Sinds
2026-10-20 komt die alleen nog van de themadienst die Plex zelf gebruikt
(`tvthemes.plexapp.com`, op het TVDB-nummer van de serie). Je Plex-server hoeft daarvoor niet te
draaien. CineVault haalt elk nummer één keer op en bewaart het in de cache (`themes`); daarna speelt
het ook als die dienst er even niet is. De mediamappen blijven onaangeroerd.

- **Anime: ook van AnimeThemes.** Heeft Plex niets voor een anime, dan neemt CineVault de eerste
  opening van [AnimeThemes](https://animethemes.moe) (sinds 2026-10-22). Dat werkt voor series die in
  de anime-lijsten van AniSkip staan (op MyAnimeList); gewone series komen alleen van Plex. Uitzetten:
  `ANIME_THEMES=false` in `.env`.
- **Anders: ThemerrDB en YouTube.** Heeft ook AnimeThemes niets, dan zoekt CineVault de serie op
  in [ThemerrDB](https://github.com/LizardByte/ThemerrDB) (een lijst met themesongs op YouTube,
  bijgehouden door gebruikers van Plex- en Jellyfin-plugins) en downloadt het nummer van YouTube met
  yt-dlp. Hooguit de eerste 3 minuten. Let op: downloaden van YouTube is tegen de voorwaarden van
  YouTube. yt-dlp zit in de API-container en werkt zichzelf elke dag bij (YouTube verandert vaak).
  Vraagt YouTube om in te loggen (_Sign in to confirm you're not a bot_), dan wacht CineVault een
  kwartier en probeert het opnieuw. Uitzetten: `THEMERRDB=false` in `.env`. Staat een serie niet in
  ThemerrDB, dan kun je hem daar zelf aanmelden (zie de README van ThemerrDB); een week later vraagt
  CineVault het opnieuw, of meteen met _Nu opnieuw proberen_.
- **Alleen series.** Plex heeft geen themamuziek voor films, dus films hebben er geen.
- **Niet elke serie.** Heeft Plex geen nummer voor een serie, dan blijft het stil; CineVault vraagt
  het na een week opnieuw. Er wordt niets meer uit je eigen bestanden geknipt.
- **Geen officiële dienst.** Plex kan hem zonder waarschuwing veranderen of stoppen. Wat al in de
  cache staat, blijft dan werken.
- **Uitzetten per serie** (beheerder): op de pagina ⋯ → _Themamuziek uitzetten_.
- **Helemaal uitzetten:** `PLEX_THEMES=false` in `.env`.
- **Vooraf:** elke 10 minuten haalt de server de nummers van een paar series op (50 per keer, de
  nieuwste eerst, één per seconde), zodat een pagina het meteen heeft. Een pagina die er nog geen
  heeft, wacht er een paar seconden op. Op de tv speelt bij het bladeren alleen wat al is opgehaald.
- **Hoe ver het is:** _Beheer_ → _Overzicht_ → _Themamuziek_: hoeveel series een nummer hebben,
  voor hoeveel Plex er geen heeft, en de laatste fout (bijvoorbeeld _Plex themes not reachable_).
  Meer details in het logboek van de API:

  ```
  docker compose logs api | Select-String themes
  ```

- **HTTP:** de themadienst van Plex is bedoeld voor `http://`. CineVault probeert eerst `https://`
  en gebruikt `http://` als dat geen verbinding geeft, of als `https://` zegt dat er niets is (404):
  pas als beide niets hebben, telt het als _geen bij Plex_.
- **Welke series er geen hebben:** onder _Themamuziek_ staat _Series zonder themamuziek_ (op het
  web uitklappen, in de app _Toon de series…_). Per serie het TVDB-nummer en wat Plex antwoordde
  (`Plex: 404 https, 404 http`: Plex heeft niets voor dat nummer; `AnimeThemes: geen opening` of
  `niet bij AnimeThemes`; `ThemerrDB: niet in ThemerrDB` of `ThemerrDB: YouTube: …`). Controleren
  kan zelf:
  - het TVDB-nummer opent de serie op TheTVDB. Is dat een andere serie, dan is de match verkeerd:
    corrigeer die op de pagina van de serie (⋯ → _Match corrigeren_);
  - _bij Plex_ opent `http://tvthemes.plexapp.com/<nummer>.mp3`. Speelt dat in je browser ook niet,
    dan heeft Plex echt geen nummer voor die serie. Plex heeft vooral muziek voor bekende,
    Amerikaanse en Britse series; voor anime en heel nieuwe series vaak niet.
- **Nu opnieuw proberen:** vraagt Plex meteen opnieuw naar alle series zonder nummer (anders na een
  week), bijvoorbeeld na het corrigeren van een match.

**Op de tv al bij het bladeren:** blijft de focus even (ongeveer een seconde) op een poster staan,
op Home, in een bibliotheek, bij zoeken of in Ontdekken, dan begint de themamuziek van die titel
al. Ga je naar een andere poster, dan gaat de muziek over in die van de nieuwe titel. Open je de
titel, dan speelt hetzelfde nummer gewoon door; bij _Afspelen_ stopt het meteen. Bij het bladeren
speelt alleen themamuziek die de server al heeft opgehaald, zodat bladeren niet voor elke poster
een verzoek naar Plex stuurt. Een serie waarvan het er nog niet is, speelt het op zijn eigen
pagina wel.

**Per apparaat** kies je het onder _Profiel_:

- **Browser:** _Themamuziek op dit apparaat_, aan of uit, en het volume (standaard 30%).
  Browsers spelen pas geluid na een klik op de pagina; kom je via een klik van een andere pagina,
  dan begint het meteen.
- **Tv-app:** _Uit_, _Zacht_, _Normaal_ (standaard) of _Luider_.
- **Telefoon:** dezelfde keuzes, maar standaard _Uit_. Muziek van een andere app wordt even
  zachter en komt daarna terug.
- De knop **Muziek stoppen** (of het luidsprekertje in de browser) stopt het voor die serie.
  Op _Afspelen_ drukken of de pagina verlaten laat het uitfaden.

Na de update met ThemerrDB (2026-10-22): `.\scripts\up.ps1` (het API-image haalt yt-dlp op; dat
duurt de eerste keer even), daarna in _Beheer_ één keer _Nu opnieuw proberen_. De app hoeft niet
opnieuw gebouwd te worden.

Na de update met AnimeThemes (2026-10-22): `.\scripts\up.ps1`, daarna in _Beheer_ één keer _Nu
opnieuw proberen_; dan haalt de server de openings van de anime meteen op, anders binnen een uur.
De app hoeft niet opnieuw gebouwd te worden.

Na de update van 2026-10-22 (de lijst en _Nu opnieuw proberen_): `.\scripts\up.ps1`, daarna in
_Beheer_ één keer _Nu opnieuw proberen_ (dan vraagt CineVault ook via `http://`). De app heeft alleen
een nieuwe build nodig voor de lijst in de app.

Na de update van 2026-10-20 (Plex als bron): `.\scripts\up.ps1`. De oude, zelf geknipte nummers
worden bij de start uit de cache verwijderd. De transcoder hoeft niet opnieuw te starten (hij maakt
geen themamuziek meer; `.\scripts\transcoder.ps1 -Restart` ruimt dat deel op als je wilt). Alleen
voor de nieuwe tekst onder _Profiel_ heeft de app een nieuwe build nodig; zonder werkt alles ook.

## 33. Audio en ondertitels per serie, en voorbeeldbeelden op de tijdlijn

**Audio en ondertitels per serie.** Kies je bij een serie een ander audiospoor of andere
ondertitels, dan onthoudt CineVault dat voor die serie en dat profiel. De volgende aflevering
begint zo, ook op een ander apparaat (browser, telefoon, tv). Bijvoorbeeld Vinland Saga in het
Japans met Nederlandse ondertitels.

- **Anime** (de bibliotheek `Anime`) begint in het Japans als de aflevering een Japans spoor heeft,
  tot je zelf iets anders kiest. Commentaarsporen worden overgeslagen. Bij Japans geluid kiest de
  speler zelf Nederlandse of anders Engelse ondertitels.
- Is de gekozen taal er in een aflevering niet, dan gelden de gewone keuzes.
- Een ander spoor dan het standaardspoor betekent een remux door de transcoder, net als wanneer
  je het met de hand kiest.

**Voorbeeldbeelden op de tijdlijn.** Tijdens het spoelen zie je een klein beeld van waar je heen
gaat: in de browser onder de muis of tijdens het slepen, op de telefoon tijdens het slepen, en op
de tv bij links en rechts.

- De transcoder maakt die beelden één keer per bestand: elke 10 seconden een beeld (bij lange
  films wat minder vaak, hooguit zo'n 400). Hij zoekt daarvoor per beeld het dichtstbijzijnde
  keyframe op, zodat hij maar een paar MB per beeld leest en niet het hele bestand. HDR wordt
  omgezet naar normale kleuren.
- Dat gebeurt **alleen als er 2 minuten niemand kijkt**, de nieuwste bestanden eerst. Begint
  iemand te kijken, dan stopt het na het blad waar hij mee bezig is, en gaat later daar verder.
- Een film of aflevering van een uur kost ongeveer een halve minuut tot een paar minuten. De hele
  bibliotheek duurt dus een tijd; nieuwe bestanden komen vanzelf aan de beurt.
- De beelden staan in de cache (`thumbnails`): ongeveer 5 MB per uur video, voor de hele
  bibliotheek dus enkele GB in het Docker-volume. Bestanden korter dan 2 minuten krijgen er geen.

Na de update met AnimeThemes (2026-10-22): `.\scripts\up.ps1`, daarna in _Beheer_ één keer _Nu
opnieuw proberen_; dan haalt de server de openings van de anime meteen op, anders binnen een uur.
De app hoeft niet opnieuw gebouwd te worden.

Na de update van 2026-10-22 (de lijst en _Nu opnieuw proberen_): `.\scripts\up.ps1`, daarna in
_Beheer_ één keer _Nu opnieuw proberen_ (dan vraagt CineVault ook via `http://`). De app heeft alleen
een nieuwe build nodig voor de lijst in de app.

Na de update van 2026-10-20 (Plex als bron): `.\scripts\up.ps1`. De oude, zelf geknipte nummers
worden bij de start uit de cache verwijderd. De transcoder hoeft niet opnieuw te starten (hij maakt
geen themamuziek meer; `.\scripts\transcoder.ps1 -Restart` ruimt dat deel op als je wilt). Alleen
voor de nieuwe tekst onder _Profiel_ heeft de app een nieuwe build nodig; zonder werkt alles ook.

## 34. Beeldondertitels als tekst, en recaps overslaan

**Beeldondertitels (PGS) als tekst.** Blu-ray-releases hebben vaak ondertitels als plaatjes
(PGS, bijvoorbeeld "English (SDH)"). Die kon CineVault niet tonen. Nu leest de server ze met
tekstherkenning (Tesseract, in de API zelf) en maakt er gewone ondertitels van.

- Alleen **PGS in het Engels of het Nederlands** (en PGS zonder taal, als Engels gelezen).
  VobSub (DVD) en andere talen niet.
- **Vanzelf:** als er 2 minuten niemand kijkt, de nieuwste bestanden eerst, en alleen sporen
  waarvoor het bestand nog geen tekstondertitel in die taal heeft. Geforceerde sporen niet.
- **Met de hand:** in de speler onder _Audio en ondertitels_ staat bij zo'n spoor _Omzetten naar
  tekst_ (op de telefoon en de tv: het spoor kiezen). Dat gaat voor. Je ziet het percentage;
  als het klaar is, kiest de speler het spoor zelf.
- De server leest daarvoor het **hele bestand** één keer van de schijf (via de read-only mount).
  Een film kost zo enkele minuten. Het resultaat staat in de cache en is daarna meteen te kiezen,
  op elk apparaat.
- Tekstherkenning maakt soms een fout (een `l` voor een `I`, een verkeerde letter bij
  cursieve tekst). Lukt het niet, dan staat er _Omzetten naar tekst lukte niet_ en kun je het
  opnieuw proberen of OpenSubtitles gebruiken.
- Uitzetten kan met `SUBTITLE_OCR=false` in `.env`.

**Recap overslaan.** Begint een aflevering met "Previously on…", dan staat er _Recap overslaan_
in de speler, net als _Intro overslaan_ (web, telefoon, tv, en de telefoon tijdens het casten).

- **Anime:** de tijden van AniSkip, als die ze heeft.
- **Hoofdstukken:** een hoofdstuk _Recap_, _Previously_ of _Previously on …_.
- **Anders de audio:** de server zoekt in de eerste 6 minuten naar stukjes van de vorige
  aflevering (of de laatste van het vorige seizoen), en sinds 2026-10-20 van die hele aflevering
  plus het begin en het eind van de twee daarvoor. Een reeks van zulke stukjes vlak aan het
  begin, of vlak na de intro, is de recap. De intro zelf en de aftiteling tellen niet mee, en
  ook niet wat de vorige aflevering ná de aftiteling liet zien (een vooruitblik).
- De eerste aflevering van een serie heeft geen recap.
- **Komt een aflevering later binnen** (de vorige, of de tweede van een nieuwe serie), dan
  kijkt de server opnieuw naar de afleveringen ernaast waar nog niets gevonden was.
- Onder _Beheer_ → _Overzicht_ staat hoe ver het zoeken naar intro, recap en aftiteling is.
- Bestaande afleveringen worden vanzelf doorzocht, als er niemand kijkt. De vingerafdrukken staan
  al in de cache, dus dat gaat snel en leest bijna niets van de schijf.
- Klopt het niet: in de webspeler onder _Instellingen_ → _Recap_ (_Begint hier_, _Eindigt hier_,
  _Geen recap_, _Opnieuw zoeken_), alleen voor beheerders.

Na deze update: `.\scripts\up.ps1` (een nieuw API-image met de tekstherkenning, en een migratie).
De transcoder hoeft niet opnieuw te starten. (De update van 2026-10-20 zoekt na `up.ps1` opnieuw
bij alle afleveringen zonder intro, recap of aftiteling; vingerafdrukken staan al in de cache,
alleen het middenstuk van elke aflevering wordt nog één keer gelezen.) De app heeft een nieuwe build nodig
(`.\scripts\build-apk.ps1`); de browser niet.

## 35. Casten vanuit de browser, en "Omdat je … keek"

**Casten vanuit de browser.** In Chrome en Edge staat in de speler het cast-icoon zodra er een
Chromecast in het netwerk is. Dat werkt alleen via `https://cine-vault.nl` (of op de N100 zelf
via `localhost`), niet via `http://192.168.0.110:8765`: Google laat casten vanuit een browser
alleen toe op een beveiligde pagina.

- Kies een Chromecast. De video stopt in de browser en speelt verder op de tv; de pagina wordt
  de afstandsbediening (pauze, spoelen, intro, recap en aftiteling overslaan, volgende
  aflevering).
- _Stoppen met casten_ zet het terug in de browser, op de plek waar de tv was.
- De browser weet niet welk model de Chromecast is. Heb je een Chromecast Ultra of een
  Chromecast met Google TV (4K), kies dan onder _Profiel_ → _Casten naar een Chromecast_ de
  optie _4K_. Anders krijgt de tv 1080p.
- Safari en Firefox kunnen niet casten (in Safari is er AirPlay).
- De Chromecast haalt de video op via `CAST_BASE_URL`, net als bij de Android-app.

**Omdat je … keek.** De startpagina heeft nu per profiel hooguit twee rijen met titels die lijken
op wat dat profiel de laatste tijd keek, zonder wat het al zag. Er is niets voor in te stellen;
de rijen verschijnen zodra je iets van minstens 10 minuten hebt gekeken.

Na deze update: `.\scripts\up.ps1`. De app hoeft niet opnieuw gebouwd te worden; de telefoon en
de tv tonen de nieuwe rijen vanzelf.

## 36. Beheer in de app

Wie als beheerder inlogt in de Android-app op een telefoon of tablet, heeft onder _Profiel_ →
**Beheer** hetzelfde als _Beheer_ op de website. Leden zien het niet, en op de tv zit het niet.

- **Overzicht:** een scan starten (_Scannen_ of _Alles vernieuwen_), de bibliotheken, wat er in je
  bibliotheek zit (codecs, resoluties, HDR), hoe ver het zoeken naar intro, recap en aftiteling
  is, en de themamuziek van Plex (met de laatste fout).
- **Aandacht nodig:** titels zonder overtuigende match. _Match zoeken_ zoekt bij TMDB en TVmaze;
  kies de goede titel. Een melding over een titel zonder match opent dit scherm.
- **Accounts:** zoals eerst.
- **Verzoeken:** automatisch goedkeuren, en per soort (films, series, anime) de map en de
  kwaliteit van Radarr en Sonarr. _Naar de verzoeken_ opent de lijst met verzoeken.
- **Op de pagina van een titel**, onder _Beheer_: _Match corrigeren_, _Match ongedaan maken_ (bij
  een match die je met de hand koos), _Themamuziek uitzetten_ of _aanzetten_, en verwijderen via
  Radarr of Sonarr.
- **In de speler**, onder _Instellingen_: de intro, de recap en de aftiteling van deze aflevering
  (_Begint hier_, _Eindigt hier_, _Geen …_, _Opnieuw zoeken_). Zet de video eerst op het begin of
  het eind. Dat geldt voor iedereen.

De server hoeft niet bijgewerkt te worden. De app heeft een nieuwe build nodig
(`.\scripts\build-apk.ps1 -Variant phone`).

## 37. Intro, recap en aftiteling in één keer zoeken

Normaal zoekt de server de intro, de recap en de aftiteling alleen als er niemand kijkt, een paar
afleveringen tegelijk. Dat kan dagen duren. Om alles in één keer te laten zoeken:

```
powershell -ExecutionPolicy Bypass -File .\scripts\intro-search.ps1
```

- Het script start het zoeken en laat elke 10 seconden zien hoe ver het is, met een schatting van
  de tijd die nog nodig is. De server zoekt alle afleveringen achter elkaar, ook als er iemand
  kijkt. Kijken kan daardoor haperen: de server leest veel van de mediaschijf.
- **Ctrl+C** stopt alleen de weergave; de server gaat door. Start het script opnieuw om het te
  volgen.
- **`-All`** zoekt alle afleveringen opnieuw, ook die al gedaan zijn. Wat je met de hand hebt
  ingesteld, blijft staan.
- **`-Stop`** gaat terug naar zoeken als niemand kijkt.
- **`-NoWait`** start het en stopt het script meteen.
- Hetzelfde kan in _Beheer_ → _Overzicht_ (op de website en in de app): **Nu alles zoeken** bij
  _Intro, recap en aftiteling_.
- De transcoder moet draaien (`.\scripts\transcoder.ps1`). Antwoordt hij tien keer na elkaar
  niet (ongeveer 5 minuten), dan stopt het script met _the transcoder did not answer_. Herstart hem
  met `.\scripts\transcoder.ps1 -Restart` en start het script opnieuw; het gaat verder waar het was.
- Blijven de getallen even staan, dan meldt het script elke minuut waar de server mee bezig is
  (_still on_) en wat hij leest (_reading the middle of …_). Voor de recap leest hij de hele
  aflevering ervoor. Eén stuk lezen duurt hooguit 2,5 minuut. Lukt dat niet in ruim 4 minuten,
  dan slaat de server dat stuk over en gaat hij door.
- Is alles bekeken, dan gaat de server vanzelf terug naar zoeken als niemand kijkt.

Na deze update: `.\scripts\up.ps1`. De app heeft een nieuwe build nodig voor de knop in _Beheer_.

**Sneller zoeken (2026-10-22).** Het zoeken leest elk bestand één keer helemaal; de snelheid van
de schijf bepaalt dus hoe lang het duurt. Nu:

- **Eerst de intro en de aftiteling van alles,** daarna pas de recaps. Daarvoor is van elke
  aflevering alleen het begin en het eind nodig, ongeveer een derde van het bestand. _Intro
  overslaan_ staat zo veel eerder overal; de recaps (de rest van elk bestand) komen erna.
- **Seizoenen zonder recaps** worden na 3 afleveringen zonder recap niet meer helemaal gelezen.
- **Als niemand kijkt,** leest de server zo snel als de schijf kan. Wordt er gekeken, dan houdt hij
  ruimte over voor de stream, zoals eerst.
- **Films:** de transcoder bekijkt eerst een derde van de beelden, en alleen rond de aftiteling
  alles, en doet er drie tegelijk als niemand kijkt.

Na deze update: wacht tot het lopende zoekscript klaar is of stop het (`.\scripts\intro-search.ps1
-Stop`), dan `.\scripts\up.ps1` en `.\scripts\transcoder.ps1 -Restart`, en start het script
opnieuw. Wat al gevonden is, blijft; het gaat verder waar het was.

## 38. Aftiteling van films overslaan

Films hebben geen andere afleveringen om het geluid mee te vergelijken. Daarom kijkt de server
naar het beeld: aftiteling is een donker beeld met een beetje lichte tekst in regels, minuut na
minuut.

- **Hoe:** de transcoder bekijkt in het laatste deel van de film (20%, tussen 5 en 20 minuten)
  elke 4 seconden het dichtstbijzijnde keyframe. Begint de aftiteling al aan het begin van dat
  stuk, dan kijkt hij verder terug, tot de helft van de film. Een film leest zo een paar honderd
  losse beelden, niet de hele film.
- **Scènes na de aftiteling worden nooit overgeslagen.** Alles wat een paar seconden geen
  aftiteling of zwart is, telt als een scène. De aftiteling stopt daar, en _Aftiteling
  overslaan_ springt naar het begin van die scène. Komt er na zo'n scène nog aftiteling (zoals
  bij films van Marvel), dan is dat een tweede deel met weer een eigen knop.
- **Loopt de aftiteling tot het eind,** dan is er geen knop: er is niets om naartoe te springen.
- **Gezien:** een film telt als gezien vanaf het begin van de aftiteling.
- **Wat het niet herkent:** aftiteling over bewegend beeld of op een gekleurde achtergrond
  (vaak het begin van de aftiteling, of bij animatiefilms). Dan begint de knop later, bij de
  rollende namen op zwart, of is er geen.
- **Wanneer:** zoals de intro: als er niemand kijkt, de nieuwste films eerst, en een film die je
  opent gaat voor (dan rustiger, zodat het kijken niet hapert). `.\scripts\intro-search.ps1`
  doet de films ook. Hoe ver het is, staat in _Beheer_ → _Overzicht_ (_Aftiteling van films_).
- **Klopt het niet?** Zet het in de speler als beheerder: _Instellingen_ → _Aftiteling_ (zoals
  bij afleveringen). Met de hand instellen maakt er één deel van; _Opnieuw zoeken_ zoekt alle
  delen opnieuw.

Na deze update: `.\scripts\transcoder.ps1 -Restart` (de transcoder kent een nieuwe opdracht) en
`.\scripts\up.ps1`. De app heeft een nieuwe build nodig voor de knop op de telefoon en de tv;
de website heeft hem meteen.

## 39. Gezondheid van de server

_Beheer_ → _Overzicht_ begint met **Gezondheid**: in één blik of alles werkt. Op de website en in
de app op de telefoon of tablet (_Profiel_ → _Beheer_), alleen voor beheerders.

- **Wat de server controleert,** elke 15 minuten:
  - **De schijven:** de mediaschijf (`D:/`), de cache (het Docker-volume) en de map van de
    transcoder voor de HLS-segmenten. _Let op_ bij minder dan 5% of 200 GB vrij op de
    mediaschijf (10% of 20 GB voor de andere twee), _Probleem_ bij minder dan 2% of 50 GB (3% of
    5 GB).
  - **De transcoder:** antwoordt hij, en werkt de GPU (QSV)? Op de CPU is _Let op_.
  - **De back-up van de database:** _Let op_ als de laatste ouder is dan 48 uur, _Probleem_ na 7
    dagen.
  - **Scannen:** of de scan van elk uur loopt, en of de laatste fouten had.
  - **Het certificaat** van `cine-vault.nl`: _Let op_ als het binnen 14 dagen verloopt
    (Caddy vernieuwt het 30 dagen vooraf; lukt dat niet, dan zijn poort 80 en 443 meestal niet
    bereikbaar), _Probleem_ binnen 3 dagen.
  - **Radarr en Sonarr:** bereikbaar met de API-key, en wat ze zelf als probleem melden (_Health_
    in Radarr en Sonarr, bijvoorbeeld een indexer die niet werkt).
  - **Titels zonder match** (_Aandacht nodig_). Daarvoor komt geen melding.
- Bij elk punt staat wat er aan de hand is, sinds wanneer, en wat je eraan kunt doen.
  _Opnieuw kijken_ controleert het meteen.
- **Meldingen:** beheerders krijgen een melding als iets misgaat, één keer per probleem, en
  opnieuw als het erger wordt (van _Let op_ naar _Probleem_). Is het opgelost en gaat het later
  weer mis, dan is dat een nieuwe melding. Ze vallen onder _Meldingen voor beheerders_ (op Android
  het kanaal _Beheer_).
- **De back-up** draait op Windows; de API ziet de back-upmap niet. Daarom meldt
  `scripts\backup.ps1` na elke geslaagde back-up het bestand en de grootte aan de API (met
  `API_TOKEN`). Lukt dat niet (de API draait niet), dan staat er een waarschuwing in `backup.log`;
  de back-up zelf is dan gewoon gelukt.

Na deze update: `.\scripts\up.ps1` en `.\scripts\transcoder.ps1 -Restart` (de transcoder meldt nu
hoeveel ruimte er vrij is). Draai daarna één keer `.\scripts\backup.ps1`, anders staat er _Nog geen
back-up gemeld_ tot de back-up van vannacht. De app heeft een nieuwe build nodig voor het blok in
_Beheer_.

## 40. Collecties

Films die bij elkaar horen (_Harry Potter Collection_, _The Lord of the Rings Collection_)
staan samen in een collectie, zoals TMDB ze indeelt.

- **Waar:**
  - **Startpagina:** de rij _Collecties_ (na _Hoog gewaardeerd_) en _Volgende in de reeks_ (na
    Mijn lijst): de film die je na de laatst gekeken film van een reeks kunt kijken.
  - **De pagina van een collectie:** alle films op volgorde van verschijnen, met _Begin met …_ of
    _Verder met …_. Films die er niet zijn, staan er ook, half doorzichtig: _Aangevraagd_,
    _Aangekondigd_, _Verschijnt 2027_ of _Niet in de bibliotheek_. Een tik op die laatste opent
    de film in Ontdekken, waar je hem aanvraagt.
  - **De pagina van een film:** een rij met de andere films van de reeks.
  - **Alle collecties:** op de website in het profielmenu, in de app onder _Profiel_ →
    _Collecties_, en via _Alles_ bij de rij.
  - **Tv:** de rij op de startpagina, de pagina van een collectie en de rij op de pagina van een
    film.
- **Wanneer een collectie verschijnt:** zodra er minstens twee films van in de bibliotheek
  staan.
- **Kinderprofielen** zien alleen de films voor hun leeftijd die er zijn, en kunnen niets
  aanvragen.
- **Bijwerken:** na elke scan haalt de server collecties op die hij nog niet kent of die een
  week oud zijn (hooguit 40 per keer). De eerste scan na de update haalt alle films één keer
  opnieuw op bij TMDB, omdat de collectie van een film eerst niet bewaard werd. Dat duurt een
  paar minuten.

Na deze update: `.\scripts\up.ps1`. De app heeft een nieuwe build nodig.

## 41. Intro, recap en aftiteling beter vinden (2026-10-28)

De server vond bij veel series geen intro, recap of aftiteling, ook als ze er duidelijk waren
(bijvoorbeeld de laatste afleveringen van VisionQuest). Vier oorzaken, alle vier opgelost:

- **Een fout sinds 21 oktober (de hoofdoorzaak).** Bij elk leesverzoek aan de transcoder rekent
  de server uit hoe lang het mag duren. Sinds 21 oktober kwam daar bij bestanden met een hoge
  bitrate (4K) een gebroken getal uit, en sinds 22 oktober bij bijna alle bestanden. Node weigert
  zo'n getal, dus het verzoek ging nooit de deur uit. De server zag dat als "bestand onleesbaar" en
  zette de aflevering op _doorzocht, niets gevonden_. In het log van de API staat dan _intro search:
  file not readable_ met _RangeError … delay_. Nu is het een heel getal, en een fout die niet aan
  het bestand ligt, zet een aflevering nooit meer op _niets gevonden_.
- **Het geluid werd te grof gemeten.** De server maakte elke 0,124 seconde een "vingerafdruk"
  van het geluid. Valt het themalied in twee afleveringen net tussen twee metingen (tot 62 ms
  verschoven), dan leek het geluid niet genoeg op elkaar. Bij ongeveer de helft van de paren
  afleveringen gebeurde dat. Nu meet de server elke 0,031 seconde. In een proef met echte muziek
  in zes verschillende codecs vond hij het themalied in 30 van de 30 paren (eerst 14), en een
  korte, zachte intro van 16 seconden in 26 van de 30 (eerst 6).
- **Lange aftiteling werd afgewezen.** Een aftiteling langer dan 6 minuten telde niet, en de
  server keek alleen naar de laatste 7 minuten. Series als die van Marvel hebben een aftiteling
  van 7 tot 9 minuten. Nu tot 10 minuten.
- **Aftiteling met een ander nummer per aflevering.** Dan delen de afleveringen geen geluid. Vindt
  het geluid niets, dan kijkt de server nu naar het beeld, zoals bij films: lichte tekst op een
  donkere achtergrond.

**Bijwerken:** de transcoder moet opnieuw starten, anders wacht het zoeken op hem (_Beheer_ →
_Overzicht_ zegt dan dat hij op de transcoder wacht).

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\transcoder.ps1 -Restart
powershell -ExecutionPolicy Bypass -File .\scripts\intro-search.ps1
```

- Alle afleveringen waar niets gevonden was, worden opnieuw bekeken. Wat al gevonden was, blijft
  staan. Wil je ook die opnieuw laten zoeken: `.\scripts\intro-search.ps1 -All`.
- De oude vingerafdrukken passen niet bij de nieuwe; de server leest de afleveringen daarom
  opnieuw van de schijf. Voor de hele bibliotheek duurt dat weer een tijd (net als de eerste
  keer). Met het script gaat het het snelst; zonder script doet de server het als niemand kijkt.
- De transcoder rekent nu tijdens het lezen, in kleine stukjes, zodat lopende streams er geen last
  van hebben.
- De app hoeft niet opnieuw gebouwd te worden.

## 42. "Movies is empty or unavailable": de API ziet de schijf niet meer

Onder _Bibliotheek scannen_ staat dan per bibliotheek _… is empty or unavailable; kept … known
files_, en nieuwe films en afleveringen verschijnen niet. Toch werkt de rest gewoon.

**Wat er aan de hand is.** De API draait in Docker Desktop en ziet de schijf `D:` via een koppeling
die Docker Desktop zelf maakt. Raakt die koppeling kwijt (de schijf was even weg, Windows sliep of
werd bijgewerkt, Docker Desktop herstartte half), dan ziet de API lege mappen. Windows zelf, Sonarr,
Radarr en de transcoder zien de schijf wel. Daarom speelt alles nog af: dat loopt grotendeels via de
transcoder, en de database weet nog welke titels er zijn. De scanner schrijft niets weg zolang de
mappen leeg lijken; zo raak je geen kijkvoortgang of handmatige matches kwijt. Maar nieuwe bestanden
ziet hij ook niet.

**Oplossen** (een herstart van alleen de API helpt niet; dan meldt Docker _mkdir
/run/desktop/mnt/host/d: file exists_):

1. Sluit Docker Desktop: rechtsklik op het walvisje bij de klok, **Quit Docker Desktop**.
2. In PowerShell: `wsl --shutdown`
3. Start Docker Desktop weer en wacht tot het _Engine running_ zegt.
4. In de map van CineVault: `powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1`
5. Controleer: `docker compose exec api ls /media/Movies` toont je films.
6. Kies in _Beheer_ **Scannen**. De meldingen verdwijnen en de nieuwe titels komen erbij.

**Sinds 2026-10-30** staat dit ook onder _Beheer_ → _Gezondheid_ als **Mediamappen: probleem**, met
deze stappen, en krijgen beheerders er een melding van. Zo zie je het meteen, niet pas als er iets
ontbreekt.

**Vanzelf laten herstellen (sinds 2026-11-02).** `scripts\media-watchdog.ps1` doet de stappen
hierboven zelf. Eén keer installeren:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\media-watchdog.ps1 -Install
```

- **Elke 10 minuten** kijkt een geplande taak (_CineVault Media Watchdog_, in jouw Windows-sessie,
  net als Docker Desktop) of de API de mappen in `MEDIA_ROOT` ziet die Windows wel ziet (Movies,
  Series, Anime).
- **Pas na twee keer achter elkaar** (dus niet bij een hapering) herstart het Docker Desktop:
  afsluiten, `wsl --shutdown`, starten, `docker compose up -d`, en daarna een scan.
- **Niet terwijl er gekeken wordt** via de transcoder: dan wacht het, hooguit een uur
  (`-MaxWaitMinutes`). Daarna herstart het toch, want anders komt er niets nieuws bij. Kijken stopt
  dan een minuut of twee.
- **Niet als Windows de schijf zelf niet ziet:** dan is de schijf echt weg en helpt een herstart
  niet.
- **Hooguit één keer per uur.** Helpt een herstart niet, dan laat het 6 uur met rust en staat dat in
  het log. Herstart dan de N100.
- **Draait Docker Desktop helemaal niet** (twee keer achter elkaar), dan start het hem.
- `wsl --shutdown` stopt ook andere WSL-distributies, als je die gebruikt.
- Elke 10 minuten flitst er heel kort een PowerShell-venster als je achter de N100 zit.

Handig:

- `.\scripts\media-watchdog.ps1 -Status`: de taak en de laatste regels van
  `logs\media-watchdog.log`;
- `.\scripts\media-watchdog.ps1 -CheckOnly`: alleen kijken, niets doen;
- `.\scripts\media-watchdog.ps1 -Force`: nu meteen herstarten;
- `.\scripts\media-watchdog.ps1 -Uninstall`: de taak weer weg. Doe dat ook (of zet de taak
  even uit in Taakplanner) als je Docker Desktop zelf een tijd uit wilt laten: anders start het
  script hem binnen 20 minuten weer.

`scripts\verify-setup.ps1` meldt of de taak er is.

## 43. Intro, recap en aftiteling: het vergelijken verbeterd (2026-11-12)

Bij veel afleveringen met een duidelijke intro of aftiteling vond de server die nog steeds niet.
Het lag aan de manier waarop twee afleveringen vergeleken werden:

- **Praten over het themalied.** Hoorde je in een aflevering stemmen, geluidseffecten of een stilte
  door het themalied heen, dan brak het gedeelde stuk in stukjes van een paar seconden, en elk
  stukje was te kort voor een intro. Nu horen stukjes die op dezelfde plek in beide afleveringen
  liggen en hooguit 6 seconden uit elkaar zitten bij elkaar.
- **Een te lang gedeeld stuk verborg de intro.** Delen twee afleveringen een lange scène (de
  volgende aflevering speelt het einde van de vorige opnieuw af), dan koos de server die, zag dat
  hij te lang was voor een intro, en gaf het voor dat paar op. Nu kijkt hij naar elk gedeeld stuk
  dat de goede lengte heeft.
- **De afleveringen stemmen.** De server vergelijkt een aflevering met de afleveringen ernaast, en
  kiest het stuk dat de meeste ervan delen. Eerst deed elke buur maar één stuk mee (het langste);
  nu elk stuk, zodat de intro wint als hij overal terugkomt.
- **Hoofdstukken** met namen als _OP2_, _Opening Song_, _ED 1_ of _Ending Theme_ tellen nu ook.

**De recap ("Previously on…")** wordt ook beter gevonden:

- Een recap mag nu clips laten zien van tot 12 afleveringen terug (eerst 3), ook uit het vorige
  seizoen bij de eerste aflevering van een seizoen. Voor de oudere afleveringen gebruikt de server
  alleen wat al in de cache staat, dus hij leest daarvoor niets extra van de schijf.
- Clips vanaf anderhalve seconde tellen mee (eerst 2): een recap knipt snel.
- Praat er een verteller tussen de clips, of staat er een titelkaart of muziek tussen, dan dekken
  de clips minder van de recap. Komen ze van minstens 3 verschillende plekken, dan is een kwart nu
  genoeg.

**Bijwerken:**

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\intro-search.ps1
```

- Afleveringen waar het geluid niets vond (intro, aftiteling of recap), worden opnieuw bekeken. Dat
  komt bijna helemaal uit de cache (de vingerafdrukken zijn er al), dus het gaat snel.
- De transcoder en de app blijven zoals ze zijn.
- Vindt de server bij een aflevering nog steeds niets, dan staat in het log van de API
  (`docker compose logs api`) _intro search: no shared audio_ (de afleveringen ernaast delen geen
  geluid) of _no other episode to compare with_ (er is geen andere aflevering om mee te
  vergelijken), met het pad. Stuur me die regels, met de naam van de serie.

## 44. Overslaan: hoe zeker, de preview, automatisch overslaan en per seizoen (2026-11-13)

**Hoe zeker de server is.** Bij elke intro, recap, aftiteling en preview bewaart de server nu hoe
zeker hij is (0-100%):

- Uit het geluid: het deel van de afleveringen ernaast waarin hij hetzelfde vond.
- Uit een hoofdstuk: 95%. Van AniSkip: 90%.
- De aftiteling uit het beeld: van een film 70%, van een aflevering 50%.
- Onder de 50% tonen de spelers geen knop (en wordt er niets vanzelf overgeslagen); in _Beheer_
  zie je het wel. Wat je met de hand instelt, geldt altijd.

**De preview van de volgende aflevering** ("Volgende keer bij…"): de server zoekt in het eind van
een aflevering naar stukjes van de volgende. Dat gebeurt alleen uit de cache: hij leest daarvoor
niets extra van de schijf. Een hoofdstuk _Preview_ of _Next Episode_ telt ook. De aftiteling stopt
waar de preview begint. In de spelers staat dan _Preview overslaan_.

**De knop verdwijnt na 8 seconden.** Begint een intro, recap, preview of aftiteling, dan staat de
knop 8 seconden in beeld. Daarna komt hij terug met de bediening (tikken, de muis, een toets). Op
de tv slaat OK over zolang de knop in beeld is; daarna toont OK de bediening, met de knop erin.

**Automatisch overslaan, per profiel.** Onder _Profiel_ → _Automatisch overslaan_ (web, telefoon,
tv) of in de speler onder _Instellingen_: de intro, de recap, de aftiteling (de volgende aflevering
begint dan meteen) en de preview, elk apart. Dat geldt voor het profiel op elk apparaat. Spoel je
terug in een deel dat al is overgeslagen, dan zie je de knop. "Intro automatisch overslaan" stond
eerst per apparaat aan; dat gaat de eerste keer vanzelf over naar het profiel.

**Per seizoen in _Beheer_.** Op de pagina van een serie: ⋯ (web) of het blok _Beheer_ (app) →
_Intro, recap en aftiteling per aflevering_. Per aflevering een tijdlijn met de delen, waar ze
vandaan komen en hoe zeker ze zijn (onzekere delen vaag). Verder:

- _Aanpassen in de speler_ (▶ in de app): begin en eind zet je daar onder _Instellingen_ → _Begint
  hier_ / _Eindigt hier_.
- _Intro naar alle afleveringen_: dezelfde intro, met de hand, op elke aflevering van het seizoen
  (voor series waar de intro altijd op dezelfde plek zit). _Aftiteling naar alle afleveringen_
  doet hetzelfde, gerekend vanaf het einde van elke aflevering.
- _Seizoen opnieuw zoeken_: alles van dat seizoen opnieuw, behalve wat met de hand is ingesteld.

**Bijwerken:**

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\intro-search.ps1
```

- Wat het geluid of het beeld eerder vond, wordt opnieuw bekeken, zodat het een zekerheid krijgt.
  Dat komt uit de cache. Daarna kan een intro die maar in één van de afleveringen ernaast terugkwam
  uit de spelers verdwijnen: zo hoort het, je ziet hem in _Beheer_.
- De app heeft een nieuwe build nodig (`scripts\build-apk.ps1`) voor de knop van 8 seconden,
  _Automatisch overslaan_ en het scherm per seizoen. Oude apps blijven werken; ze krijgen ook geen
  onzekere delen meer.

## 45. Casten naar een tv lukt niet

**Wat er gebeurt bij casten.** De telefoon (of Chrome) start een stream op de server en geeft de
tv een link: `CAST_BASE_URL/api/cast/…/index.m3u8`. De tv haalt de video daar zelf op, met de
ontvanger van Google (de _Default Media Receiver_). Gaat dat mis, dan bleef de telefoon eerst op
_Laden…_ staan zonder te zeggen waarom.

**Nu zegt de telefoon (en de browser) waarom.** Na het laden vraagt hij de server wat de tv
ophaalde:

- _De tv haalde niets op bij http://…_: de tv bereikt het adres niet, of weigert het. De
  ontvanger van Google draait op https, en een stream via http is dan "gemengde inhoud", die hij
  vaak niet laadt. Zet `CAST_BASE_URL` op een https-adres (hieronder).
- _De server gaf de tv een fout (…)_: de tv bereikt de server wel; het getal zegt wat er misging.
- _De tv haalde de video op, maar kon hem niet afspelen_: de tv kan dat beeld niet aan. Bij 4K
  probeert de telefoon het dan vanzelf één keer in 1080p (H.264).

In `docker compose logs api` staat bij de eerste vraag van de tv een regel `cast: the TV fetched`,
met wat voor apparaat het is (`CrKey/…` is een Chromecast). Staat die regel er niet, dan bereikte
de tv de server niet.

**Instellen.** _Beheer_ → _Gezondheid_ → _Chromecast_ zegt of `CAST_BASE_URL` gezet is, of de
server het adres zelf bereikt, en of het https is.

1. Kijk of de router NAT loopback doet: `scripts\public-access.ps1` (de regel over
   `https://cine-vault.nl` vanaf de N100 zelf). Of open `https://cine-vault.nl` op de telefoon
   terwijl die thuis op de wifi zit.
2. Werkt dat, zet dan in `.env`:

   ```
   CAST_BASE_URL=https://cine-vault.nl
   ```

   en start `scripts\up.ps1`. Kijk daarna in _Beheer_ → _Gezondheid_: _Chromecast_ moet groen
   zijn.

3. Werkt het niet (geen NAT loopback), laat het me weten: dan zijn er andere wegen (een eigen
   ontvanger die via http mag laden, of een https-adres voor thuis). Geef daarbij de melding die de
   telefoon toont, en of `docker compose logs api` een regel `cast: the TV fetched` heeft.

**Ondertitels op de tv.** Kies ze tijdens het casten met _Ondertitels: …_ (app) of _Ondertitels op
de tv_ (browser). Een ondertitel die in het videobestand zit, leest de server eerst helemaal uit;
de telefoon toont dan _Ondertitels worden klaargezet voor de tv: 42%…_. Daarna laadt de tv de video
op dezelfde plek opnieuw, met de ondertitel. Dat duurt bij een aflevering meestal enkele seconden,
bij een grote 4K-film langer (de server leest het hele bestand). De volgende keer is hij er meteen.

**Bijwerken:** `git pull`, `scripts\up.ps1`. De nieuwe meldingen in de app vragen een nieuwe
build (`scripts\build-apk.ps1`); in de browser zijn ze er meteen.

## 46. _cancelled after … s_ in het log van de transcoder

Voor _Intro overslaan_ en de aftiteling leest de transcoder het begin en het eind van elke
aflevering (tot 10 minuten audio). Bij een 4K-remux is dat 3 à 4 GB per stuk. De API gaf het eerst
op na een geschatte tijd (ongeveer 3 minuten); was de schijf trager, dan stond er
`fingerprint …: cancelled after 175.7 s`, en kreeg die aflevering geen intro en geen aftiteling.

Nu meldt de transcoder elke paar seconden hoe ver hij is, en wacht de API zolang hij doorleest. Pas
als er 2 minuten niets bij komt (of na een half uur), geeft de API het op. In _Beheer_ →
_Overzicht_ staat tijdens het lezen _… % gelezen_.

**Bijwerken:** `git pull`, `scripts\transcoder.ps1 -Restart` en `scripts\up.ps1`. De API zet
daarna de afleveringen zonder intro of aftiteling weer open; wat al gelezen was, staat in de cache.
Wil je niet wachten tot dat vanzelf gebeurt: `scripts\intro-search.ps1`. De app hoeft niet opnieuw
gebouwd te worden.

**Kijk in het log:** een geslaagde regel eindigt nu met de snelheid, bijvoorbeeld
`600 s, 0 chapters, 95.2 s (6x real time)`. Wordt er toch iets afgebroken, dan staat erbij hoeveel
er gelezen was (`cancelled after 140.0 s, 210 of 600 s read`).

## 47. Ubuntu Server op de N100 (Linux)

Besluit van 2026-11-17: de N100 draait voortaan Ubuntu Server 26.04 LTS met Docker Engine. Dat
lost het grootste nadeel van Windows op: Docker Desktop kon de Intel-GPU niet aan een container
geven, dus de transcoder draaide los op Windows. Op Linux is alles een container.

**Wat er verandert:**

| Windows                                                    | Linux                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| Docker Desktop (WSL2)                                      | Docker Engine                                                       |
| transcoder native: `scripts\transcoder.ps1`, geplande taak | de container `transcoder`, met de GPU via `/dev/dri`                |
| `MEDIA_ROOT=D:/`                                           | `MEDIA_ROOT=/mnt/media`                                             |
| `TRANSCODE_TMP=C:/CineVault-data/transcode`                | `TRANSCODE_TMP=/srv/cinevault-data/transcode`                       |
| `TRANSCODER_URL=http://host.docker.internal:8766`          | `http://transcoder:8766` (standaard; de poort is niet gepubliceerd) |
| `scripts\*.ps1`                                            | `scripts/*.sh`                                                      |
| geplande taken                                             | systemd-timers                                                      |
| firewallregels voor 80/443                                 | niet nodig                                                          |
| `media-watchdog.ps1`                                       | vervalt                                                             |

**Wat hetzelfde blijft:** de projectnaam `cinevault`, de volumes `pgdata`, `cache` en
`caddy-data`, de diensten `db`, `api` en `web`, de API op `127.0.0.1:3000` (`/api/health`) en de
webpoorten 80, 443 en 8765. `RADARR_URL` en `SONARR_URL` blijven `host.docker.internal`: de
Arr-stack draait in Docker met gepubliceerde poorten.

### 47.1 Inrichten met n100-server

De overstap zelf (exporteren op Windows, Ubuntu installeren, alles terugzetten) staat in de
repository `nsamoedj/n100-server`. Kort:

1. `sudo ./linux/bootstrap.sh`: Docker, de mediaschijf in `/etc/fstab` op `/mnt/media`, Docker
   laten wachten op die schijf, de Intel-driver (`intel-media-va-driver-non-free`, `vainfo`) en
   de mappen in `/srv`.
2. `./linux/herstel.sh`: eerst Voqa Social (stap 20, dat maakt het Docker-netwerk
   `voqa-intern`), dan CineVault (stap 30: code, `.env`, de volumes met de certificaten).
3. Daarna één keer, in `/srv/cinevault`:

   ```bash
   scripts/up.sh
   ```

   Dat bouwt de drie images en vult `.env` aan: `RENDER_GID` (de groep van de GPU) en een
   `TRANSCODER_URL` van Windows wordt `http://transcoder:8766`. Het herstelscript start met
   `docker compose up -d --build`; met de `.env` van Windows bereikt de API de transcoder dan
   nog niet, tot `up.sh` dit heeft gedaan.

4. `scripts/verify-setup.sh` (zie 47.5).

### 47.2 Zonder n100-server

```bash
sudo apt install -y git curl jq openssl intel-media-va-driver-non-free vainfo
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"          # daarna uit- en weer inloggen
sudo mkdir -p /srv/cinevault /srv/cinevault-data/transcode
sudo chown -R "$USER": /srv/cinevault /srv/cinevault-data
git clone https://github.com/nsamoedj/cinevault.git /srv/cinevault && cd /srv/cinevault
cp .env.example .env && nano .env        # POSTGRES_PASSWORD, MEDIA_ROOT, sleutels
docker network inspect voqa-intern >/dev/null 2>&1 || docker network create voqa-intern
scripts/up.sh
```

- **De mediaschijf** moet gekoppeld zijn voordat Docker start; anders zien de containers een
  lege map. Zet hem in `/etc/fstab` (met `nofail`) en laat Docker erop wachten:
  `sudo systemctl edit docker` met `[Unit]`, `Wants=mnt-media.mount` en `After=mnt-media.mount`.
- **`voqa-intern`:** Caddy sluit zich aan op het netwerk van Voqa Social. Draait Voqa Social
  niet, maak het netwerk dan zelf (zoals hierboven); Voqa Social maakt het anders.

### 47.3 De GPU in de container

- **Doorgeven:** `docker-compose.yml` geeft `/dev/dri` aan de transcoder (`devices`) en de groep
  van de render-node (`group_add: RENDER_GID`). `up.sh` zet `RENDER_GID` op het nummer van de
  groep `render` (`getent group render`). Is dat nummer fout, dan voegt de container de groep van
  `/dev/dri/renderD128` zelf toe, met een waarschuwing in het log.
- **De container** (`apps/transcoder/Dockerfile`): Ubuntu 26.04 met FFmpeg 8 (QSV via libvpl),
  `intel-media-va-driver-non-free`, `libmfx-gen1.2` en `vainfo`, en Node 24. De transcoder
  draait als gebruiker `cinevault` (uid 1000) en maakt `TRANSCODE_TMP` zelf van die gebruiker.
- **Zelftest:** bij elke start test de transcoder QSV (beeld op de GPU schalen en coderen met een
  bitrate, zoals een echte transcode) en HDR-tonemapping. Werkt QSV alleen in de low-power-modus,
  dan gebruikt hij die (`-low_power 1`); werkt QSV helemaal niet, dan codeert hij op de CPU. De
  uitkomst staat in `docker compose logs transcoder`, in _Beheer_ → _Gezondheid_ en in
  `verify-setup.sh`.
- **Op de CPU terwijl er een GPU is?**
  1. `ls -l /dev/dri`: is er een `renderD128`?
  2. `vainfo --display drm --device /dev/dri/renderD128` op de server: noemt het de driver
     `iHD` en `VAProfileH264… VAEntrypointEncSlice`?
  3. `docker compose exec transcoder vainfo --display drm --device /dev/dri/renderD128`: hetzelfde
     in de container.
  4. `docker compose logs transcoder | head`: de reden van de zelftest. Noemt die een fout met
     `-low_power 1`, kijk dan of de HuC-firmware geladen is: `sudo dmesg | grep -i huc`.
  5. Na een wijziging: `docker compose restart transcoder`.
- **Bestanden in gebruik:** op Linux kunnen Sonarr en Radarr een bestand verwijderen of vervangen
  terwijl het gelezen wordt. De omweg via HTTP van Windows is daarom uit
  (`TRANSCODER_MEDIA_OVER_HTTP=0`).

### 47.4 De scripts

Dezelfde opties als de `.ps1`-versies, als `--optie`:

| Windows                                       | Linux                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `up.ps1 [-NoBuild]`                           | `scripts/up.sh [--no-build]`                                          |
| `backup.ps1 [-Install] [-Status] [-Tag naam]` | `scripts/backup.sh [--install] [--status] [--tag naam]`               |
| `restore.ps1 [-File pad] [-List]`             | `scripts/restore.sh [--file pad] [--list]`                            |
| `verify-setup.ps1`                            | `scripts/verify-setup.sh`                                             |
| `arr-webhook.ps1`                             | `scripts/arr-webhook.sh`                                              |
| `scan.ps1 [-Library naam] [-Refresh]`         | `scripts/scan.sh [--library naam] [--refresh]`                        |
| `build-apk.ps1 [-Variant] [-Aab] [-DebugKey]` | `scripts/build-apk.sh [--variant] [--aab] [--debug-key]`              |
| `public-access.ps1` (controle)                | `scripts/public-access.sh`                                            |
| `transcoder.ps1`                              | `docker compose restart transcoder`, `docker compose logs transcoder` |

Ze hebben `jq` en `curl` nodig (`sudo apt install jq curl`). `--help` toont de uitleg.

**Vervalt op Linux:** `media-watchdog.ps1` (die herstelde Docker Desktop als het de schijf
kwijt was; een gewone koppeling doet dat niet) en het firewall-deel van `public-access.ps1`.
Nog zonder Linux-versie: `intro-search.ps1`, `get-apk.ps1`, `android-key.ps1`, `check-qsv.ps1`
(de zelftest en `verify-setup.sh` vervangen die laatste).

### 47.5 Controleren

```bash
scripts/verify-setup.sh
```

Naast wat het Windows-script controleerde: de Intel-GPU, `/dev/dri` en de groep ervan,
`RENDER_GID`, `vainfo` op de server en in de container, of de mediaschijf gekoppeld is en Docker
erop wacht, de vier containers, `/media` read-only in `api` en `transcoder`, `voqa-intern`, de
zelftest van de transcoder, dat zijn poort niet gepubliceerd is, en de back-ups. Het rapport
(`setup-report.txt`) bevat geen wachtwoorden of sleutels.

### 47.6 Back-ups

- **`scripts/backup.sh --install`** zet een systemd-timer `cinevault-backup` op 03:30 (vraagt om
  `sudo`). Een gemiste back-up (server uit) volgt bij de volgende start. Status:
  `scripts/backup.sh --status`, of `journalctl -u cinevault-backup`.
- **Met n100-server** maakt de timer `n100-backup` om 03:30 al een dump van deze database, in
  `BACKUP_DIR` (`/mnt/media/backups/cinevault`), met dezelfde bestandsnaam. Eén van beide is
  genoeg. Let op: alleen `scripts/backup.sh` meldt de back-up aan _Beheer_ → _Gezondheid_;
  zonder die melding zegt _Gezondheid_ na twee dagen dat de back-up oud is.
- **Terugzetten:** `scripts/restore.sh` (de nieuwste) of `scripts/restore.sh --file <pad>`.

### 47.7 Toegang van buitenaf

De router blijft zoals hij is (TCP 80 en 443 naar de N100). Een firewallregel is niet nodig:
Docker opent de poorten die het publiceert zelf, ook als `ufw` aan staat. De API (3000) is alleen
op `127.0.0.1` gepubliceerd en dus niet van buiten bereikbaar. Controleren:
`scripts/public-access.sh` (DNS, publiek IP, de poorten, het certificaat, NAT loopback). Het
certificaat komt mee in het volume `caddy-data`.

### 47.8 Sonarr en Radarr

`scripts/arr-webhook.sh` toont het adres voor de webhook. Draaien Sonarr en Radarr in Docker
(n100-server, `stacks/arr`), gebruik dan `http://host.docker.internal:8765/api/hooks/arr?token=…`;
hun containers hebben daarvoor `extra_hosts: host.docker.internal:host-gateway`.

### 47.9 Android-apps bouwen

`scripts/build-apk.sh` zoekt de sleutel in `~/CineVault-android` (of `ANDROID_KEY_DIR` in `.env`,
of `--key-dir`). Kopieer daarvoor `Documents\CineVault-android` van Windows naar de server. De
APK's komen zoals eerst in `downloads/` (`/android` en `/tv`).

### 47.10 Bijwerken

```bash
cd /srv/cinevault && git pull && scripts/up.sh
```

Dat bouwt en herstart `api`, `web` en `transcoder` in één keer; een aparte herstart van de
transcoder is niet meer nodig.

### 47.11 Getest en nog niet getest

**Getest in de cloudsandbox (zonder GPU):** de images (de transcoder met FFmpeg 8.0.1 van Ubuntu
26.04), de hele stack met Compose, de transcoder op de CPU (zelftest met terugval, een transcode
via HTTP), de API die de transcoder via `http://transcoder:8766` bereikt, Caddy op `voqa-intern`,
alle scripts tegen die stack (`build-apk.sh` met een nagebootste Docker), shellcheck, en alle
bestaande tests, ook die van de transcoder met FFmpeg 8 in het image.

**Pas op de N100 te testen:** QSV en tonemapping in de container (`/dev/dri`, de render-groep,
de iHD-driver, HuC), hoeveel transcodes tegelijk gaan, de mediaschijf (NTFS via `ntfs3`), de
systemd-timer, het certificaat en Let's Encrypt, Sonarr en Radarr in Docker, een Android-build.
