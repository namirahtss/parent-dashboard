// TheSwimStarter — Parent Portal backend (v2)
// Express + Airtable (Coach Portal Sandbox). Phone login, live reads/writes,
// capacity-based booking off empty Timetable rows, profile editing, daily rollover.

import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Airtable from "airtable";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID = "app0uSWJNEQnBZvbb",
  SESSION_SECRET = "dev-insecure-secret-change-me",
  SESSION_TTL_HOURS = "24",
  CRON_SECRET = "",
  PORT = 3000,
} = process.env;

if (!AIRTABLE_API_KEY) {
  console.error("\n[FATAL] AIRTABLE_API_KEY is not set. Copy .env.example to .env and fill it in.\n");
  process.exit(1);
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const T = {
  ENROLLED: "tblvqKw192z7IlPWk",
  TIMETABLE: "tblhDZijmCIlpkmOh",
  ISSUE: "tblmT005Qqc93fHr4",
  ELC_LOG: "tblFWCDdL7r6OIN0y",
  CLASS_CHANGE: "tbl0dhZEAP4Nim1hB",
  ATTENDANCE: "tbl3ud0Iscx6EP8UD",
  CHURN: "tblLj23NawaT1bYWi",
  ANNOUNCEMENTS: "tblL7jdyYTJmPlWkS",
  POOL_STATUS: "tbl3V8lYy4SfC406N",
};

const BOOK_WINDOW_DAYS = 14;   // parents can book up to 2 weeks ahead
const SLOT_CAP = 10;           // each timeslot capped at 10

const PAUSE_REASONS = [
  "Take a Break", "Medical Reason (short term)", "Medical Reason (long term)",
  "Lessons Schedule", "Personal Schedule", "Financial Issues", "Progress",
  "Holiday Period", "School Commitment", "Personal",
];

// Day-name (incl. abbreviations used in the base) -> JS weekday number (0=Sun)
const DAY_DOW = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
function normalizePhone(raw) {
  if (raw == null) return "";
  return String(raw).replace(/\D/g, "");
}
function firstVal(v) { return Array.isArray(v) ? v[0] : v; }
function asName(v) {
  const x = firstVal(v);
  if (x && typeof x === "object" && "name" in x) return x.name;
  return x ?? null;
}
function asNameList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => (x && typeof x === "object" && "name" in x ? x.name : x)).filter(Boolean);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function esc(s) { return String(s).replace(/'/g, "\\'"); }

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d)) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 120 ? a : null;
}

