# De Android-app

De Android-app (`apps/mobile`, Expo) gebruikt dezelfde API als de webinterface. Hij werkt met dezelfde accounts, voortgang en ondertitels. De app praat met Caddy op de N100, net als de browser: via `https://cine-vault.nl`, of thuis op poort 8765.

## 1. De app bouwen en downloaden

De N100 bouwt de app zelf, in Docker. GitHub doet dat niet meer vanzelf, omdat elke build zo'n 100 van de gratis bouwminuten per maand kostte (oktober 2026: op).

1. Haal de nieuwste code op en bouw, in de CineVault-map op de N100 (Ubuntu):

   ```bash
   git pull
   scripts/build-apk.sh
   ```

2. De APK's komen in de map `downloads`, en Caddy biedt ze meteen aan:

   ```
   https://cine-vault.nl/android   CineVault.apk (telefoons)
   https://cine-vault.nl/tv        CineVault-TV.apk (tv's, zie deel 6)
   ```

- **De eerste keer** haalt het script de Android SDK, de NDK en de bibliotheken van Gradle op (5–8 GB, in Docker-volumes) en duurt het 30–45 minuten.
- **Daarna sneller (2026-10-22):**
  - **Eén build voor telefoon en tv:** de telefoon-APK en de tv-APK komen uit dezelfde build (de tv-APK bevat ook de 32-bit-code). Eerst bouwde het script alles twee keer.
  - **Alleen wat veranderd is:** is er alleen iets aan de app zelf veranderd (de schermen, niet de instellingen of de onderdelen), dan houdt het script de Android-map van de vorige build, en compileert Gradle de native code niet opnieuw. Verwacht dan ongeveer 5–10 minuten. Na een update van de onderdelen (`app.json`, `package.json`, `pnpm-lock.yaml`, de plugins of de eigen module) begint de Android-map opnieuw, zoals eerst.
  - **Geen lint** meer bij het bouwen (dat kostte minuten en waarschuwde alleen), en de caches van Gradle en Metro blijven tussen builds bewaard.
- **Alleen de telefoon:** `scripts/build-apk.sh --variant phone`. Alleen de tv: `--variant tv`. Allebei tegelijk is nu bijna net zo snel als één.
- **De N100 is druk** tijdens het bouwen (3 van de 4 kernen, `--cpus`): bouw liever als er niemand kijkt.
- **Het buildnummer** is het aantal commits (bijvoorbeeld 120), zodat een nieuwe APK altijd over de oude heen installeert. Het staat in `downloads/build.txt`.
- **Alleen wat gecommit is** wordt gebouwd: precies wat `git pull` binnenhaalde.
- **De sleutel:** het script ondertekent met de eigen sleutel uit `~/CineVault-android` (of `ANDROID_KEY_DIR` in `.env`, of `--key-dir`; de map `Documents\CineVault-android` van de oude Windows-server, deel 7). Is die er niet, bouw dan met `--debug-key`: dat gebruikt de openbare debug-sleutel van Expo, dezelfde als in de APK's van GitHub tot nu toe (die hadden geen eigen sleutel). Zo'n APK installeert over die van GitHub heen.
- **Een vreemde fout:** probeer `scripts/build-apk.sh --fresh`. Dat begint met een schone kopie van de code, en een nieuwe Android-map. Blijft het mislukken, stuur dan de laatste regels.

**Via GitHub kan het nog wel**, met de hand: _Actions_ → _Android_ → _Run workflow_ (zolang er bouwminuten zijn). De APK's staan dan bij de release **android-latest**; `scripts\get-apk.ps1` zet ze in `downloads`.

## 2. Installeren

1. Tik op het gedownloade `CineVault.apk`.
2. Android vraagt of de browser (of _Bestanden_) apps mag installeren: zet **Toestaan van deze bron** aan.
3. Play Protect kan waarschuwen dat de app onbekend is (hij komt niet uit de Play Store): kies **Meer details** → **Toch installeren**.

