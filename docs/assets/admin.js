let supabaseClient = null;
let currentUser = null;
let cityManifest = [];

const SCORING_FIELDS = [
  { path: ["antecedent_saturation_mm"], label: "Antecedent saturation (mm)" },
  { path: ["current_hour_saturation_mm"], label: "Current-hour saturation (mm)" },
  { path: ["trend_saturation_mm_per_hr"], label: "Trend saturation (mm/hr)" },
];
const PATTERN_KEYS = ["convective_burst", "prolonged_system", "moderate_monsoon"];
const PREDICTIVE_WEIGHT_KEYS = ["forecast", "antecedent", "vulnerability"];
const REALTIME_WEIGHT_KEYS = ["current_hour", "trend", "vulnerability"];

function initSupabase() {
  if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || !window.supabase) {
    document.getElementById("signin-note").textContent = "Supabase isn't configured (docs/assets/supabase-config.js) — the admin panel can't function.";
    return false;
  }
  supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  return true;
}

// ---------- Auth --------------------------------------------------------

async function isAdmin(userId) {
  const { data, error } = await supabaseClient.from("admins").select("id").eq("id", userId);
  if (error) {
    console.warn("admin check failed:", error.message);
    return false;
  }
  return (data || []).length > 0;
}

async function refreshAuthUi() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const authStatus = document.getElementById("auth-status");
  const signinPanel = document.getElementById("signin-panel");
  const adminApp = document.getElementById("admin-app");

  if (!session) {
    currentUser = null;
    authStatus.textContent = "";
    signinPanel.hidden = false;
    adminApp.hidden = true;
    return;
  }

  const admin = await isAdmin(session.user.id);
  if (!admin) {
    currentUser = null;
    authStatus.textContent = `Signed in as ${session.user.email || session.user.id} — not an admin.`;
    document.getElementById("signin-note").textContent =
      "This GitHub account isn't in the admins table. Ask an existing admin to run: insert into admins (id) select id from auth.users where email = 'your@email';";
    signinPanel.hidden = false;
    adminApp.hidden = true;
    return;
  }

  currentUser = session.user;
  authStatus.textContent = `Signed in as ${session.user.email || session.user.id}`;
  signinPanel.hidden = true;
  adminApp.hidden = false;
  await loadEverything();
}

function setupAuthControls() {
  document.getElementById("github-signin").addEventListener("click", async () => {
    await supabaseClient.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: window.location.href },
    });
  });
  document.getElementById("signout-btn").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    await refreshAuthUi();
  });
  supabaseClient.auth.onAuthStateChange(() => { refreshAuthUi(); });
}

// ---------- Tabs ---------------------------------------------------------

function setupTabs() {
  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.dataset.tab !== btn.dataset.tab; });
    });
  });
}

// ---------- Site settings -------------------------------------------------

async function loadSiteSettingsTab() {
  const { data, error } = await supabaseClient.from("site_config").select("*");
  if (error) {
    document.getElementById("site-config-status").textContent = "Couldn't load: " + error.message;
    return;
  }
  const cfg = {};
  (data || []).forEach((row) => { cfg[row.key] = row.value; });
  document.getElementById("bmc-url").value = cfg.bmc_url || "";
  document.getElementById("reports-enabled").checked = cfg.reports_enabled !== false;
}

async function saveSiteSettings() {
  const statusEl = document.getElementById("site-config-status");
  statusEl.textContent = "Saving…";
  const bmcUrl = document.getElementById("bmc-url").value.trim();
  const reportsEnabled = document.getElementById("reports-enabled").checked;

  const rows = [
    { key: "bmc_url", value: bmcUrl || null },
    { key: "reports_enabled", value: reportsEnabled },
  ];
  const { error } = await supabaseClient.from("site_config").upsert(rows, { onConflict: "key" });
  statusEl.textContent = error ? "Couldn't save: " + error.message : "Saved.";
}

// ---------- Scoring config -------------------------------------------------

