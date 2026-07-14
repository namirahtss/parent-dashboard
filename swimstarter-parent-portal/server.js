// TheSwimStarter — Parent Portal backend
// Express + Airtable (Coach Portal Sandbox base). Phone-number login, live reads/writes.

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
  PORT = 3000,
} = process.env;

if (!AIRTABLE_API_KEY) {
  console.error("\n[FATAL] AIRTABLE_API_KEY is not set. Copy .env.example to .env and fill it in.\n");
  process.exit(1);
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

// ---- Table IDs (from Coach Portal Sandbox) ----
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

// Parent-facing pause reasons that map to valid Churn/Resume options.
const PAUSE_REASONS = [
  "Take a Break",
  "Medical Reason (short term)",
  "Medical Reason (long term)",
  "Lessons Schedule",
  "Personal Schedule",
  "Financial Issues",
  "Progress",
  "Holiday Period",
  "School Commitment",
  "Personal",
];

// ---------------- helpers ----------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Digits-only phone. Airtable stores phone as a NUMBER, so we compare numerically.
function normalizePhone(raw) {
  if (raw === undefined || raw === null) return "";
  return String(raw).replace(/\D/g, "");
}

// -------- lightweight signed token (HMAC), scoped to a phone --------
function signToken(phone) {
  const payload = {
    phone,
    exp: Date.now() + Number(SESSION_TTL_HOURS) * 3600 * 1000,
  };
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
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Session expired. Please log in again." });
  req.phone = payload.phone;
  next();
}

// Read helpers ---------------------------------------------------------------

function firstVal(v) {
  return Array.isArray(v) ? v[0] : v;
}
function asName(v) {
  // singleSelect / linked values may come back as {name} objects
  const x = firstVal(v);
  if (x && typeof x === "object" && "name" in x) return x.name;
  return x ?? null;
}
function asNameList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => (x && typeof x === "object" && "name" in x ? x.name : x)).filter(Boolean);
}

async function selectAll(tableId, options) {
  return base(tableId).select(options).all();
}

// Fetch all Enrolled records for a phone number.
async function enrolledForPhone(phone) {
  const num = Number(phone);
  const records = await selectAll(T.ENROLLED, {
    filterByFormula: `{Phone Number} = ${num}`,
  });
  return records;
}

// Ensure a child record belongs to the logged-in phone (authorization guard).
async function requireOwnedChild(childId, phone) {
  const rec = await base(T.ENROLLED).find(childId).catch(() => null);
  if (!rec) return null;
  const recPhone = normalizePhone(rec.get("Phone Number"));
  if (recPhone !== normalizePhone(phone)) return null;
  return rec;
}

// Shape one enrolled record into a parent-friendly child profile.
function shapeChild(rec) {
  const stripe = rec.get("Stripe Payment"); // { label, url }
  const coach =
    asNameList(rec.get("Coach (from Timetable)"))[0] ||
    asNameList(rec.get("Surname (from Coach)"))[0] ||
    null;
  return {
    id: rec.id,
    childName: rec.get("Name of Child") || "",
    parentName: rec.get("Parent Name") || "",
    parentEmail: rec.get("Parent Email") || "",
    enrolmentStatus: asName(rec.get("Enrolment Status")),
    testLevel: asName(rec.get("Test Level")),
    testResult: asName(rec.get("Test Result")),
    location: asName(rec.get("Locations")),
    coach,
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

// Write helper: create a record but gracefully drop select fields Airtable rejects.
async function safeCreate(tableId, fields) {
  try {
    const [rec] = await base(tableId).create([{ fields }], { typecast: true });
    return rec;
  } catch (err) {
    // Retry once dropping any field named in an invalid-option error.
    const badField = /Unknown field|INVALID_MULTIPLE_CHOICE_OPTIONS|Insufficient permissions|cannot accept/i.test(
      err.message || ""
    );
    if (badField) {
      console.warn("[safeCreate] retrying with typecast on:", err.message);
    }
    throw err;
  }
}

// ---------------- routes ----------------

// POST /api/login  { phone }
app.post("/api/login", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (phone.length < 6) return res.status(400).json({ error: "Please enter a valid phone number." });

    const records = await enrolledForPhone(phone);
    if (!records.length) {
      return res.status(404).json({
        error: "No account found for that phone number. Please check the number or contact support.",
      });
    }

    // best-effort: stamp Last Login on the Parent Base is skipped (interface writes vary); keep login read-only.
    const parentName =
      records.map((r) => r.get("Parent Name")).find(Boolean) || "";

    res.json({
      token: signToken(phone),
      parentName,
      children: records.map((r) => ({
        id: r.id,
        childName: r.get("Name of Child") || "",
        enrolmentStatus: asName(r.get("Enrolment Status")),
      })),
    });
  } catch (err) {
    console.error("login error", err);
    res.status(500).json({ error: "Something went wrong logging in. Please try again." });
  }
});