// dates within the next N days matching a given weekday name
function upcomingDatesForDay(dayName, days = BOOK_WINDOW_DAYS) {
  const dow = DAY_DOW[String(dayName || "").trim().toLowerCase()];
  if (dow === undefined) return [];
  const out = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = 1; i <= days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (d.getDay() === dow) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function selectAll(tableId, options) { return base(tableId).select(options).all(); }

// ---------- token auth ----------
function signToken(phone) {
  const payload = { phone, exp: Date.now() + Number(SESSION_TTL_HOURS) * 3600 * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const p = verifyToken(h.startsWith("Bearer ") ? h.slice(7) : "");
  if (!p) return res.status(401).json({ error: "Session expired. Please log in again." });
  req.phone = p.phone;
  next();
}

// ---------- data helpers ----------
async function enrolledForPhone(phone) {
  return selectAll(T.ENROLLED, { filterByFormula: `{Phone Number} = ${Number(phone)}` });
}
async function requireOwnedChild(childId, phone) {
  const rec = await base(T.ENROLLED).find(childId).catch(() => null);
  if (!rec) return null;
  if (normalizePhone(rec.get("Phone Number")) !== normalizePhone(phone)) return null;
  return rec;
}
function childCoach(rec) {
  return (
    asNameList(rec.get("Coach (from Timetable)"))[0] ||
    asNameList(rec.get("Surname (from Coach)"))[0] ||
    null
  );
}
function shapeChild(rec) {
  const stripe = rec.get("Stripe Payment");
  const dob = rec.get("DOB (Enrolled GCS)") || null;
  return {
    id: rec.id,
    childName: rec.get("Name of Child") || "",
    parentName: rec.get("Parent Name") || "",
    parentEmail: rec.get("Parent Email") || "",
    phoneNumber: rec.get("Phone Number") || "",
    altNumber: rec.get("Alternative Number") || "",
    dob,
    age: ageFromDob(dob),
    enrolmentStatus: asName(rec.get("Enrolment Status")),
    testLevel: asName(rec.get("Test Level")),
    testResult: asName(rec.get("Test Result")),
    location: asName(rec.get("Locations")),
    coach: childCoach(rec),
    lessonDay: asNameList(rec.get("Lesson Day")),
    timeslot: asNameList(rec.get("Timeslot")),
    nextLesson: rec.get("Next Lesson") || null,
    extraLessonCredits: Number(rec.get("Extra Lesson Credits") || 0),
    bonusCredits: Number(rec.get("Bonus Credits") || 0),
    certificates: asNameList(rec.get("Certificates")),
    stripeUrl: stripe && stripe.url ? stripe.url : null,
    paidTermStart: asNameList(rec.get("Paid Term Start date (from Term Payment)"))[0] || null,
    paidTermEnd: asNameList(rec.get("Paid Term End date (from Term Payment)"))[0] || null,
  };
}

// Find empty (bookable) Timetable rows: no student linked AND no Timetable Date.
// We filter emptiness in JS (Airtable BLANK() checks on linked fields are unreliable).
async function emptyRows({ coach, day, timeslot }) {
  const clauses = [];
  if (coach) clauses.push(`{Coach (string)} = '${esc(coach)}'`);
  if (day) clauses.push(`{Day} = '${esc(day)}'`);
  if (timeslot) clauses.push(`{Timeslot} = '${esc(timeslot)}'`);
  const opts = {
    fields: ["Day", "Timeslot", "Pool", "Coach (string)", "Category", "Enrolled", "Timetable Date"],
    pageSize: 200,
  };
  if (clauses.length) opts.filterByFormula = clauses.length === 1 ? clauses[0] : `AND(${clauses.join(",")})`;
  const rows = await selectAll(T.TIMETABLE, opts);
  return rows.filter((r) => {
    const enr = r.get("Enrolled");
    const hasStudent = Array.isArray(enr) ? enr.length > 0 : !!enr;
    return !hasStudent && !r.get("Timetable Date");
  });
}

// ---------------- routes ----------------

app.post("/api/login", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (phone.length < 6) return res.status(400).json({ error: "Please enter a valid phone number." });
    const records = await enrolledForPhone(phone);
    if (!records.length)
      return res.status(404).json({ error: "No account found for that phone number. Please check the number or contact support." });
    res.json({
      token: signToken(phone),
      parentName: records.map((r) => r.get("Parent Name")).find(Boolean) || "",
      children: records.map((r) => ({ id: r.id, childName: r.get("Name of Child") || "", enrolmentStatus: asName(r.get("Enrolment Status")) })),
    });
  } catch (err) {
    console.error("login", err);
    res.status(500).json({ error: "Something went wrong logging in. Please try again." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const records = await enrolledForPhone(req.phone);
    res.json({
      parentName: records.map((r) => r.get("Parent Name")).find(Boolean) || "",
      children: records.map(shapeChild),
    });
  } catch (err) {
    console.error("me", err);
    res.status(500).json({ error: "Could not load your profile." });
  }
});

// Edit the child's profile (only parent-editable fields).
app.post("/api/profile", auth, async (req, res) => {
  try {
    const { childId, childName, dob, phoneNumber, altNumber, parentName } = req.body;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });

    const fields = {};
    if (childName != null && childName.trim()) fields["Name of Child"] = childName.trim();
    if (parentName != null) fields["Parent Name"] = parentName.trim();
    if (dob != null) fields["DOB (Enrolled GCS)"] = dob.trim();
    if (phoneNumber != null && String(phoneNumber).trim()) {
      const n = Number(normalizePhone(phoneNumber));
      if (!Number.isNaN(n)) fields["Phone Number"] = n;
    }
    if (altNumber != null) {
      const digits = normalizePhone(altNumber);
      fields["Alternative Number"] = digits ? Number(digits) : null;
    }
    await base(T.ENROLLED).update([{ id: childId, fields }], { typecast: true });
    const fresh = await base(T.ENROLLED).find(childId);
    res.json({ ok: true, child: shapeChild(fresh) });
  } catch (err) {
    console.error("profile", err);
    res.status(500).json({ error: "Could not save your changes. Please try again." });
  }
});

