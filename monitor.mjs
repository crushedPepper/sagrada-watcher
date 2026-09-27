// Sagrada Familia ticket watcher.
// Checks the official booking backend (the same one tickets.sagradafamilia.org
// uses) and sends a phone push via ntfy.sh when the watched dates open up.
// It never books or pays - you get the alert and book yourself.

import { pathToFileURL } from "node:url";

// ---------- settings (edit these if your plans change) ----------
export const SETTINGS = {
  dates: (process.env.WATCH_DATES || "2026-10-07,2026-10-08,2026-10-09")
    .split(",").map((d) => d.trim()).filter(Boolean),
  partySize: Number(process.env.PARTY_SIZE || 2),
  product: {
    id: 4375,
    venueId: 1,
    name: "Sagrada Familia (basic entry)",
    url: "https://tickets.sagradafamilia.org/en/1-individual/4375-sagrada-familia",
  },
  pollMinutes: Number(process.env.POLL_MINUTES || 50),     // how long one run keeps watching
  pollIntervalSec: Number(process.env.POLL_INTERVAL_SEC || 180), // gap between checks
  repeatAfterHours: 1, // re-alert about a still-open date at most once an hour
};

const API = "https://services.clorian.com";
const SALES_GROUP = "1";
const POS = "649";
const FRONTEND_KEY = "thesagradafamiliafrontendoftomorrow"; // public key used by the official site
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const COMMON_HEADERS = {
  accept: "application/json, text/plain, */*",
  origin: "https://tickets.sagradafamilia.org",
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
async function getCalendar(token, minTickets) {
  const months = [...new Set(SETTINGS.dates.map((d) => d.slice(0, 7)))];
  const calendar = {};
  for (const ym of months) {
    const [year, month] = ym.split("-");
    const qs = new URLSearchParams({
      minTickets: String(minTickets),
      month: String(Number(month)),
      venueId: String(SETTINGS.product.venueId),
      year,
    });
    const res = await request(
      `${API}/catalog/salesGroups/${SALES_GROUP}/product/${SETTINGS.product.id}/availability?${qs}`,
      { headers: { ...COMMON_HEADERS, authorization: `Bearer ${token}`, pos: POS, "content-type": "application/json" } },
    );
    Object.assign(calendar, await res.json());
  }
  return calendar;
}

export function openDates(calendar, dates = SETTINGS.dates) {
  return dates.filter((d) => calendar?.[d] === "availability");
}

// One check. Returns the watched dates that have a slot for the whole party.
export async function check(token) {
  const permissive = await getCalendar(token, 1);
  if (Object.keys(permissive).length === 0) {
    // An empty calendar means the API shape/venue changed, not "sold out".
    throw new Error("Booking backend returned an empty calendar - the checker may need updating.");
  }
  await sleep(300);
  const forParty = await getCalendar(token, SETTINGS.partySize);
  return { open: openDates(forParty), anyOpen: openDates(permissive) };
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
    return (await res.text()).split("\n").some((l) => l.includes(`ref:${ref}`));
  } catch {
    return false;
  }
}

const pretty = (d) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function buildAlert(open, anyOpen) {
  if (open.length) {
    return {
      title: `Sagrada Familia: tickets OPEN for ${open.map(pretty).join(", ")}`,
      message: `A time slot with ${SETTINGS.partySize} seats together just appeared. Book fast - these go in minutes.`,
      priority: 5,
      tags: ["rotating_light", "ticket"],
      click: SETTINGS.product.url,
      ref: `open:${open.join(",")}`,
    };
  }
  const single = anyOpen;
  if (single.length && SETTINGS.partySize > 1) {
    return {
      title: `Sagrada Familia: 1 seat open on ${single.map(pretty).join(", ")}`,
      message: `Only single seats right now, not ${SETTINGS.partySize} together. You could try booking 1 + 1 in two nearby slots.`,
      priority: 4,
      tags: ["ticket"],
      click: SETTINGS.product.url,
      ref: `single:${single.join(",")}`,
    };
  }
  return null;
}

function windowOver() {
  const last = [...SETTINGS.dates].sort().at(-1);
  return Date.now() > Date.parse(`${last}T18:00:00Z`); // evening of the last date, Barcelona time
}

// ---------- GitHub Actions plumbing ----------
async function github(path, method, body) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
  if (!token || !repo) return null;
  return fetch(`https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/${path}`, {
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
      title: "Sagrada watcher connected",
      message: `Watching ${SETTINGS.dates.map(pretty).join(", ")} for ${SETTINGS.partySize} tickets.`,
      tags: ["white_check_mark"],
      click: SETTINGS.product.url,
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
  let checks = 0;
  let failures = 0;
  const alreadySent = new Set();

  while (Date.now() < deadline) {
    checks++;
    try {
      const { open, anyOpen } = await check(token);
      failures = 0;
      console.log(`Check ${checks}: open for party=${open.length}, any seat=${anyOpen.length}`);

      const alert = buildAlert(open, anyOpen);
      if (alert && !alreadySent.has(alert.ref) && !(await sentRecently(alert.ref, SETTINGS.repeatAfterHours))) {
        await notify(alert);
        alreadySent.add(alert.ref);
      }

      // Once a day (about 9:00 IST) confirm the watcher is still alive.
      const now = new Date();
      if (checks === 1 && now.getUTCHours() === 3 && !(await sentRecently("heartbeat", 6))) {
        await notify({
          title: "Sagrada watcher: still running",
          message: `Nothing open yet for ${SETTINGS.dates.map(pretty).join(", ")}. If this daily note stops, the watcher has stopped.`,
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
          title: "Sagrada watcher has a problem",
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