function getPath(obj, path) {
  return path.reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}
function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    cur[path[i]] = cur[path[i]] || {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}

function renderScoringForm(config) {
  const container = document.getElementById("scoring-form");
  let html = "";

  html += `<fieldset class="scoring-field-group"><legend>Rainfall pattern saturation (mm)</legend>`;
  PATTERN_KEYS.forEach((k) => {
    const val = getPath(config, ["pattern_presets", k, "forecast_saturation_mm"]);
    html += `<div class="scoring-field"><label>${k.replace("_", " ")}</label><input type="number" step="0.1" data-path="pattern_presets.${k}.forecast_saturation_mm" value="${val ?? ""}"></div>`;
  });
  html += `</fieldset>`;

  html += `<fieldset class="scoring-field-group"><legend>Other saturation thresholds</legend>`;
  SCORING_FIELDS.forEach((f) => {
    const val = getPath(config, f.path);
    html += `<div class="scoring-field"><label>${f.label}</label><input type="number" step="0.1" data-path="${f.path.join(".")}" value="${val ?? ""}"></div>`;
  });
  html += `</fieldset>`;

  html += `<fieldset class="scoring-field-group"><legend>Predictive weights (should sum to 1.0)</legend>`;
  PREDICTIVE_WEIGHT_KEYS.forEach((k) => {
    const val = getPath(config, ["predictive_weights", k]);
    html += `<div class="scoring-field"><label>${k}</label><input type="number" step="0.01" min="0" max="1" data-path="predictive_weights.${k}" value="${val ?? ""}"></div>`;
  });
  html += `</fieldset>`;

  html += `<fieldset class="scoring-field-group"><legend>Realtime weights (should sum to 1.0)</legend>`;
  REALTIME_WEIGHT_KEYS.forEach((k) => {
    const val = getPath(config, ["realtime_weights", k]);
    html += `<div class="scoring-field"><label>${k}</label><input type="number" step="0.01" min="0" max="1" data-path="realtime_weights.${k}" value="${val ?? ""}"></div>`;
  });
  html += `</fieldset>`;

  container.innerHTML = html;
}

async function loadCityManifestForAdmin() {
  try {
    const res = await fetch("data/cities.json", { cache: "no-store" });
    if (!res.ok) throw new Error("no manifest");
    const list = await res.json();
    if (Array.isArray(list) && list.length) return list;
    throw new Error("empty");
  } catch (err) {
    return [{ city_id: "chennai", city_name: "Chennai" }];
  }
}

async function loadScoringConfigForCity(cityId) {
  const { data, error } = await supabaseClient.from("scoring_config").select("config").eq("city_id", cityId).maybeSingle();
  if (error) {
    console.warn("scoring_config load failed:", error.message);
    return {};
  }
  return (data && data.config) || {};
}

async function setupScoringTab() {
  cityManifest = await loadCityManifestForAdmin();
  const select = document.getElementById("scoring-city-select");
  select.innerHTML = cityManifest.map((c) => `<option value="${c.city_id}">${c.city_name}</option>`).join("");

  async function loadForSelected() {
    const cfg = await loadScoringConfigForCity(select.value);
    renderScoringForm(cfg);
    document.getElementById("scoring-config-status").textContent = Object.keys(cfg).length
      ? "Showing saved override for this city."
      : "No override saved yet — showing blank form; engine defaults apply until you save one.";
  }

  select.addEventListener("change", loadForSelected);
  await loadForSelected();

  document.getElementById("save-scoring-config").addEventListener("click", async () => {
    const statusEl = document.getElementById("scoring-config-status");
    statusEl.textContent = "Saving…";
    const config = {};
    document.querySelectorAll("#scoring-form input[data-path]").forEach((input) => {
      const path = input.dataset.path.split(".");
      const val = input.value === "" ? undefined : parseFloat(input.value);
      if (val !== undefined && !Number.isNaN(val)) setPath(config, path, val);
    });
    const { error } = await supabaseClient.from("scoring_config").upsert(
      { city_id: select.value, config },
      { onConflict: "city_id" }
    );
    statusEl.textContent = error ? "Couldn't save: " + error.message : "Saved — takes effect on the next hourly pipeline run.";
  });
}

