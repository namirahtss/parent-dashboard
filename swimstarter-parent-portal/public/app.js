// TheSwimStarter Parent Portal — frontend
// Vanilla JS SPA. Talks to the Express backend under /api.

const state = {
  token: null,
  parentName: "",
  children: [],       // full profiles
  activeChildId: null,
  view: "home",
  timetable: null,    // cached slots
  pauseReasons: [],
};

// ---------- tiny helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function saveSession() {
  try { localStorage.setItem("tss_token", state.token || ""); } catch {}
}
function loadSession() {
  try { return localStorage.getItem("tss_token") || null; } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem("tss_token"); } catch {}
}

function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: "Bearer " + state.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) { logout(); throw new Error(data.error || "Session expired"); }
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function activeChild() {
  return state.children.find((c) => c.id === state.activeChildId) || state.children[0] || null;
}

// ---------- auth ----------
async function doLogin(phone) {
  const data = await api("/login", { method: "POST", body: { phone } });
  state.token = data.token;
  saveSession();
  await bootApp();
}

function logout() {
  state.token = null;
  state.children = [];
  clearSession();
  $("#app-screen").classList.remove("active");
  $("#login-screen").classList.add("active");
  $("#phone").value = "";
}

async function bootApp() {
  const me = await api("/me");
  state.parentName = me.parentName || "Parent";
  state.children = me.children || [];
  state.activeChildId = state.children[0]?.id || null;
  try { state.pauseReasons = (await api("/pause-reasons")).reasons || []; } catch {}

  $("#login-screen").classList.remove("active");
  $("#app-screen").classList.add("active");
  $("#hello").textContent = "Hello, " + (state.parentName || "Parent");
  renderChildSwitcher();
  switchView("home");
}

// ---------- child switcher ----------
function renderChildSwitcher() {
  const wrap = $("#child-switcher");
  if (state.children.length <= 1) { wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.innerHTML = "";
  state.children.forEach((c) => {
    const b = el(`<button class="chip ${c.id === state.activeChildId ? "active" : ""}">${esc(c.childName || "Child")}</button>`);
    b.onclick = () => { state.activeChildId = c.id; renderChildSwitcher(); renderView(); };
    wrap.appendChild(b);
  });
}

// ---------- view routing ----------
const TITLES = {
  home: "Home", book: "Book Extra Class", schedule: "Change Schedule",
  payment: "Payment", progress: "Progress & Tests", support: "Support",
  notices: "Notices", more: "More",
};

function switchView(view) {
  state.view = view;
  $("#page-title").textContent = TITLES[view] || "";
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const target = $("#view-" + view);
  if (target) target.classList.add("active");
  // tabbar highlight (only for primary tabs)
  document.querySelectorAll(".tab").forEach((t) => {
    const primary = ["home", "book", "schedule", "payment"].includes(view) ? view : "more";
    t.classList.toggle("active", t.dataset.view === primary);
  });
  window.scrollTo(0, 0);
  renderView();
}

function renderView() {
  const fn = VIEWS[state.view];
  if (fn) fn();
}

// ---------- views ----------
const VIEWS = {};

VIEWS.home = function () {
  const c = activeChild();
  const root = $("#view-home");
  if (!c) { root.innerHTML = `<div class="empty">No enrolment found.</div>`; return; }
  const statusBadge = enrolBadge(c.enrolmentStatus);
  root.innerHTML = `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div>
          <h3 style="margin-bottom:4px">${esc(c.childName)}</h3>
          <div class="muted" style="font-size:13px">${esc(c.location || "")} ${c.coach ? "· Coach " + esc(c.coach) : ""}</div>
        </div>
        ${statusBadge}
      </div>
      <div class="spacer"></div>
      <div class="credit-row">
        <div class="credit"><div class="num">${c.extraLessonCredits}</div><div class="lbl">Extra Lesson Credits</div></div>
        <div class="credit"><div class="num">${c.bonusCredits}</div><div class="lbl">Bonus Credits</div></div>
      </div>
      <div class="spacer"></div>
      <div class="kv"><span class="k">Test level</span><span class="v">${esc(c.testLevel || "—")}</span></div>
      <div class="kv"><span class="k">Class</span><span class="v">${esc((c.lessonDay || []).join(", ") || "—")} ${esc((c.timeslot || []).join(", "))}</span></div>
      <div class="kv"><span class="k">Next lesson</span><span class="v">${fmtDate(c.nextLesson) || "—"}</span></div>
    </div>

    <div class="actions-grid">
      ${tile("➕", "Book Extra Class", "Use your credits", "book")}
      ${tile("📅", "Change Schedule", "Move to a new slot", "schedule")}
      ${tile("💳", "Payment", "Link & term dates", "payment")}
      ${tile("📈", "Progress & Tests", "Levels & certs", "progress")}
      ${tile("💬", "Support", "Raise an issue", "support")}
      ${tile("📣", "Notices", "News & pool status", "notices")}
    </div>
  `;
  root.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => switchView(b.dataset.goto)));
};