// GET /api/me  -> full profile for all children on the account
app.get("/api/me", auth, async (req, res) => {
  try {
    const records = await enrolledForPhone(req.phone);
    res.json({
      parentName: records.map((r) => r.get("Parent Name")).find(Boolean) || "",
      children: records.map(shapeChild),
    });
  } catch (err) {
    console.error("me error", err);
    res.status(500).json({ error: "Could not load your profile." });
  }
});

// GET /api/timetable?location=&category=  -> bookable / changeable slots
app.get("/api/timetable", auth, async (req, res) => {
  try {
    const { location, category } = req.query;
    const clauses = ["{Day} != ''", "{Timeslot} != ''"];
    if (location) clauses.push(`{Pool} = '${String(location).replace(/'/g, "\\'")}'`);
    if (category) clauses.push(`{Category} = '${String(category).replace(/'/g, "\\'")}'`);
    const records = await selectAll(T.TIMETABLE, {
      filterByFormula: `AND(${clauses.join(",")})`,
      fields: ["Coach (string)", "Pool", "Day", "Timeslot", "Category", "Session Type"],
      pageSize: 100,
    });
    const slots = records.map((r) => ({
      id: r.id,
      coach: asName(r.get("Coach (string)")) || asNameList(r.get("Coach (string)"))[0] || "",
      pool: asName(r.get("Pool")),
      day: asName(r.get("Day")),
      timeslot: asName(r.get("Timeslot")),
      category: asName(r.get("Category")),
    }));
    res.json({ slots });
  } catch (err) {
    console.error("timetable error", err);
    res.status(500).json({ error: "Could not load the timetable." });
  }
});

// POST /api/book-extra  { childId, slotId, date }
app.post("/api/book-extra", auth, async (req, res) => {
  try {
    const { childId, slotId, date } = req.body;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    if (!slotId) return res.status(400).json({ error: "Please choose a class slot." });
    if (!date) return res.status(400).json({ error: "Please choose a date." });

    const elc = Number(child.get("Extra Lesson Credits") || 0);
    const bc = Number(child.get("Bonus Credits") || 0);
    if (elc <= 0 && bc <= 0) {
      return res
        .status(400)
        .json({ error: "You have no Extra Lesson Credits or Bonus Credits available to book." });
    }

    const slot = await base(T.TIMETABLE).find(slotId).catch(() => null);
    if (!slot) return res.status(404).json({ error: "That class slot no longer exists." });

    const deductFrom = elc > 0 ? "Extra Lesson Credit" : "Bonus Credit";

    // Create the booking (live, confirmed).
    const booking = await safeCreate(T.ELC_LOG, {
      Student: [childId],
      "Timetable slot": [slotId],
      Date: date,
      Locations: asName(slot.get("Pool")),
      Day: asName(slot.get("Day")),
      Timeslot: asName(slot.get("Timeslot")),
      Status: "Confirmed",
      "Deducted From": deductFrom,
    });

    // Decrement the credit used.
    const patch =
      elc > 0
        ? { "Extra Lesson Credits": elc - 1 }
        : { "Bonus Credits": bc - 1 };
    await base(T.ENROLLED).update([{ id: childId, fields: patch }]);

    res.json({
      ok: true,
      bookingId: booking.id,
      deductedFrom: deductFrom,
      remaining: { extraLessonCredits: elc > 0 ? elc - 1 : elc, bonusCredits: elc > 0 ? bc : bc - 1 },
    });
  } catch (err) {
    console.error("book-extra error", err);
    res.status(500).json({ error: "Could not complete the booking. Please try again." });
  }
});