Android 7 of nieuwer is nodig. De APK is voor 64-bit-ARM-telefoons (`arm64-v8a`), dus vrijwel alle telefoons en tablets van na 2017.

## 3. Verbinden en inloggen

1. Vul het adres van de server in, zonder `http://` of `https://`:
   - overal: `cine-vault.nl` (HTTPS, zie stap 20 van [server-setup.md](server-setup.md));
   - thuis: `192.168.0.110:8765`;
   - onderweg, met de Tailscale-app op de telefoon: `100.119.127.18:8765`.

   Een domein zonder poort gebruikt de app via HTTPS; een IP-adres of een adres met poort via HTTP.

   **Thuis en onderweg:** tik op _Tweede adres (thuis en onderweg)_ en vul beide in, bijvoorbeeld `cine-vault.nl` en `192.168.0.110:8765`. De app gebruikt dan vanzelf het adres dat antwoordt, en het lokale adres eerst: thuis het snelle adres in je eigen netwerk, onderweg het domein. Dat werkt ook als de router `cine-vault.nl` thuis niet terugstuurt naar binnen (_NAT loopback_). Hij kijkt opnieuw bij het openen van de app en als de server ineens niet antwoordt, bijvoorbeeld als je de deur uit gaat. Je login werkt op beide adressen.

2. Kies je profiel en log in met dezelfde gebruikersnaam en hetzelfde wachtwoord als in de browser.

Onder _Profiel_ → _Server_ staan beide adressen, met welk adres de app nu gebruikt. Met _Adressen wijzigen_ voeg je het tweede adres later toe of pas je een adres aan, zonder opnieuw in te loggen. _Andere server_ begint opnieuw, met inloggen.

## 4. Afspelen

- **Direct play** als de telefoon het bestand zelf kan afspelen. De app vraagt de hardware-decoders van de telefoon welke codecs, profielen en resoluties ze aankunnen (HEVC 10-bit, HDR, AV1, 4K). MKV speelt de app zelf af, anders dan Safari.
- **Remux of transcode** via HLS als dat niet gaat, net als in de browser (fase 4). De kwaliteit (_Origineel_, _1080p_, _720p_) kies je in de speler of onder _Profiel_; de keuze geldt voor dit apparaat.
- **Ondertitels:** ingebouwde tekstsporen, losse bestanden en OpenSubtitles, met verschuiven in stappen van 0,5 s.
- **Voortgang:** "Verder kijken" en "gezien" zijn dezelfde als in de browser. Na een aflevering start de volgende na 10 s.
- **Intro overslaan:** tijdens de intro van een aflevering staat rechtsonder _Intro overslaan_. Op de tv druk je dan op OK. Tijdens het casten staat de knop op de telefoon.
- **Bediening:** tik toont of verbergt de bediening, dubbeltik links of rechts spoelt 10 s. Beeld-in-beeld werkt via de thuisknop.
- **Beeldformaat:** _Automatisch_ vult het scherm als er alleen zwarte balken wegvallen. Dat gebeurt bijvoorbeeld bij een film met balken in het bestand zelf. De server zoekt die balken één keer per bestand. Kies onder _Instellingen_ → _Beeldformaat_ vast voor _Passend_ of _Vullen_, of knijp met twee vingers om te wisselen.