// Booking/class-change options: available days & timeslots (with slots left).
// scope = "book" (child's coach only) or "change" (any coach).
app.get("/api/slots", auth, async (req, res) => {
  try {
    const { childId, scope = "book" } = req.query;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });

    const coach = scope === "change" ? null : childCoach(child);
    const rows = await emptyRows({ coach });

    // group by day -> timeslot -> {pool, count}
    const byDay = {};
    for (const r of rows) {
      const day = asName(r.get("Day"));
      const ts = asName(r.get("Timeslot"));
      const pool = asName(r.get("Pool"));
      if (!day || !ts) continue;
      byDay[day] = byDay[day] || {};
      byDay[day][ts] = byDay[day][ts] || { timeslot: ts, pool, slotsLeft: 0, cap: SLOT_CAP };
      byDay[day][ts].slotsLeft++;
    }
    const days = Object.keys(byDay)
      .filter((d) => DAY_DOW[d.toLowerCase()] !== undefined)
      .map((day) => ({
        day,
        dates: upcomingDatesForDay(day),
        timeslots: Object.values(byDay[day]).sort((a, b) => a.timeslot.localeCompare(b.timeslot)),
      }))
      .filter((d) => d.dates.length && d.timeslots.length);

    res.json({ coach, days, windowDays: BOOK_WINDOW_DAYS });
  } catch (err) {
    console.error("slots", err);
    res.status(500).json({ error: "Could not load available slots." });
  }
});

// Book an extra class into an empty row (or extend a consecutive booking).
app.post("/api/book-extra", auth, async (req, res) => {
  try {
    const { childId, day, timeslot, date } = req.body;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    if (!day || !timeslot || !date) return res.status(400).json({ error: "Please choose a day, date and timeslot." });
    if (!upcomingDatesForDay(day).includes(date))
      return res.status(400).json({ error: "That date must be within the next 2 weeks and match the chosen day." });

    const elc = Number(child.get("Extra Lesson Credits") || 0);
    const bc = Number(child.get("Bonus Credits") || 0);
    if (elc <= 0 && bc <= 0)
      return res.status(400).json({ error: "You have no Extra Lesson Credits or Bonus Credits available to book." });

    const coach = childCoach(child);
    const childName = child.get("Name of Child") || "";

    // Consecutive booking? Reuse the child's existing extra-lesson row for this slot.
    const existing = await selectAll(T.TIMETABLE, {
      filterByFormula: `AND({Day}='${esc(day)}',{Timeslot}='${esc(timeslot)}',{Category}='extra lesson',FIND('${esc(childName)}',{Enrolled}&''))`,
      fields: ["Day", "Timeslot", "Pool", "Timetable Date"],
      pageSize: 5,
    });

    let entry, pool;
    if (existing.length) {
      entry = existing[0];
      pool = asName(entry.get("Pool"));
    } else {
      const empties = await emptyRows({ coach, day, timeslot });
      if (!empties.length) return res.status(400).json({ error: "Sorry, that timeslot is now full. Please pick another." });
      entry = empties[0];
      pool = asName(entry.get("Pool"));
      await base(T.TIMETABLE).update([{ id: entry.id, fields: {
        Enrolled: [childId], "Timetable Date": date, Category: "extra lesson",
        "Consecutive Lesson Entry": false,
      } }], { typecast: true });
    }

    // Log the booking.
    await base(T.ELC_LOG).create([{ fields: {
      Student: [childId], "Timetable slot": [entry.id], Date: date, Status: "Confirmed",
      "Deducted From": elc > 0 ? "Extra Lesson Credit" : "Bonus Credit",
      Locations: pool, Day: day, Timeslot: timeslot,
    } }], { typecast: true });

    // If consecutive, set Timetable Date to the earliest upcoming booked date & flag it.
    if (existing.length) {
      const logs = await selectAll(T.ELC_LOG, {
        filterByFormula: `AND(FIND('${esc(childName)}',{Student}&''),{Status}='Confirmed')`,
        fields: ["Date", "timetable recordid"],
        pageSize: 50,
      });
      const dates = logs
        .filter((l) => asNameList(l.get("timetable recordid")).includes(entry.id))
        .map((l) => l.get("Date")).filter(Boolean).concat(date)
        .filter((d) => d >= todayISO()).sort();
      await base(T.TIMETABLE).update([{ id: entry.id, fields: {
        "Timetable Date": dates[0] || date, "Consecutive Lesson Entry": true,
      } }], { typecast: true });
    }

    // Deduct one credit.
    await base(T.ENROLLED).update([{ id: childId, fields:
      elc > 0 ? { "Extra Lesson Credits": elc - 1 } : { "Bonus Credits": bc - 1 } }]);

    res.json({ ok: true, deductedFrom: elc > 0 ? "Extra Lesson Credit" : "Bonus Credit",
      remaining: { extraLessonCredits: elc > 0 ? elc - 1 : elc, bonusCredits: elc > 0 ? bc : bc - 1 } });
  } catch (err) {
    console.error("book-extra", err);
    res.status(500).json({ error: "Could not complete the booking. Please try again." });
  }
});

