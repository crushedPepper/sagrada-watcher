// Alhambra (Granada Card) ticket watcher.
// The official Alhambra site sits behind a bot check, so this watches the Granada
// Card instead: the city's official card, which carries its own reserved batch of
// Alhambra tickets and is sold through a plain booking backend (granadatur.clorian.com).
// Sends a phone push via ntfy.sh when the watched dates open up.
// It never books or pays - you get the alert and book yourself.

import { pathToFileURL } from "node:url";

// ---------- settings (edit these if your plans change) ----------
export const SETTINGS = {
  dates: (process.env.WATCH_DATES || "2026-10-13,2026-10-14")
    .split(",").map((d) => d.trim()).filter(Boolean),
  partySize: Number(process.env.PARTY_SIZE || 2),
  // Each card spans two venues (the city pass, 136, and its Alhambra part). A date only
  // counts as open when EVERY venue of the card has room - that is what makes it bookable.
  products: [
    { id: 3790, venues: [136, 157], name: "Granada Card 48h (Alhambra incl. Nasrid Palaces)", url: "https://granadatur.clorian.com/en/116-web-individual/3790-granada-card-48h" },
    { id: 3804, venues: [136, 386], name: "Granada Card 72h (Alhambra incl. Nasrid Palaces)", url: "https://granadatur.clorian.com/en/116-web-individual/3804-granada-card-72h" },
    { id: 3805, venues: [136, 346], name: "Granada Card 24h (Nasrid Palaces at NIGHT)", url: "https://granadatur.clorian.com/en/116-web-individual/3805-granada-card-24h" },
    { id: 851, venues: [136, 347], name: "Granada Card Gardens (NO Nasrid Palaces)", url: "https://granadatur.clorian.com/en/116-web-individual/851-granada-card-gardens" },
  ],
  pollMinutes: Number(process.env.POLL_MINUTES || 50),           // how long one run keeps watching
  pollIntervalSec: Number(process.env.POLL_INTERVAL_SEC || 180), // gap between checks
  repeatAfterHours: 1, // re-alert about the same opening at most once an hour
};

