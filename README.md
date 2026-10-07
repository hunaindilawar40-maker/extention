# AI Outreach for Zoho Mail

A Manifest V3 Chrome extension that turns an Apollo.io CSV export into personalized,
human-sounding cold emails, written by a free Groq-hosted LLM, and sends them straight
from your own **Zoho Mail** inbox (`mail.zoho.com`) — with built-in pacing and daily
limits so your free Zoho account stays healthy.

Built for: `support@navainai.com` on **Zoho Mail Free**, using the **Groq API** (free tier)
and leads exported from **Apollo.io**.

---

## ✨ What it does

1. **Import leads** — drag & drop your Apollo.io CSV export. Columns like
   `First Name`, `Email`, `Title`, `Company Name`, `Industry`, `Company Description`,
   `City/State/Country`, `Website`, `LinkedIn URL` are auto-detected. A column-mapping
   screen lets you fix anything that wasn't recognized.
2. **Generate** a short, natural, non-templated email per lead with a live model
   available to your Groq account (`openai/gpt-oss-20b` fallback), referencing real details from the lead's
   row so every email feels individually written — never two identical openings,
   even for leads in the same industry.
3. **Inject directly into Zoho Mail** — the extension opens "New Mail" in your real
   Zoho Mail tab, fills in the recipient, subject and body (keeping your existing
   Zoho signature), and either sends automatically or waits for your 1-click approval.
4. **Protect your account** — randomized delays between sends, a hard daily send cap,
   and a floating on-screen HUD with Pause/Resume/Stop/Skip-Delay controls so you're
   always in control.
5. **Log everything** — every attempt (sent/failed/skipped) is recorded and exportable
   as CSV.

---

## 📦 Install (Load Unpacked)

1. Click **Code → Download ZIP** on this repository and unzip it somewhere permanent
   (don't delete the folder after installing — Chrome loads the extension from it
   directly).
