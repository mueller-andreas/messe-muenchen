/* ==========================================================================
   Die Messe München in Zahlen
   --------------------------------------------------------------------------
   Lädt die offenen Daten "Bisherige Veranstaltungen der Messe München"
   (Open Data Portal München) direkt im Browser und rendert daraus eine
   interaktive Datengeschichte mit D3.js.

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
  const RESOURCE_ID = "b698829c-b051-4092-a276-9ba1afdc12f3";
  const CSV_URL =
    "https://opendata.muenchen.de/dataset/ef068a1c-315c-4262-8cf1-903767831225/resource/" +
    RESOURCE_ID +
    "/download/veranstaltungsdaten.csv";
  const DATASTORE_URL =
    "https://opendata.muenchen.de/api/3/action/datastore_search?resource_id=" +
    RESOURCE_ID +
    "&limit=32000";
  const PACKAGE_URL =
    "https://opendata.muenchen.de/api/3/action/package_show?id=veranstaltungen-der-messe-muenchen";
  const LOCAL_SNAPSHOT = "data/veranstaltungsdaten.csv";
  // Letzter Ausweg, falls das Portal keine CORS-Header liefert:
  const PROXY_CSV_URL =
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(CSV_URL);

  const COLORS = {
    munich: "#0a6ebd",
    other: "#16a3a3",
    single: "#0a6ebd",
    bar: "#0a6ebd",
    barSoft: "#9cc8e8",
    warm: "#e8643c",
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

  /* ------------------------------------------------------------------ *
   *  Robustes Parsen (deutsche Zahlen-/Datumsformate, Encoding, Delimiter)
   * ------------------------------------------------------------------ */

  function parseNumber(v) {
    if (v == null) return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    let s = String(v).trim();
    if (!s || /^(k\.?\s?a\.?|n\/?\s?a|-+|–|\.|x)$/i.test(s)) return null;
    s = s.replace(/[^\d,.\-]/g, "");
    if (!s || s === "-" ) return null;
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      // deutsches Format: 1.234.567,8
      s = s.replace(/\./g, "").replace(",", ".");
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
   *  Spaltenerkennung — der Datensatz definiert die exakten Spaltennamen,
   *  daher werden sie hier tolerant über Schlüsselwörter zugeordnet.
   * ------------------------------------------------------------------ */

  const FIELD_SPECS = [
    { key: "year", patterns: [/^jahr\b/, /\bjahr$/, /^year/] },
    { key: "start", patterns: [/beginn/, /\bstart\b/, /^von$/, /^datum vo/, /^anfang/, /^datum$/] },
    { key: "end", patterns: [/ende/, /^bis$/, /^datum bis/] },
    { key: "visitors", patterns: [/besucher/] },
    { key: "exhibitors", patterns: [/aussteller(?!.*flaeche)/] },
    { key: "area", patterns: [/flaeche/, /vermietet/, /\bqm\b/, /\bm2\b/] },
    { key: "city", patterns: [/veranstaltungsort/, /^ort\b/, /\bstadt\b/, /standort/, /^city/] },
    { key: "country", patterns: [/^land$/, /\bland\b/, /country/, /staat/] },
    { key: "type", patterns: [/veranstaltungsart/, /veranstaltungstyp/, /^art\b/, /^typ\b/, /kategorie/, /turnus/] },
    { key: "organizer", patterns: [/veranstalter/, /eigenveranstaltung/, /gastveranstaltung/] },
    {
      key: "name",
      patterns: [
        /veranstaltungstitel/, /veranstaltungsname/, /titel/, /bezeichnung/,
        /^veranstaltung(en)?$/, /^name\b/, /\bmesse\b/, /event/,
      ],
    },
  ];

  function detectColumns(headers, sampleRows) {
    const map = {};
    const used = new Set(["_id"]);
    const norm = headers.map(normalizeHeader);

    for (const spec of FIELD_SPECS) {
      for (const pattern of spec.patterns) {
        const idx = headers.findIndex(
          (h, i) => !used.has(h) && pattern.test(norm[i])
        );
        if (idx >= 0) {
          map[spec.key] = headers[idx];
          used.add(headers[idx]);
          break;
        }
      }
    }

    // Fallback für den Veranstaltungsnamen: erste übrige Textspalte
    if (!map.name) {
      const candidate = headers.find((h) => {
        if (used.has(h)) return false;
        const vals = sampleRows.map((r) => r[h]).filter((v) => v != null && v !== "");
        if (!vals.length) return false;
        const numeric = vals.filter((v) => parseNumber(v) != null).length;
        return numeric / vals.length < 0.5;
      });
      if (candidate) map.name = candidate;
    }
    return map;
  }

  /* ------------------------------------------------------------------ *
   *  Datenmodell
   * ------------------------------------------------------------------ */

  function buildEvents(rows, cols) {
    const events = [];
    for (const r of rows) {
      const start = cols.start ? parseDate(r[cols.start]) : null;
      const end = cols.end ? parseDate(r[cols.end]) : null;
      let year = cols.year ? parseNumber(r[cols.year]) : null;
      if (year != null && (year < 1900 || year > 2100)) year = null;
      if (year == null && start) year = start.getFullYear();
      if (year == null && cols.year && r[cols.year]) {
        const m = String(r[cols.year]).match(/(19|20)\d{2}/);
        if (m) year = +m[0];
      }

      const cityRaw = cols.city ? String(r[cols.city] || "").trim() : "";
      const countryRaw = cols.country ? String(r[cols.country] || "").trim() : "";
      const place = [cityRaw, countryRaw].filter(Boolean).join(", ");

      let group = null;
      const probe = normalizeHeader(cityRaw + " " + countryRaw);
      if (cityRaw || countryRaw) {
        group =
          /muenchen|munich|riem|\bicm\b|\bmoc\b/.test(probe) ||
          (!cityRaw && /deutschland|germany/.test(probe))
            ? "munich"
            : "other";
      }

      const ev = {
        name: cols.name ? String(r[cols.name] || "").trim() : "",
        year: year,
        start: start,
        end: end,
        place: place,
        group: group,
        visitors: cols.visitors ? parseNumber(r[cols.visitors]) : null,
        exhibitors: cols.exhibitors ? parseNumber(r[cols.exhibitors]) : null,
        area: cols.area ? parseNumber(r[cols.area]) : null,
        type: cols.type ? String(r[cols.type] || "").trim() : "",
        organizer: cols.organizer ? String(r[cols.organizer] || "").trim() : "",
      };
      if (!ev.name && ev.year == null && ev.visitors == null) continue; // Leerzeile
      events.push(ev);
    }
    return events;
  }

  /* ------------------------------------------------------------------ *
   *  Laden mit Fallback-Kette:
   *  1) CKAN-Datastore-API (JSON)   2) Original-CSV
   *  3) lokaler Snapshot im Repo    4) CORS-Proxy auf die Original-CSV
   * ------------------------------------------------------------------ */

  async function fetchJson(url) {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " für " + url);
    return resp.json();
  }

  async function fetchCsvRows(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status + " für " + url);
    return parseCsv(await resp.arrayBuffer());
  }

  async function loadData() {
    const attempts = [];

    // 1) Datastore-API
    try {
      const json = await fetchJson(DATASTORE_URL);
      const records = json && json.result && json.result.records;
      if (json.success && records && records.length) {
        const headers = json.result.fields
          ? json.result.fields.map((f) => f.id)
          : Object.keys(records[0]);
        return { rows: records, headers, origin: "live", via: "Datastore-API" };
      }
      attempts.push("Datastore-API: keine Datensätze");
    } catch (e) {
      attempts.push("Datastore-API: " + e.message);
    }

    // 2) Original-CSV
    try {
      const rows = await fetchCsvRows(CSV_URL);
      return { rows, headers: rows.columns, origin: "live", via: "CSV-Download" };
    } catch (e) {
      attempts.push("CSV: " + e.message);
    }

    // 3) lokaler Snapshot
    try {
      const rows = await fetchCsvRows(LOCAL_SNAPSHOT);
      return { rows, headers: rows.columns, origin: "snapshot", via: "lokaler Snapshot" };
    } catch (e) {
      attempts.push("Snapshot: " + e.message);
    }

    // 4) CORS-Proxy
    try {
      const rows = await fetchCsvRows(PROXY_CSV_URL);
      return { rows, headers: rows.columns, origin: "live", via: "CSV via Proxy" };
    } catch (e) {
      attempts.push("Proxy: " + e.message);
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

  function eventTooltipHtml(d) {
    const rows = [];
    if (d.year != null) rows.push(["Jahr", d.year]);
    if (d.place) rows.push(["Ort", d.place]);
    if (d.type) rows.push(["Art", d.type]);
    if (d.visitors != null) rows.push(["Besucher:innen", fmtInt.format(d.visitors)]);
    if (d.exhibitors != null) rows.push(["Aussteller", fmtInt.format(d.exhibitors)]);
    if (d.area != null) rows.push(["Fläche", fmtInt.format(d.area) + " m²"]);
    return (
      "<h4>" + escapeHtml(d.name || "Veranstaltung") + "</h4><table>" +
      rows.map((r) => "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>").join("") +
      "</table>"
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
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

  function groupColor(g) {
    if (g === "munich") return COLORS.munich;
    if (g === "other") return COLORS.other;
    return COLORS.single;
  }

  function groupLabel(g) {
    if (g === "munich") return "München";
    if (g === "other") return "Andere Standorte";
    return "Alle Veranstaltungen";
  }

  function renderLegend(containerId, groups) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = groups
      .map(
        (g) =>
          '<span class="legend-item"><span class="legend-swatch" style="background:' +
          groupColor(g) + '"></span>' + groupLabel(g) + "</span>"
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

  /* ------------------------------------------------------------------ *
   *  Kapitel 1 — Veranstaltungen pro Jahr (gestapelte Balken)
   * ------------------------------------------------------------------ */

  function renderYears(events) {
    const container = document.getElementById("chartYears");
    const withYear = events.filter((d) => d.year != null);
    if (!withYear.length) { container.textContent = "Keine Jahresangaben im Datensatz."; return; }

    const hasGroups = withYear.some((d) => d.group != null);
    const groups = hasGroups ? ["munich", "other"] : ["all"];
    const years = d3.sort(Array.from(new Set(withYear.map((d) => d.year))));

    const counts = years.map((y) => {
      const row = { year: y };
      for (const g of groups) {
        row[g] = withYear.filter(
          (d) => d.year === y && (hasGroups ? (d.group || "other") === g : true)
        ).length;
      }
      return row;
    });

    const isMobile = container.clientWidth < 560;
    const { w, h } = chartSize(container, 0.52, 300, 430);
    const margin = { top: 24, right: 12, bottom: 34, left: 40 };
    const svg = svgIn(container, w, h);

    const x = d3.scaleBand().domain(years).range([margin.left, w - margin.right]).padding(0.25);
    const maxTotal = d3.max(counts, (r) => d3.sum(groups, (g) => r[g])) || 1;
    const y = d3.scaleLinear().domain([0, maxTotal]).nice().range([h - margin.bottom, margin.top]);

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(0," + (h - margin.bottom) + ")")
      .call(d3.axisBottom(x).tickValues(
        isMobile ? years.filter((d, i) => i % 2 === 0) : years
      ).tickSizeOuter(0));

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
      .attr("fill", (s) => (hasGroups ? groupColor(s.key) : COLORS.bar))
      .selectAll("rect")
      .data((s) => s.map((seg) => Object.assign(seg, { key: s.key })))
      .join("rect")
      .attr("x", (seg) => x(seg.data.year))
      .attr("width", x.bandwidth())
      .attr("y", (seg) => y(seg[1]))
      .attr("height", (seg) => Math.max(0, y(seg[0]) - y(seg[1])))
      .attr("rx", 3)
      .call(bindTooltip, (seg) => {
        const total = d3.sum(groups, (g) => seg.data[g]);
        return (
          "<h4>" + seg.data.year + "</h4><table>" +
          (hasGroups
            ? "<tr><td>" + groupLabel(seg.key) + "</td><td>" + (seg[1] - seg[0]) + "</td></tr>"
            : "") +
          "<tr><td>Gesamt</td><td>" + total + " Veranstaltungen</td></tr></table>"
        );
      });

    // Summen über den Balken
    svg.append("g")
      .selectAll("text")
      .data(counts)
      .join("text")
      .attr("x", (r) => x(r.year) + x.bandwidth() / 2)
      .attr("y", (r) => y(d3.sum(groups, (g) => r[g])) - 6)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("font-weight", 700)
      .attr("fill", "#4a5568")
      .text((r) => d3.sum(groups, (g) => r[g]));

    if (hasGroups) renderLegend("legendYears", groups);

    // Erzählerischer Zusatz
    const totals = counts.map((r) => ({ year: r.year, n: d3.sum(groups, (g) => r[g]) }));
    const best = totals.reduce((a, b) => (b.n > a.n ? b : a));
    const worst = totals.reduce((a, b) => (b.n < a.n ? b : a));
    appendFact(
      "narrativeYears",
      "Das stärkste Jahr im Datensatz ist " + best.year + " mit " + best.n +
      " Veranstaltungen, das schwächste " + worst.year + " mit " + worst.n + "."
    );
    setText("subYears", years[0] + "–" + years[years.length - 1] + (hasGroups ? " · nach Standort" : ""));
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 2 — Timeline-Bubbles
   * ------------------------------------------------------------------ */

  function renderTimeline(events) {
    const container = document.getElementById("chartTimeline");
    let data = events.filter((d) => d.visitors != null && d.visitors > 0);
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
      .domain([0, d3.max(data, (d) => d.visitors)]).nice()
      .range([h - margin.bottom, margin.top]);

    const hasArea = data.some((d) => d.area != null && d.area > 0);
    const r = hasArea
      ? d3.scaleSqrt().domain([0, d3.max(data, (d) => d.area || 0)]).range([3, isMobile ? 16 : 24])
      : () => (isMobile ? 5 : 6);

    // Pandemie-Band
    if (useDates) {
      const bandStart = new Date(2020, 2, 11);
      const bandEnd = new Date(2022, 3, 3);
      const [d0, d1] = x.domain();
      if (bandStart < d1 && bandEnd > d0) {
        const x0 = x(d3.max([bandStart, d0]));
        const x1 = x(d3.min([bandEnd, d1]));
        svg.append("rect")
          .attr("class", "annotation-band")
          .attr("x", x0).attr("width", Math.max(0, x1 - x0))
          .attr("y", margin.top).attr("height", h - margin.top - margin.bottom);
        svg.append("text")
          .attr("class", "annotation-label")
          .attr("x", (x0 + x1) / 2)
          .attr("y", margin.top + 14)
          .attr("text-anchor", "middle")
          .text("Corona-Pandemie");
      }
    }

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
      .attr("cx", (d) =>
        useDates ? x(d.start) : x(d.year) + (jitter() - 0.5) * 18
      )
      .attr("cy", (d) => y(d.visitors))
      .attr("r", (d) => (hasArea ? r(d.area || 0) : r()))
      .attr("fill", (d) => groupColor(d.group))
      .attr("fill-opacity", 0.55)
      .attr("stroke", (d) => groupColor(d.group))
      .attr("stroke-width", 1)
      .call(bindTooltip, eventTooltipHtml);

    const groups = Array.from(new Set(data.map((d) => d.group).filter((g) => g != null)));
    if (groups.length > 1) renderLegend("legendTimeline", ["munich", "other"]);

    const top = data.reduce((a, b) => (b.visitors > a.visitors ? b : a));
    appendFact(
      "narrativeTimeline",
      "Die besucherstärkste Einzelveranstaltung: " + top.name +
      (top.year != null ? " (" + top.year + ")" : "") +
      " mit " + fmtInt.format(top.visitors) + " Besucher:innen."
    );
    setText(
      "subTimeline",
      fmtInt.format(data.length) + " Veranstaltungen mit Besucherangabe" +
      (hasArea ? " · Kreisgröße = vermietete Fläche" : "")
    );
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 3 — Top-Veranstaltungen (horizontale Balken)
   * ------------------------------------------------------------------ */

  function renderTop(events) {
    const container = document.getElementById("chartTop");
    const data = events
      .filter((d) => d.visitors != null && d.visitors > 0 && d.name)
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, 12);
    if (!data.length) { container.textContent = "Keine Besucherzahlen im Datensatz."; return; }

    const isMobile = container.clientWidth < 560;
    const w = container.clientWidth || 600;
    const rowH = isMobile ? 52 : 42;
    const margin = { top: 8, right: 70, bottom: 8, left: 8 };
    const h = data.length * rowH + margin.top + margin.bottom;
    const svg = svgIn(container, w, h);

    const x = d3.scaleLinear()
      .domain([0, d3.max(data, (d) => d.visitors)])
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
      .attr("width", (d) => Math.max(2, x(d.visitors)))
      .attr("rx", barH / 2)
      .attr("fill", (d) => groupColor(d.group))
      .attr("fill-opacity", 0.85)
      .call(bindTooltip, eventTooltipHtml);

    row.append("text")
      .attr("x", 2)
      .attr("y", isMobile ? 16 : barY - 4)
      .attr("font-size", isMobile ? 12 : 12.5)
      .attr("font-weight", 600)
      .attr("fill", "#14213d")
      .text((d) =>
        truncate(d.name, isMobile ? 34 : 56) +
        (d.year != null ? "  ·  " + d.year : "")
      );

    row.append("text")
      .attr("x", (d) => Math.max(2, x(d.visitors)) + 8)
      .attr("y", barY + barH / 2 + 4)
      .attr("font-size", 11.5)
      .attr("font-weight", 700)
      .attr("fill", "#4a5568")
      .text((d) => fmtCompact(d.visitors));

    const total = d3.sum(events, (d) => d.visitors || 0);
    const topShare = total ? d3.sum(data, (d) => d.visitors) / total : 0;
    appendFact(
      "narrativeTop",
      "Die " + data.length + " größten Veranstaltungen vereinen " +
      fmt1.format(topShare * 100) + " % aller dokumentierten Besuche auf sich."
    );
    setText("subTop", "Top " + data.length + " nach Besucher:innen");
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 4 — Aussteller vs. Besucher (log-log)
   * ------------------------------------------------------------------ */

  function renderScatter(events) {
    const container = document.getElementById("chartScatter");
    const data = events.filter(
      (d) => d.visitors != null && d.visitors > 0 && d.exhibitors != null && d.exhibitors > 0
    );
    if (data.length < 3) {
      container.textContent = "Zu wenige Datensätze mit Aussteller- und Besucherzahlen.";
      return;
    }

    const isMobile = container.clientWidth < 560;
    const { w, h } = chartSize(container, 0.7, 360, 520);
    const margin = { top: 16, right: 18, bottom: 44, left: isMobile ? 44 : 56 };
    const svg = svgIn(container, w, h);

    const x = d3.scaleLog()
      .domain(padLog(d3.extent(data, (d) => d.exhibitors)))
      .range([margin.left, w - margin.right]);
    const y = d3.scaleLog()
      .domain(padLog(d3.extent(data, (d) => d.visitors)))
      .range([h - margin.bottom, margin.top]);

    function padLog(ext) { return [ext[0] / 1.4, ext[1] * 1.4]; }

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

    // Achsentitel
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
      const pts = [];
      for (const ex of [x.domain()[0], x.domain()[1]]) {
        pts.push([ex, ex * ratio]);
      }
      const clipped = pts.map(([ex, vis]) => [
        x(ex),
        Math.max(margin.top, Math.min(h - margin.bottom, y(Math.max(y.domain()[0], Math.min(y.domain()[1], vis))))),
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
      .attr("cx", (d) => x(d.exhibitors))
      .attr("cy", (d) => y(d.visitors))
      .attr("r", isMobile ? 5 : 6)
      .attr("fill", (d) => groupColor(d.group))
      .attr("fill-opacity", 0.55)
      .attr("stroke", (d) => groupColor(d.group))
      .call(bindTooltip, eventTooltipHtml);

    const groups = Array.from(new Set(data.map((d) => d.group).filter((g) => g != null)));
    if (groups.length > 1) renderLegend("legendScatter", ["munich", "other"]);

    // Pearson-Korrelation auf log-Werten
    const lx = data.map((d) => Math.log10(d.exhibitors));
    const ly = data.map((d) => Math.log10(d.visitors));
    const mx = d3.mean(lx), my = d3.mean(ly);
    const num = d3.sum(lx.map((v, i) => (v - mx) * (ly[i] - my)));
    const den = Math.sqrt(d3.sum(lx.map((v) => (v - mx) ** 2)) * d3.sum(ly.map((v) => (v - my) ** 2)));
    const rPearson = den ? num / den : 0;
    appendFact(
      "narrativeScatter",
      "Der Zusammenhang ist deutlich: Die Korrelation (log-skaliert) beträgt r = " +
      fmt1.format(rPearson).replace(".", ",") + "."
    );
    setText("subScatter", fmtInt.format(data.length) + " Veranstaltungen mit beiden Angaben");
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 5 — Tabelle
   * ------------------------------------------------------------------ */

  function renderTable(events) {
    const columns = [
      { key: "name", label: "Veranstaltung", num: false },
      { key: "year", label: "Jahr", num: true },
      { key: "place", label: "Ort", num: false },
      { key: "type", label: "Art", num: false },
      { key: "visitors", label: "Besucher:innen", num: true },
      { key: "exhibitors", label: "Aussteller", num: true },
      { key: "area", label: "Fläche (m²)", num: true },
    ].filter((c) => events.some((d) => d[c.key] != null && d[c.key] !== ""));

    const thead = document.querySelector("#dataTable thead");
    const tbody = document.querySelector("#dataTable tbody");
    const search = document.getElementById("tableSearch");
    const countEl = document.getElementById("tableCount");

    let sortKey = "visitors";
    let sortDir = -1;
    if (!columns.some((c) => c.key === "visitors")) {
      sortKey = columns[0].key;
      sortDir = 1;
    }

    function draw() {
      const q = (search.value || "").toLowerCase();
      let rows = events.filter(
        (d) =>
          !q ||
          (d.name && d.name.toLowerCase().includes(q)) ||
          (d.place && d.place.toLowerCase().includes(q)) ||
          (d.type && d.type.toLowerCase().includes(q)) ||
          (d.year != null && String(d.year).includes(q))
      );
      rows = rows.slice().sort((a, b) => {
        const va = a[sortKey], vb = b[sortKey];
        if (va == null || va === "") return 1;
        if (vb == null || vb === "") return -1;
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * sortDir;
        return String(va).localeCompare(String(vb), "de") * sortDir;
      });

      thead.innerHTML =
        "<tr>" +
        columns.map((c) =>
          "<th data-key=\"" + c.key + "\">" + c.label +
          (c.key === sortKey
            ? '<span class="sort-ind">' + (sortDir > 0 ? "▲" : "▼") + "</span>"
            : "") +
          "</th>"
        ).join("") +
        "</tr>";

      tbody.innerHTML = rows.map((d) =>
        "<tr>" +
        columns.map((c) => {
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
        fmtInt.format(rows.length) + " von " + fmtInt.format(events.length) + " Veranstaltungen";

      thead.querySelectorAll("th").forEach((th) => {
        th.addEventListener("click", () => {
          const key = th.dataset.key;
          if (key === sortKey) sortDir *= -1;
          else {
            sortKey = key;
            sortDir = columns.find((c) => c.key === key).num ? -1 : 1;
          }
          draw();
        });
      });
    }

    search.addEventListener("input", draw);
    draw();
  }

  /* ------------------------------------------------------------------ *
   *  KPIs & erzählerische Bausteine
   * ------------------------------------------------------------------ */

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
    const visitors = d3.sum(events, (d) => d.visitors || 0);
    const exhibitors = d3.sum(events, (d) => d.exhibitors || 0);
    const years = Array.from(new Set(events.map((d) => d.year).filter((y) => y != null)));
    const kpis = {
      events: [events.length, (v) => fmtInt.format(Math.round(v))],
      visitors: [visitors > 0 ? visitors : null, (v) => fmtCompact(v)],
      exhibitors: [exhibitors > 0 ? exhibitors : null, (v) => fmtCompact(v)],
      years: [years.length || null, (v) => fmtInt.format(Math.round(v))],
    };
    document.querySelectorAll("[data-kpi]").forEach((el) => {
      const [target, format] = kpis[el.dataset.kpi] || [null, fmtInt.format];
      animateKpi(el, target, format);
    });
    if (years.length) {
      const el = document.querySelector('[data-kpi="years"]');
      const range = d3.min(years) + "–" + d3.max(years);
      setTimeout(() => {
        el.innerHTML = fmtInt.format(years.length) + " <small>(" + range + ")</small>";
      }, 1400);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Metadaten (Lizenz, Stand) — best effort
   * ------------------------------------------------------------------ */

  async function loadMetadata() {
    try {
      const json = await fetchJson(PACKAGE_URL);
      if (!json.success || !json.result) return;
      const pkg = json.result;
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
    renderTimeline(EVENTS);
    renderTop(EVENTS);
    renderScatter(EVENTS);
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
  }

  async function main() {
    setupReveal();
    const statusEl = document.getElementById("dataStatus");

    try {
      const { rows, headers, origin, via } = await loadData();
      const cols = detectColumns(
        headers.filter((hh) => hh !== "_id"),
        rows.slice(0, 50)
      );
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
