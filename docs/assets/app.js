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
let cityManifest = [];
let mapInstance = null;
let siteConfig = {};
let supabaseClient = null;
let presenceChannel = null;

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
    return [{ city_id: "chennai", city_name: "Chennai" }];
  }
}

function pickInitialCity(manifest) {
  const params = new URLSearchParams(window.location.search);
  const candidates = [params.get("city"), localStorage.getItem("flood_selected_city"), "chennai"];
  for (const c of candidates) {
    if (c && manifest.some((m) => m.city_id === c)) return c;
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
      label: `${summary.calibration_worse} of ${summary.reports_last_2h} recent reports say worse than shown`,
    };
  }
  if (betterRatio > 0.5) {
    return {
      delta: -FEEDBACK_ADJUSTMENT_POINTS,
      label: `${summary.calibration_better} of ${summary.reports_last_2h} recent reports say better than shown`,
    };
  }
  return null;
}

function adjustedScoreHtml(baseScore, wardId) {
  const adj = computeFeedbackAdjustment(reportSummaryByWard[wardId]);
  if (!adj) return { score: baseScore, band: bandFor(baseScore), html: "" };
  const adjustedScore = Math.max(0, Math.min(100, baseScore + adj.delta));
  const adjustedBand = bandFor(adjustedScore);
  return {
    score: adjustedScore,
    band: adjustedBand,
    html: `<div class="feedback-adjustment">Adjusted to ${adjustedScore.toFixed(0)} (${adjustedBand}) — ${adj.label}</div>`,
  };
}

// ---------- Rendering: map, list, sources -----------------------------------

function reportBadgeHtml(wardId) {
  const summary = reportSummaryByWard[wardId];
  if (!summary || !summary.reports_last_2h) return "";
  const bits = [`${summary.reports_last_2h} citizen report${summary.reports_last_2h === 1 ? "" : "s"} (2h)`];
  if (summary.most_reported_water_level) bits.push(`water: ${summary.most_reported_water_level.replace("_", " ")}`);
  if (summary.most_reported_trend) bits.push(summary.most_reported_trend);
  if (summary.calibration_worse) bits.push(`${summary.calibration_worse} say worse than shown`);
  return `<div class="report-badge">${bits.join(" &middot; ")}</div>`;
}

function renderMap(wards, center, zoom) {
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
      `72h predictive risk: ${w.predictive_risk.score} (${w.predictive_risk.band})<br>` +
      `Pattern: ${w.predictive_risk.pattern_description || w.predictive_risk.rainfall_pattern}<br>` +
      `Current severity: ${w.realtime_severity.score} (${w.realtime_severity.band})<br>` +
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
        ${w.predictive_risk.score.toFixed(0)} &middot; ${w.predictive_risk.band}
      </div>
      <div class="score-pill">
        <i class="dot" style="background:${BAND_COLORS[w.realtime_severity.band]}"></i>
        ${w.realtime_severity.score.toFixed(0)} &middot; ${w.realtime_severity.band}
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
    card.querySelector(".vote-status").textContent = "Couldn't record your vote — you may have already voted on this one.";
    return;
  }
  card.querySelectorAll(".vote-btn").forEach((b) => { b.disabled = true; });
  card.querySelector(".vote-status").textContent = "Thanks — recorded.";
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
    container.innerHTML = '<p class="empty-note">No reports in the last 2 hours for this city.</p>';
    return;
  }

  container.innerHTML = reports.map((r) => {
    const summary = confirmSummary[r.id] || { confirms: 0, disputes: 0 };
    const bits = [];
    if (r.calibration) bits.push(r.calibration.replace("_", " "));
    if (r.water_level) bits.push(`water: ${r.water_level.replace("_", " ")}`);
    if (r.trend) bits.push(r.trend);
    return `
      <div class="recent-report-card" data-report-id="${r.id}">
        <div class="recent-report-meta">
          <strong>${r.ward_name}</strong> &middot; ${bits.join(", ") || "report"} &middot; ${timeAgo(r.created_at)}
        </div>
        <div class="recent-report-votes">
          <button type="button" class="vote-btn confirm" data-vote="confirm">Confirm (${summary.confirms})</button>
          <button type="button" class="vote-btn dispute" data-vote="dispute">Dispute (${summary.disputes})</button>
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
    wrap.innerHTML = `&middot; <a href="${cfg.bmc_url}" target="_blank" rel="noopener">Buy me a coffee</a>`;
  } else {
    wrap.innerHTML = "";
  }

  const panel = document.getElementById("report-panel");
  if (cfg.reports_enabled === false) {
    panel.querySelectorAll("button, select").forEach((el) => { el.disabled = true; });
    document.getElementById("report-status").textContent = "Citizen reports are temporarily disabled by the site admin.";
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
      el.textContent = `${count} viewing now`;
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
  select.innerHTML = '<option value="">Select your area&hellip;</option>';
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
      statusEl.textContent = "You've already reported for this area recently — thanks. Try again later.";
    }
    updateSubmitState();
  });

  submitBtn.addEventListener("click", async () => {
    const wardId = wardSelect.value;
    const ward = wardsData.find((w) => w.ward_id === wardId);
    if (!ward) return;

    if (isOnCooldown(currentCityId, wardId)) {
      statusEl.textContent = "You've already reported for this area recently — thanks. Try again later.";
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = "Submitting…";

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
      statusEl.textContent = "Couldn't submit — please try again in a moment.";
      console.error(error);
      updateSubmitState();
      return;
    }

    setCooldown(currentCityId, wardId);
    statusEl.textContent = "Thanks — recorded.";
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
    document.getElementById("page-title").textContent = `${data.city_name} Flood Risk`;
    document.getElementById("updated-at").textContent = `Updated ${formatTime(data.generated_at)}`;

    reportSummaryByWard = await loadReportSummary(currentCityId);

    renderMap(wardsData, data.map_center, data.map_zoom);
    renderList(wardsData);
    renderSources(data.data_sources);
    populateWardSelect(wardsData);
    renderRecentReports(currentCityId);
  } catch (err) {
    document.getElementById("updated-at").textContent = "Could not load latest data";
    console.error(err);
  }
}

async function boot() {
  initSupabase();

  cityManifest = await loadCityManifest();
  currentCityId = pickInitialCity(cityManifest);
  populateCitySelect(cityManifest);

  siteConfig = await loadSiteConfig();
  applySiteConfig(siteConfig);

  setupReportPanel();
  setupVisitorPresence();
  recordPageView();

  await loadAndRenderCity();
}

boot();