const API = "https://services.clorian.com";
const SALES_GROUP = "116";
const POS = "663";
const FRONTEND_KEY = "thegranadaturfrontendoftomorrow"; // public key used by the official Granada Card site
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const COMMON_HEADERS = {
  accept: "application/json, text/plain, */*",
  origin: "https://granadatur.clorian.com",
  "user-agent": UA,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, options = {}, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
      if (res.ok) return res;
      last = new Error(`${options.method || "GET"} ${url.split("?")[0]} -> HTTP ${res.status}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw last;
    } catch (e) {
      last = e;
    }
    if (i < attempts - 1) await sleep(1000 * 2 ** i);
  }
  throw last;
}

async function getToken() {
  const res = await request(`${API}/user/api/oauth/token?secretKey=${FRONTEND_KEY}`, {
    method: "POST",
    body: "",
    headers: { ...COMMON_HEADERS, "content-type": "application/json" },
  });
  const json = await res.json();
  if (!json?.access_token) throw new Error("Booking backend did not return an access token.");
  return json.access_token;
}

// Returns { "YYYY-MM-DD": "availability" | other, ... } for every month the dates touch.
async function getVenueCalendar(token, product, venueId, minTickets) {
  const months = [...new Set(SETTINGS.dates.map((d) => d.slice(0, 7)))];
  const calendar = {};
  for (const ym of months) {
    const [year, month] = ym.split("-");
    const qs = new URLSearchParams({
      minTickets: String(minTickets),
      month: String(Number(month)),
      venueId: String(venueId),
      year,
    });
    const res = await request(
      `${API}/catalog/salesGroups/${SALES_GROUP}/product/${product.id}/availability?${qs}`,
      { headers: { ...COMMON_HEADERS, authorization: `Bearer ${token}`, pos: POS, "content-type": "application/json" } },
    );
    Object.assign(calendar, await res.json());
    await sleep(200);
  }
  return calendar;
}

// A card's calendar: a date is "availability" only if every venue of the card says so.
async function getCalendar(token, product, minTickets) {
  const cals = [];
  for (const v of product.venues) cals.push(await getVenueCalendar(token, product, v, minTickets));
  if (product.venues[0] === 136 && Object.keys(cals[0]).length === 0) {
    // The city-pass venue always returns a full month; empty means the API changed, not "sold out".
    throw new Error(`Booking backend returned an empty calendar for ${product.name} - the checker may need updating.`);
  }
  const merged = {};
  for (const d of SETTINGS.dates) merged[d] = cals.every((c) => c[d] === "availability") ? "availability" : "no-availability";
  return merged;
}

export function openDates(calendar, dates = SETTINGS.dates) {
  return dates.filter((d) => calendar?.[d] === "availability");
}

// Some ticket types ignore the group-size filter (they say "available" even for
// 100,000 people). For those we can only say a date opened, not how many seats.
// Checked once per run so the watcher adapts if the booking system changes.
async function detectGroupFilter(token) {
  const result = new Map();
  for (const p of SETTINGS.products) {
    try {
      const huge = await getCalendar(token, p, 100000);
      result.set(p.id, Object.values(huge).every((v) => v !== "availability"));
    } catch {
      result.set(p.id, false);
    }
  }
  return result;
}

// One check across all ticket types.
// Returns [{ product, date, level }] where level is:
//   "party"      - a slot fits the whole group (confirmed)
//   "unverified" - the date opened; this ticket type can't report group size
//   "single"     - only a single seat per slot
export async function check(token, groupFilter) {
  const found = [];
  for (const p of SETTINGS.products) {
    const any = await getCalendar(token, p, 1);
    const anyOpen = openDates(any);
    if (!anyOpen.length) continue;
    if (!groupFilter.get(p.id) || SETTINGS.partySize <= 1) {
      const level = SETTINGS.partySize <= 1 ? "party" : "unverified";
      for (const date of anyOpen) found.push({ product: p, date, level });
      continue;
    }
    const partyOpen = openDates(await getCalendar(token, p, SETTINGS.partySize));
    for (const date of anyOpen) {
      found.push({ product: p, date, level: partyOpen.includes(date) ? "party" : "single" });
    }
  }
  return found;
}

// ---------- notifications (ntfy.sh) ----------
const TOPIC = (process.env.NTFY_TOPIC || "").trim();

async function notify({ title, message, priority = 3, tags = [], click, ref }) {
  if (!TOPIC) throw new Error("NTFY_TOPIC secret is missing.");
  await request("https://ntfy.sh/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic: TOPIC, title, message: `${message}\n\nref:${ref}`, priority, tags, click }),
  });
  console.log(`Sent: ${title}`);
}

// Looks at the topic's recent history so separate runs don't repeat the same alert.
async function sentRecently(ref, hours) {
  try {
    const res = await request(`https://ntfy.sh/${TOPIC}/json?poll=1&since=${hours}h`, {}, 1);
    // The ref is always the last thing in the message, so match it with the closing
    // quote - otherwise "open:A" would wrongly match an earlier "open:A,B".
    return (await res.text()).split("\n").some((l) => l.includes(`ref:${ref}"`));
  } catch {
    return false;
  }
}

const pretty = (d) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

const RANK = { party: 0, unverified: 1, single: 2 };
const LABEL = {
  party: () => `${SETTINGS.partySize} seats together`,
  unverified: () => "open (this ticket type doesn't say how many seats - check)",
  single: () => "1 seat per slot only",
};

export function buildAlert(found) {
  if (!found.length) return null;
  const sorted = [...found].sort(
    (a, b) => RANK[a.level] - RANK[b.level] || a.date.localeCompare(b.date) ||
      SETTINGS.products.indexOf(a.product) - SETTINGS.products.indexOf(b.product),
  );
  const best = sorted[0];
  const dates = [...new Set(sorted.map((f) => f.date))].sort();
  const lines = dates.map((d) => {
    const items = sorted.filter((f) => f.date === d).map((f) => `  - ${f.product.name}: ${LABEL[f.level]()}`);
    return `${pretty(d)}\n${items.join("\n")}`;
  });
  const headline = {
    party: `${SETTINGS.partySize} tickets OPEN`,
    unverified: "tickets opening",
    single: "1 seat open",
  }[best.level];
  return {
    title: `Alhambra: ${headline} - ${best.product.name}, ${pretty(best.date)}`,
    message: `${lines.join("\n\n")}\n\nTap to open ${best.product.name} and pick the date. Have both passports ready - Alhambra tickets are issued in each visitor's name. Book fast; if nothing is bookable, someone may be holding it in their cart and you'll get another alert if it comes back.`,
    priority: best.level === "single" ? 4 : 5,
    tags: best.level === "single" ? ["ticket"] : ["rotating_light", "ticket"],
    click: best.product.url,
    ref: "open:" + sorted.map((f) => `${f.product.id}/${f.date}/${f.level}`).sort().join(","),
  };
}

