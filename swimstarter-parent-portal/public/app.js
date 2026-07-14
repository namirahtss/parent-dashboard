// TheSwimStarter Parent Portal — frontend (v2)
const state = {
  token: null, parentName: "", children: [], activeChildId: null,
  view: "home", pauseReasons: [], slotsCache: {},
};

const $ = (s, r = document) => r.querySelector(s);
const el = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function saveSession() { try { localStorage.setItem("tss_token", state.token || ""); } catch {} }
function loadSession() { try { return localStorage.getItem("tss_token") || null; } catch { return null; } }
function clearSession() { try { localStorage.removeItem("tss_token"); } catch {} }

function toast(msg, kind = "") {
  const t = $("#toast"); t.textContent = msg; t.className = "toast " + kind; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3400);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method, headers: { "Content-Type": "application/json", ...(state.token ? { Authorization: "Bearer " + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await res.json(); } catch {}
  if (res.status === 401) { logout(); throw new Error(data.error || "Session expired"); }
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

const activeChild = () => state.children.find((c) => c.id === state.activeChildId) || state.children[0] || null;

// ---------- auth ----------
async function doLogin(phone) {
  const data = await api("/login", { method: "POST", body: { phone } });
  state.token = data.token; saveSession(); await bootApp();
}
function logout() {
  state.token = null; state.children = []; clearSession();
  $("#app-screen").classList.remove("active"); $("#login-screen").classList.add("active"); $("#phone").value = "";
}
async function bootApp() {
  const me = await api("/me");
  state.parentName = me.parentName || "Parent"; state.children = me.children || [];
  state.activeChildId = state.children[0]?.id || null;
  try { state.pauseReasons = (await api("/pause-reasons")).reasons || []; } catch {}
  $("#login-screen").classList.remove("active"); $("#app-screen").classList.add("active");
  $("#hello").textContent = "Hello, " + (state.parentName || "Parent");
  const su = $("#side-user"); if (su) su.textContent = state.parentName || "Parent";
  renderChildSwitcher(); switchView("home");
}

function renderChildSwitcher() {
  const wrap = $("#child-switcher");
  if (state.children.length <= 1) { wrap.hidden = true; return; }
  wrap.hidden = false; wrap.innerHTML = "";
  state.children.forEach((c) => {
    const b = el(`<button class="chip ${c.id === state.activeChildId ? "active" : ""}">${esc(c.childName || "Child")}</button>`);
    b.onclick = () => { state.activeChildId = c.id; renderChildSwitcher(); renderView(); };
    wrap.appendChild(b);
  });
}

const TITLES = { home: "Home", book: "Class Booking", schedule: "Class Schedule", payment: "Payment", more: "More" };
function switchView(view) {
  state.view = view; $("#page-title").textContent = TITLES[view] || "";
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("#view-" + view)?.classList.add("active");
  document.querySelectorAll(".navbtn").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  window.scrollTo(0, 0); renderView();
}
function renderView() { VIEWS[state.view]?.(); }
const VIEWS = {};

// ---------- HOME: notices + editable profile + read-only stage/progress/attendance ----------
VIEWS.home = async function () {
  const c = activeChild(); const root = $("#view-home");
  if (!c) { root.innerHTML = `<div class="empty">No enrolment found.</div>`; return; }
  root.innerHTML = `
    <div id="home-notices"></div>
    <div class="section-label">My child</div>
    <div class="panel" id="profile-panel"></div>
    <div class="section-label">Progress &amp; level</div>
    <div class="panel" id="progress-panel">
      <div class="kv"><span class="k">Current stage / level</span><span class="v">${esc(c.testLevel || "—")}</span></div>
      <div class="kv"><span class="k">Latest test result</span><span class="v">${esc(c.testResult || "—")}</span></div>
      <div class="kv"><span class="k">Coach</span><span class="v">${esc(c.coach || "—")}</span></div>
      <div class="kv"><span class="k">Class</span><span class="v">${esc((c.lessonDay||[]).join(", ")||"—")} ${esc((c.timeslot||[]).join(", "))}</span></div>
      <div style="margin-top:10px" class="section-label" >Certificates</div>
      <div>${(c.certificates||[]).length ? c.certificates.map((x)=>`<span class="tag">${esc(x)}</span>`).join("") : `<span class="muted">None recorded yet.</span>`}</div>
    </div>
    <div class="section-label">Attendance</div>
    <div class="panel" id="att-panel"><div class="loader">Loading…</div></div>`;
  renderProfilePanel(c);
  loadNoticesInto("#home-notices", true);
  loadAttendanceInto("#att-panel", c);
};

function renderProfilePanel(c, editing = false) {
  const p = $("#profile-panel"); if (!p) return;
  if (!editing) {
    p.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <h3 style="margin:0">${esc(c.childName)}</h3>
        ${enrolBadge(c.enrolmentStatus)}
      </div>
      <div class="kv"><span class="k">Age</span><span class="v">${c.age != null ? c.age + " yrs" : "—"}${c.dob ? " · " + fmtDate(c.dob) : ""}</span></div>
      <div class="kv"><span class="k">Location</span><span class="v">${esc(c.location || "—")}</span></div>
      <div class="kv"><span class="k">Phone number</span><span class="v">${esc(c.phoneNumber || "—")}</span></div>
      <div class="kv"><span class="k">Alt. phone</span><span class="v">${esc(c.altNumber || "—")}</span></div>
      <div class="kv"><span class="k">Parent name</span><span class="v">${esc(c.parentName || "—")}</span></div>
      <div class="spacer"></div>
      <button class="btn btn-ghost" id="edit-profile">Edit details</button>`;
    $("#edit-profile").onclick = () => renderProfilePanel(c, true);
  } else {
    p.innerHTML = `
      <h3 style="margin-top:0">Edit details</h3>
      <label class="section-label" style="margin-top:0">Child's name</label>
      <input id="pf-name" value="${esc(c.childName || "")}" />
      <div class="spacer"></div>
      <label class="section-label">Date of birth</label>
      <input id="pf-dob" type="date" value="${esc(c.dob || "")}" />
      <div class="spacer"></div>
      <label class="section-label">Phone number</label>
      <input id="pf-phone" type="tel" inputmode="numeric" value="${esc(c.phoneNumber || "")}" />
      <div class="spacer"></div>
      <label class="section-label">Alternate phone</label>
      <input id="pf-alt" type="tel" inputmode="numeric" value="${esc(c.altNumber || "")}" />
      <div class="spacer"></div>
      <label class="section-label">Parent name</label>
      <input id="pf-parent" value="${esc(c.parentName || "")}" />
      <div class="hint" style="text-align:left">Note: changing the phone number changes the number you log in with.</div>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="pf-save">Save changes</button>
      <div class="spacer"></div>
      <button class="btn btn-ghost" id="pf-cancel">Cancel</button>`;
    $("#pf-cancel").onclick = () => renderProfilePanel(activeChild(), false);
    $("#pf-save").onclick = async () => {
      const btn = $("#pf-save"); btn.disabled = true; btn.textContent = "Saving…";
      try {
        const r = await api("/profile", { method: "POST", body: {
          childId: c.id, childName: $("#pf-name").value, dob: $("#pf-dob").value,
          phoneNumber: $("#pf-phone").value, altNumber: $("#pf-alt").value, parentName: $("#pf-parent").value,
        }});
        const idx = state.children.findIndex((x) => x.id === c.id);
        if (idx >= 0 && r.child) state.children[idx] = r.child;
        toast("Details saved.", "ok"); renderChildSwitcher(); renderProfilePanel(r.child || activeChild(), false);
      } catch (e) { toast(e.message, "err"); btn.disabled = false; btn.textContent = "Save changes"; }
    };
  }
}

async function loadAttendanceInto(sel, c) {
  const box = $(sel); if (!box) return;
  try {
    const data = await api("/attendance?childId=" + encodeURIComponent(c.id));
    if (!data.attendance.length) { box.innerHTML = `<div class="empty">No attendance records yet.</div>`; return; }
    box.innerHTML = data.attendance.map((a) => `
      <div class="att-row">
        <div><div style="font-weight:600">${fmtDate(a.date) || "—"}</div>
        <div class="d">${esc([a.day, a.time, a.location].filter(Boolean).join(" · "))}${a.coach ? " · Coach " + esc(a.coach) : ""}</div></div>
        ${a.present ? `<span class="badge green">Present</span>` : a.absent ? `<span class="badge red">Absent</span>` : `<span class="badge blue">—</span>`}
      </div>`).join("");
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function loadNoticesInto(sel, compact = false) {
  const box = $(sel); if (!box) return;
  box.innerHTML = `<div class="section-label" style="margin-top:0">Announcements</div><div class="panel"><div class="loader">Loading…</div></div>`;
  try {
    const data = await api("/announcements");
    let html = `<div class="section-label" style="margin-top:0">Announcements</div>`;
    const items = compact ? (data.announcements || []).slice(0, 3) : (data.announcements || []);
    if (!items.length && !(data.pool || []).length) { box.innerHTML = html + `<div class="panel"><div class="empty">No notices right now.</div></div>`; return; }
    items.forEach((a) => {
      html += `<div class="panel">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <strong>${esc(a.title || "Notice")}</strong>
          ${a.priority ? `<span class="badge ${/high|urgent/i.test(a.priority) ? "red" : "blue"}">${esc(a.priority)}</span>` : ""}
        </div>
        <div class="muted" style="font-size:12px;margin:4px 0 6px">${fmtDate(a.date) || ""}</div>
        <div style="white-space:pre-wrap">${esc(a.body || "")}</div></div>`;
    });
    if ((data.pool || []).length) {
      html += `<div class="section-label">Pool status</div>`;
      data.pool.forEach((p) => {
        html += `<div class="panel"><div style="display:flex;justify-content:space-between;gap:8px">
          <strong>${esc(p.location || "Pool")}</strong>
          <span class="badge ${/open|yes/i.test(p.canEnter || p.status || "") ? "green" : "amber"}">${esc(p.status || p.canEnter || "—")}</span></div>
          ${p.timing ? `<div class="muted" style="font-size:13px;margin-top:6px">${esc(p.timing)}</div>` : ""}
          ${p.remarks ? `<div style="font-size:13px;margin-top:4px">${esc(p.remarks)}</div>` : ""}</div>`;
      });
    }
    box.innerHTML = html;
  } catch (e) { box.innerHTML = `<div class="panel"><div class="empty">${esc(e.message)}</div></div>`; }
}

// ---------- CLASS BOOKING: day -> date -> timeslot(slots left) ----------
VIEWS.book = async function () {
  const c = activeChild(); const root = $("#view-book");
  const canBook = c && (c.extraLessonCredits > 0 || c.bonusCredits > 0);
  root.innerHTML = `
    <div class="panel">
      <h3>Your credits — ${esc(c?.childName || "")}</h3>
      <div class="credit-row">
        <div class="credit"><div class="num">${c?.extraLessonCredits ?? 0}</div><div class="lbl">Extra Lesson Credits</div></div>
        <div class="credit"><div class="num">${c?.bonusCredits ?? 0}</div><div class="lbl">Bonus Credits</div></div>
      </div>
      ${canBook ? `<p class="hint" style="text-align:left">Choose a day, then a date (within 2 weeks), then a timeslot. One credit is used per class (Extra Lesson Credits first).</p>`
                : `<div class="badge amber" style="margin-top:12px">No credits available — you can't book an extra class right now.</div>`}
    </div>
    ${canBook ? bookingFormHTML("bk") : ""}`;
  if (canBook) wireBookingForm("bk", c, "book", async (payload) => {
    const r = await api("/book-extra", { method: "POST", body: payload });
    toast(`Booked! Credit used: ${r.deductedFrom}.`, "ok");
    await refreshChildren(); switchView("home");
  });
};

// ---------- CLASS SCHEDULE: current class + request change ----------
VIEWS.schedule = async function () {
  const c = activeChild(); const root = $("#view-schedule");
  root.innerHTML = `
    <div class="panel">
      <h3>Current class — ${esc(c?.childName || "")}</h3>
      <div class="kv"><span class="k">Day &amp; time</span><span class="v">${esc((c?.lessonDay||[]).join(", ")||"—")} ${esc((c?.timeslot||[]).join(", "))}</span></div>
      <div class="kv"><span class="k">Location</span><span class="v">${esc(c?.location || "—")}</span></div>
      <div class="kv"><span class="k">Coach</span><span class="v">${esc(c?.coach || "—")}</span></div>
    </div>
    <div class="panel">
      <h3>Request a class change</h3>
      <p class="hint" style="text-align:left">Pick your new day, timeslot and the date it should take effect. Your current class stays active until the effective date.</p>
      ${bookingFormHTML("ch", true)}
    </div>`;
  wireBookingForm("ch", c, "change", async (payload) => {
    await api("/change-class", { method: "POST", body: { childId: payload.childId, day: payload.day, timeslot: payload.timeslot, effectiveDate: payload.effectiveDate } });
    toast("Class change submitted.", "ok");
    await refreshChildren(); switchView("home");
  }, true);
};

// Shared booking form markup. mode "ch" adds an effective-date field instead of a class date.
function bookingFormHTML(id, isChange = false) {
  return `
    <div class="panel">
      <label class="section-label" style="margin-top:0">Day</label>
      <select id="${id}-day"><option value="">Select a day…</option></select>
      <div class="spacer"></div>
      ${isChange
        ? `<label class="section-label">Effective from</label><input id="${id}-eff" type="date" />`
        : `<label class="section-label">Date</label><select id="${id}-date"><option value="">Select a day first…</option></select>`}
      <div class="spacer"></div>
      <label class="section-label">Timeslot</label>
      <div id="${id}-slots"><div class="muted" style="font-size:14px">Select a day to see timeslots.</div></div>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="${id}-submit" disabled>${isChange ? "Confirm class change" : "Book extra class"}</button>
    </div>`;
}

async function wireBookingForm(id, child, scope, onSubmit, isChange = false) {
  const daySel = $(`#${id}-day`), slotsBox = $(`#${id}-slots`), submit = $(`#${id}-submit`);
  const dateSel = isChange ? null : $(`#${id}-date`);
  const effInput = isChange ? $(`#${id}-eff`) : null;
  let chosen = { day: "", date: "", timeslot: "" };

  if (effInput) { effInput.min = new Date(Date.now() + 864e5).toISOString().slice(0, 10); }

  let data;
  try { data = await loadSlots(child.id, scope); }
  catch (e) { slotsBox.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  if (!data.days.length) { daySel.innerHTML = `<option value="">No slots available</option>`; slotsBox.innerHTML = `<div class="empty">No open slots right now. Please check back later.</div>`; return; }

  daySel.innerHTML = `<option value="">Select a day…</option>` + data.days.map((d) => `<option value="${esc(d.day)}">${esc(d.day)}</option>`).join("");

  function paintTimeslots(dayObj) {
    if (!dayObj) { slotsBox.innerHTML = ""; return; }
    slotsBox.innerHTML = dayObj.timeslots.map((t) => {
      const full = t.slotsLeft <= 0;
      return `<div class="slot ${full ? "disabled" : ""}" data-ts="${esc(t.timeslot)}">
        <div><div class="title">${esc(t.timeslot)}</div><div class="meta">${esc(t.pool || "")}</div></div>
        <span class="badge ${full ? "red" : t.slotsLeft <= 3 ? "amber" : "green"}">${full ? "Full" : t.slotsLeft + " / " + (t.cap || 10) + " left"}</span>
      </div>`;
    }).join("");
    slotsBox.querySelectorAll(".slot").forEach((row) => {
      if (row.classList.contains("disabled")) return;
      row.onclick = () => {
        slotsBox.querySelectorAll(".slot").forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected"); chosen.timeslot = row.dataset.ts; update();
      };
    });
  }
  function update() {
    const dateOk = isChange ? !!effInput.value : !!chosen.date;
    submit.disabled = !(chosen.day && dateOk && chosen.timeslot);
  }

  daySel.onchange = () => {
    chosen = { day: daySel.value, date: "", timeslot: "" };
    const dayObj = data.days.find((d) => d.day === daySel.value);
    if (dateSel) {
      dateSel.innerHTML = dayObj
        ? `<option value="">Select a date…</option>` + dayObj.dates.map((d) => `<option value="${d}">${fmtDate(d)}</option>`).join("")
        : `<option value="">Select a day first…</option>`;
    }
    paintTimeslots(dayObj); update();
  };
  if (dateSel) dateSel.onchange = () => { chosen.date = dateSel.value; update(); };
  if (effInput) effInput.onchange = update;

  submit.onclick = async () => {
    submit.disabled = true; const label = submit.textContent; submit.textContent = "Submitting…";
    try {
      await onSubmit({ childId: child.id, day: chosen.day, timeslot: chosen.timeslot, date: chosen.date, effectiveDate: effInput ? effInput.value : undefined });
    } catch (e) { toast(e.message, "err"); submit.disabled = false; submit.textContent = label; }
  };
}

async function loadSlots(childId, scope) {
  const key = childId + ":" + scope;
  const data = await api(`/slots?childId=${encodeURIComponent(childId)}&scope=${scope}`);
  state.slotsCache[key] = data; return data;
}

// ---------- PAYMENT ----------
VIEWS.payment = async function () {
  const root = $("#view-payment"); root.innerHTML = `<div class="loader">Loading payment details…</div>`;
  try {
    const data = await api("/payment");
    root.innerHTML = data.children.map((c) => `
      <div class="panel">
        <h3>${esc(c.childName)}</h3>
        <div class="kv"><span class="k">Paid term start</span><span class="v">${fmtDate(c.paidTermStart) || "—"}</span></div>
        <div class="kv"><span class="k">Paid term end</span><span class="v">${fmtDate(c.paidTermEnd) || "—"}</span></div>
        <div class="spacer"></div>
        ${c.stripeUrl ? `<a class="btn btn-primary" href="${esc(c.stripeUrl)}" target="_blank" rel="noopener">Open payment page</a>`
                      : `<div class="badge amber">No payment link available yet.</div>`}
      </div>`).join("") || `<div class="empty">No payment records.</div>`;
  } catch (e) { root.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};

// ---------- MORE: support + pause/resume ----------
VIEWS.more = function () {
  const c = activeChild(); const root = $("#view-more");
  const TYPES = [
    "Operations (Service, TnC, Regulations, Lesson Arrangement))",
    "Coach (Onsite, LA, PCC, Progression, Attitude of Coaches, Inappropriate actions, Curriculum, Can't find Coach, etc)",
    "Accounts (Refund, Error Amount, Invoices, Receipt, etc)",
    "Marketing (PDPA, Ad and postings related issues, etc)",
    "Management (Pool, Locations, Rates, etc) ", "Call Request", "Equipment",
  ];
  const shortLabel = (t) => t.split("(")[0].trim();
  const selected = new Set();
  root.innerHTML = `
    <div class="section-label" style="margin-top:0">Support</div>
    <div class="panel">
      <h3 style="margin-top:0">Raise an issue</h3>
      <p class="hint" style="text-align:left">For ${esc(c?.childName || "your child")}. Our team will follow up with you.</p>
      <div class="section-label" style="margin-top:6px">Category (optional)</div>
      <div class="pills" id="tk-types">${TYPES.map((t, i) => `<button type="button" class="pill" data-i="${i}">${esc(shortLabel(t))}</button>`).join("")}</div>
      <div class="spacer"></div>
      <label class="section-label">Describe your issue *</label>
      <textarea id="tk-concerns" placeholder="Tell us what's happening…"></textarea>
      <div class="spacer"></div>
      <label class="section-label">Suggestions (optional)</label>
      <textarea id="tk-suggest" style="min-height:70px" placeholder="Anything we could do better?"></textarea>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="tk-submit">Submit ticket</button>
    </div>
    <div class="section-label">Lessons</div>
    <div class="panel">
      <h3 style="margin-top:0">Pause / Resume / Quit</h3>
      <p class="hint" style="text-align:left">Request to pause, resume or quit lessons. <strong>Your request is not final</strong> — it will be reviewed and confirmed by our admin team, who will be in touch.</p>
      <button class="btn btn-ghost" id="open-pause">Make a pause / resume request</button>
    </div>
    <div class="panel">
      <div class="kv"><span class="k">Signed in as</span><span class="v">${esc(state.parentName)}</span></div>
      <div class="spacer"></div>
      <button class="btn btn-danger" id="more-logout">Log out</button>
    </div>`;
  root.querySelectorAll("#tk-types .pill").forEach((p) => {
    p.onclick = () => { const t = TYPES[+p.dataset.i]; if (selected.has(t)) { selected.delete(t); p.classList.remove("on"); } else { selected.add(t); p.classList.add("on"); } };
  });
  $("#tk-submit").onclick = async () => {
    const concerns = $("#tk-concerns").value.trim();
    if (!concerns) return toast("Please describe your issue.", "err");
    const btn = $("#tk-submit"); btn.disabled = true; btn.textContent = "Submitting…";
    try {
      await api("/ticket", { method: "POST", body: { childId: c.id, complaintTypes: [...selected], concerns, suggestions: $("#tk-suggest").value.trim() } });
      toast("Ticket submitted. We'll be in touch.", "ok"); switchView("home");
    } catch (e) { toast(e.message, "err"); btn.disabled = false; btn.textContent = "Submit ticket"; }
  };
  $("#open-pause").onclick = openPauseModal;
  $("#more-logout").onclick = logout;
};

function openPauseModal() {
  const c = activeChild(); const backdrop = $("#modal-backdrop"); const modal = $("#modal");
  modal.innerHTML = `
    <h3>Pause / Resume — ${esc(c?.childName || "")}</h3>
    <div class="badge amber" style="margin-bottom:10px">Requests are confirmed by our admin team after review.</div>
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
    <button class="btn btn-ghost" id="pr-cancel">Cancel</button>`;
  backdrop.hidden = false; backdrop.classList.add("show");
  const typeSel = $("#pr-type"), reasonWrap = $("#pr-reason-wrap"), msgLabel = $("#pr-msg-label");
  typeSel.onchange = () => {
    const resume = typeSel.value === "resume";
    reasonWrap.style.display = resume ? "none" : "block";
    msgLabel.textContent = resume ? "Preferred resume date (YYYY-MM-DD) or message" : "Message (optional)";
  };
  const close = () => { backdrop.hidden = true; backdrop.classList.remove("show"); };
  $("#pr-cancel").onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  $("#pr-submit").onclick = async () => {
    const btn = $("#pr-submit"); btn.disabled = true; btn.textContent = "Submitting…";
    try {
      await api("/pause-resume", { method: "POST", body: { childId: c.id, type: typeSel.value,
        reason: typeSel.value === "resume" ? undefined : $("#pr-reason").value, message: $("#pr-msg").value.trim() } });
      close(); toast("Request submitted. Our admin team will confirm.", "ok"); await refreshChildren();
    } catch (e) { toast(e.message, "err"); btn.disabled = false; btn.textContent = "Submit request"; }
  };
}

// ---------- helpers ----------
async function refreshChildren() {
  const me = await api("/me"); state.children = me.children || [];
  if (!state.children.find((c) => c.id === state.activeChildId)) state.activeChildId = state.children[0]?.id || null;
  state.slotsCache = {}; renderChildSwitcher();
}
function enrolBadge(status) {
  if (!status) return ""; const s = status.toLowerCase();
  const cls = s.includes("enrol") ? "green" : s.includes("pause") ? "amber" : s.includes("quit") ? "red" : "blue";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}
function fmtDate(d) {
  if (!d) return ""; const dt = new Date(d); if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// ---------- wiring ----------
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const btn = $("#login-btn"), err = $("#login-error"); err.hidden = true;
  btn.disabled = true; btn.textContent = "Logging in…";
  try { await doLogin($("#phone").value); }
  catch (ex) { err.textContent = ex.message; err.hidden = false; }
  finally { btn.disabled = false; btn.textContent = "Log in"; }
});
$("#logout-btn").addEventListener("click", logout);
$("#side-logout")?.addEventListener("click", logout);
document.querySelectorAll(".navbtn").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));

(async function init() {
  const t = loadSession();
  if (t) { state.token = t; try { await bootApp(); } catch { logout(); } }
})();