function tile(emoji, t, d, goto) {
  return `<button class="action-tile" data-goto="${goto}">
    <span class="emoji">${emoji}</span>
    <span class="t">${t}</span><span class="d">${d}</span></button>`;
}

VIEWS.book = function () {
  const c = activeChild();
  const root = $("#view-book");
  const canBook = c && (c.extraLessonCredits > 0 || c.bonusCredits > 0);
  root.innerHTML = `
    <div class="panel">
      <h3>Your credits — ${esc(c?.childName || "")}</h3>
      <div class="credit-row">
        <div class="credit"><div class="num">${c?.extraLessonCredits ?? 0}</div><div class="lbl">Extra Lesson Credits</div></div>
        <div class="credit"><div class="num">${c?.bonusCredits ?? 0}</div><div class="lbl">Bonus Credits</div></div>
      </div>
      ${canBook
        ? `<p class="hint" style="text-align:left">Pick a class slot and a date below. One credit is used per booking (Extra Lesson Credits are used first).</p>`
        : `<div class="badge amber" style="margin-top:12px">No credits available — you can't book an extra class right now.</div>`}
    </div>
    ${canBook ? bookingUI(c) : `<div class="empty">Contact us if you think this is a mistake.</div>`}
  `;
  if (canBook) wireBooking(c);
};

function bookingUI(c) {
  return `
    <div class="panel">
      <h3>Choose a class</h3>
      <label class="section-label" style="margin-top:0">Location</label>
      <select id="book-loc"></select>
      <div class="spacer"></div>
      <label class="section-label">Date of extra class</label>
      <input id="book-date" type="date" />
      <div class="spacer"></div>
      <div id="book-slots"><div class="loader">Loading slots…</div></div>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="book-submit" disabled>Book extra class</button>
    </div>`;
}

async function wireBooking(c) {
  const slotsBox = $("#book-slots");
  const locSel = $("#book-loc");
  const dateInput = $("#book-date");
  const submit = $("#book-submit");
  let selectedSlot = null;

  const tt = await loadTimetable();
  const locations = [...new Set(tt.map((s) => s.pool).filter(Boolean))].sort();
  locSel.innerHTML = `<option value="">All locations</option>` +
    locations.map((l) => `<option ${l === c.location ? "selected" : ""}>${esc(l)}</option>`).join("");

  function paint() {
    const loc = locSel.value;
    const list = tt.filter((s) => !loc || s.pool === loc);
    if (!list.length) { slotsBox.innerHTML = `<div class="empty">No slots found.</div>`; return; }
    slotsBox.innerHTML = list.map((s) => slotRow(s)).join("");
    slotsBox.querySelectorAll(".slot").forEach((row) => {
      row.onclick = () => {
        slotsBox.querySelectorAll(".slot").forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected");
        selectedSlot = row.dataset.id;
        updateBtn();
      };
    });
  }
  function updateBtn() { submit.disabled = !(selectedSlot && dateInput.value); }

  locSel.onchange = () => { selectedSlot = null; paint(); updateBtn(); };
  dateInput.onchange = updateBtn;
  paint();

  submit.onclick = async () => {
    submit.disabled = true; submit.textContent = "Booking…";
    try {
      const r = await api("/book-extra", { method: "POST", body: { childId: c.id, slotId: selectedSlot, date: dateInput.value } });
      toast(`Booked! Credit used: ${r.deductedFrom}.`, "ok");
      await refreshChildren();
      switchView("home");
    } catch (e) {
      toast(e.message, "err");
      submit.disabled = false; submit.textContent = "Book extra class";
    }
  };
}

function slotRow(s) {
  return `<div class="slot" data-id="${s.id}">
    <div><div class="title">${esc(s.day || "")} · ${esc(s.timeslot || "")}</div>
    <div class="meta">${esc(s.pool || "")}${s.coach ? " · Coach " + esc(s.coach) : ""}${s.category ? " · " + esc(s.category) : ""}</div></div>
    <div class="badge blue">Select</div>
  </div>`;
}

VIEWS.schedule = function () {
  const c = activeChild();
  const root = $("#view-schedule");
  root.innerHTML = `
    <div class="panel">
      <h3>Current class — ${esc(c?.childName || "")}</h3>
      <div class="kv"><span class="k">Day & time</span><span class="v">${esc((c?.lessonDay || []).join(", ") || "—")} ${esc((c?.timeslot || []).join(", "))}</span></div>
      <div class="kv"><span class="k">Location</span><span class="v">${esc(c?.location || "—")}</span></div>
      <div class="kv"><span class="k">Coach</span><span class="v">${esc(c?.coach || "—")}</span></div>
    </div>
    <div class="panel">
      <h3>Move to a new slot</h3>
      <label class="section-label" style="margin-top:0">Location</label>
      <select id="ch-loc"></select>
      <div class="spacer"></div>
      <label class="section-label">Effective from</label>
      <input id="ch-date" type="date" />
      <div class="spacer"></div>
      <div id="ch-slots"><div class="loader">Loading slots…</div></div>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="ch-submit" disabled>Confirm schedule change</button>
    </div>`;
  wireSchedule(c);
};

async function wireSchedule(c) {
  const slotsBox = $("#ch-slots");
  const locSel = $("#ch-loc");
  const dateInput = $("#ch-date");
  const submit = $("#ch-submit");
  let selected = null;

  const tt = await loadTimetable();
  const locations = [...new Set(tt.map((s) => s.pool).filter(Boolean))].sort();
  locSel.innerHTML = `<option value="">All locations</option>` +
    locations.map((l) => `<option ${l === c?.location ? "selected" : ""}>${esc(l)}</option>`).join("");

  function paint() {
    const loc = locSel.value;
    const list = tt.filter((s) => !loc || s.pool === loc);
    slotsBox.innerHTML = list.length ? list.map(slotRow).join("") : `<div class="empty">No slots found.</div>`;
    slotsBox.querySelectorAll(".slot").forEach((row) => {
      row.onclick = () => {
        slotsBox.querySelectorAll(".slot").forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected");
        selected = row.dataset.id; upd();
      };
    });
  }
  function upd() { submit.disabled = !(selected && dateInput.value); }
  locSel.onchange = () => { selected = null; paint(); upd(); };
  dateInput.onchange = upd;
  paint();

  submit.onclick = async () => {
    submit.disabled = true; submit.textContent = "Submitting…";
    try {
      await api("/change-class", { method: "POST", body: { childId: c.id, slotId: selected, effectiveDate: dateInput.value } });
      toast("Schedule change confirmed.", "ok");
      await refreshChildren();
      switchView("home");
    } catch (e) {
      toast(e.message, "err");
      submit.disabled = false; submit.textContent = "Confirm schedule change";
    }
  };
}

VIEWS.payment = async function () {
  const root = $("#view-payment");
  root.innerHTML = `<div class="loader">Loading payment details…</div>`;
  try {
    const data = await api("/payment");
    root.innerHTML = data.children.map((c) => `
      <div class="panel">
        <h3>${esc(c.childName)}</h3>
        <div class="kv"><span class="k">Paid term start</span><span class="v">${fmtDate(c.paidTermStart) || "—"}</span></div>
        <div class="kv"><span class="k">Paid term end</span><span class="v">${fmtDate(c.paidTermEnd) || "—"}</span></div>
        <div class="spacer"></div>
        ${c.stripeUrl
          ? `<a class="btn btn-primary" href="${esc(c.stripeUrl)}" target="_blank" rel="noopener">Open payment page</a>`
          : `<div class="badge amber">No payment link available yet.</div>`}
      </div>
    `).join("") || `<div class="empty">No payment records.</div>`;
  } catch (e) { root.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};

VIEWS.progress = async function () {
  const c = activeChild();
  const root = $("#view-progress");
  root.innerHTML = `
    <div class="panel">
      <h3>${esc(c?.childName || "")}</h3>
      <div class="kv"><span class="k">Current test level</span><span class="v">${esc(c?.testLevel || "—")}</span></div>
      <div class="kv"><span class="k">Latest result</span><span class="v">${esc(c?.testResult || "—")}</span></div>
      <div class="spacer"></div>
      <div class="section-label" style="margin-top:0">Certificates</div>
      <div>${(c?.certificates || []).length ? c.certificates.map((x) => `<span class="tag">${esc(x)}</span>`).join("") : `<span class="muted">No certificates recorded yet.</span>`}</div>
    </div>
    <div class="panel">
      <h3>Attendance history</h3>
      <div id="att-box"><div class="loader">Loading…</div></div>
    </div>`;
  try {
    const data = await api("/attendance?childId=" + encodeURIComponent(c.id));
    const box = $("#att-box");
    if (!data.attendance.length) { box.innerHTML = `<div class="empty">No attendance records yet.</div>`; return; }
    box.innerHTML = data.attendance.map((a) => `
      <div class="att-row">
        <div><div style="font-weight:600">${fmtDate(a.date) || "—"}</div>
        <div class="d">${esc([a.day, a.time, a.location].filter(Boolean).join(" · "))}${a.coach ? " · Coach " + esc(a.coach) : ""}</div></div>
        ${a.present ? `<span class="badge green">Present</span>` : a.absent ? `<span class="badge red">Absent</span>` : `<span class="badge blue">—</span>`}
      </div>`).join("");
  } catch (e) { $("#att-box").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};

VIEWS.support = function () {
  const c = activeChild();
  const root = $("#view-support");
  const TYPES = [
    "Operations (Service, TnC, Regulations, Lesson Arrangement))",
    "Coach (Onsite, LA, PCC, Progression, Attitude of Coaches, Inappropriate actions, Curriculum, Can't find Coach, etc)",
    "Accounts (Refund, Error Amount, Invoices, Receipt, etc)",
    "Marketing (PDPA, Ad and postings related issues, etc)",
    "Management (Pool, Locations, Rates, etc) ",
    "Call Request",
    "Equipment",
  ];
  const shortLabel = (t) => t.split("(")[0].trim();
  const selected = new Set();
  root.innerHTML = `
    <div class="panel">
      <h3>Submit an issue or request</h3>
      <p class="hint" style="text-align:left">For ${esc(c?.childName || "your child")}. Our team will follow up with you.</p>
      <div class="section-label" style="margin-top:6px">Category (optional)</div>
      <div class="pills" id="ticket-types">
        ${TYPES.map((t, i) => `<button type="button" class="pill" data-i="${i}">${esc(shortLabel(t))}</button>`).join("")}
      </div>
      <div class="spacer"></div>
      <label class="section-label">Describe your issue *</label>
      <textarea id="ticket-concerns" placeholder="Tell us what's happening…"></textarea>
      <div class="spacer"></div>
      <label class="section-label">Suggestions (optional)</label>
      <textarea id="ticket-suggest" style="min-height:70px" placeholder="Anything we could do better?"></textarea>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="ticket-submit">Submit ticket</button>
    </div>`;
  root.querySelectorAll("#ticket-types .pill").forEach((p) => {
    p.onclick = () => {
      const t = TYPES[+p.dataset.i];
      if (selected.has(t)) { selected.delete(t); p.classList.remove("on"); }
      else { selected.add(t); p.classList.add("on"); }
    };
  });
  $("#ticket-submit").onclick = async () => {
    const concerns = $("#ticket-concerns").value.trim();
    if (!concerns) return toast("Please describe your issue.", "err");
    const btn = $("#ticket-submit"); btn.disabled = true; btn.textContent = "Submitting…";
    try {
      await api("/ticket", { method: "POST", body: {
        childId: c.id, complaintTypes: [...selected], concerns, suggestions: $("#ticket-suggest").value.trim(),
      }});
      toast("Ticket submitted. We'll be in touch.", "ok");
      switchView("home");
    } catch (e) {
      toast(e.message, "err"); btn.disabled = false; btn.textContent = "Submit ticket";
    }
  };
};

VIEWS.notices = async function () {
  const root = $("#view-notices");
  root.innerHTML = `<div class="loader">Loading notices…</div>`;
  try {
    const data = await api("/announcements");
    const notices = (data.announcements || []).map((a) => `
      <div class="panel">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <h3 style="margin:0">${esc(a.title || "Notice")}</h3>
          ${a.priority ? `<span class="badge ${/high|urgent/i.test(a.priority) ? "red" : "blue"}">${esc(a.priority)}</span>` : ""}
        </div>
        <div class="muted" style="font-size:12px;margin:4px 0 8px">${fmtDate(a.date) || ""}</div>
        <div style="white-space:pre-wrap">${esc(a.body || "")}</div>
      </div>`).join("");
    const pool = (data.pool || []).length ? `
      <div class="section-label">Pool status</div>
      ${data.pool.map((p) => `
        <div class="panel">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <strong>${esc(p.location || "Pool")}</strong>
            <span class="badge ${/open|yes/i.test(p.canEnter || p.status || "") ? "green" : "amber"}">${esc(p.status || p.canEnter || "—")}</span>
          </div>
          ${p.timing ? `<div class="muted" style="font-size:13px;margin-top:6px">${esc(p.timing)}</div>` : ""}
          ${p.remarks ? `<div style="font-size:13px;margin-top:4px">${esc(p.remarks)}</div>` : ""}
        </div>`).join("")}` : "";
    root.innerHTML = (notices || pool) ? (notices + pool) : `<div class="empty">No notices right now.</div>`;
  } catch (e) { root.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};

VIEWS.more = function () {
  const root = $("#view-more");
  root.innerHTML = `
    <div class="actions-grid">
      ${tile("📈", "Progress & Tests", "Levels & certs", "progress")}
      ${tile("💬", "Support", "Raise an issue", "support")}
      ${tile("📣", "Notices", "News & pool status", "notices")}
      ${tile("⏸️", "Pause / Resume", "Manage lessons", "__pause")}
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>Account</h3>
      <div class="kv"><span class="k">Signed in as</span><span class="v">${esc(state.parentName)}</span></div>
      <div class="spacer"></div>
      <button class="btn btn-danger" id="more-logout">Log out</button>
    </div>`;
  root.querySelectorAll("[data-goto]").forEach((b) => {
    b.onclick = () => (b.dataset.goto === "__pause" ? openPauseModal() : switchView(b.dataset.goto));
  });
  $("#more-logout").onclick = logout;
};

// ---------- pause / resume modal ----------
function openPauseModal() {
  const c = activeChild();
  const backdrop = $("#modal-backdrop");
  const modal = $("#modal");
  modal.innerHTML = `
    <h3>Pause / Resume — ${esc(c?.childName || "")}</h3>
    <label class="section-label" style="margin-top:0">Request type</label>
    <select id="pr-type">
      <option value="pause (paid)">Pause lessons (paid up)</option>
      <option value="pause (not paid)">Pause lessons (not paid)</option>
      <option value="resume">Resume / rejoin lessons</option>
      <option value="quit">Quit lessons</option>
    </select>
    <div class="spacer"></div>
    <div id="pr-reason-wrap">
      <label class="section-label" style="margin-top:0">Reason</label>
      <select id="pr-reason">${state.pauseReasons.map((r) => `<option>${esc(r)}</option>`).join("")}</select>
      <div class="spacer"></div>
    </div>
    <label class="section-label" style="margin-top:0" id="pr-msg-label">Message (optional)</label>
    <textarea id="pr-msg" style="min-height:80px" placeholder="Anything you'd like to add…"></textarea>
    <div class="spacer"></div>
    <button class="btn btn-primary" id="pr-submit">Submit request</button>
    <div class="spacer"></div>
    <button class="btn btn-ghost" id="pr-cancel">Cancel</button>
  `;
  backdrop.hidden = false;
  const typeSel = $("#pr-type");
  const reasonWrap = $("#pr-reason-wrap");
  const msgLabel = $("#pr-msg-label");
  typeSel.onchange = () => {
    const resume = typeSel.value === "resume";
    reasonWrap.style.display = resume ? "none" : "block";
    msgLabel.textContent = resume ? "Preferred resume date (YYYY-MM-DD) or message" : "Message (optional)";
  };
  $("#pr-cancel").onclick = () => (backdrop.hidden = true);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.hidden = true; };
  $("#pr-submit").onclick = async () => {
    const btn = $("#pr-submit"); btn.disabled = true; btn.textContent = "Submitting…";
    try {
      await api("/pause-resume", { method: "POST", body: {
        childId: c.id, type: typeSel.value,
        reason: typeSel.value === "resume" ? undefined : $("#pr-reason").value,
        message: $("#pr-msg").value.trim(),
      }});
      backdrop.hidden = true;
      toast("Request submitted. Our team will follow up.", "ok");
      await refreshChildren();
      switchView("home");
    } catch (e) {
      toast(e.message, "err"); btn.disabled = false; btn.textContent = "Submit request";
    }
  };
}

// ---------- data helpers ----------
async function loadTimetable() {
  if (state.timetable) return state.timetable;
  const data = await api("/timetable");
  state.timetable = data.slots || [];
  return state.timetable;
}
async function refreshChildren() {
  const me = await api("/me");
  state.children = me.children || [];
  if (!state.children.find((c) => c.id === state.activeChildId)) state.activeChildId = state.children[0]?.id || null;
  renderChildSwitcher();
}

function enrolBadge(status) {
  if (!status) return "";
  const s = status.toLowerCase();
  const cls = s.includes("enrol") ? "green" : s.includes("pause") ? "amber" : s.includes("quit") ? "red" : "blue";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ---------- wiring ----------
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#login-btn"); const err = $("#login-error");
  err.hidden = true;
  btn.disabled = true; btn.textContent = "Logging in…";
  try {
    await doLogin($("#phone").value);
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Log in";
  }
});
$("#logout-btn").addEventListener("click", logout);
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));

// auto-login if a valid token is stored
(async function init() {
  const t = loadSession();
  if (t) {
    state.token = t;
    try { await bootApp(); } catch { logout(); }
  }
})();