- **Beheer (alleen beheerders, telefoon en tablet):** onder _Profiel_ → _Beheer_ staan het overzicht (scannen, bibliotheken, intro's, themamuziek), _Aandacht nodig_ (matchen), _Accounts_ en de instellingen voor verzoeken. In de speler corrigeer je onder _Instellingen_ de intro, recap en aftiteling. Zie `docs/server-setup.md`, stap 36.

## 5. Chromecast

1. Zet op de N100 in `.env` het adres waarop een Chromecast de server bereikt: liefst `CAST_BASE_URL=https://cine-vault.nl` (als dat adres thuis werkt), anders `CAST_BASE_URL=http://192.168.0.110:8765`; via http laadt de ontvanger van Google de stream vaak niet. Start daarna `scripts/up.sh`. _Beheer_ → _Gezondheid_ → _Chromecast_ controleert het adres; zie ook `docs/server-setup.md`, stap 45. De telefoon kan dan ook via `cine-vault.nl` of Tailscale verbonden zijn; de Chromecast gebruikt `CAST_BASE_URL`.
2. Tik op het Cast-icoon (rechtsboven op de startpagina of in de speler) en kies je Chromecast. De telefoon en de Chromecast moeten op hetzelfde wifi-netwerk zitten.
3. Start een film of aflevering. Hij speelt dan op de tv, en de telefoon wordt de afstandsbediening: pauzeren, spoelen, 10 seconden terug of vooruit, en _Stoppen met casten_. Daarna speelt de telefoon verder waar de tv was.

- **Wat er naar de tv gaat:** de server pakt het bestand om (of zet het om) voor de Chromecast. Een Chromecast Ultra of Chromecast met Google TV krijgt 4K HEVC, andere 1080p H.264. De audio wordt AAC. Herkent de app je Chromecast niet goed, kies dan onder _Profiel_ → _Chromecast_ zelf 4K of 1080p.
- **Ondertitels:** de ondertitel die op de telefoon gekozen was, gaat mee. Dat lukt alleen met een ondertitel die al helemaal klaar is: een los bestand, een download van OpenSubtitles of een ingebouwd spoor dat al eens helemaal gelezen is.
- **Voortgang en volgende aflevering** werken zoals op de telefoon, zolang de speler op de telefoon openstaat. Ga je terug naar de bibliotheek, dan speelt de tv gewoon verder.
- **Vanuit de browser** kan casten nog niet. Chrome staat dat alleen toe op een HTTPS-adres; met `https://cine-vault.nl` kan het nu gebouwd worden.

## 6. Android TV en Google TV

Dezelfde app werkt ook op een tv of tv-box met Android TV of Google TV, bijvoorbeeld een Chromecast met Google TV. Op een tv toont hij eigen schermen voor de afstandsbediening. Gebruik daarvoor **CineVault-TV.apk**: die werkt ook op tv's met 32-bit-Android, en dat hebben veel tv's. Die APK werkt ook op telefoons, maar is groter.

**Op de N100** (eenmalig, en na elke nieuwe versie):

1. Werk bij en start opnieuw: `git pull` en `scripts/up.sh`.
2. Bouw de APK's op de N100: `scripts/build-apk.sh` (deel 1). Ze komen in de map `downloads` in de CineVault-map. (Een build van GitHub haal je met `.\scripts\get-apk.ps1`; dat gebruikt de GitHub CLI: `winget install GitHub.cli`, dan in een **nieuw** PowerShell-venster één keer `gh auth login`.)

Caddy biedt ze daarna aan op `http://192.168.0.110:8765/tv` (en `/android` voor telefoons). Dat is nodig omdat de repository privé is: een tv kan niet bij GitHub inloggen. Ze staan ook op je domein: `cine-vault.nl/tv` en `cine-vault.nl/android`, dus ook buiten de deur. Typ je `http://`, dan stuurt Caddy je vanzelf door naar `https://`. Er hoort geen login bij: wie het adres kent, kan de APK downloaden. Daar staat niets geheims in, maar wel alleen de versie van de laatste keer dat je `build-apk.sh` (of `get-apk.ps1`) draaide.

**Op de tv:**

1. Installeer uit de Play Store de app **Downloader** (van AFTVnews).
2. Sta toe dat Downloader apps installeert: _Instellingen_ → _Apps_ → _Beveiliging en beperkingen_ → _Onbekende bronnen_ → Downloader aan. De namen verschillen iets per tv.
3. Open Downloader, typ `http://192.168.0.110:8765/tv` en kies _Go_. Na het downloaden kies je _Installeren_.
4. CineVault staat daarna bij je apps, met het CineVault-logo. Verplaats het naar je favorieten als je wilt.
5. Vul het serveradres in (`192.168.0.110:8765`).
6. **Inloggen met je telefoon:** de tv toont een QR-code en een code zoals `BCDF-2345`.
   - Scan de QR-code met de camera van je telefoon. Je telefoon opent CineVault in de browser. Ben je daar nog niet ingelogd, log dan eerst in. Kies daarna _Inloggen als …_.
   - Of open op je telefoon de CineVault-app, ga naar _Profiel_ → _Inloggen op een tv_ en typ de code.
   - De tv logt binnen een paar seconden in, als het profiel dat op de telefoon bevestigde. Elk lid van het huishouden doet dat met de eigen telefoon.
   - Liever met een wachtwoord? Kies op de tv _Inloggen met wachtwoord_.
   - De code werkt 10 minuten; daarna toont de tv vanzelf een nieuwe.

**De afstandsbediening:**

- **Overal:** met de pijltjes verplaats je de focus, met OK kies je, en met _Terug_ ga je terug. Het menu staat links.
- **In de speler:**
  - **Bediening verborgen:** links en rechts spoelen 10 seconden. Houd je de knop vast of druk je snel achter elkaar, dan gaat het steeds sneller, tot 2 minuten per stap. Het spoelen begint als je loslaat. OK toont de bediening.
  - **Bediening zichtbaar:** op de tijdlijn spoel je met links en rechts. Daaronder staan pauze, _Audio en ondertitels_, de kwaliteit en _Volgende_.
  - **Mediaknoppen:** afspelen/pauze, terug- en vooruitspoelen en _Volgende_ werken altijd.
  - **Terug:** sluit eerst een paneel, verbergt dan de bediening, en verlaat daarna de speler.

**Bijwerken:** voer `scripts/build-apk.sh` opnieuw uit en installeer de nieuwe APK op de tv met Downloader. Hij komt over de oude heen, net als op de telefoon.

**Nog niet op de tv:** casten (de tv is zelf het scherm), beeld-in-beeld, zoeken met je stem, en een eigen rij in het startscherm van Google TV. Inloggen met de QR-code is er wel; dat werkt alleen als de telefoon het serveradres van de tv kan bereiken (thuis, of met Tailscale aan). De tv-versie is nog niet op een echte tv getest.

## 7. Updates en de eigen sleutel

Android installeert een nieuwe versie alleen over de oude als beide met dezelfde sleutel ondertekend zijn. De APK's van GitHub tot build 40 hadden de debug-sleutel van Expo. Die werkt, maar is openbaar. Een eigen sleutel is beter:

1. Maak de sleutel op de N100 (Docker Desktop moet draaien):

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\android-key.ps1
   ```

   De sleutel komt in `Documents\CineVault-android`. **Bewaar die map, ook in een back-up.** Zonder die sleutel installeert een nieuwe versie pas na het verwijderen van de app.

2. Bouw: `scripts/build-apk.sh` (deel 1). Het script vindt de sleutel zelf (in `~/CineVault-android`; kopieer de map daarheen).
3. Verwijder de app één keer van de telefoon en de tv, en installeer de nieuwe APK. Dat is alleen nodig bij de overstap van de debug-sleutel naar de eigen sleutel. Je moet daarna opnieuw verbinden en inloggen; de kijkvoortgang staat op de server en blijft. Daarna gaan updates gewoon over de oude versie heen.
4. Alleen voor builds op GitHub: maak op GitHub (_Settings_ → _Secrets and variables_ → _Actions_ → _New repository secret_) de drie secrets aan uit `Documents\CineVault-android\github-secrets.txt`.

## 8. Zelf bouwen (voor ontwikkelaars)

```bash
pnpm install
pnpm --filter @cinevault/shared build
cd apps/mobile
pnpm exec expo prebuild --platform android --no-install --clean   # maakt android/ (niet in git)
cd android && ./gradlew assembleRelease
```

Daarvoor zijn JDK 17 en de Android SDK nodig. `pnpm --filter @cinevault/mobile start` start Metro voor een development build.

## 9. In de auto: Android Automotive OS (Polestar, Volvo)

Auto's met _Google built-in_, zoals Polestar 2, 3 en 4 en de Volvo EX30, EX90 en XC40/EX40, draaien
Android Automotive OS. CineVault werkt daarop met **dezelfde app** als op de telefoon: er is geen aparte
auto-app nodig.

**Wat je in de auto krijgt:**

- De schermen van de telefoon en tablet, met een eigen indeling voor het brede, liggende scherm
  (gemaakt voor de Polestar 4, 1920×1200):
  - het menu (Home, Bibliotheek, Zoeken, Ontdekken, Profiel) staat als smalle balk **links**, aan de kant
    van de bestuurder; onderaan het scherm zit de balk van de auto zelf;
  - het grote beeld op Home en de achtergrond van een titel zijn lager, met de tekst en de knoppen links,
    zodat de eerste rij en _Afspelen_ meteen in beeld zijn;
  - knoppen worden niet over de hele breedte uitgerekt en zijn wat groter, kaarten wat kleiner;
  - alles is groter getekend: de Polestar tekent zijn scherm op ware grootte (ongeveer 1×), dus
    tekst, menu, knoppen en kaarten worden in de auto zo'n 1,4× zo groot gemaakt; ook de ondertitels
    zijn groter;
  - de laatste rij schuift boven de klimaatbalk van de auto uit;
  - tekst en afleveringen blijven binnen een leesbare breedte;
  - onder _Profiel_ geen Chromecast en geen _Inloggen op een tv_.
- **Video alleen als de auto stilstaat.** Zodra de auto rijdt, legt het systeem een eigen scherm over de
  app, en CineVault pauzeert. De video start daarna niet vanzelf weer, ook niet de volgende aflevering:
  druk op afspelen als je weer geparkeerd staat. Zo eisen Google en de autofabrikanten het.
- **Inloggen met je telefoon:** de auto toont een QR-code, net als de tv (deel 6). Of kies _Inloggen
  met wachtwoord_.
- **Serveradres:** `cine-vault.nl`. De auto heeft zijn eigen internet; het thuisadres
  (`192.168.0.110:8765`) werkt alleen als de auto op je wifi staat. Vul het als tweede adres in onder
  _Profiel_ → _Server_ → _Adressen wijzigen_ als je ook in de garage wilt kijken.
- Niet in de auto: casten naar een Chromecast en beeld-in-beeld.

**Installeren.** Polestar en Volvo hebben geen officiële manier om zelf een APK te installeren, zoals
op de tv. Er zijn twee wegen:

### A. Via Google Play, als interne test (werkt op elke auto met Google built-in)

Een interne test is een besloten versie in de Play Store, voor hooguit 100 mensen die jij uitnodigt.
Google keurt een interne test niet eerst (wel een openbare release).

1. Maak een ontwikkelaarsaccount op [play.google.com/console](https://play.google.com/console):
   eenmalig 25 dollar, en Google controleert je identiteit (dat kan een paar dagen duren).
2. Maak in de Play Console een app aan: naam _CineVault_, standaardtaal Nederlands, _App_, _Gratis_.
3. Bouw de app-bundel op de N100:

   ```bash
   git pull
   scripts/build-apk.sh --variant car
   ```

   Dan staat `play/CineVault.aab` in de CineVault-map (die map biedt Caddy niet aan). `--variant car`
   bouwt alleen de bundel, zonder APK's, met een eigen manifest voor de auto: `distractionOptimized`
   op de app en de volledige-schermspeler, en alleen liggend (verzoek eigenaar, 2026-11-20). Het
   systeem legt dan tijdens het rijden geen scherm meer over de app; de speler pauzeert video tijdens
   het rijden nog steeds zelf. Volgens de richtlijnen van Google mag een video-app die vlag niet
   hebben, dus de Play Console kan de bundel weigeren. Met `--aab` bouwt hij de bundel naast de APK's
   voor telefoon en tv, zonder dat manifest. Wissel je tussen `--variant car` en een andere build, dan
   maakt `expo prebuild` de Android-map opnieuw en duurt de build langer.

   Wil je de bundel of de Android-bestanden van de build op je telefoon hebben (bijvoorbeeld om ze
   te delen): `cp play/CineVault.aab downloads/` geeft `https://<domein>/download/CineVault.aab`, en
   `scripts/android-files.sh` zet de manifesten (ook het samengevoegde), de Kotlin, de Gradle-bestanden
   en `res/xml` in `https://<domein>/download/android-config.zip`. Haal ze daarna weer weg
   (`rm downloads/CineVault.aab`, `scripts/android-files.sh --remove`).
4. In de Play Console: _Testen_ → _Interne test_ → _Nieuwe release maken_.
   - Bij de eerste keer vraagt de Console naar **Play App Signing**: laat Google de sleutel beheren (de
     standaardkeuze). De bundel is ondertekend met je eigen sleutel uit `Documents\CineVault-android`; die
     wordt daarmee je _uploadsleutel_. Google ondertekent de app in de Play Store met een eigen sleutel.
     Daardoor installeert de versie uit de Play Store niet over een APK heen en andersom. In de auto komt
     de app alleen uit de Play Store, dus daar maakt dat niet uit; houd op je telefoon en tv de APK.
   - Upload `play/CineVault.aab` en geef de release een naam (bijvoorbeeld het buildnummer).
5. _Testers_: maak een lijst met het e-mailadres van het Google-account waarmee je in de auto bent
   ingelogd. Kopieer de **link om mee te doen** en open die op je telefoon of computer, ingelogd met
   datzelfde account. Kies _Tester worden_.
6. _Instellingen_ → _Geavanceerde instellingen_ → _Formfactors_ → **Android Automotive OS** toevoegen.
   Kies daar het type track **Mobiel**: dan gaat dezelfde release ook naar de auto (dat mag voor
   video-apps). De Console vraagt ook om de reviewregels te accepteren.
7. Vul in wat de Console verder vraagt onder _App-content_ (onder andere doelgroep en
   gegevensveiligheid). Voor een interne test is een uitgebreide winkelpagina niet nodig.
8. In de auto: open de **Play Store**, zoek _CineVault_ en installeer. Een nieuwe versie: bouw opnieuw
   met `-Aab` en upload die bij een nieuwe release van de interne test; de Play Store werkt de app dan
   zelf bij.

### B. Zelf installeren met ADB (alleen als je auto het toestaat)

Sommige eigenaren melden dat ook Polestar en Volvo de ontwikkelaarsopties tonen: _Instellingen_ →
_Systeem_ → _Over_ en 7 keer tikken op de buildversie. Polestar en Volvo bevestigen dat zelf niet, en
een update van de auto kan het weer uitzetten. Lukt het, zet dan de (draadloze) foutopsporing aan, laat
de auto op je wifi staan, en installeer vanaf de N100 zoals bij de tv (deel 6):

```powershell
adb connect <ip-van-de-auto>:5555
adb install -r downloads\CineVault-TV.apk
```

**Nog niet getest:** in een echte auto (en in de emulator van Android Studio), en hoe de app in de Play
Store van de auto verschijnt. Laat weten wat je ziet, dan passen we het aan.

**Kijken tijdens het rijden (voor de kinderen achterin):** dat kan niet op het scherm van de auto.
Google en Polestar laten video op het middenscherm alleen toe als de auto stilstaat; het systeem
legt er tijdens het rijden zelf een scherm overheen. Ook alleen het geluid laten doorspelen mag
voorlopig alleen bij apps die Google heeft uitgekozen (een bèta). Wat wel kan: een tablet of
telefoon met de CineVault-app achterin, met internet via de wifi-hotspot van een telefoon.

**Niet gebouwd:** geluid doorspelen tijdens het rijden (Google laat dat alleen bij uitgekozen partners
toe), en een staande indeling voor auto's met een staand scherm (zoals de Polestar 2 en de Volvo EX30):
die krijgen de indeling van de tablet.
