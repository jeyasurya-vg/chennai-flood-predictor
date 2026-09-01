const BAND_COLORS = {
  low: "#2E7D5B",
  moderate: "#B8901F",
  high: "#B5541C",
  severe: "#A5322A",
};

const REPORT_COOLDOWN_MS = 15 * 60 * 1000;

// Bounded, documented citizen-feedback adjustment (see methodology.html).
// Deliberately not a learned weight: fixed point delta, only applied once
// enough independent reports exist to outrank noise/gaming from a single
// device.
const MIN_REPORTS_FOR_ADJUSTMENT = 3;
const FEEDBACK_ADJUSTMENT_POINTS = 10;

let wardsData = [];
let reportSummaryByWard = {};
let currentCityId = "chennai";
let currentLangId = "en";
let cityManifest = [];
let langManifest = [];
let translations = {};
let mapInstance = null;
let lastMapCenter = { lat: 13.02, lon: 80.2 };
let lastMapZoom = 11;
let lastCityName = null;
let lastGeneratedAt = null;
let siteConfig = {};
let supabaseClient = null;
let presenceChannel = null;

// ---------- i18n ---------------------------------------------------------

function t(key, vars) {
  let str = translations[key];
  if (str === undefined) str = key;
  if (vars) {
    Object.keys(vars).forEach((k) => { str = str.replace(`{${k}}`, vars[k]); });
  }
  return str;
}

async function loadLangManifest() {
  try {
    const res = await fetch("assets/i18n/index.json", { cache: "no-store" });
    if (!res.ok) throw new Error("no lang manifest");
    const list = await res.json();
    if (Array.isArray(list) && list.length) return list;
    throw new Error("empty");
  } catch (err) {
    return [{ code: "en", name: "English" }];
  }
}

