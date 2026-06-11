# Die Messe München in Zahlen 📊

Eine interaktive Datengeschichte über die Veranstaltungen der Messe München seit 2018 –
Besucher:innen, Aussteller und vermietete Flächen, visualisiert mit [D3.js](https://d3js.org).

**Live-Seite:** <https://mueller-andreas.github.io/messe-muenchen/>

## Datenquelle

| | |
|---|---|
| Datensatz | [„Bisherige Veranstaltungen der Messe München – Veranstaltungsdaten ab 2018“](https://opendata.muenchen.de/dataset/veranstaltungen-der-messe-muenchen) |
| Portal | [Open Data Portal der Landeshauptstadt München](https://opendata.muenchen.de) |
| Herausgeber | Messe München GmbH |
| Lizenz | siehe Angaben auf der Datensatzseite (wird auf der Seite zusätzlich live aus den Portal-Metadaten angezeigt) |

Die Seite lädt die Daten **beim Aufruf direkt im Browser** vom Open Data Portal –
zuerst über die CKAN-Datastore-API, ersatzweise als CSV-Download. Es findet keine
serverseitige Verarbeitung statt; die Zahlen sind dadurch immer auf dem Stand des Portals.

### Optionaler Daten-Snapshot

Falls das Portal einmal nicht erreichbar ist (oder keine CORS-Header liefert), fällt die
Seite auf einen lokalen Snapshot zurück. Dazu einfach die Original-CSV in dieses
Repository legen:

```
data/veranstaltungsdaten.csv
```

Download der CSV: über die [Datensatzseite](https://opendata.muenchen.de/dataset/veranstaltungen-der-messe-muenchen)
→ Ressource „Veranstaltungsdaten“ → „Herunterladen“.

## Veröffentlichung (GitHub Pages)

Die Seite wird vom Branch `gh-pages` ausgeliefert. Der Workflow
`.github/workflows/deploy-pages.yml` spiegelt bei jedem Push auf `main`
den Stand automatisch nach `gh-pages` – es ist kein Build-Schritt nötig.

Falls die Pages-Quelle einmal manuell gesetzt werden muss:
Repo-Einstellungen → **Pages** → Source: **Deploy from a branch** →
Branch `gh-pages`, Ordner `/ (root)`.

## Lokal ansehen

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Technik

- Statische Seite ohne Build-Schritt (HTML + CSS + Vanilla JS)
- [D3.js v7](https://d3js.org) (ISC-Lizenz), lokal eingebunden unter `assets/vendor/`
- Responsiv (mobile-first), `prefers-reduced-motion` wird respektiert
- Robustes Daten-Parsing: Trennzeichen-Erkennung, deutsche Zahlen-/Datumsformate,
  Windows-1252-Fallback, tolerante Spaltenerkennung über Schlüsselwörter

## Hinweis

Dieses Projekt ist ein unabhängiges Open-Data-Projekt und steht in keiner Verbindung
zur Messe München GmbH oder zur Landeshauptstadt München.
