# NBC Board-Import: Taskcards & Edumaps

Chrome-Erweiterung, die öffentliche [Taskcards](https://www.taskcards.de/)-
und [Edumaps](https://edumaps.de/)-Boards direkt als neuen Bereich in einen
Raum der [Niedersächsischen Bildungscloud](https://niedersachsen.cloud)
importiert -- ohne Server, ohne Zugangsdaten, im Konto der angemeldeten
Person.

## Warum eine Erweiterung statt eines Servers?

Es gibt bereits zwei funktionierende Import-Wege für diese Quellen:

* [`nbcimport`](https://github.com/steedalot/nbcimport) (Python/FastAPI) --
  der vollständige Pfad für beide Quellen, mit Pipeline-Stages, Job-Store,
  Mail. Braucht einen Server, einen NBC-Service-Account mit Zugangsdaten und
  einen festen Ablage-Raum -- Boards landen deshalb nicht im Konto der
  Lehrkraft, sondern werden per Share-Token weitergereicht.
* `edumaps-import` (lokal, Node/TypeScript) -- ein bereits vollständig in
  JavaScript umgesetzter Weg nur für Edumaps. Braucht ebenfalls einen
  Server und verlangt, dass die Nutzerin ihr JWT von Hand aus den
  Browser-Cookies kopiert.

Das Vorbild [`nbc-files`](https://github.com/pepperworth/nbc-files) zeigt,
dass beides unnötig ist: Eine Chrome-Erweiterung, die auf
`niedersachsen.cloud` läuft, spricht die NBC-API mit
`credentials: "same-origin"` an -- kein Token, kein Server, keine
Zugangsdaten. Diese Erweiterung überträgt genau dieses Prinzip auf den
Board-Import.

## Installation

1. Dieses Repository herunterladen bzw. `git clone`
2. `chrome://extensions` öffnen
3. **Entwicklermodus** oben rechts einschalten
4. **Entpackte Erweiterung laden** → den Ordner `extension/` auswählen

Für ein Release-ZIP (z.B. für eine GitHub-Release-Datei): `./build.sh`.

## Benutzung

1. Einen Raum auf `niedersachsen.cloud` öffnen, in den das Board importiert
   werden soll
2. Unten rechts auf **„Board importieren"** klicken
3. Taskcards- oder Edumaps-Link einfügen, Optionen wählen, **Import
   starten**
4. Am Ende **„Schließen + Neu laden"** -- erst danach zeigt der Raum den
   neuen Bereich

Öffentliche Boards reichen normalerweise. Bei einer Quelle mit eigenem Login
vorher dort einloggen -- der Abruf läuft mit der Cookie-Session dieses
Browser-Tabs (`credentials: "include"` im Service-Worker-Fetch), nicht mit
einem separat eingegebenen Token.

## Architektur

```
  niedersachsen.cloud/rooms/<id>          Service Worker           Quelle
  ┌────────────────────────────┐        ┌──────────────┐     ┌──────────────┐
  │ content-nbc.js             │        │ background.js│     │ taskcards.de │
  │  · Button + Panel          │ msg    │              │fetch│ edumaps.de   │
  │  · Quelle holen lassen ────┼───────►│ host_perms   ├────►│ + Medien-CDN │
  │  · HTML/JSON parsen        │◄───────┤ (kein CORS)  │     └──────────────┘
  │    (DOMParser im Tab)      │        └──────────────┘
  │  · Export gegen /api/v3    │
  │    credentials same-origin │
  │  · Fortschritt im Panel    │
  └────────────────────────────┘
```

Der eigentliche Export läuft **im Tab**, nicht im Service Worker -- MV3
beendet Worker nach kurzer Leerlaufzeit, ein Import mit hunderten
sequentiellen Requests würde das nicht überleben. Der Worker macht nur
kurze Einzel-Fetches gegen die Quellen (Cross-Origin, braucht
`host_permissions`, ist dort im Gegensatz zum Content-Script nicht an die
CORS-Regeln der Zielseite gebunden).

**Datei-Uploads** bevorzugen `POST /file/upload-from-url/...` -- die NBC
zieht die Datei dann selbst, kein Download in den Browser nötig. Nur wenn
das fehlschlägt (oder die Datei ein im Browser gerendertes Inline-Bild ist,
z.B. ein QR-Code), lädt der Service Worker die Bytes selbst und die
Erweiterung lädt sie per Multipart hoch.

### Dateien

| Datei | Aufgabe |
|---|---|
| `extension/manifest.json` | MV3-Konfiguration, `host_permissions` |
| `extension/background.js` | Service Worker: Cross-Origin-Fetch, komplette Taskcards-GraphQL-Choreografie |
| `extension/content-nbc.js` | Button + Panel auf der Raum-Seite, orchestriert Abruf → Export |
| `extension/lib/colors.js` | Hex-Farbe → NBC-Kartenfarbe (CIE-Lab-Nearest-Neighbour) |
| `extension/lib/sanitize.js` | RichText-Sanitizer (Inline-Style → semantische Tags, CSS-Clamping, DOMPurify-Schlusspass) |
| `extension/lib/qr.js` | QR-Code-Rendering für Edumaps-QR-Widgets |
| `extension/lib/edumaps-parser.js` | Edumaps-HTML → gemeinsames Board-Format |
| `extension/lib/taskcards.js` | Taskcards-GraphQL-Board → gemeinsames Board-Format |
| `extension/lib/nbc-api.js` | NBC-API-Client (Cookie-Auth, Retry-Wrapper) |
| `extension/lib/exporter.js` | Gemeinsames Board-Format → NBC-API-Aufrufe |
| `extension/lib/vendor/` | Vendorisierte Bibliotheken (DOMPurify, qrcode-generator) |

Alle `lib/*.js`-Dateien sind klassische Scripts (kein Bundler), die sich
einen gemeinsamen Namespace `window.NBCImport` teilen -- geladen in
Abhängigkeitsreihenfolge über `content_scripts.js` im Manifest.

## Herkunft des Codes

Diese Erweiterung ist eine Portierung, kein Neuentwurf. Herkunft der
einzelnen Teile:

* **Edumaps-Parser** (`lib/edumaps-parser.js`) -- adaptiert aus
  `edumaps-import/edumaps-parser.js` (lokales Schwesterprojekt), das dort
  bereits gegen eine browser-äquivalente DOM-API (linkedom) läuft. Die
  Farblogik wurde herausgelöst und durch `lib/colors.js` ersetzt.
* **Taskcards-Abruf** (Teil von `background.js`) -- fast unverändert aus
  `app/static/taskcards_client_ingest.js`
  ([`nbcimport`](https://github.com/steedalot/nbcimport)), das denselben
  Visitor-Token-/Query-Ablauf schon heute im Browser fährt, dort als
  Page-Script statt im Service Worker.
* **Taskcards-Mapping** (`lib/taskcards.js`) -- neu geschrieben, Port von
  `app/importers/taskcards.py` (GraphQL-Board → Zwischenformat).
* **RichText-Sanitizer** (`lib/sanitize.js`) -- neu geschrieben, Port von
  `app/importers/rich_text_sanitizer.py`. Der DOM-Walk übernimmt die
  NBC-Transforms, [DOMPurify](https://github.com/cure53/DOMPurify)
  übernimmt die abschließende Sicherheitsschicht (entspricht der Rolle von
  `nh3`/html5ever im Python-Original).
* **Farb-Zuordnung** (`lib/colors.js`) -- Port von `app/pipeline/colors.py`,
  ergänzt um eine Korrektur aus der Python-Analyse, die in der bisherigen
  JS-Fassung fehlte: Der NBC-Nuxt-Client rendert nur 11 der 20
  `CardColor`-Werte in seinem Farbwähler: Für alle anderen speichert der
  Server den Wert klaglos, im UI erscheint die Karte aber uneingefärbt.
  Das Mapping bildet deshalb bewusst nur auf diese 11 Werte ab.
* **NBC-API-Client** (`lib/nbc-api.js`) -- aus
  `edumaps-import/src/api-client.ts`, Auth von `Authorization: Bearer`
  (JWT aus der Zwischenablage) auf `credentials: "same-origin"`
  umgestellt.
* **Export-Choreografie** (`lib/exporter.js`) -- aus
  `edumaps-import/server.js#runImport` (dort die vollständigste
  JS-Fassung, u.a. mit Ankerauflösung für interne Links), ergänzt um
  Quirks aus `app/nbc/exporter.py`: Titel-Kappung bei 100 Zeichen,
  RichText-500-Fallback auf Plaintext, `requiredEmptyElements` für
  Videokonferenz-Elemente, File-Element-Cleanup bei Upload-Fehlern.

## Bewusste Vereinfachungen gegenüber `nbcimport`

Diese Erweiterung deckt den Import-Pfad ab, nicht das ganze `nbcimport`.
Bewusst draußen gelassen:

* **H5P, External Tools, Kurs-/Raum-Import** -- der Importer-Pfad erzeugt
  nur sechs Elementtypen (RichText, Link, Datei, Videokonferenz,
  gemeinsamer Texteditor, interner Link); die aufwendigen Teile des
  Python-Exporters (H5P, External-Tool-Rebinding) liegen außerhalb.
* **`board_lint`, `a11y_check`** -- reine, deterministische
  Prüf-Stages ohne Netzbedarf. Ändern das Board nicht, liefern nur
  Warnungen. Lassen sich später als eigene Module nachrüsten.
* **`taskcards_comments`-Stage** -- im Original eine interaktive
  Pipeline-Stage mit Rückfrage. Diese Erweiterung übernimmt
  Taskcards-Kommentare stattdessen immer (nicht interaktiv) als kurze
  Notiz am Ende der jeweiligen Karte.
* **`link_preview`-Stage** -- lädt beliebige Fremd-URLs, um
  Vorschaubilder für Link-Elemente zu holen. Als Erweiterung hieße das
  die Berechtigung `<all_urls>` -- die breiteste denkbare, mit
  Store-Review-Risiko und IP-Leak an jede verlinkte Domain. Bewusst nicht
  eingebaut; falls das später kommt, dann über NBCs eigenen
  `POST /api/v3/meta-tag-extractor`, nicht über eigene Fetches.
* **Mail, Job-Store, SSE, Cleanup-Cron, SSRF-Schutz, JWT-Session** --
  reine Server-Infrastruktur, die ohne Server ersatzlos entfällt.
* **Weg B (Button auf der Quellseite)** -- für nicht-öffentliche Boards
  mit eigenem Login gibt es im aktuellen Weg A schon eine Lösung: Der
  Worker-Fetch läuft mit `credentials: "include"` und schickt die
  Cookies der Quellseite mit. Ein zusätzlicher Button direkt auf
  `edumaps.de`/`taskcards.de` (für Inhalte, die erst durch Interaktion im
  Tab entstehen) ist nicht Teil dieser Fassung.
* **Ziel-Raum** -- immer der Raum, in dem der Button gedrückt wurde. Kein
  Raum-Auswahldialog; das Board entsteht dort, ohne Ablage-Raum-Umweg und
  ohne Share-Token-Pflicht (der Teilen-Link ist optional, nicht Vor
  aussetzung).

## Entwicklung

Keine Build-Pipeline -- die `lib/*.js`-Dateien sind klassische Scripts, die
sich `window.NBCImport` teilen. `node --check <datei>` prüft nur Syntax
(die Dateien laufen gegen Browser-APIs wie `DOMParser`, `chrome.*`,
`fetch`, die es in Node nicht gibt). Für echte Läufe: Erweiterung entpackt
laden und gegen ein öffentliches Test-Board probieren.

```bash
npm install          # einmalig: jsdom als Test-Dependency
./build.sh           # Release-ZIP bauen
npm test             # Unit-Tests (Mapping/Farben/Sanitizer, jsdom-basiert)
```

Die Tests laden die `lib/*.js`-Dateien unverändert per `vm.runInThisContext`
in eine jsdom-Umgebung (`test/harness.js`) -- kein Babel, kein Mocking der
Modulgrenzen, die Dateien laufen exakt so wie im Content-Script. `chrome.*`
und Netzwerk (`background.js`, `nbc-api.js`, `exporter.js`, `content-nbc.js`)
sind bewusst nicht automatisiert getestet; das ist der End-to-End-Fall aus
der „Benutzung"-Anleitung oben.

## Offene Punkte

* **Reicht die Cookie-Session für `POST /rooms`, `POST /boards` und
  `POST /sharetoken`?** Für Spalten, Karten, Elemente und Uploads ist das
  durch `nbc-files` belegt, für diese drei (noch) nicht getestet.
  Fallback, falls nicht: JWT aus dem Cookie lesen und als
  `Authorization: Bearer` mitschicken.
* **`upload-from-url` gegen Taskcards-S3.** Ob die NBC die presigned
  S3-URLs der Taskcards-Anhänge selbst ziehen kann, ist ungetestet. Der
  Multipart-Fallback greift automatisch, falls nicht.
* **Große Boards / große Dateien.** Der Multipart-Fallback hält den Blob
  im Speicher des Tabs -- bei sehr großen Anhängen kann das eng werden.
  Es gibt (bewusst) keine harte Größengrenze wie im Python-Original
  (250 MB serverseitig).