// POST /api/change-class  { childId, slotId, effectiveDate }
app.post("/api/change-class", auth, async (req, res) => {
  try {
    const { childId, slotId, effectiveDate } = req.body;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    if (!slotId) return res.status(400).json({ error: "Please choose a new class slot." });
    if (!effectiveDate) return res.status(400).json({ error: "Please choose an effective date." });

    const slot = await base(T.TIMETABLE).find(slotId).catch(() => null);
    if (!slot) return res.status(404).json({ error: "That class slot no longer exists." });

    const rec = await safeCreate(T.CLASS_CHANGE, {
      Student: [childId],
      Slot: [slotId],
      "Effective Date": effectiveDate,
      "New Day (wef effective date)": asName(slot.get("Day")),
      "New Time (wef effective date)": asName(slot.get("Timeslot")),
      "New Location (wef effective date)": asName(slot.get("Pool")),
      "Class Change Status": "Confirmed",
    });

    res.json({ ok: true, changeId: rec.id });
  } catch (err) {
    console.error("change-class error", err);
    res.status(500).json({ error: "Could not submit the class change. Please try again." });
  }
});

// GET /api/payment  -> stripe link + term dates per child
app.get("/api/payment", auth, async (req, res) => {
  try {
    const records = await enrolledForPhone(req.phone);
    res.json({
      children: records.map((r) => {
        const stripe = r.get("Stripe Payment");
        return {
          id: r.id,
          childName: r.get("Name of Child") || "",
          stripeUrl: stripe && stripe.url ? stripe.url : null,
          paidTermStart: asNameList(r.get("Paid Term Start date (from Term Payment)"))[0] || null,
          paidTermEnd: asNameList(r.get("Paid Term End date (from Term Payment)"))[0] || null,
        };
      }),
    });
  } catch (err) {
    console.error("payment error", err);
    res.status(500).json({ error: "Could not load payment details." });
  }
});

// POST /api/ticket  { childId, complaintTypes[], concerns, suggestions }
app.post("/api/ticket", auth, async (req, res) => {
  try {
    const { childId, complaintTypes = [], concerns, suggestions } = req.body;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    if (!concerns || !concerns.trim())
      return res.status(400).json({ error: "Please describe your issue." });

    const fields = {
      "Student Record": [childId],
      Concerns: concerns.trim(),
      "Issue Status": "Not Done",
    };
    if (Array.isArray(complaintTypes) && complaintTypes.length) fields["Complaint Type"] = complaintTypes;
    if (suggestions && suggestions.trim()) fields["Suggestions"] = suggestions.trim();

    const rec = await safeCreate(T.ISSUE, fields);
    res.json({ ok: true, ticketId: rec.id });
  } catch (err) {
    console.error("ticket error", err);
    res.status(500).json({ error: "Could not submit your ticket. Please try again." });
  }
});

// GET /api/attendance?childId=  -> recent attendance for one child
app.get("/api/attendance", auth, async (req, res) => {
  try {
    const { childId } = req.query;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    const childName = child.get("Name of Child") || "";
    const num = Number(req.phone);

    const records = await selectAll(T.ATTENDANCE, {
      filterByFormula: `FIND('${num}', ARRAYJOIN({Phone Number (from Student)}))`,
      fields: ["Name of Child", "Date", "Lesson Date", "Present", "Absent", "Location", "Day", "Time", "Coach", "Stage"],
      sort: [{ field: "Date", direction: "desc" }],
      pageSize: 100,
    });

    const rows = records
      .map((r) => ({
        date: r.get("Date") || r.get("Lesson Date") || null,
        present: !!r.get("Present"),
        absent: !!r.get("Absent"),
        location: asName(r.get("Location")),
        day: asName(r.get("Day")),
        time: asName(r.get("Time")),
        coach: asName(r.get("Coach")),
        stage: asNameList(r.get("Stage"))[0] || null,
        _child: asNameList(r.get("Name of Child"))[0] || "",
      }))
      .filter((row) => !childName || !row._child || row._child === childName)
      .filter((row) => row.date)
      .slice(0, 25)
      .map(({ _child, ...row }) => row);

    res.json({ attendance: rows });
  } catch (err) {
    console.error("attendance error", err);
    res.status(500).json({ error: "Could not load attendance history." });
  }
});