// Class change: add the child to a new slot (2nd name) until the effective date.
app.post("/api/change-class", auth, async (req, res) => {
  try {
    const { childId, day, timeslot, effectiveDate } = req.body;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    if (!day || !timeslot || !effectiveDate) return res.status(400).json({ error: "Please choose a new day, timeslot and effective date." });
    if (effectiveDate < todayISO()) return res.status(400).json({ error: "Effective date can't be in the past." });

    const empties = await emptyRows({ day, timeslot });
    if (!empties.length) return res.status(400).json({ error: "That timeslot is full. Please pick another." });
    const slot = empties[0];
    const newPool = asName(slot.get("Pool"));

    // Add child to the new recurring slot (no Timetable Date — it's a weekly slot).
    await base(T.TIMETABLE).update([{ id: slot.id, fields: { Enrolled: [childId] } }], { typecast: true });

    await base(T.CLASS_CHANGE).create([{ fields: {
      Student: [childId], Slot: [slot.id], "Effective Date": effectiveDate,
      "New Day (wef effective date)": day, "New Time (wef effective date)": timeslot,
      "New Location (wef effective date)": newPool,
      "OG Day": asNameList(child.get("Lesson Day"))[0] || undefined,
      "OG Time": asNameList(child.get("Timeslot"))[0] || undefined,
      "OG Location": asName(child.get("Locations")) || undefined,
      "Class Change Status": "Confirmed",
    } }], { typecast: true });

    res.json({ ok: true });
  } catch (err) {
    console.error("change-class", err);
    res.status(500).json({ error: "Could not submit the class change. Please try again." });
  }
});

app.get("/api/payment", auth, async (req, res) => {
  try {
    const records = await enrolledForPhone(req.phone);
    res.json({ children: records.map((r) => {
      const s = r.get("Stripe Payment");
      return { id: r.id, childName: r.get("Name of Child") || "", stripeUrl: s && s.url ? s.url : null,
        paidTermStart: asNameList(r.get("Paid Term Start date (from Term Payment)"))[0] || null,
        paidTermEnd: asNameList(r.get("Paid Term End date (from Term Payment)"))[0] || null };
    }) });
  } catch (err) { console.error("payment", err); res.status(500).json({ error: "Could not load payment details." }); }
});

app.post("/api/ticket", auth, async (req, res) => {
  try {
    const { childId, complaintTypes = [], concerns, suggestions } = req.body;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    if (!concerns || !concerns.trim()) return res.status(400).json({ error: "Please describe your issue." });
    const fields = { "Student Record": [childId], Concerns: concerns.trim(), "Issue Status": "Not Done" };
    if (Array.isArray(complaintTypes) && complaintTypes.length) fields["Complaint Type"] = complaintTypes;
    if (suggestions && suggestions.trim()) fields["Suggestions"] = suggestions.trim();
    const [rec] = await base(T.ISSUE).create([{ fields }], { typecast: true });
    res.json({ ok: true, ticketId: rec.id });
  } catch (err) { console.error("ticket", err); res.status(500).json({ error: "Could not submit your ticket. Please try again." }); }
});