2. Open `chrome://extensions` (also works in Brave at `brave://extensions` and Edge at
   `edge://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder (the one containing
   `manifest.json`).
5. Pin the extension (puzzle-piece icon → pin "AI Outreach") so it's always one click
   away.

---

## 🔑 Get a free Groq API key

1. Go to [console.groq.com/keys](https://console.groq.com/keys) and sign up (free).
2. Click **Create API Key**, name it anything, and copy the key (starts with `gsk_`).
3. In the extension popup, open the **Settings** tab and paste the key into **Groq API
   key**. Click **Refresh available models** (the extension also refreshes them
   automatically), then click **Find & Test a Working Model**. The extension tries a
   tiny completion and automatically saves the first model your key can really use.
   The dropdown is loaded from Groq's live Models API, so deprecated or unavailable
   models are not trusted from a hard-coded list.

Groq's free tier is generous for this use case (a few dozen short completions a day is
nowhere near typical limits), but if you ever see `429` errors in the Settings tab,
wait a minute and try again, or switch to the 8B instant model temporarily.

---

## 📄 Upload your Apollo.io CSV

1. In Apollo.io, build your list and click **Export** → CSV.
2. Open the extension popup → **Leads** tab.
3. Drag the CSV file onto the drop zone (or click **Browse file**).
4. A mapping screen appears with the columns we auto-detected. Review each field —
   `Email` is the only required one. Fix any dropdown that points to the wrong column,
   then click **Import Leads**.
5. Your leads appear in the queue table with a **Pending** status. Use the search box
   and the status filter to find specific leads, and the eye icon to preview a
   generated draft once one exists.

Leads are de-duplicated by email address automatically if you import the same list
twice.

---

## ✍️ Customize how the AI writes

Open the **Compose** tab to control the voice of every email:

- **Sender context** — your name, company, and a one-line description of what you're
  offering. These get woven into the prompt so the AI writes *as you*, not as a
  generic vendor.
- **Style controls** — max word count (default 110, keeps emails skimmable), a
  creativity/temperature slider (0.6–0.95; higher = more varied phrasing, defaults to
  0.80), and a toggle to keep your existing Zoho signature untouched (recommended —
  the AI never overwrites it, it only inserts the new message above it).
- **Banned robotic phrases** — a list of stock phrases (e.g. *"I hope this email
  finds you well"*, *"In today's fast-paced digital world"*) the AI is explicitly
  told never to use. If it ever slips one in, the extension automatically asks it to
  rewrite the email from scratch before injecting it into Zoho Mail.
- **Prompt template** — the full instruction sent to Groq, with placeholders like
  `{{firstName}}`, `{{company}}`, `{{industry}}`, `{{description}}` filled in per
  lead. Edit it to match your pitch, or hit **Reset to default** to go back to the
  built-in template.

Every single generation also gets a random "style hint" behind the scenes (different
opening style, structure, and call-to-action phrasing each time) plus a small random
jitter on temperature, which is why no two emails come out looking templated — even
back-to-back emails to two people in the same industry.

---

## ⚙️ Sending behavior & Zoho Free-tier safety

In the **Settings** tab:

- **Send mode**
  - **Review mode** (default, recommended) — the extension fills in the compose
    window in Zoho Mail and pauses. You read it, make any tweak you want, then click
    **Approve & Send** in the floating HUD (or **Skip Lead** to discard it).
  - **Full-Auto** — the extension clicks Send itself with no pause. Only use this once
    you've reviewed a batch of drafts in Review mode and trust the output.
- **Delay between sends** — a random number of seconds between your Min/Max is waited
  between each email (default 30–60s) so sending doesn't look automated.
- **Daily sending quota** — hard cap on emails per day (default 60). Once hit, the
  campaign stops itself automatically, even mid-list. This exists specifically to
  protect a **Zoho Mail Free** account from rate-limit or spam flags — free tier
  accounts should generally stay well under 80-100 outbound emails/day, and starting
  conservative (e.g. 30-40/day) for the first week or two of warming up a new sending
  address is strongly recommended.

### Recommended best practices for Zoho Mail Free

- Start low (20-30 emails/day) for your first 1-2 weeks, then ramp up gradually.
- Always leave **Review mode** on until you've checked a few dozen sent emails read
  naturally.
- Keep the 30–60s (or longer) delay — real humans don't send a new email every 2
  seconds.
- Make sure a real signature with your name, a reply-to email, and (ideally) an
  unsubscribe/opt-out line is set as your Zoho Mail default signature — the extension
  preserves it automatically.
- Watch your Zoho **Sent** folder and bounce notifications; if you see a spike in
  bounces or a Zoho warning banner, stop the campaign (big red **Stop** button in the
  popup or the HUD) and lower your daily quota.

---

## ▶️ Running a campaign

1. Open `mail.zoho.com` and make sure you're logged in — keep that tab open.
2. Open the extension popup → **Dashboard** tab. The colored dot in the header (and
   the "Zoho Mail tab" card) shows whether the extension found and connected to your
   Zoho Mail tab; click **Re-check connection** if needed.
3. Pick **Review** or **Full-Auto** send mode.
4. Click **▶ Start Campaign**.
5. Switch to the Zoho Mail tab — a floating **HUD** card appears showing the lead
   currently being processed (name, company, email), the current step (Generating →
   Injected → Sending/Awaiting review → Cooldown), a live countdown to the next send,
   and buttons:
   - **Skip Delay** — jump straight to the next lead instead of waiting out the
     cooldown.
   - **Pause / Resume** — freeze the whole campaign (countdown, generation, sending).
   - **Stop** — end the campaign immediately.
   - *(Review mode only)* **Approve & Send** / **Skip Lead** — appear once a draft has
     been injected into the compose window.
6. You can close the popup at any time — the HUD and the send loop keep running
   inside the Zoho Mail tab. Reopen the popup to check live stats or hit Stop/Pause
   from the Dashboard tab instead of the HUD.

---

## 📊 Logs & reporting

The **Logs** tab records every attempt — timestamp, recipient, company, subject,
status (`sent` / `failed` / `skipped`), and any error message. Use **Export CSV** to
download the full campaign log for reporting, and **Clear** to reset it.

---

## 🗂️ Project structure

```
manifest.json         Manifest V3 config (permissions, content script, icons)
background.js         Service worker: Groq API calls, quota tracking, tab relay
content.js            Injected into mail.zoho.com: DOM automation + floating HUD
content.css           Styles for the floating HUD overlay
popup.html/js/css     Extension popup UI (Dashboard, Leads, Compose, Settings, Logs)
lib/constants.js      Shared constants, default prompt template, banned phrases
lib/storage.js        chrome.storage.local helpers (settings, leads, logs, quota)
lib/csv.js            Dependency-free CSV parser + Apollo.io column auto-mapper
lib/groq.js           Groq chat-completions client + prompt builder (background only)
icons/                16x16, 48x48, 128x128 extension icons
```

---

## 🔒 Privacy & data

- Your Groq API key, leads, prompt settings, and logs are stored **locally** in
  `chrome.storage.local` on your machine — nothing is sent anywhere except:
  - Lead details + your prompt → **Groq's API** (`api.groq.com`), to generate the
    email text.
  - The generated email → **your own Zoho Mail tab**, via normal DOM interaction
    (exactly as if you'd typed it yourself).
- No third-party analytics, no external servers of ours are involved.

---

## 🛠️ Troubleshooting

- **"No open Zoho Mail tab was found"** — open `mail.zoho.com` (or your regional Zoho
  Mail domain) in a tab, log in, then click **Re-check connection**.
- **"Could not find or open the Zoho Mail compose window"** — Zoho occasionally ships
  UI updates that change element names. Try opening "New Mail" manually once; if the
  extension still can't find the To/Subject/Body fields, see `content.js` — the
  `SELECTORS` object at the top lists every lookup strategy and is designed to be
  easy to extend with a new selector if Zoho changes its markup.
- **Groq errors (401/429)** — 401 means the API key is wrong; re-copy it from
  [console.groq.com/keys](https://console.groq.com/keys). 429 means you're
  rate-limited — wait a minute, or switch to a smaller/faster model.
- **Emails look repetitive** — raise the temperature slider in the Compose tab, add
  more detail to "What you're offering", and make sure your CSV actually has
  `Industry` / `Company Description` / `Keywords` columns populated — the more real
  detail Apollo exports, the more specific (and less generic) each email gets.

---

## ⚠️ Disclaimer

This tool automates sending from your own mailbox using your own credentials, with no
password or account access required — it drives the Zoho Mail web UI the same way a
human would. You are responsible for complying with applicable anti-spam laws (e.g.
CAN-SPAM, GDPR, CASL) and Zoho's Terms of Service for your outreach: get consent where
required, include a clear way to opt out, and keep sending volumes reasonable.
