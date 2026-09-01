const BAND_COLORS = {
  low: "#2E7D5B",
  moderate: "#B8901F",
  high: "#B5541C",
  severe: "#A5322A",
};

const REPORT_COOLDOWN_MS = 15 * 60 * 1000;

let wardsData = [];
let reportSummaryByWard = {};
let supabaseClient = null;

// ---------- Supabase setup (guarded — dashboard still works without it) ----

function initSupabase() {
  if (window.SUPABASE_URL && window.SUPABASE_ANON_KEY && window.supabase) {
    supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  } else {
    console.warn("Supabase not configured — community reports are disabled. Fill in docs/assets/supabase-config.js.");
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

function cooldownKey(wardId) {
  return `flood_report_cooldown_${wardId}`;
}

function isOnCooldown(wardId) {
  const last = localStorage.getItem(cooldownKey(wardId));
  if (!last) return false;
  return Date.now() - Number(last) < REPORT_COOLDOWN_MS;
}

function setCooldown(wardId) {
  localStorage.setItem(cooldownKey(wardId), String(Date.now()));
}

// ---------- Fetching prediction + report data ------------------------------

async function loadPredictionData() {
  const res = await fetch("data/latest.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load latest.json");
  return res.json();
}

async function loadReportSummary() {
  if (!supabaseClient) return {};
  const { data, error } = await supabaseClient.from("ward_reports_summary").select("*");
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

function renderMap(wards) {
  const map = L.map("map", { scrollWheelZoom: false }).setView([13.02, 80.2], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  wards.forEach((w) => {
    const color = BAND_COLORS[w.predictive_risk.band] || "#888";
    const marker = L.circleMarker([w.lat, w.lon], {
      radius: 9,
      color: color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 1,
    }).addTo(map);

    marker.bindPopup(
      `<strong>${w.ward_name}</strong><br>` +
      `72h predictive risk: ${w.predictive_risk.score} (${w.predictive_risk.band})<br>` +
      `Pattern: ${w.predictive_risk.pattern_description || w.predictive_risk.rainfall_pattern}<br>` +
      `Current severity: ${w.realtime_severity.score} (${w.realtime_severity.band})<br>` +
      `Forecast rain (72h): ${w.raw_inputs.forecast_72h_mm} mm` +
      reportBadgeHtml(w.ward_id)
    );
  });
}

function renderList(wards) {
  const container = document.getElementById("ward-list");
  const sorted = [...wards].sort((a, b) => b.predictive_risk.score - a.predictive_risk.score);

  container.innerHTML = sorted.map((w) => `
    <div class="ward-row">
      <div>
        <span class="ward-name">${w.ward_name}</span>
        ${reportBadgeHtml(w.ward_id)}
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
  `).join("");
}

function renderSources(sources) {
  const el = document.getElementById("sources");
  const items = sources.map(s => s.url
    ? `<li><a href="${s.url}" target="_blank" rel="noopener">${s.name}</a> — ${s.role}</li>`
    : `<li>${s.name} — ${s.role}</li>`
  ).join("");
  el.innerHTML = `<strong>Data sources</strong><ul>${items}</ul>`;
}

// ---------- Report panel -----------------------------------------------------

function populateWardSelect(wards) {
  const select = document.getElementById("report-ward");
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
    submitBtn.disabled = !wardId || !hasAnyField || !supabaseClient;
  }

  wardSelect.addEventListener("change", () => {
    statusEl.textContent = "";
    if (wardSelect.value && isOnCooldown(wardSelect.value)) {
      statusEl.textContent = "You've already reported for this area recently — thanks. Try again later.";
    }
    updateSubmitState();
  });

  submitBtn.addEventListener("click", async () => {
    const wardId = wardSelect.value;
    const ward = wardsData.find((w) => w.ward_id === wardId);
    if (!ward) return;

    if (isOnCooldown(wardId)) {
      statusEl.textContent = "You've already reported for this area recently — thanks. Try again later.";
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = "Submitting…";

    const { error } = await supabaseClient.from("ward_reports").insert({
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

    setCooldown(wardId);
    statusEl.textContent = "Thanks — recorded.";
    document.querySelectorAll(".button-row button.active").forEach((b) => b.classList.remove("active"));
    selectedValues.calibration = null;
    selectedValues.water_level = null;
    selectedValues.trend = null;
    updateSubmitState();
  });
}

// ---------- Boot --------------------------------------------------------------

async function boot() {
  initSupabase();

  try {
    const data = await loadPredictionData();
    wardsData = data.wards;
    document.getElementById("updated-at").textContent = `Updated ${formatTime(data.generated_at)}`;

    reportSummaryByWard = await loadReportSummary();

    renderMap(wardsData);
    renderList(wardsData);
    renderSources(data.data_sources);
    populateWardSelect(wardsData);
    setupReportPanel();
  } catch (err) {
    document.getElementById("updated-at").textContent = "Could not load latest data";
    console.error(err);
  }
}

boot();