function windowOver() {
  const last = [...SETTINGS.dates].sort().at(-1);
  return Date.now() > Date.parse(`${last}T18:00:00Z`); // evening of the last date, Barcelona time
}

// ---------- GitHub Actions plumbing ----------
async function github(path, method, body) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
  if (!token || !repo) return null;
  return fetch(`https://api.github.com/repos/${repo}/actions/workflows/alhambra.yml/${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// GitHub's own scheduler is patchy, so each run starts the next one when it finishes.
async function startNextRun() {
  if (windowOver()) return;
  const res = await github("dispatches", "POST", { ref: process.env.GITHUB_REF_NAME || "main" });
  if (res) console.log(res.status === 204 ? "Next run queued." : `Could not queue next run: ${res.status}`);
}

// ---------- main ----------
export async function main() {
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && process.env.TEST_PUSH === "true") {
    await notify({
      title: "Alhambra watcher connected",
      message: `Watching ${SETTINGS.dates.map(pretty).join(", ")} for ${SETTINGS.partySize} tickets, all Granada Card types.`,
      tags: ["white_check_mark"],
      click: SETTINGS.products[0].url,
      ref: `test:${Date.now()}`,
    });
  }

  if (windowOver()) {
    console.log("Trip dates have passed - switching the watcher off.");
    await github("disable", "PUT");
    return;
  }

  const deadline = Date.now() + SETTINGS.pollMinutes * 60_000;
  let token = await getToken();
  const groupFilter = await detectGroupFilter(token);
  console.log("Group-size filter works for: " +
    SETTINGS.products.filter((p) => groupFilter.get(p.id)).map((p) => p.name).join(", "));
  let checks = 0;
  let failures = 0;
  let lastAlert = null;   // what we last told the user was open, in this run
  let sawClosed = false;  // this run has seen "nothing open" at least once

  while (Date.now() < deadline) {
    checks++;
    try {
      const found = await check(token, groupFilter);
      failures = 0;
      console.log(`Check ${checks}: ${found.length ? found.map((f) => `${f.product.id}:${f.level}`).join(" ") : "nothing open"}`);

      const alert = buildAlert(found);
      if (alert) {
        // Alert on every change. The ntfy history check only guards the very start of
        // a run (so a new run doesn't repeat its predecessor's alert); once this run has
        // seen tickets disappear, a reappearance is always news.
        const isNew = alert.ref !== lastAlert?.ref;
        if (isNew && (sawClosed || lastAlert || !(await sentRecently(alert.ref, SETTINGS.repeatAfterHours)))) {
          await notify(alert);
        }
        lastAlert = alert;
      } else {
        if (lastAlert) {
          await notify({
            title: "Alhambra: gone again",
            message: "The tickets from the last alert are no longer showing. Released tickets often get held in someone's cart and come back when that cart expires, so keep the app on - you'll get a new alert if they reappear.",
            priority: 2,
            tags: ["x"],
            ref: `closed:${Date.now()}`,
          });
        }
        lastAlert = null;
        sawClosed = true;
      }

      // Once a day (about 9:00 IST) confirm the watcher is still alive.
      if (checks === 1 && new Date().getUTCHours() === 3 && !(await sentRecently("heartbeat", 6))) {
        await notify({
          title: "Alhambra watcher: still running",
          message: `Nothing open yet for ${SETTINGS.dates.map(pretty).join(", ")} (all Granada Card types). If this daily note stops, the watcher has stopped.`,
          priority: 1,
          tags: ["hourglass"],
          ref: "heartbeat",
        });
      }
    } catch (e) {
      failures++;
      console.error(`Check ${checks} failed: ${e.message}`);
      try { token = await getToken(); } catch {}
      if (failures === 3 && !(await sentRecently("broken", 6))) {
        await notify({
          title: "Alhambra watcher has a problem",
          message: `Checks are failing, so silence doesn't mean "no tickets". Error: ${String(e.message).slice(0, 200)}`,
          priority: 4,
          tags: ["warning"],
          ref: "broken",
        }).catch(() => {});
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(SETTINGS.pollIntervalSec * 1000, left));
  }

  console.log(`Done: ${checks} checks.`);
  await startNextRun();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