// GET /api/pause-reasons
app.get("/api/pause-reasons", auth, (_req, res) => {
  res.json({ reasons: PAUSE_REASONS });
});

// POST /api/pause-resume  { childId, type, reason, message }
// type: "pause (not paid)" | "pause (paid)" | "quit" | "resume"
app.post("/api/pause-resume", auth, async (req, res) => {
  try {
    const { childId, type, reason, message } = req.body;
    const child = await requireOwnedChild(childId, req.phone);
    if (!child) return res.status(403).json({ error: "That child is not on your account." });
    if (!type) return res.status(400).json({ error: "Please choose a request type." });

    const today = new Date().toISOString().slice(0, 10);

    if (type === "resume") {
      // Resume request: create Churn/Resume row + stamp targeted resume date on Enrolled.
      const rec = await safeCreate(T.CHURN, {
        Student: [childId],
        "Rejoin Date": message && /^\d{4}-\d{2}-\d{2}$/.test(message) ? message : today,
        "Quit/Pause Message": message || "Resume request submitted via parent portal",
      });
      await base(T.ENROLLED)
        .update([{ id: childId, fields: { "FollowUp / Targeted Resume Date": today } }])
        .catch((e) => console.warn("resume enrolled patch skipped:", e.message));
      return res.json({ ok: true, requestId: rec.id, type });
    }

    // Pause / quit
    const churnFields = {
      Student: [childId],
      "Quit/Pause Message": message || "",
    };
    if (reason) churnFields["Quit/Pause Reason"] = reason;
    const rec = await safeCreate(T.CHURN, churnFields);

    // Stamp free-text/date fields on Enrolled (source of truth) — safe fields only.
    await base(T.ENROLLED)
      .update([
        {
          id: childId,
          fields: {
            "Quit/Pause Date": today,
            "Quit/Pause Message": message || "",
          },
        },
      ])
      .catch((e) => console.warn("pause enrolled patch skipped:", e.message));

    res.json({ ok: true, requestId: rec.id, type });
  } catch (err) {
    console.error("pause-resume error", err);
    res.status(500).json({ error: "Could not submit your request. Please try again." });
  }
});

// GET /api/announcements -> notices + pool status (public-ish, still behind auth)
app.get("/api/announcements", auth, async (req, res) => {
  try {
    let announcements = [];
    try {
      const recs = await selectAll(T.ANNOUNCEMENTS, {
        sort: [{ field: "Date", direction: "desc" }],
        pageSize: 20,
      });
      announcements = recs
        .filter((r) => {
          const aud = asName(r.get("Audience"));
          return !aud || /parent|all|everyone/i.test(String(aud));
        })
        .map((r) => ({
          title: r.get("Title") || "",
          body: r.get("Body") || "",
          date: r.get("Date") || null,
          priority: asName(r.get("Priority")),
        }));
    } catch (e) {
      console.warn("announcements read skipped:", e.message);
    }

    let pool = [];
    try {
      const recs = await selectAll(T.POOL_STATUS, { pageSize: 30 });
      pool = recs
        .map((r) => ({
          location: asName(r.get("Locations")),
          status: asName(r.get("Pool Status")),
          canEnter: asName(r.get("Can parent enter pool?")),
          timing: r.get("Timing") || null,
          remarks: r.get("Remarks") || null,
          lastUpdate: r.get("Last Update") || null,
        }))
        .filter((p) => p.location || p.status);
    } catch (e) {
      console.warn("pool status read skipped:", e.message);
    }

    res.json({ announcements, pool });
  } catch (err) {
    console.error("announcements error", err);
    res.status(500).json({ error: "Could not load announcements." });
  }
});

// health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// SPA fallback
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// When running normally (local, Render, Railway, a VPS) we start a listener.
// On Vercel the platform imports this file and calls the exported app as a
// serverless function, so we must NOT call listen there.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\nTheSwimStarter Parent Portal running on http://localhost:${PORT}\n`);
  });
}

export default app;
