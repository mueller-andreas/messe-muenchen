/* ==========================================================================
   Die Messe München in Zahlen — Von Riem in die Welt
   --------------------------------------------------------------------------
   Lädt die offenen Daten "Bisherige Veranstaltungen der Messe München"
   (Open Data Portal München) direkt im Browser und rendert daraus eine
   interaktive Datengeschichte mit D3.js.

   Spalten des Datensatzes (Stand 2026):
   langtitel; kurztitel; veranstaltungsjahr; veranstaltungsmonat; startdatum;
   enddatum; stadt; land; messegelaende; turnus; branchenschwerpunkte;
   veranstaltername; messetyp; nettoflaeche; aussteller_gesamt;
   aussteller_inland; aussteller_ausland; besucher_gesamt; besucher_inland;
   besucher_ausland

   Wichtig: Besucher-, Aussteller- und Flächenangaben liegen erst ab 2022 vor.

   Datenquelle:
   https://opendata.muenchen.de/dataset/veranstaltungen-der-messe-muenchen
   Herausgeber: Messe München GmbH · Landeshauptstadt München
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   *  Konfiguration
   * ------------------------------------------------------------------ */

  const DATASET_PAGE =
    "https://opendata.muenchen.de/dataset/veranstaltungen-der-messe-muenchen";
  const DATASET_ID = "veranstaltungen-der-messe-muenchen";
  const RESOURCE_ID = "b698829c-b051-4092-a276-9ba1afdc12f3";
  const CSV_URL =
    "https://opendata.muenchen.de/dataset/ef068a1c-315c-4262-8cf1-903767831225/resource/" +
    RESOURCE_ID +
    "/download/veranstaltungsdaten.csv";
  // CKAN-API-Wurzeln: Das Münchner Portal verweist in seiner API-Hilfe
  // (api_info-Snippet) für den Datastore auf www.opengov-muenchen.de.
  const API_ROOTS = [
    "https://www.opengov-muenchen.de/api/action",
    "https://opendata.muenchen.de/api/3/action",
  ];
  const LOCAL_SNAPSHOT = "data/veranstaltungsdaten.csv";
  // Letzter Ausweg, falls das Portal keine CORS-Header liefert:
  const PROXY_CSV_URLS = [
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(CSV_URL),
    "https://corsproxy.io/?url=" + encodeURIComponent(CSV_URL),
  ];

  const COLORS = {
    de: "#0a6ebd",       // Deutschland
    munich: "#0a6ebd",   // München (= Deutschland-Blau)
    deOther: "#7fb2dd",  // Deutschland außerhalb Münchens
    abroad: "#16a3a3",   // Ausland
    fach: "#0a6ebd",     // Messetyp: Fachbesucher
    mixed: "#d9a441",    // Messetyp: Fach- und Privatbesucher
    privat: "#e8643c",   // Messetyp: Privatbesucher
    unknown: "#9aa3b5",
    exhibitors: "#0a6ebd",
    visitors: "#e8643c",
    bar: "#0a6ebd",
  };

  const fmtInt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
  const fmt1 = new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  function fmtCompact(n) {
    if (n == null || !isFinite(n)) return "–";
    if (Math.abs(n) >= 1e6) return fmt1.format(n / 1e6) + " Mio.";
    return fmtInt.format(n);
  }

  function fmtPct(x) {
    return fmtInt.format(Math.round(x * 100)) + " %";
  }

  /* ------------------------------------------------------------------ *
   *  Robustes Parsen (deutsche Zahlen-/Datumsformate, Encoding, Delimiter)
   * ------------------------------------------------------------------ */

  function parseNumber(v) {
    if (v == null) return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    let s = String(v).trim();
    if (!s || /^(k\.?\s?a\.?|n\/?\s?a|-+|–|\.|x)$/i.test(s)) return null;
    s = s.replace(/[^\d,.\-]/g, "");
    if (!s || s === "-") return null;
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      s = s.replace(/\./g, "").replace(",", "."); // 1.234.567,8
    } else if (hasComma) {
      const parts = s.split(",");
      if (parts.length === 2 && parts[1].length !== 3) s = parts.join(".");
      else s = parts.join("");
    } else if (hasDot) {
      const parts = s.split(".");
      const thousandish = parts.slice(1).every((p) => p.length === 3);
      if (parts.length > 1 && thousandish) s = parts.join("");
    }
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  function parseDate(v) {
    if (v == null) return null;
    if (v instanceof Date) return isNaN(+v) ? null : v;
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/); // 24.10.2022
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2})$/); // 24.10.22
    if (m) return new Date(2000 + +m[3], +m[2] - 1, +m[1]);
    return null;
  }

  function normalizeHeader(h) {
    return String(h)
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function decodeBuffer(buf) {
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("�")) {
      try {
        text = new TextDecoder("windows-1252").decode(buf);
      } catch (e) {
        /* utf-8 behalten */
      }
    }
    return text.replace(/^﻿/, "");
  }

  function sniffDelimiter(text) {
    const firstLine = text.slice(0, text.indexOf("\n") + 1 || 2000);
    const candidates = [";", ",", "\t", "|"];
    let best = ";";
    let bestCount = -1;
    for (const c of candidates) {
      const count = firstLine.split(c).length - 1;
      if (count > bestCount) {
        bestCount = count;
        best = c;
      }
    }
    return best;
  }

  function parseCsv(buf) {
    const text = decodeBuffer(buf);
    const delim = sniffDelimiter(text);
    const rows = d3.dsvFormat(delim).parse(text);
    if (!rows.length || rows.columns.length < 2) {
      throw new Error("CSV konnte nicht interpretiert werden");
    }
    return rows;
  }

  /* ------------------------------------------------------------------ *
   *  Spaltenzuordnung — primär über die bekannten Spaltennamen des
   *  Datensatzes, mit Ausweich-Namen für künftige Umbenennungen.
   * ------------------------------------------------------------------ */

  const COLUMN_CANDIDATES = {
    long: ["langtitel"],
    name: ["kurztitel", "langtitel", "veranstaltungstitel", "titel", "name"],
    year: ["veranstaltungsjahr", "jahr"],
    start: ["startdatum", "beginn", "datum von"],
    end: ["enddatum", "ende", "datum bis"],
    city: ["stadt", "ort", "veranstaltungsort"],
    country: ["land"],
    venue: ["messegelaende", "gelaende"],
    turnus: ["turnus"],
    branchen: ["branchenschwerpunkte", "branchen", "branche"],
    organizer: ["veranstaltername", "veranstalter"],
    typ: ["messetyp", "veranstaltungsart", "typ"],
    area: ["nettoflaeche", "vermietete flaeche in qm", "flaeche"],
    ex: ["aussteller gesamt", "aussteller"],
    exIn: ["aussteller inland"],
    exAus: ["aussteller ausland"],
    vis: ["besucher gesamt", "besucher"],
    visIn: ["besucher inland"],
    visAus: ["besucher ausland"],
  };

  function detectColumns(headers) {
    const norm = new Map(headers.map((h) => [normalizeHeader(h), h]));
    const map = {};
    for (const [key, candidates] of Object.entries(COLUMN_CANDIDATES)) {
      for (const c of candidates) {
        if (norm.has(c)) {
          map[key] = norm.get(c);
          break;
        }
      }
    }
    return map;
  }

  /* ------------------------------------------------------------------ *
   *  Datenmodell
   * ------------------------------------------------------------------ */

  function typGroupOf(raw) {
    const t = String(raw || "").split("*")[0].trim().toLowerCase();
    if (!t) return "unknown";
    if (t.startsWith("fach- und privat")) return "mixed";
    if (t.startsWith("fach")) return "fach";
    if (t.startsWith("privat")) return "privat";
    return "unknown";
  }

  const TYP_LABELS = {
    fach: "Fachbesucher",
    mixed: "Fach- & Privatbesucher",
    privat: "Privatbesucher",
    unknown: "ohne Angabe",
  };

  function cleanBranche(b) {
    return b.replace(/\(Branche\s*\d+\)/gi, "").replace(/\s+/g, " ").trim();
  }

  function buildEvents(rows, cols) {
    const str = (r, k) => (cols[k] ? String(r[cols[k]] || "").trim() : "");
    const num = (r, k) => (cols[k] ? parseNumber(r[cols[k]]) : null);

    const events = [];
    for (const r of rows) {
      const start = cols.start ? parseDate(r[cols.start]) : null;
      let year = num(r, "year");
      if (year != null && (year < 1900 || year > 2100)) year = null;
      if (year == null && start) year = start.getFullYear();

      const city = str(r, "city");
      const country = str(r, "country");

      const ev = {
        name: str(r, "name"),
        long: str(r, "long"),
        year: year,
        start: start,
        end: cols.end ? parseDate(r[cols.end]) : null,
        city: city,
        country: country,
        place: [city, country].filter(Boolean).join(", "),
        venue: str(r, "venue"),
        turnus: str(r, "turnus"),
        organizer: str(r, "organizer"),
        typRaw: str(r, "typ"),
        typ: typGroupOf(str(r, "typ")),
        branchen: str(r, "branchen")
          .split(";")
          .map(cleanBranche)
          .filter(Boolean),
        area: num(r, "area"),
        ex: num(r, "ex"),
        exIn: num(r, "exIn"),
        exAus: num(r, "exAus"),
        vis: num(r, "vis"),
        visIn: num(r, "visIn"),
        visAus: num(r, "visAus"),
      };
      ev.isDE = /deutschland|germany/i.test(country);
      ev.isMUC = /m(ü|ue)nchen|munich/i.test(city);
      ev.exShare =
        ev.ex > 0 && ev.exAus != null ? ev.exAus / ev.ex : null;
      ev.visShare =
        ev.vis > 0 && ev.visAus != null ? ev.visAus / ev.vis : null;

      if (!ev.name && ev.year == null && ev.vis == null) continue; // Leerzeile
      events.push(ev);
    }
    return events;
  }

  /* ------------------------------------------------------------------ *
   *  Laden nach den CKAN-API-Regeln des Münchner Portals:
   *
   *  1) package_show liefert die Metadaten des Datensatzes – darunter für
   *     jede Ressource die aktuelle Download-URL und das Flag
   *     `datastore_active`. Erst damit ist klar, ob datastore_search
   *     überhaupt erlaubt/sinnvoll ist (sonst antwortet CKAN mit 404).
   *  2) Bevorzugt wird die Original-CSV (immer aktuelles Schema),
   *     dann der gebündelte Snapshot, dann – nur falls aktiv – der
   *     Datastore, JSONP und zuletzt CORS-Proxys.
   *  3) Jede geladene Quelle wird gegen das erwartete Schema validiert;
   *     fehlen Kernspalten (Titel, Jahr, Stadt, Besucher), wird die
   *     nächste Quelle versucht statt eine halbleere Story zu rendern.
   * ------------------------------------------------------------------ */

  const FETCH_TIMEOUT_MS = 8000;

  async function fetchWithTimeout(url, opts) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchJson(url) {
    const resp = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " für " + url);
    return resp.json();
  }

  async function fetchCsvRows(url) {
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status + " für " + url);
    return parseCsv(await resp.arrayBuffer());
  }

  // Prüft, ob eine geladene Quelle die Kernspalten des Datensatzes enthält.
  function validateSource(headers) {
    const cols = detectColumns(headers.filter((hh) => hh !== "_id"));
    if (cols.name && cols.year && cols.city && cols.vis) return cols;
    return null;
  }

  // Schritt 1 der API-Regeln: Metadaten holen, Ressource identifizieren.
  let DISCOVERED_PKG = null;

  async function discoverResource(attempts) {
    for (const root of API_ROOTS) {
      try {
        const json = await fetchJson(root + "/package_show?id=" + DATASET_ID);
        if (!json || !json.success || !json.result) {
          throw new Error("API-Antwort ohne Ergebnis");
        }
        DISCOVERED_PKG = json.result;
        const resources = json.result.resources || [];
        const resource =
          resources.find((r) => r.id === RESOURCE_ID) ||
          resources.find((r) => /csv/i.test(r.format || "")) ||
          resources[0] ||
          null;
        return { resource, root };
      } catch (e) {
        attempts.push("package_show (" + new URL(root).host + "): " + e.message);
      }
    }
    return null;
  }

  // JSONP-Fallback: CKAN beantwortet GET-Anfragen mit ?callback=… auch ohne
  // CORS-Header, da die Antwort als <script> geladen wird.
  function fetchJsonp(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cb = "__ckanCb" + Math.random().toString(36).slice(2);
      const script = document.createElement("script");
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("JSONP-Timeout"));
      }, timeoutMs || 8000);
      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
      }
      window[cb] = (data) => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error("JSONP-Fehler")); };
      script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
      document.head.appendChild(script);
    });
  }

  function datastoreUrl(root, limit, offset) {
    return (
      root + "/datastore_search?resource_id=" + RESOURCE_ID +
      "&limit=" + limit + "&offset=" + offset
    );
  }

  function unpackDatastore(json) {
    if (!json || !json.success || !json.result) {
      throw new Error("API-Antwort ohne Ergebnis");
    }
    const records = json.result.records || [];
    const headers = json.result.fields
      ? json.result.fields.map((f) => f.id)
      : records.length
        ? Object.keys(records[0])
        : [];
    const total = typeof json.result.total === "number" ? json.result.total : null;
    return { records, headers, total };
  }

  async function fetchDatastore(root) {
    const all = [];
    let headers = null;
    let offset = 0;
    let total = Infinity;
    while (offset < total && offset < 100000) {
      const page = unpackDatastore(await fetchJson(datastoreUrl(root, 10000, offset)));
      if (!headers) headers = page.headers;
      all.push.apply(all, page.records);
      total = page.total != null ? page.total : all.length;
      if (!page.records.length) break;
      offset = all.length;
    }
    if (!all.length) throw new Error("keine Datensätze");
    return { rows: all, headers };
  }

  async function loadData() {
    const attempts = [];

    // 1) Metadaten-Discovery (package_show): aktuelle CSV-URL + datastore_active
    const discovery = await discoverResource(attempts);
    const resource = discovery && discovery.resource;
    const datastoreActive = resource ? resource.datastore_active === true : null;

    function finish(rows, headers, origin, via) {
      const cols = validateSource(headers);
      if (!cols) {
        attempts.push(via + ": Kernspalten fehlen (Schema weicht ab) – übersprungen");
        return null;
      }
      return { rows, headers, cols, origin, via };
    }

    // 2) Original-CSV (aktuelle URL aus den Metadaten, sonst bekannte URL)
    const csvCandidates = [];
    if (resource && resource.url) csvCandidates.push(resource.url);
    if (!csvCandidates.includes(CSV_URL)) csvCandidates.push(CSV_URL);
    for (const url of csvCandidates) {
      try {
        const rows = await fetchCsvRows(url);
        const result = finish(rows, rows.columns, "live", "CSV-Download");
        if (result) return result;
      } catch (e) {
        attempts.push("CSV: " + e.message);
      }
    }

    // 3) gebündelter Snapshot (garantiert korrektes Schema)
    try {
      const rows = await fetchCsvRows(LOCAL_SNAPSHOT);
      const result = finish(rows, rows.columns, "snapshot", "lokaler Snapshot");
      if (result) return result;
    } catch (e) {
      attempts.push("Snapshot: " + e.message);
    }

    // 4) Datastore-API – nur wenn die Metadaten sie nicht ausschließen
    if (datastoreActive === false) {
      attempts.push("Datastore: laut Metadaten nicht aktiv – übersprungen");
    } else {
      for (const root of API_ROOTS) {
        try {
          const { rows, headers } = await fetchDatastore(root);
          const result = finish(rows, headers, "live", "Datastore-API");
          if (result) return result;
        } catch (e) {
          attempts.push("Datastore (" + new URL(root).host + "): " + e.message);
        }
      }

      // 5) Datastore per JSONP (umgeht fehlende CORS-Header)
      for (const root of API_ROOTS) {
        try {
          const page = unpackDatastore(await fetchJsonp(datastoreUrl(root, 10000, 0)));
          if (!page.records.length) throw new Error("keine Datensätze");
          const result = finish(page.records, page.headers, "live", "Datastore-API (JSONP)");
          if (result) return result;
        } catch (e) {
          attempts.push("JSONP (" + new URL(root).host + "): " + e.message);
        }
      }
    }

    // 6) CORS-Proxys auf die Original-CSV
    for (const proxyUrl of PROXY_CSV_URLS) {
      try {
        const rows = await fetchCsvRows(proxyUrl);
        const result = finish(rows, rows.columns, "live", "CSV via Proxy");
        if (result) return result;
      } catch (e) {
        attempts.push("Proxy (" + new URL(proxyUrl).host + "): " + e.message);
      }
    }

    const err = new Error("Alle Datenquellen fehlgeschlagen");
    err.attempts = attempts;
    throw err;
  }

  /* ------------------------------------------------------------------ *
   *  Tooltip
   * ------------------------------------------------------------------ */

  const tooltip = document.getElementById("tooltip");

  function showTooltip(html, event) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    moveTooltip(event);
  }

  function moveTooltip(event) {
    const pad = 14;
    const rect = tooltip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
    tooltip.style.left = Math.max(8, x) + "px";
    tooltip.style.top = Math.max(8, y) + "px";
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  const fmtDay = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });

  function eventTooltipHtml(d) {
    const rows = [];
    if (d.start) {
      rows.push([
        "Termin",
        fmtDay.format(d.start) + (d.end ? " – " + fmtDay.format(d.end) : ""),
      ]);
    } else if (d.year != null) {
      rows.push(["Jahr", d.year]);
    }
    if (d.place) rows.push(["Ort", escapeHtml(d.place)]);
    if (d.typRaw) rows.push(["Messetyp", escapeHtml(TYP_LABELS[d.typ])]);
    if (d.vis != null) {
      rows.push([
        "Besucher:innen",
        fmtInt.format(d.vis) +
        (d.visShare != null ? " (" + fmtPct(d.visShare) + " Ausland)" : ""),
      ]);
    }
    if (d.ex != null) {
      rows.push([
        "Aussteller",
        fmtInt.format(d.ex) +
        (d.exShare != null ? " (" + fmtPct(d.exShare) + " Ausland)" : ""),
      ]);
    }
    if (d.area != null) rows.push(["Nettofläche", fmtInt.format(d.area) + " m²"]);
    if (d.turnus) rows.push(["Turnus", escapeHtml(d.turnus)]);
    return (
      "<h4>" + escapeHtml(d.name || "Veranstaltung") + "</h4><table>" +
      rows.map((r) => "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>").join("") +
      "</table>"
    );
  }

  function bindTooltip(selection, htmlOf) {
    selection
      .on("pointerenter", function (event, d) { showTooltip(htmlOf(d), event); })
      .on("pointermove", function (event) { moveTooltip(event); })
      .on("pointerleave", hideTooltip)
      .on("click", function (event, d) {
        showTooltip(htmlOf(d), event);
        event.stopPropagation();
      });
  }
  document.addEventListener("click", hideTooltip);

  /* ------------------------------------------------------------------ *
   *  Gemeinsame Chart-Helfer
   * ------------------------------------------------------------------ */

  function renderLegend(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = items
      .map(
        (it) =>
          '<span class="legend-item"><span class="legend-swatch" style="background:' +
          it.color + '"></span>' + escapeHtml(it.label) + "</span>"
      )
      .join("");
  }

  function chartSize(container, aspect, minH, maxH) {
    const w = container.clientWidth || 600;
    const h = Math.max(minH, Math.min(maxH, Math.round(w * aspect)));
    return { w, h };
  }

  function svgIn(container, w, h) {
    d3.select(container).selectAll("svg").remove();
    return d3
      .select(container)
      .append("svg")
      .attr("viewBox", "0 0 " + w + " " + h)
      .attr("width", "100%")
      .attr("preserveAspectRatio", "xMidYMid meet");
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function appendFact(id, sentence) {
    const el = document.getElementById(id);
    if (!el || el.dataset.factDone) return;
    el.dataset.factDone = "1";
    const strong = document.createElement("strong");
    strong.className = "narrative-fact";
    strong.textContent = " " + sentence;
    el.appendChild(strong);
  }

  const CURRENT_YEAR = new Date().getFullYear();

  /* ------------------------------------------------------------------ *
   *  Kapitel 1 — Veranstaltungen pro Jahr (Deutschland vs. Ausland)
   * ------------------------------------------------------------------ */

  function renderYears(events) {
    const container = document.getElementById("chartYears");
    const withYear = events.filter((d) => d.year != null);
    if (!withYear.length) { container.textContent = "Keine Jahresangaben im Datensatz."; return; }

    const groups = ["de", "abroad"];
    const years = d3.sort(Array.from(new Set(withYear.map((d) => d.year))));
    const counts = years.map((y) => ({
      year: y,
      de: withYear.filter((d) => d.year === y && d.isDE).length,
      abroad: withYear.filter((d) => d.year === y && !d.isDE).length,
    }));

    const isMobile = container.clientWidth < 560;
    const { w, h } = chartSize(container, 0.52, 300, 430);
    const margin = { top: 34, right: 12, bottom: 36, left: 40 };
    const svg = svgIn(container, w, h);

    const x = d3.scaleBand().domain(years).range([margin.left, w - margin.right]).padding(0.25);
    const maxTotal = d3.max(counts, (r) => r.de + r.abroad) || 1;
    const y = d3.scaleLinear().domain([0, maxTotal]).nice().range([h - margin.bottom, margin.top]);

    // Corona-Band hinter 2020/21
    const covidYears = years.filter((yy) => yy === 2020 || yy === 2021);
    if (covidYears.length) {
      const x0 = x(covidYears[0]) - x.step() * x.padding() * 0.5;
      const x1 = x(covidYears[covidYears.length - 1]) + x.bandwidth() + x.step() * x.padding() * 0.5;
      svg.append("rect")
        .attr("class", "annotation-band")
        .attr("x", x0).attr("width", x1 - x0)
        .attr("y", margin.top - 18).attr("height", h - margin.top - margin.bottom + 18);
      svg.append("text")
        .attr("class", "annotation-label")
        .attr("x", (x0 + x1) / 2)
        .attr("y", margin.top - 4)
        .attr("text-anchor", "middle")
        .text("Corona");
    }

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(0," + (h - margin.bottom) + ")")
      .call(
        d3.axisBottom(x)
          .tickValues(isMobile ? years.filter((d, i) => i % 2 === 0) : years)
          .tickFormat((yy) => (yy === CURRENT_YEAR ? yy + "*" : yy))
          .tickSizeOuter(0)
      );

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(" + margin.left + ",0)")
      .call(d3.axisLeft(y).ticks(5).tickSize(-(w - margin.left - margin.right)))
      .call((g) => g.selectAll(".tick line").attr("class", "grid-line"))
      .call((g) => g.select(".domain").remove());

    const stack = d3.stack().keys(groups)(counts);

    svg.append("g")
      .selectAll("g")
      .data(stack)
      .join("g")
      .attr("fill", (s) => (s.key === "de" ? COLORS.de : COLORS.abroad))
      .selectAll("rect")
      .data((s) => s.map((seg) => Object.assign(seg, { key: s.key })))
      .join("rect")
      .attr("x", (seg) => x(seg.data.year))
      .attr("width", x.bandwidth())
      .attr("y", (seg) => y(seg[1]))
      .attr("height", (seg) => Math.max(0, y(seg[0]) - y(seg[1])))
      .attr("rx", 3)
      .attr("fill-opacity", (seg) => (seg.data.year === CURRENT_YEAR ? 0.45 : 1))
      .call(bindTooltip, (seg) => {
        return (
          "<h4>" + seg.data.year + (seg.data.year === CURRENT_YEAR ? " (laufend)" : "") +
          "</h4><table>" +
          "<tr><td>Deutschland</td><td>" + seg.data.de + "</td></tr>" +
          "<tr><td>Ausland</td><td>" + seg.data.abroad + "</td></tr>" +
          "<tr><td>Gesamt</td><td>" + (seg.data.de + seg.data.abroad) + " Veranstaltungen</td></tr></table>"
        );
      });

    svg.append("g")
      .selectAll("text")
      .data(counts)
      .join("text")
      .attr("x", (r) => x(r.year) + x.bandwidth() / 2)
      .attr("y", (r) => y(r.de + r.abroad) - 6)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("font-weight", 700)
      .attr("fill", "#4a5568")
      .text((r) => r.de + r.abroad);

    renderLegend("legendYears", [
      { color: COLORS.de, label: "Deutschland" },
      { color: COLORS.abroad, label: "Ausland" },
    ]);

    if (years.includes(CURRENT_YEAR)) {
      setText(
        "noteYears",
        "* " + CURRENT_YEAR + " ist das laufende Jahr – der Kalender ist noch nicht vollständig."
      );
    }

    const y2019 = counts.find((r) => r.year === 2019);
    const y2021 = counts.find((r) => r.year === 2021);
    const best = counts
      .filter((r) => r.year !== CURRENT_YEAR)
      .reduce((a, b) => (b.de + b.abroad > a.de + a.abroad ? b : a));
    if (y2019 && y2021) {
      appendFact(
        "narrativeYears",
        "In der Pandemie sank die Zahl der Veranstaltungen von " +
        (y2019.de + y2019.abroad) + " (2019) auf " + (y2021.de + y2021.abroad) +
        " (2021) – das bisher dichteste Jahr ist " + best.year + " mit " +
        (best.de + best.abroad) + " Messen."
      );
    }
    setText("subYears", years[0] + "–" + years[years.length - 1] + " · nach Standort");
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 2 — Veranstaltungen nach Stadt
   * ------------------------------------------------------------------ */

  function renderCities(events) {
    const container = document.getElementById("chartCities");
    const withCity = events.filter((d) => d.city);
    if (!withCity.length) { container.textContent = "Keine Ortsangaben im Datensatz."; return; }

    const byCity = d3.rollups(withCity, (v) => v, (d) => d.city + "|" + d.country)
      .map(([key, v]) => ({
        city: v[0].city,
        country: v[0].country,
        n: v.length,
        isDE: v[0].isDE,
        isMUC: v[0].isMUC,
      }))
      .sort((a, b) => b.n - a.n);

    const TOP = 12;
    const top = byCity.slice(0, TOP);
    const rest = byCity.slice(TOP);
    if (rest.length) {
      top.push({
        city: rest.length + " weitere Städte",
        country: rest.map((r) => r.country).filter((c, i, a) => a.indexOf(c) === i).length + " Länder",
        n: d3.sum(rest, (r) => r.n),
        isDE: false,
        isMUC: false,
        isRest: true,
      });
    }

    const isMobile = container.clientWidth < 560;
    const w = container.clientWidth || 600;
    const rowH = isMobile ? 46 : 38;
    const margin = { top: 4, right: 46, bottom: 4, left: 8 };
    const h = top.length * rowH + margin.top + margin.bottom;
    const svg = svgIn(container, w, h);

    const x = d3.scaleLinear()
      .domain([0, d3.max(top, (d) => d.n)])
      .range([0, w - margin.left - margin.right]);

    const colorOf = (d) =>
      d.isRest ? COLORS.unknown : d.isMUC ? COLORS.munich : d.isDE ? COLORS.deOther : COLORS.abroad;

    const row = svg.append("g")
      .selectAll("g")
      .data(top)
      .join("g")
      .attr("transform", (d, i) => "translate(" + margin.left + "," + (margin.top + i * rowH) + ")");

    const barH = isMobile ? 15 : 18;
    const barY = isMobile ? 22 : 14;

    row.append("rect")
      .attr("y", barY)
      .attr("height", barH)
      .attr("width", (d) => Math.max(2, x(d.n)))
      .attr("rx", barH / 2)
      .attr("fill", colorOf)
      .attr("fill-opacity", 0.9)
      .call(bindTooltip, (d) =>
        "<h4>" + escapeHtml(d.city) + "</h4><table>" +
        "<tr><td>Land</td><td>" + escapeHtml(d.country) + "</td></tr>" +
        "<tr><td>Veranstaltungen</td><td>" + d.n + "</td></tr></table>"
      );

    row.append("text")
      .attr("x", 2)
      .attr("y", isMobile ? 15 : barY - 4)
      .attr("font-size", isMobile ? 11.5 : 12.5)
      .attr("font-weight", 600)
      .attr("fill", "#14213d")
      .text((d) => truncate(d.city, isMobile ? 30 : 44) + "  ·  " + truncate(d.country, 22));

    row.append("text")
      .attr("x", (d) => Math.max(2, x(d.n)) + 8)
      .attr("y", barY + barH / 2 + 4)
      .attr("font-size", 11.5)
      .attr("font-weight", 700)
      .attr("fill", "#4a5568")
      .text((d) => d.n);

    renderLegend("legendCities", [
      { color: COLORS.munich, label: "München" },
      { color: COLORS.deOther, label: "Deutschland (sonstige)" },
      { color: COLORS.abroad, label: "Ausland" },
    ]);

    const muc = withCity.filter((d) => d.isMUC).length;
    const countries = new Set(withCity.map((d) => d.country)).size;
    appendFact(
      "narrativeCities",
      "Nur " + muc + " von " + withCity.length + " Veranstaltungen (" +
      fmtPct(muc / withCity.length) + ") fanden in München statt – der Rest verteilt sich auf " +
      (byCity.length - 1) + " weitere Städte in " + countries + " Ländern."
    );
    setText("subCities", "Top " + TOP + " von " + byCity.length + " Städten · 2018–" + d3.max(events, (d) => d.year));
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 3 — Timeline-Bubbles (Besucherzahlen, ab 2022)
   * ------------------------------------------------------------------ */

  function renderTimeline(events) {
    const container = document.getElementById("chartTimeline");
    let data = events.filter((d) => d.vis != null && d.vis > 0);
    const useDates = data.filter((d) => d.start).length > data.length * 0.5;
    data = data.filter((d) => (useDates ? d.start : d.year != null));
    if (!data.length) { container.textContent = "Keine Besucherzahlen im Datensatz."; return; }

    const isMobile = container.clientWidth < 560;
    const { w, h } = chartSize(container, 0.6, 360, 520);
    const margin = { top: 18, right: 16, bottom: 36, left: isMobile ? 44 : 56 };
    const svg = svgIn(container, w, h);

    const x = useDates
      ? d3.scaleTime()
          .domain(d3.extent(data, (d) => d.start)).nice()
          .range([margin.left, w - margin.right])
      : d3.scaleLinear()
          .domain(d3.extent(data, (d) => d.year))
          .range([margin.left, w - margin.right]);

    const y = d3.scaleSqrt()
      .domain([0, d3.max(data, (d) => d.vis)]).nice()
      .range([h - margin.bottom, margin.top]);

    const hasArea = data.some((d) => d.area != null && d.area > 0);
    const r = hasArea
      ? d3.scaleSqrt().domain([0, d3.max(data, (d) => d.area || 0)]).range([3, isMobile ? 16 : 24])
      : () => (isMobile ? 5 : 6);

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(0," + (h - margin.bottom) + ")")
      .call(
        (useDates
          ? d3.axisBottom(x).ticks(isMobile ? 4 : 8)
          : d3.axisBottom(x).ticks(isMobile ? 4 : 8).tickFormat(d3.format("d"))
        ).tickSizeOuter(0)
      );

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(" + margin.left + ",0)")
      .call(
        d3.axisLeft(y).ticks(6)
          .tickFormat((v) => (v >= 1e6 ? v / 1e6 + " Mio." : v >= 1e3 ? v / 1e3 + "k" : v))
          .tickSize(-(w - margin.left - margin.right))
      )
      .call((g) => g.selectAll(".tick line").attr("class", "grid-line"))
      .call((g) => g.select(".domain").remove());

    const jitter = d3.randomLcg(42);
    svg.append("g")
      .selectAll("circle")
      .data(data)
      .join("circle")
      .attr("cx", (d) => (useDates ? x(d.start) : x(d.year) + (jitter() - 0.5) * 18))
      .attr("cy", (d) => y(d.vis))
      .attr("r", (d) => (hasArea ? r(d.area || 0) : r()))
      .attr("fill", (d) => (d.isDE ? COLORS.de : COLORS.abroad))
      .attr("fill-opacity", 0.55)
      .attr("stroke", (d) => (d.isDE ? COLORS.de : COLORS.abroad))
      .attr("stroke-width", 1)
      .call(bindTooltip, eventTooltipHtml);

    renderLegend("legendTimeline", [
      { color: COLORS.de, label: "Deutschland" },
      { color: COLORS.abroad, label: "Ausland" },
    ]);

    const top = data.reduce((a, b) => (b.vis > a.vis ? b : a));
    appendFact(
      "narrativeTimeline",
      "Die besucherstärkste Veranstaltung: " + top.name +
      (top.year != null ? " (" + top.year + ")" : "") +
      " mit " + fmtInt.format(top.vis) + " Besucher:innen."
    );
    setText(
      "subTimeline",
      fmtInt.format(data.length) + " Veranstaltungen mit Besucherangabe" +
      (hasArea ? " · Kreisgröße = Nettofläche" : "")
    );
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 4 — Top-Veranstaltungen (horizontale Balken)
   * ------------------------------------------------------------------ */

  function renderTop(events) {
    const container = document.getElementById("chartTop");
    const data = events
      .filter((d) => d.vis != null && d.vis > 0 && d.name)
      .sort((a, b) => b.vis - a.vis)
      .slice(0, 12);
    if (!data.length) { container.textContent = "Keine Besucherzahlen im Datensatz."; return; }

    const isMobile = container.clientWidth < 560;
    const w = container.clientWidth || 600;
    const rowH = isMobile ? 52 : 42;
    const margin = { top: 8, right: 70, bottom: 8, left: 8 };
    const h = data.length * rowH + margin.top + margin.bottom;
    const svg = svgIn(container, w, h);

    const x = d3.scaleLinear()
      .domain([0, d3.max(data, (d) => d.vis)])
      .range([0, w - margin.left - margin.right]);

    const row = svg.append("g")
      .selectAll("g")
      .data(data)
      .join("g")
      .attr("transform", (d, i) => "translate(" + margin.left + "," + (margin.top + i * rowH) + ")");

    const barH = isMobile ? 18 : 22;
    const barY = isMobile ? 24 : 14;

    row.append("rect")
      .attr("y", barY)
      .attr("height", barH)
      .attr("width", (d) => Math.max(2, x(d.vis)))
      .attr("rx", barH / 2)
      .attr("fill", (d) => (d.isDE ? COLORS.de : COLORS.abroad))
      .attr("fill-opacity", 0.85)
      .call(bindTooltip, eventTooltipHtml);

    row.append("text")
      .attr("x", 2)
      .attr("y", isMobile ? 16 : barY - 4)
      .attr("font-size", isMobile ? 12 : 12.5)
      .attr("font-weight", 600)
      .attr("fill", "#14213d")
      .text((d) =>
        truncate(d.name, isMobile ? 26 : 40) +
        (d.year != null ? "  ·  " + d.year : "") +
        (d.city ? "  ·  " + truncate(d.city, 16) : "")
      );

    row.append("text")
      .attr("x", (d) => Math.max(2, x(d.vis)) + 8)
      .attr("y", barY + barH / 2 + 4)
      .attr("font-size", 11.5)
      .attr("font-weight", 700)
      .attr("fill", "#4a5568")
      .text((d) => fmtCompact(d.vis));

    const total = d3.sum(events, (d) => d.vis || 0);
    const topShare = total ? d3.sum(data, (d) => d.vis) / total : 0;
    appendFact(
      "narrativeTop",
      "Die " + data.length + " größten Veranstaltungen vereinen " +
      fmtPct(topShare) + " aller dokumentierten Besuche auf sich."
    );
    setText("subTop", "Top " + data.length + " nach Besucher:innen · ab 2022");
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 5 — Auslandsanteile (Hanteldiagramm)
   * ------------------------------------------------------------------ */

  function renderIntl(events) {
    const container = document.getElementById("chartIntl");
    const data = events
      .filter((d) => d.isDE && d.exShare != null && d.visShare != null && d.vis > 0)
      .sort((a, b) => b.vis - a.vis)
      .slice(0, 10);
    if (data.length < 3) {
      container.textContent = "Zu wenige Veranstaltungen mit In-/Auslandsangaben.";
      return;
    }

    const isMobile = container.clientWidth < 560;
    const w = container.clientWidth || 600;
    const rowH = isMobile ? 56 : 46;
    const margin = { top: 26, right: 18, bottom: 8, left: 18 };
    const h = data.length * rowH + margin.top + margin.bottom;
    const svg = svgIn(container, w, h);

    const x = d3.scaleLinear().domain([0, 1]).range([margin.left, w - margin.right]);

    // Prozent-Hilfslinien
    const gridTicks = [0, 0.25, 0.5, 0.75, 1];
    svg.append("g")
      .selectAll("line")
      .data(gridTicks)
      .join("line")
      .attr("class", "grid-line")
      .attr("x1", (t) => x(t)).attr("x2", (t) => x(t))
      .attr("y1", margin.top - 6).attr("y2", h - margin.bottom);
    svg.append("g")
      .selectAll("text")
      .data(gridTicks)
      .join("text")
      .attr("x", (t) => x(t))
      .attr("y", margin.top - 12)
      .attr("text-anchor", "middle")
      .attr("font-size", 10.5)
      .attr("fill", "#8a93a6")
      .text((t) => Math.round(t * 100) + " %");

    const row = svg.append("g")
      .selectAll("g")
      .data(data)
      .join("g")
      .attr("transform", (d, i) => "translate(0," + (margin.top + i * rowH) + ")");

    const dotY = isMobile ? 34 : 28;
    const dotR = isMobile ? 6 : 7;

    row.append("text")
      .attr("x", margin.left)
      .attr("y", isMobile ? 16 : 12)
      .attr("font-size", isMobile ? 12 : 12.5)
      .attr("font-weight", 600)
      .attr("fill", "#14213d")
      .text((d) => truncate(d.name, isMobile ? 30 : 48) + "  ·  " + d.year);

    row.append("line")
      .attr("x1", (d) => x(Math.min(d.exShare, d.visShare)))
      .attr("x2", (d) => x(Math.max(d.exShare, d.visShare)))
      .attr("y1", dotY).attr("y2", dotY)
      .attr("stroke", "#cdd5e0")
      .attr("stroke-width", 3)
      .attr("stroke-linecap", "round");

    row.append("circle")
      .attr("cx", (d) => x(d.exShare))
      .attr("cy", dotY).attr("r", dotR)
      .attr("fill", COLORS.exhibitors)
      .call(bindTooltip, (d) =>
        "<h4>" + escapeHtml(d.name) + " " + d.year + "</h4><table>" +
        "<tr><td>Aussteller aus dem Ausland</td><td>" + fmtPct(d.exShare) + "</td></tr>" +
        "<tr><td>Besucher:innen aus dem Ausland</td><td>" + fmtPct(d.visShare) + "</td></tr></table>"
      );

    row.append("circle")
      .attr("cx", (d) => x(d.visShare))
      .attr("cy", dotY).attr("r", dotR)
      .attr("fill", COLORS.visitors)
      .call(bindTooltip, (d) =>
        "<h4>" + escapeHtml(d.name) + " " + d.year + "</h4><table>" +
        "<tr><td>Aussteller aus dem Ausland</td><td>" + fmtPct(d.exShare) + "</td></tr>" +
        "<tr><td>Besucher:innen aus dem Ausland</td><td>" + fmtPct(d.visShare) + "</td></tr></table>"
      );

    renderLegend("legendIntl", [
      { color: COLORS.exhibitors, label: "Anteil Aussteller aus dem Ausland" },
      { color: COLORS.visitors, label: "Anteil Besucher:innen aus dem Ausland" },
    ]);

    const all = events.filter((d) => d.isDE && d.exShare != null && d.visShare != null);
    const meanEx = d3.mean(all, (d) => d.exShare);
    const meanVis = d3.mean(all, (d) => d.visShare);
    appendFact(
      "narrativeIntl",
      "Über alle deutschen Veranstaltungen mit Angaben kommen im Schnitt " +
      fmtPct(meanEx) + " der Aussteller, aber nur " + fmtPct(meanVis) +
      " der Besucher:innen aus dem Ausland."
    );
    setText("subIntl", "Die " + data.length + " besucherstärksten Veranstaltungen in Deutschland");
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 6 — Aussteller vs. Besucher nach Messetyp (log-log)
   * ------------------------------------------------------------------ */

  function renderScatter(events) {
    const container = document.getElementById("chartScatter");
    const data = events.filter(
      (d) => d.vis != null && d.vis > 0 && d.ex != null && d.ex > 0
    );
    if (data.length < 3) {
      container.textContent = "Zu wenige Datensätze mit Aussteller- und Besucherzahlen.";
      return;
    }

    const isMobile = container.clientWidth < 560;
    const { w, h } = chartSize(container, 0.7, 360, 520);
    const margin = { top: 16, right: 18, bottom: 44, left: isMobile ? 44 : 56 };
    const svg = svgIn(container, w, h);

    function padLog(ext) { return [ext[0] / 1.4, ext[1] * 1.4]; }
    const x = d3.scaleLog()
      .domain(padLog(d3.extent(data, (d) => d.ex)))
      .range([margin.left, w - margin.right]);
    const y = d3.scaleLog()
      .domain(padLog(d3.extent(data, (d) => d.vis)))
      .range([h - margin.bottom, margin.top]);

    const fmtTick = (v) => (v >= 1e6 ? v / 1e6 + " Mio." : v >= 1e3 ? v / 1e3 + "k" : v);

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(0," + (h - margin.bottom) + ")")
      .call(d3.axisBottom(x).ticks(isMobile ? 4 : 6, fmtTick).tickSizeOuter(0));
    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(" + margin.left + ",0)")
      .call(d3.axisLeft(y).ticks(isMobile ? 5 : 6, fmtTick)
        .tickSize(-(w - margin.left - margin.right)))
      .call((g) => g.selectAll(".tick line").attr("class", "grid-line"))
      .call((g) => g.select(".domain").remove());

    svg.append("text")
      .attr("x", (margin.left + w - margin.right) / 2)
      .attr("y", h - 8)
      .attr("text-anchor", "middle")
      .attr("font-size", 11).attr("fill", "#8a93a6")
      .text("Aussteller (log)");
    svg.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -(margin.top + h - margin.bottom) / 2)
      .attr("y", 14)
      .attr("text-anchor", "middle")
      .attr("font-size", 11).attr("fill", "#8a93a6")
      .text("Besucher:innen (log)");

    // Orientierungslinien: Besucher je Aussteller
    for (const ratio of [10, 100]) {
      const pts = [x.domain()[0], x.domain()[1]].map((ex) => [ex, ex * ratio]);
      const clipped = pts.map(([ex, vis]) => [
        x(ex),
        Math.max(margin.top, Math.min(h - margin.bottom,
          y(Math.max(y.domain()[0], Math.min(y.domain()[1], vis))))),
      ]);
      svg.append("line")
        .attr("x1", clipped[0][0]).attr("y1", clipped[0][1])
        .attr("x2", clipped[1][0]).attr("y2", clipped[1][1])
        .attr("stroke", "#cdd5e0").attr("stroke-dasharray", "3 5");
      svg.append("text")
        .attr("x", clipped[1][0] - 4)
        .attr("y", clipped[1][1] - 6)
        .attr("text-anchor", "end")
        .attr("font-size", 10).attr("fill", "#8a93a6")
        .text(ratio + " Besucher je Aussteller");
    }

    svg.append("g")
      .selectAll("circle")
      .data(data)
      .join("circle")
      .attr("cx", (d) => x(d.ex))
      .attr("cy", (d) => y(d.vis))
      .attr("r", isMobile ? 5 : 6)
      .attr("fill", (d) => COLORS[d.typ])
      .attr("fill-opacity", 0.6)
      .attr("stroke", (d) => COLORS[d.typ])
      .call(bindTooltip, eventTooltipHtml);

    const typsPresent = ["fach", "mixed", "privat", "unknown"].filter((t) =>
      data.some((d) => d.typ === t)
    );
    renderLegend(
      "legendScatter",
      typsPresent.map((t) => ({ color: COLORS[t], label: TYP_LABELS[t] }))
    );

    const medianRatio = (t) => {
      const arr = data.filter((d) => d.typ === t).map((d) => d.vis / d.ex);
      return arr.length ? d3.median(arr) : null;
    };
    const mFach = medianRatio("fach");
    const mPriv = medianRatio("privat") || medianRatio("mixed");
    if (mFach && mPriv) {
      appendFact(
        "narrativeScatter",
        "Auf reinen Fachmessen kommen im Median rund " + fmtInt.format(Math.round(mFach)) +
        " Besucher:innen auf einen Aussteller – auf Messen mit Privatpublikum etwa " +
        fmtInt.format(Math.round(mPriv)) + "."
      );
    }
    setText("subScatter", fmtInt.format(data.length) + " Veranstaltungen mit beiden Angaben · ab 2022");
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 7 — Branchenschwerpunkte
   * ------------------------------------------------------------------ */

  function renderBranchen(events) {
    const container = document.getElementById("chartBranchen");
    const counts = new Map();
    let assignments = 0;
    for (const ev of events) {
      for (const b of ev.branchen) {
        counts.set(b, (counts.get(b) || 0) + 1);
        assignments++;
      }
    }
    if (!counts.size) { container.textContent = "Keine Branchenangaben im Datensatz."; return; }

    const top = Array.from(counts, ([branche, n]) => ({ branche, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 10);

    const isMobile = container.clientWidth < 560;
    const w = container.clientWidth || 600;
    const rowH = isMobile ? 50 : 40;
    const margin = { top: 4, right: 44, bottom: 4, left: 8 };
    const h = top.length * rowH + margin.top + margin.bottom;
    const svg = svgIn(container, w, h);

    const x = d3.scaleLinear()
      .domain([0, d3.max(top, (d) => d.n)])
      .range([0, w - margin.left - margin.right]);

    const shade = d3.scaleLinear()
      .domain([0, top.length - 1])
      .range([1, 0.45]);

    const row = svg.append("g")
      .selectAll("g")
      .data(top)
      .join("g")
      .attr("transform", (d, i) => "translate(" + margin.left + "," + (margin.top + i * rowH) + ")");

    const barH = isMobile ? 15 : 18;
    const barY = isMobile ? 26 : 16;

    row.append("rect")
      .attr("y", barY)
      .attr("height", barH)
      .attr("width", (d) => Math.max(2, x(d.n)))
      .attr("rx", barH / 2)
      .attr("fill", COLORS.bar)
      .attr("fill-opacity", (d, i) => shade(i))
      .call(bindTooltip, (d) =>
        "<h4>" + escapeHtml(d.branche) + "</h4><table>" +
        "<tr><td>Veranstaltungen</td><td>" + d.n + "</td></tr></table>"
      );

    row.append("text")
      .attr("x", 2)
      .attr("y", isMobile ? 17 : barY - 4)
      .attr("font-size", isMobile ? 11.5 : 12.5)
      .attr("font-weight", 600)
      .attr("fill", "#14213d")
      .text((d) => truncate(d.branche, isMobile ? 42 : 70));

    row.append("text")
      .attr("x", (d) => Math.max(2, x(d.n)) + 8)
      .attr("y", barY + barH / 2 + 4)
      .attr("font-size", 11.5)
      .attr("font-weight", 700)
      .attr("fill", "#4a5568")
      .text((d) => d.n);

    appendFact(
      "narrativeBranchen",
      "An der Spitze: „" + top[0].branche + "“ mit " + top[0].n +
      " Veranstaltungen – geprägt von der bauma-Familie auf drei Kontinenten."
    );
    setText(
      "subBranchen",
      "Top 10 von " + counts.size + " Branchen · " + fmtInt.format(assignments) + " Zuordnungen"
    );
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 8 — Tabelle
   * ------------------------------------------------------------------ */

  function renderTable(events) {
    const columns = [
      { key: "name", label: "Veranstaltung", num: false },
      { key: "year", label: "Jahr", num: true },
      { key: "city", label: "Stadt", num: false },
      { key: "country", label: "Land", num: false },
      { key: "typLabel", label: "Messetyp", num: false },
      { key: "vis", label: "Besucher:innen", num: true },
      { key: "ex", label: "Aussteller", num: true },
      { key: "area", label: "Fläche (m²)", num: true },
    ];
    const rows = events.map((d) =>
      Object.assign({ typLabel: d.typRaw ? TYP_LABELS[d.typ] : "" }, d)
    );
    const visible = columns.filter((c) => rows.some((d) => d[c.key] != null && d[c.key] !== ""));

    const thead = document.querySelector("#dataTable thead");
    const tbody = document.querySelector("#dataTable tbody");
    const search = document.getElementById("tableSearch");
    const countEl = document.getElementById("tableCount");

    let sortKey = "vis";
    let sortDir = -1;
    if (!visible.some((c) => c.key === "vis")) {
      sortKey = visible[0].key;
      sortDir = 1;
    }

    function draw() {
      const q = (search.value || "").toLowerCase();
      let shown = rows.filter(
        (d) =>
          !q ||
          (d.name && d.name.toLowerCase().includes(q)) ||
          (d.long && d.long.toLowerCase().includes(q)) ||
          (d.city && d.city.toLowerCase().includes(q)) ||
          (d.country && d.country.toLowerCase().includes(q)) ||
          (d.year != null && String(d.year).includes(q))
      );
      shown = shown.slice().sort((a, b) => {
        const va = a[sortKey], vb = b[sortKey];
        if (va == null || va === "") return 1;
        if (vb == null || vb === "") return -1;
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * sortDir;
        return String(va).localeCompare(String(vb), "de") * sortDir;
      });

      thead.innerHTML =
        "<tr>" +
        visible.map((c) =>
          "<th data-key=\"" + c.key + "\">" + c.label +
          (c.key === sortKey
            ? '<span class="sort-ind">' + (sortDir > 0 ? "▲" : "▼") + "</span>"
            : "") +
          "</th>"
        ).join("") +
        "</tr>";

      tbody.innerHTML = shown.map((d) =>
        "<tr>" +
        visible.map((c) => {
          const v = d[c.key];
          if (v == null || v === "") return '<td class="' + (c.num ? "num" : "") + '">–</td>';
          const text = c.num && typeof v === "number" && c.key !== "year"
            ? fmtInt.format(v)
            : escapeHtml(String(v));
          return '<td class="' + (c.num ? "num" : "") + '">' + text + "</td>";
        }).join("") +
        "</tr>"
      ).join("");

      countEl.textContent =
        fmtInt.format(shown.length) + " von " + fmtInt.format(rows.length) + " Veranstaltungen";

      thead.querySelectorAll("th").forEach((th) => {
        th.addEventListener("click", () => {
          const key = th.dataset.key;
          if (key === sortKey) sortDir *= -1;
          else {
            sortKey = key;
            sortDir = visible.find((c) => c.key === key).num ? -1 : 1;
          }
          draw();
        });
      });
    }

    search.addEventListener("input", draw);
    draw();
  }

  /* ------------------------------------------------------------------ *
   *  KPIs
   * ------------------------------------------------------------------ */

  function animateKpi(el, target, format) {
    if (target == null) { el.textContent = "–"; return; }
    const dur = 1300;
    const start = performance.now();
    const ease = d3.easeCubicOut;
    function tick(now) {
      const t = Math.min(1, (now - start) / dur);
      el.textContent = format(target * ease(t));
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = format(target);
    }
    requestAnimationFrame(tick);
  }

  function renderKpis(events) {
    const visitors = d3.sum(events, (d) => d.vis || 0);
    const exhibitors = d3.sum(events, (d) => d.ex || 0);
    const cities = new Set(events.filter((d) => d.city).map((d) => d.city + "|" + d.country)).size;
    const kpis = {
      events: [events.length, (v) => fmtInt.format(Math.round(v))],
      cities: [cities || null, (v) => fmtInt.format(Math.round(v))],
      visitors: [visitors > 0 ? visitors : null, (v) => fmtCompact(v)],
      exhibitors: [exhibitors > 0 ? exhibitors : null, (v) => fmtCompact(v)],
    };
    document.querySelectorAll("[data-kpi]").forEach((el) => {
      const [target, format] = kpis[el.dataset.kpi] || [null, fmtInt.format];
      animateKpi(el, target, format);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Metadaten (Lizenz, Stand) — best effort
   * ------------------------------------------------------------------ */

  async function loadMetadata() {
    try {
      let pkg = DISCOVERED_PKG; // bereits beim Laden per package_show geholt
      if (!pkg) {
        for (const root of API_ROOTS) {
          try {
            const json = await fetchJson(root + "/package_show?id=" + DATASET_ID);
            if (json && json.success && json.result) { pkg = json.result; break; }
          } catch (e) {
            /* nächste Wurzel */
          }
        }
      }
      if (!pkg) return;
      if (pkg.license_title || pkg.license_id) {
        const licenseEl = document.getElementById("licenseInfo");
        const name = escapeHtml(pkg.license_title || pkg.license_id);
        const url = pkg.license_url
          ? ' (<a href="' + escapeHtml(pkg.license_url) + '" rel="noopener">Lizenztext</a>)'
          : "";
        licenseEl.innerHTML = "Lizenz: <strong>" + name + "</strong>" + url +
          ' · Quelle: <a href="' + DATASET_PAGE + '" rel="noopener">Datensatzseite</a>';
      }
      const modified = pkg.metadata_modified || pkg.metadata_created;
      if (modified) {
        const d = new Date(modified);
        if (!isNaN(+d)) {
          setText(
            "freshnessInfo",
            "Metadaten zuletzt aktualisiert am " +
            d.toLocaleDateString("de-DE", { year: "numeric", month: "long", day: "numeric" }) + "."
          );
        }
      }
    } catch (e) {
      /* Metadaten sind optional – statischer Fallback steht im HTML */
    }
  }

  /* ------------------------------------------------------------------ *
   *  Scroll-Reveal
   * ------------------------------------------------------------------ */

  function setupReveal() {
    const els = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("visible"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------------------------ *
   *  Bootstrap
   * ------------------------------------------------------------------ */

  let EVENTS = null;

  function renderAllCharts() {
    if (!EVENTS) return;
    renderYears(EVENTS);
    renderCities(EVENTS);
    renderTimeline(EVENTS);
    renderTop(EVENTS);
    renderIntl(EVENTS);
    renderScatter(EVENTS);
    renderBranchen(EVENTS);
  }

  function setupResize() {
    let raf = null;
    let lastW = window.innerWidth;
    window.addEventListener("resize", () => {
      if (window.innerWidth === lastW) return; // mobile Adressleiste ignorieren
      lastW = window.innerWidth;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTimeout(renderAllCharts, 120));
    });

    // Charts neu zeichnen, wenn sich die Containerbreite nachträglich ändert
    // (z. B. wenn Layout/Fonts auf Mobilgeräten erst nach dem ersten Rendern
    // fertig sind oder das Gerät gedreht wird). Nur Breitenänderungen lösen
    // aus, damit das Neuzeichnen selbst keine Schleife erzeugt.
    if ("ResizeObserver" in window) {
      const widths = new Map();
      let pending = null;
      const containers = document.querySelectorAll(".chart");
      containers.forEach((c) =>
        widths.set(c, Math.round(c.getBoundingClientRect().width))
      );
      const ro = new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const w = Math.round(e.contentRect.width);
          if (widths.get(e.target) !== w) {
            widths.set(e.target, w);
            changed = true;
          }
        }
        if (changed) {
          clearTimeout(pending);
          pending = setTimeout(renderAllCharts, 150);
        }
      });
      containers.forEach((c) => ro.observe(c));
    }
  }

  async function main() {
    setupReveal();
    const statusEl = document.getElementById("dataStatus");

    try {
      const { rows, cols, origin, via } = await loadData();
      EVENTS = buildEvents(rows, cols);
      if (!EVENTS.length) throw new Error("Datensatz ist leer");

      statusEl.textContent =
        (origin === "live"
          ? "Live-Daten geladen (" + via + ")"
          : "Daten-Snapshot aus diesem Repository geladen") +
        " · " + fmtInt.format(EVENTS.length) + " Veranstaltungen";
      statusEl.classList.add(origin === "live" ? "ok" : "warn");

      renderKpis(EVENTS);
      renderAllCharts();
      renderTable(EVENTS);
      setupResize();
      loadMetadata();
    } catch (err) {
      statusEl.textContent = "Daten konnten nicht geladen werden.";
      statusEl.classList.add("warn");
      document.getElementById("storyRoot").hidden = true;
      const panel = document.getElementById("errorPanel");
      panel.hidden = false;
      document.getElementById("errorDetail").textContent = (err.attempts || [err.message]).join(" · ");
    }
  }

  main();
})();