// ---------- Report moderation ----------------------------------------------

async function loadModerationTab() {
  const container = document.getElementById("moderation-list");
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseClient
    .from("ward_reports")
    .select("*")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });

  if (error) {
    container.innerHTML = `<p>Couldn't load: ${error.message}</p>`;
    return;
  }
  if (!data.length) {
    container.innerHTML = `<p class="empty-note">No reports in the last 24 hours.</p>`;
    return;
  }

  container.innerHTML = data.map((r) => `
    <div class="moderation-row" data-id="${r.id}" data-client="${r.client_id}">
      <span>${r.city_id} / ${r.ward_name} &middot; ${r.calibration || ""} ${r.water_level || ""} ${r.trend || ""} &middot; ${new Date(r.created_at).toLocaleString("en-IN")} &middot; client ${r.client_id.slice(0, 8)}&hellip;</span>
      <span>
        <button type="button" class="delete-report">Delete</button>
        <button type="button" class="block-client danger">Block device</button>
      </span>
    </div>
  `).join("");

  container.querySelectorAll(".delete-report").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".moderation-row");
      const { error: delErr } = await supabaseClient.from("ward_reports").delete().eq("id", row.dataset.id);
      if (!delErr) row.remove();
    });
  });
  container.querySelectorAll(".block-client").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".moderation-row");
      const reason = prompt("Reason for blocking this device (optional):") || "blocked via admin panel";
      const { error: blockErr } = await supabaseClient.from("blocked_clients").insert({ client_id: row.dataset.client, reason });
      if (!blockErr) btn.textContent = "Blocked";
    });
  });
}

// ---------- Fact-check overview ---------------------------------------------

async function loadFactCheckTab() {
  const container = document.getElementById("factcheck-list");
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [reportsRes, summaryRes] = await Promise.all([
    supabaseClient.from("ward_reports").select("id, city_id, ward_name, calibration, water_level, trend, created_at").gte("created_at", sinceIso),
    supabaseClient.from("report_confirmation_summary").select("*"),
  ]);

  if (reportsRes.error || summaryRes.error) {
    container.innerHTML = `<p>Couldn't load: ${(reportsRes.error || summaryRes.error).message}</p>`;
    return;
  }

  const summaryByReport = {};
  (summaryRes.data || []).forEach((s) => { summaryByReport[s.report_id] = s; });

  const flagged = (reportsRes.data || [])
    .map((r) => ({ ...r, summary: summaryByReport[r.id] || { confirms: 0, disputes: 0 } }))
    .filter((r) => r.summary.disputes > 0 && r.summary.disputes >= r.summary.confirms);

  if (!flagged.length) {
    container.innerHTML = `<p class="empty-note">Nothing flagged — no report in the last 24h has disputes outweighing confirmations.</p>`;
    return;
  }

  container.innerHTML = flagged.map((r) => `
    <div class="factcheck-row">
      <span>${r.city_id} / ${r.ward_name} &middot; ${r.calibration || ""} ${r.water_level || ""} ${r.trend || ""} &middot; ${new Date(r.created_at).toLocaleString("en-IN")}</span>
      <span>${r.summary.confirms} confirm / ${r.summary.disputes} dispute</span>
    </div>
  `).join("");
}

// ---------- Boot -------------------------------------------------------------

async function loadEverything() {
  await Promise.all([
    loadSiteSettingsTab(),
    setupScoringTab(),
    loadModerationTab(),
    loadFactCheckTab(),
  ]);
}

async function boot() {
  if (!initSupabase()) return;
  setupTabs();
  setupAuthControls();
  document.getElementById("save-site-config").addEventListener("click", saveSiteSettings);
  await refreshAuthUi();
}

boot();