app.get("/api/attendance", auth, async (req, res) => {
  try {
    const { childId } = req.query;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    const childName = child.get("Name of Child") || "";
    const records = await selectAll(T.ATTENDANCE, {
      filterByFormula: `FIND('${Number(req.phone)}', ARRAYJOIN({Phone Number (from Student)}))`,
      fields: ["Name of Child", "Date", "Lesson Date", "Present", "Absent", "Location", "Day", "Time", "Coach", "Stage"],
      sort: [{ field: "Date", direction: "desc" }], pageSize: 100,
    });
    const rows = records.map((r) => ({
      date: r.get("Date") || r.get("Lesson Date") || null,
      present: !!r.get("Present"), absent: !!r.get("Absent"),
      location: asName(r.get("Location")), day: asName(r.get("Day")), time: asName(r.get("Time")),
      coach: asName(r.get("Coach")), stage: asNameList(r.get("Stage"))[0] || null,
      _child: asNameList(r.get("Name of Child"))[0] || "",
    })).filter((row) => (!childName || !row._child || row._child === childName) && row.date)
      .slice(0, 25).map(({ _child, ...row }) => row);
    res.json({ attendance: rows });
  } catch (err) { console.error("attendance", err); res.status(500).json({ error: "Could not load attendance history." }); }
});

app.get("/api/pause-reasons", auth, (_req, res) => res.json({ reasons: PAUSE_REASONS }));

app.post("/api/pause-resume", auth, async (req, res) => {
  try {
    const { childId, type, reason, message } = req.body;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    if (!type) return res.status(400).json({ error: "Please choose a request type." });
    const today = todayISO();
    if (type === "resume") {
      const [rec] = await base(T.CHURN).create([{ fields: {
        Student: [childId], "Rejoin Date": /^\d{4}-\d{2}-\d{2}$/.test(message || "") ? message : today,
        "Quit/Pause Message": message || "Resume request submitted via parent portal",
      } }], { typecast: true });
      await base(T.ENROLLED).update([{ id: childId, fields: { "FollowUp / Targeted Resume Date": today } }]).catch(() => {});
      return res.json({ ok: true, requestId: rec.id, type });
    }
    const fields = { Student: [childId], "Quit/Pause Message": message || "" };
    if (reason) fields["Quit/Pause Reason"] = reason;
    const [rec] = await base(T.CHURN).create([{ fields }], { typecast: true });
    await base(T.ENROLLED).update([{ id: childId, fields: { "Quit/Pause Date": today, "Quit/Pause Message": message || "" } }]).catch(() => {});
    res.json({ ok: true, requestId: rec.id, type });
  } catch (err) { console.error("pause-resume", err); res.status(500).json({ error: "Could not submit your request. Please try again." }); }
});

app.get("/api/announcements", auth, async (req, res) => {
  try {
    let announcements = [];
    try {
      const recs = await selectAll(T.ANNOUNCEMENTS, { sort: [{ field: "Date", direction: "desc" }], pageSize: 20 });
      announcements = recs.filter((r) => { const a = asName(r.get("Audience")); return !a || /parent|all|everyone/i.test(String(a)); })
        .map((r) => ({ title: r.get("Title") || "", body: r.get("Body") || "", date: r.get("Date") || null, priority: asName(r.get("Priority")) }));
    } catch (e) { console.warn("announcements read", e.message); }
    let pool = [];
    try {
      const recs = await selectAll(T.POOL_STATUS, { pageSize: 30 });
      pool = recs.map((r) => ({ location: asName(r.get("Locations")), status: asName(r.get("Pool Status")),
        canEnter: asName(r.get("Can parent enter pool?")), timing: r.get("Timing") || null,
        remarks: r.get("Remarks") || null, lastUpdate: r.get("Last Update") || null }))
        .filter((p) => p.location || p.status);
    } catch (e) { console.warn("pool read", e.message); }
    res.json({ announcements, pool });
  } catch (err) { console.error("announcements", err); res.status(500).json({ error: "Could not load announcements." }); }
});