async function loadTranslations(langCode) {
  try {
    const res = await fetch(`assets/i18n/${langCode}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error("missing lang file");
    return await res.json();
  } catch (err) {
    return null;
  }
}

function pickInitialLanguage(manifest) {
  const saved = localStorage.getItem("flood_lang");
  if (saved && manifest.some((l) => l.code === saved)) return saved;
  const nav = (navigator.language || "en").toLowerCase().split("-")[0];
  if (manifest.some((l) => l.code === nav)) return nav;
  return "en";
}

function populateLangSelect(manifest) {
  const select = document.getElementById("lang-select");
  select.innerHTML = manifest.map((l) => `<option value="${l.code}">${l.name}</option>`).join("");
  select.value = currentLangId;
  select.addEventListener("change", () => setLanguage(select.value));
}

function applyStaticTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (translations[key] !== undefined) el.textContent = translations[key];
  });
}

async function setLanguage(langCode) {
  const data = (await loadTranslations(langCode)) || (await loadTranslations("en")) || {};
  translations = data;
  currentLangId = langCode;
  localStorage.setItem("flood_lang", langCode);
  document.getElementById("html-root").lang = langCode;
  document.getElementById("html-root").dir = data.dir === "rtl" ? "rtl" : "ltr";
  applyStaticTranslations();

  if (wardsData.length) {
    renderMap(wardsData, lastMapCenter, lastMapZoom);
    renderList(wardsData);
  }
  if (lastCityName) {
    document.getElementById("page-title").textContent = `${lastCityName} ${t("title_suffix")}`;
  }
  if (lastGeneratedAt) {
    document.getElementById("updated-at").textContent = `${t("updated_prefix")} ${formatTime(lastGeneratedAt)}`;
  }
  renderRecentReports(currentCityId);
}

// ---------- Supabase setup (guarded — dashboard still works without it) ----

function initSupabase() {
  if (window.SUPABASE_URL && window.SUPABASE_ANON_KEY && window.supabase) {
    supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  } else {
    console.warn("Supabase not configured — community features are disabled. Fill in docs/assets/supabase-config.js.");
    document.getElementById("submit-report").title = "Community reports aren't configured yet.";
  }
}

function getClientId() {
  let id = localStorage.getItem("flood_report_client_id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    localStorage.setItem("flood_report_client_id", id);
  }
  return id;
}

function cooldownKey(cityId, wardId) {
  return `flood_report_cooldown_${cityId}_${wardId}`;
}

function isOnCooldown(cityId, wardId) {
  const last = localStorage.getItem(cooldownKey(cityId, wardId));
  if (!last) return false;
  return Date.now() - Number(last) < REPORT_COOLDOWN_MS;
}

function setCooldown(cityId, wardId) {
  localStorage.setItem(cooldownKey(cityId, wardId), String(Date.now()));
}

function bandFor(score) {
  if (score >= 75) return "severe";
  if (score >= 50) return "high";
  if (score >= 25) return "moderate";
  return "low";
}

// ---------- City selection ---------------------------------------------------

async function loadCityManifest() {
  try {
    const res = await fetch("data/cities.json", { cache: "no-store" });
    if (!res.ok) throw new Error("no manifest");
    const list = await res.json();
    if (Array.isArray(list) && list.length) return list;
    throw new Error("empty manifest");
  } catch (err) {
    return [{ city_id: "chennai", city_name: "Chennai", map_center: { lat: 13.02, lon: 80.2 } }];
  }
}

function nearestCity(lat, lon, manifest) {
  let best = manifest[0];
  let bestDist = Infinity;
  manifest.forEach((c) => {
    if (!c.map_center) return;
    const dLat = lat - c.map_center.lat;
    const dLon = lon - c.map_center.lon;
    const d = dLat * dLat + dLon * dLon; // squared-distance is fine at city-scale separation
    if (d < bestDist) { bestDist = d; best = c; }
  });
  return best.city_id;
}

function tryGeolocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), 6000);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }); },
      () => { clearTimeout(timer); resolve(null); },
      { timeout: 5000, maximumAge: 10 * 60 * 1000 }
    );
  });
}

async function tryIpGeolocation() {
  try {
    const res = await fetch("https://get.geojs.io/v1/ip/geo.json");
    if (!res.ok) throw new Error("ip geolocation failed");
    const data = await res.json();
    const lat = parseFloat(data.latitude);
    const lon = parseFloat(data.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  } catch (err) {
    console.warn("IP geolocation unavailable:", err);
  }
  return null;
}

async function detectInitialCity(manifest) {
  const coords = (await tryGeolocation()) || (await tryIpGeolocation());
  if (!coords) return null;
  return nearestCity(coords.lat, coords.lon, manifest);
}

async function determineInitialCity(manifest) {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("city");
  if (fromQuery && manifest.some((m) => m.city_id === fromQuery)) return fromQuery;

  const saved = localStorage.getItem("flood_selected_city");
  if (saved && manifest.some((m) => m.city_id === saved)) return saved;

  const detected = await detectInitialCity(manifest);
  if (detected) {
    localStorage.setItem("flood_selected_city", detected);
    return detected;
  }
  return manifest[0].city_id;
}

function populateCitySelect(manifest) {
  const select = document.getElementById("city-select");
  select.innerHTML = manifest.map((c) => `<option value="${c.city_id}">${c.city_name}</option>`).join("");
  select.value = currentCityId;
  select.addEventListener("change", () => switchCity(select.value));
}

async function switchCity(cityId) {
  currentCityId = cityId;
  localStorage.setItem("flood_selected_city", cityId);
  const url = new URL(window.location);
  url.searchParams.set("city", cityId);
  window.history.replaceState({}, "", url);
  await loadAndRenderCity();
}

// ---------- Fetching prediction + report data ------------------------------

async function loadPredictionData(cityId) {
  const res = await fetch(`data/${cityId}/latest.json`, { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load latest.json for " + cityId);
  return res.json();
}

async function loadReportSummary(cityId) {
  if (!supabaseClient) return {};
  const { data, error } = await supabaseClient.from("ward_reports_summary").select("*").eq("city_id", cityId);
  if (error) {
    console.warn("Could not load report summary:", error.message);
    return {};
  }
  const byWard = {};
  (data || []).forEach((row) => { byWard[row.ward_id] = row; });
  return byWard;
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }) + " IST";
}

function timeAgo(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

// ---------- Citizen-feedback score adjustment (see methodology.html) -------

function computeFeedbackAdjustment(summary) {
  if (!summary || !summary.reports_last_2h || summary.reports_last_2h < MIN_REPORTS_FOR_ADJUSTMENT) return null;
  const worseRatio = (summary.calibration_worse || 0) / summary.reports_last_2h;
  const betterRatio = (summary.calibration_better || 0) / summary.reports_last_2h;
  if (worseRatio > 0.5) {
    return {
      delta: FEEDBACK_ADJUSTMENT_POINTS,
      reasonKey: "feedback_reason_worse",
      vars: { count: summary.calibration_worse, total: summary.reports_last_2h },
    };
  }
  if (betterRatio > 0.5) {
    return {
      delta: -FEEDBACK_ADJUSTMENT_POINTS,
      reasonKey: "feedback_reason_better",
      vars: { count: summary.calibration_better, total: summary.reports_last_2h },
    };
  }
  return null;
}

function adjustedScoreHtml(baseScore, wardId) {
  const adj = computeFeedbackAdjustment(reportSummaryByWard[wardId]);
  if (!adj) return { score: baseScore, band: bandFor(baseScore), html: "" };
  const adjustedScore = Math.max(0, Math.min(100, baseScore + adj.delta));
  const adjustedBand = bandFor(adjustedScore);
  const reason = t(adj.reasonKey, adj.vars);
  const html = `<div class="feedback-adjustment">${t("feedback_adjusted", { score: adjustedScore.toFixed(0), band: t("legend_" + adjustedBand), reason })}</div>`;
  return { score: adjustedScore, band: adjustedBand, html };
}

// ---------- Rendering: map, list, sources -----------------------------------

function reportBadgeHtml(wardId) {
  const summary = reportSummaryByWard[wardId];
  if (!summary || !summary.reports_last_2h) return "";
  const bits = [t("report_badge_count", { count: summary.reports_last_2h })];
  if (summary.most_reported_water_level) bits.push(t("report_badge_water", { level: t("water_" + summary.most_reported_water_level) }));
  if (summary.most_reported_trend) bits.push(t("trend_" + summary.most_reported_trend));
  if (summary.calibration_worse) bits.push(t("report_badge_worse", { count: summary.calibration_worse }));
  return `<div class="report-badge">${bits.join(" &middot; ")}</div>`;
}

function renderMap(wards, center, zoom) {
  lastMapCenter = center;
  lastMapZoom = zoom || 11;
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  mapInstance = L.map("map", { scrollWheelZoom: false }).setView([center.lat, center.lon], zoom || 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(mapInstance);

  wards.forEach((w) => {
    const adjusted = adjustedScoreHtml(w.predictive_risk.score, w.ward_id);
    const color = BAND_COLORS[adjusted.band] || "#888";
    const marker = L.circleMarker([w.lat, w.lon], {
      radius: 9,
      color: color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 1,
    }).addTo(mapInstance);

    marker.bindPopup(
      `<strong>${w.ward_name}</strong><br>` +
      `72h predictive risk: ${w.predictive_risk.score} (${t("legend_" + w.predictive_risk.band)})<br>` +
      `Pattern: ${t("pattern_" + w.predictive_risk.rainfall_pattern) || w.predictive_risk.pattern_description}<br>` +
      `Current severity: ${w.realtime_severity.score} (${t("legend_" + w.realtime_severity.band)})<br>` +
      `Forecast rain (72h): ${w.raw_inputs.forecast_72h_mm} mm` +
      adjusted.html +
      reportBadgeHtml(w.ward_id)
    );
  });
}

function renderList(wards) {
  const container = document.getElementById("ward-list");
  const sorted = [...wards].sort((a, b) => b.predictive_risk.score - a.predictive_risk.score);

  container.innerHTML = sorted.map((w) => {
    const adjusted = adjustedScoreHtml(w.predictive_risk.score, w.ward_id);
    return `
    <div class="ward-row">
      <div>
        <span class="ward-name">${w.ward_name}</span>
        ${reportBadgeHtml(w.ward_id)}
        ${adjusted.html}
      </div>
      <div class="score-pill">
        <i class="dot" style="background:${BAND_COLORS[w.predictive_risk.band]}"></i>
        ${w.predictive_risk.score.toFixed(0)} &middot; ${t("legend_" + w.predictive_risk.band)}
      </div>
      <div class="score-pill">
        <i class="dot" style="background:${BAND_COLORS[w.realtime_severity.band]}"></i>
        ${w.realtime_severity.score.toFixed(0)} &middot; ${t("legend_" + w.realtime_severity.band)}
      </div>
    </div>
  `;
  }).join("");
}

function renderSources(sources) {
  const el = document.getElementById("sources");
  const items = sources.map(s => s.url
    ? `<li><a href="${s.url}" target="_blank" rel="noopener">${s.name}</a> — ${s.role}</li>`
    : `<li>${s.name} — ${s.role}</li>`
  ).join("");
  el.innerHTML = `<strong>Data sources</strong><ul>${items}</ul>`;
}

// ---------- Recent reports + fact-check voting ------------------------------

async function loadRecentReports(cityId) {
  if (!supabaseClient) return [];
  const { data, error } = await supabaseClient
    .from("ward_reports_recent")
    .select("*")
    .eq("city_id", cityId)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("Could not load recent reports:", error.message);
    return [];
  }
  return data || [];
}

async function loadConfirmationSummary() {
  if (!supabaseClient) return {};
  const { data, error } = await supabaseClient.from("report_confirmation_summary").select("*");
  if (error) {
    console.warn("Could not load confirmation summary:", error.message);
    return {};
  }
  const byReport = {};
  (data || []).forEach((r) => { byReport[r.report_id] = r; });
  return byReport;
}

async function submitVote(reportId, vote, btn) {
  if (!supabaseClient) return;
  btn.disabled = true;
  const { error } = await supabaseClient.from("report_confirmations").insert({
    report_id: reportId,
    client_id: getClientId(),
    vote,
  });
  const card = btn.closest(".recent-report-card");
  if (error) {
    console.warn(error);
    card.querySelector(".vote-status").textContent = t("vote_error");
    return;
  }
  card.querySelectorAll(".vote-btn").forEach((b) => { b.disabled = true; });
  card.querySelector(".vote-status").textContent = t("vote_thanks");
}

async function renderRecentReports(cityId) {
  const container = document.getElementById("recent-reports-list");
  const [reports, confirmSummary] = await Promise.all([
    loadRecentReports(cityId),
    loadConfirmationSummary(),
  ]);

  if (!supabaseClient) {
    container.innerHTML = "";
    return;
  }
  if (!reports.length) {
    container.innerHTML = `<p class="empty-note">${t("recent_reports_empty")}</p>`;
    return;
  }

  container.innerHTML = reports.map((r) => {
    const summary = confirmSummary[r.id] || { confirms: 0, disputes: 0 };
    const bits = [];
    if (r.calibration) bits.push(t("calibration_" + r.calibration));
    if (r.water_level) bits.push(t("report_badge_water", { level: t("water_" + r.water_level) }));
    if (r.trend) bits.push(t("trend_" + r.trend));
    return `
      <div class="recent-report-card" data-report-id="${r.id}">
        <div class="recent-report-meta">
          <strong>${r.ward_name}</strong> &middot; ${bits.join(", ")} &middot; ${timeAgo(r.created_at)}
        </div>
        <div class="recent-report-votes">
          <button type="button" class="vote-btn confirm" data-vote="confirm">${t("vote_confirm")} (${summary.confirms})</button>
          <button type="button" class="vote-btn dispute" data-vote="dispute">${t("vote_dispute")} (${summary.disputes})</button>
          <span class="vote-status"></span>
        </div>
      </div>`;
  }).join("");

  container.querySelectorAll(".vote-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const reportId = btn.closest(".recent-report-card").dataset.reportId;
      submitVote(reportId, btn.dataset.vote, btn);
    });
  });
}

// ---------- Site config: coffee link + reports on/off -----------------------

async function loadSiteConfig() {
  if (!supabaseClient) return {};
  const { data, error } = await supabaseClient.from("site_config").select("*");
  if (error) {
    console.warn("Could not load site_config:", error.message);
    return {};
  }
  const cfg = {};
  (data || []).forEach((row) => { cfg[row.key] = row.value; });
  return cfg;
}

function applySiteConfig(cfg) {
  const wrap = document.getElementById("coffee-link-wrap");
  if (cfg.bmc_url) {
    wrap.innerHTML = `&middot; <a href="${cfg.bmc_url}" target="_blank" rel="noopener" data-i18n="footer_coffee">${t("footer_coffee")}</a>`;
  } else {
    wrap.innerHTML = "";
  }

  const panel = document.getElementById("report-panel");
  if (cfg.reports_enabled === false) {
    panel.querySelectorAll("button, select").forEach((el) => { el.disabled = true; });
    document.getElementById("report-status").textContent = t("reports_disabled");
  }
}

// ---------- Live visitor count (Realtime Presence + page_views fallback) ---

function setupVisitorPresence() {
  const el = document.getElementById("visitor-count");
  if (!supabaseClient) {
    el.textContent = "";
    return;
  }

  presenceChannel = supabaseClient.channel("site-presence", {
    config: { presence: { key: getClientId() } },
  });

  presenceChannel
    .on("presence", { event: "sync" }, () => {
      const count = Object.keys(presenceChannel.presenceState()).length;
      el.textContent = `${count} ${t("viewing_now")}`;
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await presenceChannel.track({ online_at: new Date().toISOString() });
      }
      // Any other status (CHANNEL_ERROR, TIMED_OUT, CLOSED — e.g. the
      // project is near the free-tier concurrent-connection limit) just
      // leaves the "viewing now" count blank; recordPageViews() below is
      // the fallback stat that doesn't depend on a live connection.
    });
}

async function recordPageView() {
  if (!supabaseClient) return;
  try {
    await supabaseClient.rpc("record_page_view");
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabaseClient.from("page_views").select("views").eq("day", today).maybeSingle();
    if (data) {
      document.getElementById("visitor-count").title = `${data.views} page loads today (site-wide, all cities)`;
    }
  } catch (err) {
    console.warn("page view tracking unavailable:", err);
  }
}

// ---------- Report panel -----------------------------------------------------

function populateWardSelect(wards) {
  const select = document.getElementById("report-ward");
  Array.from(select.querySelectorAll('option:not([value=""])')).forEach((o) => o.remove());
  wards.forEach((w) => {
    const opt = document.createElement("option");
    opt.value = w.ward_id;
    opt.textContent = w.ward_name;
    select.appendChild(opt);
  });
}

function setupReportPanel() {
  const selectedValues = { calibration: null, water_level: null, trend: null };
  const wardSelect = document.getElementById("report-ward");
  const submitBtn = document.getElementById("submit-report");
  const statusEl = document.getElementById("report-status");

  document.querySelectorAll(".button-row").forEach((row) => {
    const field = row.dataset.field;
    row.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const alreadyActive = btn.classList.contains("active");
        row.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        if (!alreadyActive) {
          btn.classList.add("active");
          selectedValues[field] = btn.dataset.value;
        } else {
          selectedValues[field] = null;
        }
        updateSubmitState();
      });
    });
  });

  function updateSubmitState() {
    const wardId = wardSelect.value;
    const hasAnyField = selectedValues.calibration || selectedValues.water_level || selectedValues.trend;
    submitBtn.disabled = !wardId || !hasAnyField || !supabaseClient || siteConfig.reports_enabled === false;
  }

  wardSelect.addEventListener("change", () => {
    statusEl.textContent = "";
    if (wardSelect.value && isOnCooldown(currentCityId, wardSelect.value)) {
      statusEl.textContent = t("report_cooldown");
    }
    updateSubmitState();
  });

  submitBtn.addEventListener("click", async () => {
    const wardId = wardSelect.value;
    const ward = wardsData.find((w) => w.ward_id === wardId);
    if (!ward) return;

    if (isOnCooldown(currentCityId, wardId)) {
      statusEl.textContent = t("report_cooldown");
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = t("report_submitting");

    const { error } = await supabaseClient.from("ward_reports").insert({
      city_id: currentCityId,
      ward_id: ward.ward_id,
      ward_name: ward.ward_name,
      calibration: selectedValues.calibration,
      water_level: selectedValues.water_level,
      trend: selectedValues.trend,
      client_id: getClientId(),
    });

    if (error) {
      statusEl.textContent = t("report_error");
      console.error(error);
      updateSubmitState();
      return;
    }

    setCooldown(currentCityId, wardId);
    statusEl.textContent = t("report_thanks");
    document.querySelectorAll(".button-row button.active").forEach((b) => b.classList.remove("active"));
    selectedValues.calibration = null;
    selectedValues.water_level = null;
    selectedValues.trend = null;
    updateSubmitState();

    renderRecentReports(currentCityId);
  });
}

// ---------- Boot / per-city load ---------------------------------------------

async function loadAndRenderCity() {
  try {
    const data = await loadPredictionData(currentCityId);
    wardsData = data.wards;
    lastCityName = data.city_name;
    lastGeneratedAt = data.generated_at;
    document.getElementById("page-title").textContent = `${data.city_name} ${t("title_suffix")}`;
    document.getElementById("updated-at").textContent = `${t("updated_prefix")} ${formatTime(data.generated_at)}`;

    reportSummaryByWard = await loadReportSummary(currentCityId);

    renderMap(wardsData, data.map_center, data.map_zoom);
    renderList(wardsData);
    renderSources(data.data_sources);
    populateWardSelect(wardsData);
    renderRecentReports(currentCityId);
  } catch (err) {
    document.getElementById("updated-at").textContent = t("load_error");
    console.error(err);
  }
}

async function boot() {
  initSupabase();

  langManifest = await loadLangManifest();
  currentLangId = pickInitialLanguage(langManifest);
  populateLangSelect(langManifest);
  translations = (await loadTranslations(currentLangId)) || {};
  document.getElementById("html-root").lang = currentLangId;
  document.getElementById("html-root").dir = translations.dir === "rtl" ? "rtl" : "ltr";
  applyStaticTranslations();
  document.getElementById("updated-at").textContent = t("loading");

  cityManifest = await loadCityManifest();
  currentCityId = await determineInitialCity(cityManifest);
  populateCitySelect(cityManifest);

  siteConfig = await loadSiteConfig();
  applySiteConfig(siteConfig);

  setupReportPanel();
  setupVisitorPresence();
  recordPageView();

  await loadAndRenderCity();
}

boot();
