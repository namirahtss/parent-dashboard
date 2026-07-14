# TheSwimStarter — Parent Portal

A mobile-first web portal for parents, backed by the **Coach Portal Sandbox** Airtable base.
Parents log in with their mobile number and can:

1. **Book an extra class** — only if they have Extra Lesson Credits (ELC) or Bonus Credits (BC). ELC is used first; a confirmed booking is written to *ELC Booking Log* and the credit is deducted on the *Enrolled* record.
2. **Change their class schedule** — pick a slot from the live *Timetable*; a confirmed *Class Change Log* record is created.
3. **View their profile** — child details: test level, class day/time, coach, location, credits left, certificates, enrolment status.
4. **Payment** — open the Stripe payment link (from *Enrolled → Stripe Payment*) and see Paid Term start/end dates.
5. **Support** — submit an issue/complaint ticket into the *Issue/Complaint* table.

Plus the extras you asked for: **attendance history**, **progress & test tracker**, **pause / resume / quit requests** (into *Churn/Resume*), and **notices / pool status**.

> **Login security note:** as requested, login is **phone-number only** — anyone who knows a registered number can view that family's data. When you're ready to harden this, the natural upgrade is phone + one-time code (OTP) over WhatsApp/SMS. The code is structured so that's a drop-in change to `/api/login`.

---

## Architecture

- **Backend:** Node.js + Express (`server.js`). Holds the Airtable API key server-side and exposes a small JSON API under `/api`. Login issues a signed token (HMAC) that scopes every request to one phone number; the server re-checks record ownership on every read and write.
- **Frontend:** static mobile SPA in `public/` (plain HTML/CSS/JS — no build step).
- **Data:** Airtable base `app0uSWJNEQnBZvbb` ("Coach Portal Sandbox").

```
swimstarter-parent-portal/
├─ server.js            # Express API + Airtable integration
├─ package.json
├─ .env.example         # copy to .env and fill in
└─ public/
   ├─ index.html
   ├─ styles.css
   └─ app.js
```

---

## Run it locally

**1. Prerequisites:** Node.js 18 or newer.

**2. Get an Airtable Personal Access Token**
- Go to https://airtable.com/create/tokens
- Scopes: `data.records:read`, `data.records:write`, `schema.bases:read`
- Access: add the **Coach Portal Sandbox** base
- Copy the token (starts with `pat...`)

**3. Configure**
```bash
cd swimstarter-parent-portal
cp .env.example .env
# open .env and paste your AIRTABLE_API_KEY, and set a random SESSION_SECRET
```
Generate a session secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**4. Install & start**
```bash
npm install
npm start
```
Open **http://localhost:3000** on your phone (same Wi-Fi, use your computer's IP) or in a browser with the device toolbar on.

Log in with a mobile number that exists in the *Enrolled* table's **Phone Number** field (e.g. one of your sandbox test rows).

---

## Deploying (so parents can reach it)

Any host that runs Node works. Easiest options:

- **Render / Railway / Fly.io:** create a new "Web Service" from this folder. Build command `npm install`, start command `npm start`. Add the env vars from `.env` in the dashboard. Node auto-picks the `PORT` they give you.
- **A small VPS:** `npm install`, then run with `pm2 start server.js`.

Always set `AIRTABLE_API_KEY` and a strong `SESSION_SECRET` as environment variables on the host — never commit `.env`.

---

## How each feature maps to Airtable

| Feature | Reads | Writes |
|---|---|---|
| Login / profile | Enrolled (by `Phone Number`) | — |
| Book extra class | Enrolled credits, Timetable slot | ELC Booking Log (`Status = Confirmed`), decrements Enrolled `Extra Lesson Credits` / `Bonus Credits` |
| Change schedule | Timetable | Class Change Log (`Class Change Status = Confirmed`) |
| Payment | Enrolled `Stripe Payment`, Paid Term start/end | — |
| Support | — | Issue/Complaint (`Issue Status = Not Done`) |
| Attendance | Attendance (by phone + child) | — |
| Progress & tests | Enrolled test level/result/certificates | — |
| Pause / resume / quit | — | Churn/Resume + stamps Enrolled `Quit/Pause Date` / `Quit/Pause Message` |
| Notices | Coach Announcements, Lightning Alert Pool Status | — |

Writes use Airtable **typecast** and only known-valid select options, so new option names are handled gracefully.

---

## Things to review before going live

- **Booking capacity:** the portal currently shows all timetable slots and doesn't cap class sizes. If you want "slot full" logic, we can filter by current headcount per slot.
- **Class-change effective date rules:** it writes whatever effective date the parent picks. Add validation (e.g. minimum notice period) if needed.
- **Announcements audience:** notices show when `Audience` is Parents/All/blank. Set that field on records you want parents to see.
- **Pause/quit reasons:** the parent-facing reason list is a safe subset of your *Churn/Resume* reasons — adjust in `PAUSE_REASONS` in `server.js`.
- **Phone-only login** — see the security note above.