// ---------- daily rollover (called by Vercel Cron) ----------
async function runRollover() {
  const today = todayISO();
  const result = { extraCleared: 0, extraAdvanced: 0, classChangesApplied: 0 };

  // 1) Extra-lesson rows whose date has passed.
  const passed = await selectAll(T.TIMETABLE, {
    filterByFormula: `AND({Category}='extra lesson',{Timetable Date}!=BLANK(),IS_BEFORE({Timetable Date},TODAY()))`,
    fields: ["Timetable Date"], pageSize: 200,
  });
  // Preload confirmed ELC logs to find future dates per timetable row.
  const logs = await selectAll(T.ELC_LOG, {
    filterByFormula: `{Status}='Confirmed'`, fields: ["Date", "timetable recordid"], pageSize: 1000,
  });
  const futureByRow = {};
  for (const l of logs) {
    const d = l.get("Date");
    if (!d || d < today) continue;
    for (const rid of asNameList(l.get("timetable recordid"))) (futureByRow[rid] ||= []).push(d);
  }
  for (const row of passed) {
    const future = (futureByRow[row.id] || []).sort();
    if (future.length) {
      await base(T.TIMETABLE).update([{ id: row.id, fields: { "Timetable Date": future[0] } }], { typecast: true });
      result.extraAdvanced++;
    } else {
      await base(T.TIMETABLE).update([{ id: row.id, fields: { Enrolled: [], "Timetable Date": null, Category: null, "Consecutive Lesson Entry": false } }], { typecast: true });
      result.extraCleared++;
    }
  }

  // 2) Class changes whose effective date has arrived -> clear old slot & update enrolment.
  const changes = await selectAll(T.CLASS_CHANGE, {
    filterByFormula: `AND({Class Change Status}='Confirmed',NOT({Class Change confirmation sent?}),{Effective Date}!=BLANK(),NOT(IS_AFTER({Effective Date},TODAY())))`,
    fields: ["Student", "OG Day", "OG Time", "OG Location", "New Day (wef effective date)", "New Time (wef effective date)", "New Location (wef effective date)", "student record id"],
    pageSize: 200,
  });
  for (const c of changes) {
    const studentId = asNameList(c.get("student record id"))[0] || (Array.isArray(c.get("Student")) ? c.get("Student")[0] : null);
    const ogDay = asName(c.get("OG Day")), ogTime = asName(c.get("OG Time")), ogLoc = asName(c.get("OG Location"));
    if (studentId && ogDay && ogTime) {
      const studentRec = await base(T.ENROLLED).find(studentId).catch(() => null);
      const name = studentRec ? studentRec.get("Name of Child") : "";
      const clauses = [`{Day}='${esc(ogDay)}'`, `{Timeslot}='${esc(ogTime)}'`, `FIND('${esc(name)}',{Enrolled}&'')`, `{Category}!='extra lesson'`];
      if (ogLoc) clauses.push(`{Pool}='${esc(ogLoc)}'`);
      const oldRows = await selectAll(T.TIMETABLE, { filterByFormula: `AND(${clauses.join(",")})`, fields: ["Enrolled"], pageSize: 20 });
      for (const r of oldRows) {
        const keep = (r.get("Enrolled") || []).map((x) => x.id).filter((id) => id !== studentId);
        await base(T.TIMETABLE).update([{ id: r.id, fields: { Enrolled: keep } }], { typecast: true });
      }
      if (studentRec) {
        await base(T.ENROLLED).update([{ id: studentId, fields: {
          "Lesson Day": [asName(c.get("New Day (wef effective date)"))].filter(Boolean),
          "Timeslot": [asName(c.get("New Time (wef effective date)"))].filter(Boolean),
          "Locations": asName(c.get("New Location (wef effective date)")) || undefined,
        } }], { typecast: true }).catch((e) => console.warn("enrol update", e.message));
      }
    }
    await base(T.CLASS_CHANGE).update([{ id: c.id, fields: { "Class Change confirmation sent?": true } }]).catch(() => {});
    result.classChangesApplied++;
  }
  return result;
}

app.all("/api/cron/rollover", async (req, res) => {
  const isVercelCron = !!req.headers["x-vercel-cron"];
  const keyOk = CRON_SECRET && (req.query.key === CRON_SECRET || req.headers["authorization"] === `Bearer ${CRON_SECRET}`);
  if (!isVercelCron && !keyOk) return res.status(401).json({ error: "unauthorized" });
  try {
    const result = await runRollover();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("rollover", err);
    res.status(500).json({ error: "rollover failed" });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`\nTheSwimStarter Parent Portal running on http://localhost:${PORT}\n`));
}
export default app;
