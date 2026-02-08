require("dotenv").config();
const { App } = require("@slack/bolt");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const cheerio = require("cheerio");
const pdfParse = require("pdf-parse");

// ── Initialise clients ──────────────────────────────────────────────

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const googleAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
});

const sheets = google.sheets({ version: "v4", auth: googleAuth });
const drive = google.drive({ version: "v3", auth: googleAuth });

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const TEAM_SPREADSHEET_ID = process.env.GOOGLE_TEAM_SPREADSHEET_ID || null;
const SUBMISSIONS_SPREADSHEET_ID = process.env.GOOGLE_SUBMISSIONS_SPREADSHEET_ID || null;
const SUBMISSIONS_NOTIFY_CHANNEL = process.env.SUBMISSIONS_NOTIFY_CHANNEL || null;
const STREAMTIME_API_KEY = process.env.STREAMTIME_API_KEY || null;
const STREAMTIME_API_BASE = "https://api.streamtime.net/v1";
const TALENT_SCOUT_CHANNEL = process.env.TALENT_SCOUT_CHANNEL || null;
// Comma-separated list of directory URLs to scrape for talent
const TALENT_SCOUT_SOURCES = process.env.TALENT_SCOUT_SOURCES
  ? process.env.TALENT_SCOUT_SOURCES.split(",").map((s) => s.trim())
  : [];

// ── Claude API with retry on rate limit ─────────────────────────────

async function claudeCreate(params, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      if (err.status === 429 && attempt < retries) {
        const waitSecs = parseInt(err.headers?.["retry-after"] || "30", 10);
        console.log(`⏳ Rate limited — waiting ${waitSecs}s before retry (attempt ${attempt + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, waitSecs * 1000));
      } else {
        throw err;
      }
    }
  }
}

// ── Tabs we care about (skip "REQUESTS" tab) ────────────────────────

const FREELANCER_TABS = [
  "Creative Directors",
  "AD/Designers",
  "Copywriters",
  "Animators",
  "3D Artists",
  "Developers",
  "Producers/AM",
  "Retouchers",
  "Photographer/Videographers",
  "Strategists",
  "Specialists",
];

// ── Simple cache to avoid re-fetching the sheet on every request ──────

let rosterCache = null;
let cacheTimestamp = 0;
let teamCache = null;
let teamCacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute — fresh enough for live data, avoids hammering the API

// ── Streamtime job history cache ────────────────────────────────────
let streamtimeCache = null;
let streamtimeCacheTimestamp = 0;
const STREAMTIME_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — jobs don't change as often

// ── Streamtime API helper ───────────────────────────────────────────

async function streamtimeFetch(path, method = "GET", body = null) {
  if (!STREAMTIME_API_KEY) return null;

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${STREAMTIME_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${STREAMTIME_API_BASE}${path}`, options);
  if (!res.ok) return null;
  return res.json();
}

async function streamtimeSearch(searchView, maxResults = 200, offset = 0) {
  return streamtimeFetch(
    `/search?search_view=${searchView}&include_statistics=false`,
    "POST",
    {
      offset,
      maxResults,
      filterGroupCollection: {
        conditionMatchTypeId: 1,
        filterGroups: [],
        filterGroupCollections: [],
      },
    }
  );
}

// ── Paginated Streamtime search helper ───────────────────────────────

async function streamtimeSearchAll(searchView, maxTotal = 2000) {
  const all = [];
  let offset = 0;
  const pageSize = 200;

  while (true) {
    const data = await streamtimeSearch(searchView, pageSize, offset);
    if (!data || !data.searchResults) break;

    all.push(...data.searchResults);

    if (data.searchResults.length < pageSize) break;
    offset += pageSize;
    if (all.length >= maxTotal) break;
  }

  return all;
}

// ── Fetch Streamtime job history and build person → jobs mapping ─────

async function fetchStreamtimeJobHistory() {
  if (!STREAMTIME_API_KEY) return null;

  // Return cached data if still fresh
  if (streamtimeCache && Date.now() - streamtimeCacheTimestamp < STREAMTIME_CACHE_TTL_MS) {
    return streamtimeCache;
  }

  try {
    console.log("🏢 Fetching Streamtime data...");

    // 1. Fetch all users to get ID → name mapping
    const usersData = await streamtimeFetch("/users");
    if (!usersData) {
      console.warn("⚠️ Streamtime: could not fetch users");
      return null;
    }

    const userMap = {}; // id → { firstName, lastName, fullName, role }
    for (const u of usersData) {
      userMap[u.id] = {
        firstName: u.firstName || "",
        lastName: u.lastName || "",
        fullName: `${u.firstName || ""} ${u.lastName || ""}`.trim(),
        displayName: u.displayName || "",
        role: u.role?.name || u.jobTitle || "",
      };
    }
    console.log(`🏢 Streamtime: ${Object.keys(userMap).length} users loaded`);

    // 2. Fetch jobs, job items, and job item users in parallel
    const [allJobs, allJobItems, allJobItemUsers] = await Promise.all([
      streamtimeSearchAll(7, 2000),   // Jobs
      streamtimeSearchAll(16, 5000),  // Job Items (tasks within jobs)
      streamtimeSearchAll(17, 5000),  // Job Item Users (who's on each task + hours)
    ]);

    console.log(`🏢 Streamtime: ${allJobs.length} jobs, ${allJobItems.length} job items, ${allJobItemUsers.length} job item users`);

    // 3. Build lookup maps for enrichment
    // jobId → job info
    const jobMap = {};
    for (const job of allJobs) {
      jobMap[job.id] = {
        number: job.number || "",
        name: job.name || "",
        company: job.company?.name || "Unknown client",
        status: job.jobStatus?.name || "",
      };
    }

    // jobItemId → task name
    const jobItemMap = {};
    for (const item of allJobItems) {
      jobItemMap[item.id] = {
        name: item.name || "",
        jobId: item.jobId,
      };
    }

    // 4. Build person → jobs mapping with task-level detail
    const personJobs = {};

    // First pass: job-level assignments (from the users array on each job)
    for (const job of allJobs) {
      const jobInfo = {
        number: job.number || "",
        name: job.name || "",
        company: job.company?.name || "Unknown client",
        status: job.jobStatus?.name || "",
        tasks: [],    // Will be enriched with task-level detail
        totalHours: 0,
      };

      const jobUsers = job.users || [];
      for (const u of jobUsers) {
        const user = userMap[u.id];
        if (!user) continue;

        const key = user.fullName.toLowerCase();
        if (!personJobs[key]) {
          personJobs[key] = {
            fullName: user.fullName,
            displayName: user.displayName,
            role: user.role,
            jobs: {},      // jobId → jobInfo (deduped)
            currentJobs: [],  // Jobs where they're currently scheduled
          };
        }
        personJobs[key].jobs[job.id] = { ...jobInfo };
      }
    }

    // Second pass: enrich with task-level detail from Job Item Users
    for (const jiu of allJobItemUsers) {
      const user = userMap[jiu.userId];
      if (!user) continue;

      const key = user.fullName.toLowerCase();
      const jobItem = jobItemMap[jiu.jobItemId];
      if (!jobItem) continue;

      const job = jobMap[jobItem.jobId];
      if (!job) continue;

      // Ensure person entry exists
      if (!personJobs[key]) {
        personJobs[key] = {
          fullName: user.fullName,
          displayName: user.displayName,
          role: user.role,
          jobs: {},
          currentJobs: [],
        };
      }

      // Ensure job entry exists for this person
      if (!personJobs[key].jobs[jobItem.jobId]) {
        personJobs[key].jobs[jobItem.jobId] = {
          number: job.number,
          name: job.name,
          company: job.company,
          status: job.status,
          tasks: [],
          totalHours: 0,
        };
      }

      const personJob = personJobs[key].jobs[jobItem.jobId];

      // Add the specific task they worked on
      const hoursLogged = Math.round((jiu.totalLoggedMinutes || 0) / 60 * 10) / 10;
      if (jobItem.name) {
        personJob.tasks.push(jobItem.name);
      }
      personJob.totalHours += hoursLogged;

      // Track current scheduling for availability
      const status = jiu.jobItemUserStatus?.name || "";
      const endDate = jiu.latestEndDate || "";
      const today = new Date().toISOString().split("T")[0];

      if ((status === "Scheduled" || status === "In Play") && (!endDate || endDate >= today)) {
        personJobs[key].currentJobs.push({
          jobName: `${job.number} ${job.name}`,
          task: jobItem.name || "",
          startDate: jiu.earliestStartDate || "",
          endDate: endDate,
          status,
        });
      }
    }

    // Convert jobs objects to arrays for cleaner output
    for (const person of Object.values(personJobs)) {
      person.jobList = Object.values(person.jobs);
      // Deduplicate tasks within each job
      for (const j of person.jobList) {
        j.tasks = [...new Set(j.tasks)];
        j.totalHours = Math.round(j.totalHours * 10) / 10;
      }
      // Deduplicate current jobs
      const seen = new Set();
      person.currentJobs = person.currentJobs.filter((cj) => {
        const k = cj.jobName;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    console.log(`🏢 Streamtime: ${Object.keys(personJobs).length} people matched to jobs`);

    streamtimeCache = { userMap, personJobs, totalJobs: allJobs.length };
    streamtimeCacheTimestamp = Date.now();
    return streamtimeCache;
  } catch (err) {
    console.warn("⚠️ Streamtime fetch error:", err.message);
    return null;
  }
}

// ── Format Streamtime job history for Claude prompt ──────────────────
// Only includes people who are in the roster or team sheet to keep the prompt small.

function formatStreamtimeForPrompt(streamtimeData, roster, team) {
  if (!streamtimeData || !streamtimeData.personJobs) return "";

  const { personJobs } = streamtimeData;
  if (Object.keys(personJobs).length === 0) return "";

  // Build a set of names from the roster + team so we only include relevant people
  const knownNames = new Set();
  for (const p of (roster || [])) {
    if (p.Name) knownNames.add(normalizeName(p.Name));
  }
  for (const p of (team || [])) {
    if (p.Name) knownNames.add(normalizeName(p.Name));
  }

  let text = "\n\n═══ STREAMTIME PROJECT HISTORY ═══\n";
  text += "(Real project data from Streamtime — shows who worked on what, their tasks, hours logged, and current bookings. Use this to match people to similar jobs/clients and check availability.)\n";

  let includedCount = 0;
  for (const [key, person] of Object.entries(personJobs)) {
    // Only include people who are in our roster or team sheet
    if (!knownNames.has(normalizeName(person.fullName))) continue;

    const jobs = person.jobList || [];
    if (jobs.length === 0) continue;

    // Last 10 jobs — enough context without bloating the prompt
    const recentJobs = jobs.slice(-10);

    text += `\n• ${person.fullName}`;

    // Flag current bookings for availability
    if (person.currentJobs && person.currentJobs.length > 0) {
      const bookings = person.currentJobs.slice(0, 3);
      text += ` [⚠️ CURRENTLY BOOKED: ${bookings.map((b) => b.jobName).join(", ")}]`;
    }

    text += "\n  ";
    text += recentJobs.map((j) => {
      let entry = `${j.number} ${j.name} [${j.company}]`;
      // Add task names if available (concise)
      if (j.tasks && j.tasks.length > 0) {
        entry += ` (${j.tasks.slice(0, 3).join(", ")})`;
      }
      // Add hours if significant
      if (j.totalHours >= 1) {
        entry += ` ${j.totalHours}hrs`;
      }
      return entry;
    }).join(" | ");
    text += "\n";
    includedCount++;
  }

  if (includedCount === 0) return "";
  return text;
}

// ── Sync Streamtime users → Team Google Sheet ────────────────────────
// Streamtime is the source of truth for who's on the team.
// This adds missing people and updates roles, but never overwrites Comments
// or other manually-entered columns.

async function syncStreamtimeToTeamSheet() {
  if (!STREAMTIME_API_KEY || !TEAM_SPREADSHEET_ID) return;

  try {
    console.log("🔄 Syncing Streamtime users → Team sheet...");

    // 1. Fetch all Streamtime users
    const usersData = await streamtimeFetch("/users");
    if (!usersData || !Array.isArray(usersData)) {
      console.warn("⚠️ Streamtime sync: could not fetch users");
      return;
    }

    // 2. Read current team sheet
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: TEAM_SPREADSHEET_ID,
      range: "A1:Z",
    });

    const rows = data.values || [];
    if (rows.length < 1) {
      console.warn("⚠️ Streamtime sync: team sheet has no headers");
      return;
    }

    const headers = rows[0].map((h) => h.trim());
    const nameCol = headers.findIndex((h) => h.toLowerCase() === "name");
    const roleCol = headers.findIndex((h) => h.toLowerCase() === "role");

    if (nameCol === -1) {
      console.warn("⚠️ Streamtime sync: no 'Name' column found in team sheet");
      return;
    }

    // 3. Build a map of existing names (normalized → row index)
    const existingNames = new Map();
    for (let i = 1; i < rows.length; i++) {
      const name = (rows[i][nameCol] || "").trim();
      if (name) {
        existingNames.set(normalizeName(name), i);
      }
    }

    // 4. Compare Streamtime users against the sheet
    const statusCol = headers.findIndex((h) => h.toLowerCase() === "status");
    const newUsers = [];
    const updatedRoles = [];
    const activeStreamtimeNames = new Set(); // Track who's still in Streamtime

    for (const u of usersData) {
      const fullName = `${u.firstName || ""} ${u.lastName || ""}`.trim();
      if (!fullName) continue;

      // Skip users that look inactive/archived
      if (u.isArchived || u.archived || u.isActive === false) continue;

      const normalized = normalizeName(fullName);
      const role = u.role?.name || u.jobTitle || "";
      activeStreamtimeNames.add(normalized);

      if (!existingNames.has(normalized)) {
        // New person — needs to be added to the sheet
        newUsers.push({ name: fullName, role });
      } else if (roleCol >= 0 && role) {
        // Existing person — update their role if it changed in Streamtime
        const rowIdx = existingNames.get(normalized);
        const currentRole = (rows[rowIdx][roleCol] || "").trim();
        if (currentRole !== role) {
          updatedRoles.push({ name: fullName, role, rowIdx });
        }
      }
    }

    // 4b. Update Status column for everyone in the sheet
    const markedInactive = [];
    const markedActive = [];
    if (statusCol >= 0) {
      for (const [normalized, rowIdx] of existingNames) {
        const currentStatus = (rows[rowIdx][statusCol] || "").trim().toLowerCase();
        const name = (rows[rowIdx][nameCol] || "").trim();

        if (activeStreamtimeNames.has(normalized)) {
          // Still in Streamtime — mark Active if not already
          if (currentStatus !== "active") {
            markedActive.push({ name, rowIdx });
          }
        } else {
          // No longer in Streamtime — mark Inactive if not already
          if (currentStatus !== "inactive") {
            markedInactive.push({ name, rowIdx });
          }
        }
      }
    }

    // 5. Append new users to the sheet
    if (newUsers.length > 0) {
      const newRows = newUsers.map((u) => {
        const row = new Array(headers.length).fill("");
        if (nameCol >= 0) row[nameCol] = u.name;
        if (roleCol >= 0) row[roleCol] = u.role;
        if (statusCol >= 0) row[statusCol] = "Active";
        return row;
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId: TEAM_SPREADSHEET_ID,
        range: "A1",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: newRows },
      });

      console.log(`🔄 Added ${newUsers.length} new team member(s) from Streamtime: ${newUsers.map((u) => u.name).join(", ")}`);
    }

    // 6. Update roles for existing users (only the Role column — nothing else)
    for (const update of updatedRoles) {
      const colLetter = colIndexToLetter(roleCol);
      const sheetRow = update.rowIdx + 1; // rows array is 0-indexed, sheet is 1-indexed

      await sheets.spreadsheets.values.update({
        spreadsheetId: TEAM_SPREADSHEET_ID,
        range: `${colLetter}${sheetRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [[update.role]] },
      });
    }

    if (updatedRoles.length > 0) {
      console.log(`🔄 Updated roles for ${updatedRoles.length} team member(s): ${updatedRoles.map((u) => `${u.name} → ${u.role}`).join(", ")}`);
    }

    // 7. Update Status column — Active for current, Inactive for departed
    if (statusCol >= 0) {
      const colLetter = colIndexToLetter(statusCol);

      for (const person of markedActive) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: TEAM_SPREADSHEET_ID,
          range: `${colLetter}${person.rowIdx + 1}`,
          valueInputOption: "RAW",
          requestBody: { values: [["Active"]] },
        });
      }

      for (const person of markedInactive) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: TEAM_SPREADSHEET_ID,
          range: `${colLetter}${person.rowIdx + 1}`,
          valueInputOption: "RAW",
          requestBody: { values: [["Inactive"]] },
        });
      }
    }

    if (markedActive.length > 0) {
      console.log(`🔄 Marked ${markedActive.length} team member(s) as Active`);
    }
    if (markedInactive.length > 0) {
      console.log(`🔄 Marked ${markedInactive.length} team member(s) as Inactive: ${markedInactive.map((u) => u.name).join(", ")}`);
    }

    if (newUsers.length === 0 && updatedRoles.length === 0 && markedActive.length === 0 && markedInactive.length === 0) {
      console.log("🔄 Streamtime sync: team sheet already up to date");
    }

    // Bust team cache since we may have changed the sheet
    if (newUsers.length > 0 || updatedRoles.length > 0 || markedActive.length > 0 || markedInactive.length > 0) {
      teamCache = null;
      teamCacheTimestamp = 0;
    }
  } catch (err) {
    console.warn("⚠️ Streamtime sync error:", err.message);
  }
}

// ── Read entire freelancer roster from Google Sheets ─────────────────

async function fetchRoster() {
  // Return cached data if still fresh
  if (rosterCache && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return rosterCache;
  }

  // Fetch each tab individually so one missing tab doesn't break everything
  const roster = [];

  for (const tabName of FREELANCER_TABS) {
    try {
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${tabName}'!A2:Z`,
      });

      const rows = data.values || [];
      if (rows.length < 2) continue; // skip empty tabs

      const headers = rows[0].map((h) => h.trim());
      console.log(`📋 Tab "${tabName}" — Headers: [${headers.join(", ")}]`);
      console.log(`📋 Tab "${tabName}" — ${rows.length - 1} data rows, first row sample:`, rows[1]?.slice(0, 4));

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row[0] || !row[0].trim()) continue;

        const entry = { Category: tabName };
        headers.forEach((header, col) => {
          entry[header] = (row[col] || "").trim();
        });
        roster.push(entry);
      }
    } catch (err) {
      console.warn(`⚠️ Skipping tab "${tabName}" — not found or unreadable`);
    }
  }

  rosterCache = roster;
  cacheTimestamp = Date.now();
  return roster;
}

// ── Read internal studio team from Google Sheets ─────────────────────

async function fetchTeam() {
  if (!TEAM_SPREADSHEET_ID) return [];

  if (teamCache && Date.now() - teamCacheTimestamp < CACHE_TTL_MS) {
    return teamCache;
  }

  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: TEAM_SPREADSHEET_ID,
      range: "A1:Z",
    });

    const rows = data.values || [];
    if (rows.length < 2) return [];

    const headers = rows[0].map((h) => h.trim());
    console.log(`👥 Team sheet — Headers: [${headers.join(", ")}]`);

    const team = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0] || !row[0].trim()) continue;

      const entry = { Source: "Internal Team" };
      headers.forEach((header, col) => {
        entry[header] = (row[col] || "").trim();
      });

      // Skip people marked as Inactive (no longer at the company)
      if ((entry.Status || "").toLowerCase() === "inactive") continue;

      team.push(entry);
    }

    console.log(`👥 Team sheet — ${team.length} team members loaded`);
    teamCache = team;
    teamCacheTimestamp = Date.now();
    return team;
  } catch (err) {
    console.warn("⚠️ Could not read internal team sheet:", err.message);
    return [];
  }
}

// ── Format internal team as a readable string for Claude ─────────────

function formatTeamForPrompt(team) {
  if (team.length === 0) return "";

  let text = "\n\n═══ INTERNAL STUDIO TEAM ═══\n";
  for (const p of team) {
    text += `\n• ${p.Name || "Unknown"}`;
    if (p.Role) text += ` | Role: ${p.Role}`;
    if (p.Level) text += ` | Level: ${p.Level}`;
    if (p["Cost Rate ( per 8hr day)"] || p["Cost Rate (per 8hr day)"])
      text += ` | Day Rate: ${p["Cost Rate ( per 8hr day)"] || p["Cost Rate (per 8hr day)"]}`;
    if (p.Capabilites || p.Capabilities)
      text += `\n  Capabilities: ${p.Capabilites || p.Capabilities}`;
    if (p.Clients) text += `\n  Previous Clients: ${p.Clients}`;
    if (p.Location) text += `\n  Location: ${p.Location}`;
    if (p.Comments) text += `\n  Comments: ${p.Comments}`;
    text += "\n";
  }
  return text;
}

// ── Format roster as a readable string for Claude ────────────────────

function formatRosterForPrompt(roster) {
  const grouped = {};
  for (const person of roster) {
    const cat = person.Category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(person);
  }

  let text = "";
  for (const [category, people] of Object.entries(grouped)) {
    text += `\n═══ ${category.toUpperCase()} ═══\n`;
    for (const p of people) {
      text += `\n• ${p.Name || "Unknown"}`;
      if (p.Level) text += ` | Level: ${p.Level}`;
      if (p.Availability || p.Availibility)
        text += ` | Availability: ${p.Availability || p.Availibility}`;
      if (p.Status) text += ` | Status: ${p.Status}`;
      if (p["Cost Rate ( per 8hr day)"] || p["Cost Rate (per 8hr day)"])
        text += ` | Day Rate: ${p["Cost Rate ( per 8hr day)"] || p["Cost Rate (per 8hr day)"]}`;
      if (p["Min Sell Rate (2X)"])
        text += ` | Min Sell Rate: ${p["Min Sell Rate (2X)"]}`;
      if (p.Capabilites || p.Capabilities)
        text += `\n  Capabilities: ${p.Capabilites || p.Capabilities}`;
      if (p.Reccomendation || p.Recommendation)
        text += `\n  Recommendation: ${p.Reccomendation || p.Recommendation}`;
      if (p.Clients) text += `\n  Previous Clients: ${p.Clients}`;
      if (p.Location) text += `\n  Location: ${p.Location}`;
      if (p.Comments) text += `\n  Comments: ${p.Comments}`;
      if (p.Portfolio) text += `\n  Portfolio: ${p.Portfolio}`;
      text += "\n";
    }
  }
  return text;
}

// ── Brief extraction (PDF attachments + Google Docs links) ───────────

// Extract text from a PDF file buffer (with fallback for non-standard PDFs)
async function extractPdfText(buffer) {
  // Verify it's actually a PDF (should start with %PDF)
  const header = buffer.slice(0, 5).toString("ascii");
  if (!header.startsWith("%PDF")) {
    console.warn(`📄 File header is "${header}" — not a standard PDF, trying anyway...`);
  }

  // Primary: use pdf-parse
  try {
    const data = await pdfParse(buffer);
    const text = data.text.trim();
    if (text && text.length > 20) return text;
  } catch (error) {
    console.warn("📄 pdf-parse failed:", error.message);
  }

  // Fallback: extract readable strings from the raw PDF binary
  // Many PDFs contain readable text between stream markers
  try {
    const raw = buffer.toString("latin1");
    const textChunks = [];
    // Look for text between BT (begin text) and ET (end text) operators
    const btPattern = /BT\s([\s\S]*?)ET/g;
    let match;
    while ((match = btPattern.exec(raw)) !== null) {
      // Extract strings in parentheses (PDF text objects)
      const tjPattern = /\(([^)]+)\)/g;
      let tj;
      while ((tj = tjPattern.exec(match[1])) !== null) {
        const cleaned = tj[1].replace(/\\[nrt]/g, " ").trim();
        if (cleaned.length > 1) textChunks.push(cleaned);
      }
    }
    if (textChunks.length > 5) {
      console.log(`📄 Fallback extraction got ${textChunks.length} text chunks`);
      return textChunks.join(" ").replace(/\s+/g, " ").trim();
    }
  } catch (e) {
    console.warn("📄 Fallback text extraction also failed:", e.message);
  }

  return null;
}

// Extract text from a DOCX file buffer (DOCX = ZIP of XML files)
async function extractDocxText(buffer) {
  try {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("word/document.xml");
    if (!entry) {
      console.warn("📄 DOCX: no word/document.xml found in archive");
      return null;
    }
    const xml = entry.getData().toString("utf-8");
    // Strip XML tags, keep text content
    const text = xml
      .replace(/<w:br[^>]*\/>/g, "\n")         // line breaks
      .replace(/<\/w:p>/g, "\n")                // paragraph breaks
      .replace(/<[^>]+>/g, "")                  // strip all XML tags
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, "\n\n")              // collapse multiple blank lines
      .trim();
    return text.length > 20 ? text : null;
  } catch (error) {
    console.error("📄 DOCX extraction error:", error.message);
    return null;
  }
}

// Download a file from Slack (requires bot token for private URLs)
async function downloadSlackFile(fileUrl) {
  try {
    const response = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error("Slack file download error:", error.message);
    return null;
  }
}

// Fetch content from a Google Doc via Drive API (exports as plain text)
async function fetchGoogleDocContent(docId) {
  try {
    const response = await drive.files.export({
      fileId: docId,
      mimeType: "text/plain",
    });
    return typeof response.data === "string"
      ? response.data.trim()
      : String(response.data).trim();
  } catch (error) {
    // If it's a DOCX/uploaded file (not a native Google Doc), export won't work
    // Fall back to downloading the raw file and extracting text
    if (error.message && error.message.includes("Export only supports Docs Editors files")) {
      console.log(`📄 Doc ${docId} is not a native Google Doc (likely DOCX) — downloading raw file...`);
      try {
        const fileRes = await drive.files.get(
          { fileId: docId, alt: "media" },
          { responseType: "arraybuffer" }
        );
        const buffer = Buffer.from(fileRes.data);
        // Try DOCX extraction first (most likely for .docx files opened in Google Docs)
        const docxText = await extractDocxText(buffer);
        if (docxText) {
          console.log(`📄 Extracted ${docxText.length} chars from DOCX via Drive download`);
          return docxText;
        }
        // Try PDF extraction as fallback
        const pdfText = await extractPdfText(buffer);
        if (pdfText) {
          console.log(`📄 Extracted ${pdfText.length} chars from PDF via Drive download`);
          return pdfText;
        }
        console.warn(`📄 Could not extract text from downloaded file ${docId}`);
        return null;
      } catch (dlError) {
        console.error(`📄 Drive download fallback failed (${docId}):`, dlError.message);
        return null;
      }
    }
    console.error(`Google Doc fetch error (${docId}):`, error.message);
    return null;
  }
}

// Parse Google Doc/Slides/Sheet URLs from message text
// Supports: docs.google.com/document/d/DOC_ID/...
function extractGoogleDocIds(text) {
  const pattern = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/g;
  const ids = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

// Extract brief content from all attachments and Google Doc links in a message
async function extractBriefContent(event) {
  const briefParts = [];

  // 1. Check for file attachments (PDF, DOCX, text)
  if (event.files && event.files.length > 0) {
    for (const file of event.files) {
      const name = file.name || "unknown";
      const mime = file.mimetype || "";
      const isPdf = mime === "application/pdf" || name.endsWith(".pdf");
      const isDocx = mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || name.endsWith(".docx");
      const isText = mime.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md");

      if (isPdf || isDocx) {
        console.log(`📄 Downloading ${isPdf ? "PDF" : "DOCX"}: ${name} (${(file.size / 1024).toFixed(0)}KB)`);
        const buffer = await downloadSlackFile(file.url_private);
        let text = null;
        if (buffer) {
          if (isPdf) {
            // Try PDF extraction first
            text = await extractPdfText(buffer);
            // If PDF fails, check if it's actually a DOCX disguised as PDF
            if (!text && buffer[0] === 0x50 && buffer[1] === 0x4B) {
              console.log("📄 File is actually a ZIP/DOCX — trying DOCX extraction...");
              text = await extractDocxText(buffer);
            }
          } else {
            text = await extractDocxText(buffer);
          }
        }
        // Fallback: use Slack's own plain_text preview if our extraction fails
        if (!text) {
          const slackPreview = file.plain_text || file.preview || "";
          if (slackPreview.length > 50) {
            console.log(`📄 Using Slack preview (${slackPreview.length} chars) for ${name}`);
            text = slackPreview;
          }
        }
        // Last resort: fetch Slack's plain text conversion via files.info
        if (!text) {
          try {
            const fileInfo = await slack.client.files.info({ file: file.id });
            const content = fileInfo.content || fileInfo.file?.plain_text || fileInfo.file?.preview || "";
            if (content.length > 50) {
              console.log(`📄 Using Slack files.info content (${content.length} chars) for ${name}`);
              text = content;
            }
          } catch (e) {
            console.warn(`📄 files.info fallback failed: ${e.message}`);
          }
        }
        if (text) {
          console.log(`📄 ✅ Extracted ${text.length} chars from ${name}`);
          briefParts.push(`--- Brief: ${name} ---\n${text}`);
        } else {
          console.warn(`📄 ❌ Could not extract text from ${name} — try uploading the original .docx or a text file instead`);
        }
      } else if (isText) {
        console.log(`📄 Downloading text file: ${name}`);
        const buffer = await downloadSlackFile(file.url_private);
        if (buffer) {
          const text = buffer.toString("utf-8").trim();
          if (text) {
            briefParts.push(`--- Brief: ${name} ---\n${text}`);
          }
        }
      }
    }
  }

  // 2. Check for Google Doc links in the message text
  const messageText = event.text || "";
  const docIds = extractGoogleDocIds(messageText);
  for (const docId of docIds) {
    console.log(`📄 Fetching Google Doc: ${docId}`);
    const text = await fetchGoogleDocContent(docId);
    if (text) {
      console.log(`📄 Extracted ${text.length} chars from Google Doc`);
      briefParts.push(`--- Google Doc Brief ---\n${text}`);
    } else {
      console.warn(`📄 Could not fetch Google Doc ${docId} — make sure it's shared with the service account`);
    }
  }

  if (briefParts.length > 0) {
    return briefParts.join("\n\n");
  }
  return null;
}

// ── Portfolio scraping ────────────────────────────────────────────────

const portfolioCache = new Map();
const PORTFOLIO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // Cache for 7 days (portfolios change rarely)

function stripHtmlToText(html) {
  const $ = cheerio.load(html);
  // Remove scripts, styles, navs, footers — keep the meat
  $("script, style, nav, footer, header, iframe, noscript").remove();
  // Get text, collapse whitespace
  return $("body").text().replace(/\s+/g, " ").trim();
}

async function scrapePortfolio(portfolioUrl, personName) {
  if (!portfolioUrl) return null;

  // Clean and validate the URL
  let url = portfolioUrl.trim();
  if (!url.startsWith("http")) url = "https://" + url;

  // Check cache
  const cached = portfolioCache.get(url);
  if (cached && Date.now() - cached.timestamp < PORTFOLIO_CACHE_TTL_MS) {
    // Handle old cache format (string) vs new format ({ summary, imageUrl })
    if (typeof cached.data === "string") {
      portfolioCache.delete(url); // Force re-scrape with new format
    } else {
      return cached.data;
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8 second timeout per site

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; FreelancerFinderBot/1.0; internal agency tool)",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`Portfolio fetch failed for ${url}: ${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      // Not an HTML page (could be a PDF portfolio, image, etc.)
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // ── Smart profile image finder ─────────────────────────────────
    // Score all images on the page to find the most likely headshot.
    // Priority: filename/alt/class keywords > og:image as last resort.

    // Build name fragments for matching (e.g. "John Smith" → ["john", "smith"])
    const nameFragments = personName
      ? personName.toLowerCase().split(/[\s\-]+/).filter((w) => w.length > 2)
      : [];

    // Keywords that strongly suggest a headshot/profile pic
    const headshotKeywords = [
      "profile", "avatar", "headshot", "head-shot", "portrait",
      "author", "bio", "about-me", "aboutme", "mugshot", "selfie",
      "team-photo", "staff", "person", "face", "photo-of",
    ];

    // Keywords that suggest it's NOT a profile pic
    const excludeKeywords = [
      "logo", "favicon", "icon", "banner", "hero", "bg", "background",
      "pattern", "texture", "sprite", "placeholder", "default", "og-default",
      "loading", "spinner", "arrow", "chevron", "badge", "social",
      "facebook", "twitter", "instagram", "linkedin", "youtube",
      "client", "brand", "award", "certificate",
    ];

    // Collect all candidate images with scores
    const candidates = [];

    $("img").each((_, el) => {
      const src = $(el).attr("src") || "";
      const alt = ($(el).attr("alt") || "").toLowerCase();
      const className = ($(el).attr("class") || "").toLowerCase();
      const id = ($(el).attr("id") || "").toLowerCase();
      const parentClass = ($(el).parent().attr("class") || "").toLowerCase();
      const parentId = ($(el).parent().attr("id") || "").toLowerCase();

      if (!src) return;

      // Resolve to absolute URL
      let absoluteSrc = src;
      if (!absoluteSrc.startsWith("http")) {
        try { absoluteSrc = new URL(absoluteSrc, url).href; } catch (e) { return; }
      }

      const srcLower = absoluteSrc.toLowerCase();
      const allText = `${srcLower} ${alt} ${className} ${id} ${parentClass} ${parentId}`;

      // Skip tiny images (tracking pixels, icons) and SVGs
      if (srcLower.endsWith(".svg") || srcLower.includes("1x1") || srcLower.includes("pixel")) return;
      // Skip excluded keywords
      if (excludeKeywords.some((kw) => allText.includes(kw))) return;

      let score = 0;

      // Strong signal: filename or alt/class contains headshot keywords
      for (const kw of headshotKeywords) {
        if (srcLower.includes(kw)) score += 10;
        if (alt.includes(kw)) score += 8;
        if (className.includes(kw) || id.includes(kw)) score += 6;
        if (parentClass.includes(kw) || parentId.includes(kw)) score += 4;
      }

      // Strong signal: filename or alt contains the person's name
      for (const frag of nameFragments) {
        if (srcLower.includes(frag)) score += 12;
        if (alt.includes(frag)) score += 10;
      }

      // Medium signal: round/circle styling (common for headshots)
      if (allText.includes("rounded-full") || allText.includes("border-radius") ||
          allText.includes("circle") || allText.includes("round")) {
        score += 5;
      }

      // Medium signal: image is in an "about", "bio", "contact", "header", "intro" section
      // Walk up a few parent levels to check
      let parent = $(el).parent();
      for (let depth = 0; depth < 5; depth++) {
        const pClass = (parent.attr("class") || "").toLowerCase();
        const pId = (parent.attr("id") || "").toLowerCase();
        if (pClass.includes("about") || pId.includes("about") ||
            pClass.includes("bio") || pId.includes("bio") ||
            pClass.includes("team") || pId.includes("team") ||
            pClass.includes("author") || pId.includes("author") ||
            pClass.includes("intro") || pId.includes("intro") ||
            pClass.includes("contact") || pId.includes("contact") ||
            pClass.includes("founder") || pId.includes("founder") ||
            pClass.includes("header") || pId.includes("header") ||
            pClass.includes("hero") || pId.includes("hero")) {
          score += 6;
          break;
        }
        parent = parent.parent();
        if (!parent.length) break;
      }

      // Slight signal: common headshot image extensions & sizes
      if (srcLower.match(/\.(jpg|jpeg|png|webp)/)) score += 1;
      // object-cover + contained size classes often indicate headshots
      if (className.includes("object-cover")) score += 3;

      // Medium signal: image has width/height attributes suggesting a portrait-ish size
      const width = parseInt($(el).attr("width") || "0", 10);
      const height = parseInt($(el).attr("height") || "0", 10);
      if (width > 0 && height > 0) {
        const ratio = height / width;
        // Square-ish or portrait (0.7 to 1.5 ratio) and reasonable size
        if (ratio >= 0.7 && ratio <= 1.5 && width >= 80 && width <= 600) score += 4;
      }

      // Collect ALL images (even score 0) so we can use the best available
      candidates.push({ src: absoluteSrc, score, alt, debug: allText.substring(0, 100) });
    });

    // Sort by score descending, pick the best
    candidates.sort((a, b) => b.score - a.score);

    let imageUrl = null;

    // Also score the og:image/twitter:image as a candidate
    const ogImage =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="og:image"]').attr("content") ||
      $('meta[property="twitter:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      "";
    if (ogImage) {
      let ogAbsolute = ogImage.trim();
      try { ogAbsolute = new URL(ogAbsolute, url).href; } catch (e) { ogAbsolute = ""; }
      if (ogAbsolute) {
        const ogLower = ogAbsolute.toLowerCase();
        // Give og:image a baseline score of 2 (it's the site's chosen preview image)
        let ogScore = 2;
        // Boost if it contains headshot keywords or the person's name
        for (const kw of headshotKeywords) { if (ogLower.includes(kw)) ogScore += 8; }
        for (const frag of nameFragments) { if (ogLower.includes(frag)) ogScore += 10; }
        // Penalize if it looks like a logo or project image
        const ogBad = ["logo", "favicon", "icon", "banner", "project", "work", "og-default", "default"];
        if (!ogBad.some((p) => ogLower.includes(p))) {
          candidates.push({ src: ogAbsolute, score: ogScore, alt: "og:image", debug: "og:image" });
        }
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length > 0 && candidates[0].score >= 3) {
      imageUrl = candidates[0].src;
      console.log(`📸 ${url}: best image (score=${candidates[0].score}): ${imageUrl.substring(imageUrl.lastIndexOf("/") + 1).substring(0, 50)}`);
      if (candidates.length > 1) {
        console.log(`📸   runners-up: ${candidates.slice(1, 3).map((c) => `score=${c.score} ${c.src.substring(c.src.lastIndexOf("/") + 1).substring(0, 40)}`).join(", ")}`);
      }
    } else {
      console.log(`📸 ${url}: no suitable image found (${candidates.length} candidates, best score=${candidates.length > 0 ? candidates[0].score : 0})`);
    }

    // Ensure HTTPS for Slack
    if (imageUrl && imageUrl.startsWith("http://")) {
      imageUrl = imageUrl.replace("http://", "https://");
    }

    let pageText = stripHtmlToText(html);

    // Truncate to ~3000 chars — enough context for a summary, not so much that it's wasteful
    if (pageText.length > 3000) {
      pageText = pageText.substring(0, 3000) + "...";
    }

    let summary = null;
    if (pageText.length >= 50) {
      // Use Claude to extract a short insight from the portfolio
      const summaryResponse = await claudeCreate({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        system:
          "You summarise freelancer portfolio websites for an agency. Given the raw text from a portfolio site, provide a 1-2 sentence summary of: what kind of work they showcase, any notable clients or brands visible, and their apparent specialty or style. Be specific and factual. If the text is too garbled or empty to summarise, reply with just: INSUFFICIENT_DATA",
        messages: [
          {
            role: "user",
            content: `Portfolio text from ${url}:\n\n${pageText}`,
          },
        ],
      });

      const text = summaryResponse.content?.[0]?.text || null;
      if (text && !text.includes("INSUFFICIENT_DATA")) {
        summary = text;
      }
    }

    const result = { summary, imageUrl };

    // Cache if we got anything useful (summary or image)
    if (result.summary || result.imageUrl) {
      portfolioCache.set(url, { data: result, timestamp: Date.now() });
      return result;
    }

    return null;
  } catch (error) {
    if (error.name === "AbortError") {
      console.error(`Portfolio fetch timed out for ${url}`);
    } else {
      console.error(`Portfolio scrape error for ${url}:`, error.message);
    }
    return null;
  }
}

// Scrape portfolios for a list of recommended names
// Returns { text, images } — text is the portfolio insights string, images is a name → imageUrl map
async function enrichWithPortfolios(names, roster) {
  const matches = [];
  for (const name of names) {
    const person = roster.find(
      (p) => p.Name && normalizeName(p.Name) === normalizeName(name)
    );
    if (person) {
      const portfolioUrl = person.Portfolio || "";
      // "Profile Image" column in the sheet overrides scraped image (direct link to a headshot)
      const manualPhoto = person["Profile Image"] || person["Profile Image URL"] || person["Image"] || person.Photo || person["Photo URL"] || "";
      matches.push({ name: person.Name, url: portfolioUrl, manualPhoto: manualPhoto.trim() });
    }
  }

  if (matches.length === 0) {
    console.log("📸 No portfolio URLs found for recommended people");
    return { text: "", images: {} };
  }

  console.log(`📸 Enriching ${matches.length} recommended people: ${matches.map((m) => `${m.name} (${m.url || "no portfolio"})`).join(", ")}`);

  // Fetch all portfolios in parallel (only those with URLs)
  const results = await Promise.all(
    matches.map(async (m) => {
      let scrapeResult = null;
      if (m.url) {
        scrapeResult = await scrapePortfolio(m.url, m.name);
      }

      // Use manual photo if provided, otherwise use scraped image
      let imageUrl = m.manualPhoto || (scrapeResult ? scrapeResult.imageUrl : null);
      // Ensure HTTPS for Slack blocks
      if (imageUrl && imageUrl.startsWith("http://")) {
        imageUrl = imageUrl.replace("http://", "https://");
      }
      // Filter out URLs that are clearly not headshots (logos, icons, tiny images)
      if (imageUrl) {
        const urlLower = imageUrl.toLowerCase();
        const badPatterns = ["logo", "favicon", "icon", "badge", "banner", "sprite", "1x1", "pixel", "placeholder", "default"];
        if (badPatterns.some((p) => urlLower.includes(p))) {
          console.log(`📸 ${m.name}: filtered out bad image URL (${urlLower.substring(urlLower.lastIndexOf("/") + 1, urlLower.lastIndexOf("/") + 40)})`);
          imageUrl = null;
        }
      }
      const summary = scrapeResult ? scrapeResult.summary : null;

      if (!imageUrl && !summary) {
        console.log(`📸 ${m.name}: no image or summary found`);
        return null;
      }

      console.log(`📸 ${m.name}: image=${imageUrl ? "✅" : "❌"}, summary=${summary ? "✅" : "❌"}`);
      return { name: m.name, summary, imageUrl, url: m.url };
    })
  );

  const validResults = results.filter((r) => r !== null);
  if (validResults.length === 0) return { text: "", images: {} };

  const images = {};
  let text = "";
  const summaries = validResults.filter((r) => r.summary);

  if (summaries.length > 0) {
    text = "\n\n🎨 *Portfolio Insights*\n";
    for (const r of summaries) {
      text += `• *${r.name}*: ${r.summary} (<${r.url}|View portfolio>)\n`;
    }
  }

  for (const r of validResults) {
    if (r.imageUrl) {
      images[r.name] = r.imageUrl;
    }
  }

  console.log(`📸 Final: ${Object.keys(images).length} image(s), ${summaries.length} summary/summaries`);
  return { text, images };
}

// ── Combined enrichment ───────────────────────────────────────────────

async function enrichRecommendations(names, roster) {
  return await enrichWithPortfolios(names, roster);
}

// ── Profile Image Enrichment — scrape portfolio sites for headshots ──
// Runs in background, finds freelancers with a portfolio URL but no profile image,
// scrapes the og:image, and writes it back to the Google Sheet.

async function enrichProfileImages() {
  console.log("📸 Profile Image Enrichment: starting...");

  // Clear portfolio cache so images are re-scraped with latest scoring logic
  portfolioCache.clear();

  try {
    // Need to read fresh data (bypass cache) to see current Profile Image column
    const updates = []; // { tabName, rowIndex, colIndex, imageUrl }

    for (const tabName of FREELANCER_TABS) {
      try {
        const { data } = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${tabName}'!A2:Z`,
        });

        const rows = data.values || [];
        if (rows.length < 2) continue;

        const headers = rows[0].map((h) => h.trim());
        const nameCol = headers.findIndex((h) => h.toLowerCase() === "name");
        const portfolioCol = headers.findIndex((h) => h.toLowerCase() === "portfolio");
        const imageCol = headers.findIndex((h) =>
          h.toLowerCase() === "profile image" || h.toLowerCase() === "profile image url" || h.toLowerCase() === "image"
        );

        if (nameCol < 0 || portfolioCol < 0 || imageCol < 0) continue;

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const name = (row[nameCol] || "").trim();
          const portfolio = (row[portfolioCol] || "").trim();
          const existingImage = (row[imageCol] || "").trim();

          // Skip if no portfolio URL or already has an image
          if (!name || !portfolio || existingImage) continue;

          updates.push({
            tabName,
            name,
            portfolio,
            // Row 2 = headers, data starts at row 3 (i=1 means row 3)
            rowNumber: i + 2, // +2 because: row 1 = tab title, row 2 = headers, data starts row 3
            colIndex: imageCol,
          });
        }
      } catch (err) {
        // Tab might not exist or be unreadable
      }
    }

    if (updates.length === 0) {
      console.log("📸 Profile Image Enrichment: all freelancers already have images (or no 'Profile Image' column found)");
      return;
    }

    console.log(`📸 Profile Image Enrichment: ${updates.length} freelancer(s) need images`);

    // Process in batches of 5 to be polite
    let enrichedCount = 0;
    for (let i = 0; i < updates.length && i < 20; i++) {
      const item = updates[i];

      try {
        const result = await scrapePortfolio(item.portfolio, item.name);
        if (result && result.imageUrl) {
          // Write the image URL to the sheet
          const colLetter = String.fromCharCode(65 + item.colIndex); // A=0, B=1, etc.
          const cellRange = `'${item.tabName}'!${colLetter}${item.rowNumber}`;

          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: cellRange,
            valueInputOption: "RAW",
            requestBody: {
              values: [[result.imageUrl]],
            },
          });

          console.log(`📸 ${item.name}: saved image URL to ${cellRange}`);
          enrichedCount++;
        } else {
          console.log(`📸 ${item.name}: no image found on portfolio`);
        }
      } catch (err) {
        console.warn(`📸 ${item.name}: error — ${err.message}`);
      }

      // Be polite between requests
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Bust cache so next roster fetch picks up the new images
    rosterCache = null;
    cacheTimestamp = 0;

    console.log(`📸 Profile Image Enrichment: done — ${enrichedCount} image(s) added`);
  } catch (err) {
    console.warn("📸 Profile Image Enrichment error:", err.message);
  }
}

// ── Extract recommended names from Claude's response ─────────────────

function extractNamesFromReply(reply) {
  // Match names after the medal emojis: 🥇 *#1 — Name* or similar patterns
  const namePattern = /[🥇🥈🥉]\s*\*#\d+\s*—\s*(.+?)\*/g;
  const names = [];
  let match;
  while ((match = namePattern.exec(reply)) !== null) {
    names.push(match[1].trim());
  }
  return names;
}

// ── Build profile card blocks for recommended freelancers ──────────────
// Extracts each person's headline info from the reply text and pairs it
// with their profile image. Uses compact blocks (like talent scout cards)
// that Slack's API reliably accepts.

function buildProfileCardBlocks(reply, images) {
  if (!images || Object.keys(images).length === 0) return [];

  // Parse the reply to extract per-person sections
  const medalPattern = /([🥇🥈🥉])\s*\*?#(\d+)\s*—\s*(.+?)\*?\n([^\n]+)/g;
  const people = [];
  let match;
  while ((match = medalPattern.exec(reply)) !== null) {
    people.push({
      medal: match[1],
      rank: match[2],
      name: match[3].trim().replace(/\*$/, ""),
      detail: match[4].trim(), // e.g. "3D Artist & Motion Designer | Senior | $800/day"
    });
  }

  const blocks = [];

  for (const person of people) {
    // Find matching image (accent-insensitive)
    const normalizedName = normalizeName(person.name);
    const imageEntry = Object.entries(images).find(
      ([k]) => normalizeName(k) === normalizedName
    );
    const imageUrl = imageEntry ? imageEntry[1] : null;

    if (!imageUrl) continue; // only show cards for people with images

    // Keep text short and clean — Slack section accessories work best with compact text
    const cardText = `${person.medal} *#${person.rank} — ${person.name}*\n${person.detail}`;

    const block = {
      type: "section",
      text: { type: "mrkdwn", text: cardText },
      accessory: {
        type: "image",
        image_url: imageUrl,
        alt_text: person.name,
      },
    };

    blocks.push(block);
  }

  return blocks;
}

// ── (Legacy) Build Slack blocks with profile images from og:image ─────
// Kept for reference — chat.update with blocks was returning 500 from Slack.

function buildSlackBlocks(reply, images, portfolioText) {
  if (!images || Object.keys(images).length === 0) {
    // No images — return null to signal plain text mode
    return null;
  }

  const blocks = [];

  // Find medal emoji positions to split the reply into sections
  const medalPattern = /[🥇🥈🥉]\s*\*#\d+\s*—\s*(.+?)\*/g;
  const medals = [];
  let m;
  while ((m = medalPattern.exec(reply)) !== null) {
    medals.push({ index: m.index, name: m[1].trim() });
  }

  if (medals.length === 0) {
    // No structured recommendations found — fall back to plain text
    return null;
  }

  // Everything before the first medal = internal team section + divider
  const headerText = reply.substring(0, medals[0].index).trim();
  if (headerText) {
    // Split out the --- divider if present
    const dividerIndex = headerText.lastIndexOf("---");
    if (dividerIndex > 0) {
      const teamPart = headerText.substring(0, dividerIndex).trim();
      if (teamPart) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: teamPart } });
      }
      blocks.push({ type: "divider" });
    } else {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: headerText } });
    }
  }

  // Each freelancer recommendation section
  for (let i = 0; i < medals.length; i++) {
    const start = medals[i].index;
    const end = i + 1 < medals.length ? medals[i + 1].index : reply.length;
    let sectionText = reply.substring(start, end).trim();

    // Check for trailing 💡 Note inside this section (only in the last one)
    let noteText = null;
    const noteIndex = sectionText.indexOf("💡");
    if (noteIndex > 0) {
      noteText = sectionText.substring(noteIndex).trim();
      sectionText = sectionText.substring(0, noteIndex).trim();
    }

    // Slack section text max is 3000 chars
    if (sectionText.length > 2900) {
      sectionText = sectionText.substring(0, 2900) + "...";
    }

    const block = {
      type: "section",
      text: { type: "mrkdwn", text: sectionText },
    };

    // Attach portfolio image as thumbnail if we have one
    // Use normalized name matching (handles accents, casing differences between Claude's output and sheet names)
    const name = medals[i].name;
    const normalizedMedalName = normalizeName(name);
    const imageEntry = Object.entries(images).find(
      ([k]) => normalizeName(k) === normalizedMedalName
    );
    const imageUrl = imageEntry ? imageEntry[1] : null;
    console.log(`📸 Block match: "${name}" (normalized: "${normalizedMedalName}") → ${imageUrl ? "✅ " + imageUrl : "❌ no match"} | image keys: [${Object.keys(images).map(k => `"${k}"`).join(", ")}]`);
    if (imageUrl) {
      block.accessory = {
        type: "image",
        image_url: imageUrl,
        alt_text: name,
      };
    }

    blocks.push(block);

    // Add the 💡 Note as its own block
    if (noteText) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: noteText } });
    }
  }

  // Add portfolio insights as a final section
  if (portfolioText && portfolioText.trim()) {
    let pText = portfolioText.trim();
    if (pText.length > 2900) pText = pText.substring(0, 2900) + "...";
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: pText } });
  }

  // Final safety: remove any blocks with empty or missing text (except dividers)
  const safeBlocks = blocks.filter((b) => {
    if (b.type === "divider") return true;
    return b.text && b.text.text && b.text.text.trim().length > 0;
  });

  return safeBlocks;
}

// ── Post-project feedback system ─────────────────────────────────────

const REVIEW_PATTERN = /^(?:review|feedback)\s+(.+?)(?:\s*[-–—:]\s*)([\s\S]+)$/i;

function detectReviewRequest(text) {
  const match = text.match(REVIEW_PATTERN);
  if (!match) return null;
  return { name: match[1].trim(), feedback: match[2].trim() };
}

// Strip accents/diacritics so "Giedrė" matches "Giedre", "José" matches "Jose", etc.
function normalizeName(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function namesMatch(sheetName, searchName) {
  // Exact match (case-insensitive)
  if (sheetName.toLowerCase().trim() === searchName.toLowerCase().trim()) return true;
  // Match after stripping accents
  if (normalizeName(sheetName) === normalizeName(searchName)) return true;
  return false;
}

async function findFreelancerInSheet(name) {
  console.log(`🔍 Searching for "${name}" across all tabs...`);
  const matches = [];

  // Search each tab for the freelancer by name — collect ALL matches
  for (const tabName of FREELANCER_TABS) {
    try {
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${tabName}'!A2:Z`,
      });

      const rows = data.values || [];
      if (rows.length < 2) continue;

      const headers = rows[0].map((h) => h.trim());
      const commentsCol = headers.findIndex(
        (h) => h.toLowerCase() === "comments"
      );
      const nameCol = headers.findIndex(
        (h) => h.toLowerCase() === "name"
      );

      if (nameCol === -1) continue;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const cellName = (row[nameCol] || "").trim();
        if (!cellName) continue;

        if (namesMatch(cellName, name)) {
          const sheetRow = i + 2; // +2 because range starts at A2 (skipping title), and rows[0] = headers
          const currentComments = commentsCol >= 0 ? (row[commentsCol] || "").trim() : "";
          console.log(`✅ Found "${cellName}" in tab "${tabName}" at sheet row ${sheetRow}, comments col ${commentsCol}`);
          matches.push({
            name: cellName,
            tab: tabName,
            sheetRow,
            commentsCol: commentsCol >= 0 ? commentsCol : null,
            currentComments,
          });
        }
      }
    } catch (err) {
      console.warn(`⚠️ Review search: skipping tab "${tabName}" — ${err.message}`);
    }
  }

  // Also check internal team sheet
  if (TEAM_SPREADSHEET_ID) {
    try {
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId: TEAM_SPREADSHEET_ID,
        range: "A1:Z",
      });

      const rows = data.values || [];
      if (rows.length >= 2) {
        const headers = rows[0].map((h) => h.trim());
        const commentsCol = headers.findIndex((h) => h.toLowerCase() === "comments");
        const nameCol = headers.findIndex((h) => h.toLowerCase() === "name");

        if (nameCol >= 0) {
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const cellName = (row[nameCol] || "").trim();
            if (!cellName) continue;

            if (namesMatch(cellName, name)) {
              console.log(`✅ Found "${cellName}" in internal team sheet at row ${i + 1}, comments col ${commentsCol}`);
              matches.push({
                name: cellName,
                tab: "Internal Team",
                sheetRow: i + 1, // Headers in row 1, data from row 2
                commentsCol: commentsCol >= 0 ? commentsCol : null,
                currentComments: commentsCol >= 0 ? (row[commentsCol] || "").trim() : "",
                isTeam: true,
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ Review search: team sheet error — ${err.message}`);
    }
  }

  if (matches.length === 0) {
    console.log(`❌ "${name}" not found in any tab or team sheet`);
  } else {
    console.log(`📝 Found "${name}" in ${matches.length} location(s): ${matches.map((m) => m.tab).join(", ")}`);
  }

  return matches;
}

function colIndexToLetter(index) {
  let letter = "";
  let i = index;
  while (i >= 0) {
    letter = String.fromCharCode((i % 26) + 65) + letter;
    i = Math.floor(i / 26) - 1;
  }
  return letter;
}

async function writeFeedback(freelancer, feedback) {
  const date = new Date().toISOString().split("T")[0]; // e.g. 2026-02-07
  const newEntry = `[${date} via Slack] ${feedback}`;

  // Append to existing comments with a separator, or start fresh
  const updatedComments = freelancer.currentComments
    ? `${freelancer.currentComments} | ${newEntry}`
    : newEntry;

  const spreadsheetId = freelancer.isTeam ? TEAM_SPREADSHEET_ID : SPREADSHEET_ID;

  if (freelancer.commentsCol === null) {
    // No Comments column found — can't write
    return { success: false, reason: "no_comments_column" };
  }

  const colLetter = colIndexToLetter(freelancer.commentsCol);
  const range = freelancer.isTeam
    ? `${colLetter}${freelancer.sheetRow}`
    : `'${freelancer.tab}'!${colLetter}${freelancer.sheetRow}`;

  console.log(`📝 Writing feedback to spreadsheet: ${spreadsheetId}`);
  console.log(`📝 Range: ${range}`);
  console.log(`📝 Content: ${updatedComments.substring(0, 100)}...`);

  try {
    const result = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: {
        values: [[updatedComments]],
      },
    });

    console.log(`📝 Write result: ${result.data.updatedCells} cell(s) updated at ${result.data.updatedRange}`);

    // Bust the cache so the next recommendation picks up the new feedback
    if (freelancer.isTeam) {
      teamCache = null;
      teamCacheTimestamp = 0;
    } else {
      rosterCache = null;
      cacheTimestamp = 0;
    }

    return { success: true };
  } catch (err) {
    console.error("❌ Failed to write feedback:", err.message);
    return { success: false, reason: err.message };
  }
}

async function handleReview(query, say, threadTs, channel) {
  const review = detectReviewRequest(query);
  if (!review) return false; // Not a review request — let normal handler take over

  const thinking = await say({
    text: `📝 Logging feedback for ${review.name}...`,
    thread_ts: threadTs,
  });

  try {
    const matches = await findFreelancerInSheet(review.name);

    if (matches.length === 0) {
      await slack.client.chat.update({
        channel,
        ts: thinking.ts,
        text: `❌ Couldn't find *${review.name}* in the roster or internal team sheet. Check the spelling and try again — the name needs to match how it appears in the Google Sheet.`,
      });
      return true;
    }

    // Write feedback to ALL tabs where this person appears
    const results = [];
    for (const match of matches) {
      const result = await writeFeedback(match, review.feedback);
      results.push({ tab: match.tab, ...result });
    }

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const displayName = matches[0].name;

    if (succeeded.length > 0) {
      const tabs = succeeded.map((r) => `*${r.tab}*`).join(", ");
      let message = `✅ Feedback logged for *${displayName}* across ${succeeded.length} tab${succeeded.length > 1 ? "s" : ""}: ${tabs}\n\n> _${review.feedback}_\n\nThis will be factored into future recommendations.`;
      if (failed.length > 0) {
        const failedTabs = failed.map((r) => `${r.tab} (${r.reason})`).join(", ");
        message += `\n\n⚠️ Couldn't update: ${failedTabs}`;
      }
      await slack.client.chat.update({
        channel,
        ts: thinking.ts,
        text: message,
      });
    } else {
      await slack.client.chat.update({
        channel,
        ts: thinking.ts,
        text: `⚠️ Found *${displayName}* but couldn't write to any tabs: ${failed.map((r) => `${r.tab} (${r.reason})`).join(", ")}`,
      });
    }
  } catch (error) {
    console.error("Error processing review:", error);
    await slack.client.chat.update({
      channel,
      ts: thinking.ts,
      text: "⚠️ Something went wrong logging the feedback. Please try again.",
    });
  }

  return true; // Handled — don't pass to the normal recommendation flow
}

// ── System prompt for Claude ─────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Talent Finder — an AI assistant for a creative advertising agency. Your job is to recommend the best people for a project, always checking the INTERNAL STUDIO TEAM first before suggesting freelancers.

PRIORITY ORDER:
1. **Internal team members FIRST** — the agency always prefers to use in-house talent if someone suitable is available. Check the internal team data carefully.
2. **Freelancers as backup** — recommend freelancers when no internal team member fits, or as additional options alongside an internal pick.

HOW TO EVALUATE CANDIDATES (both internal and freelancers):
- **Capabilities**: Does their skill set directly match what the project needs?
- **Role/Category**: Does their discipline align with the work required?
- **Comments/Notes**: This is critical — it contains details about specific projects they've worked on, niche strengths, software proficiency, working style, and internal feedback. Use this to identify if someone has worked on a similar project before, or with the same client. If so, call this out prominently (e.g. "Randle worked on the previous iteration of this brand campaign — worth looping him in for continuity").
- **Previous Clients**: Have they worked on similar brands, industries, or campaign types? Someone with direct client experience is a much stronger match.
- **Level**: Does the seniority match what the project demands?
- **Recommendation**: Internal recommendation score or notes — factor this into confidence.
- **Availability & Status**: Strongly prefer people who are marked as available. Flag concerns if recommending someone who may be busy.
- **Cost Rate (per 8hr day)**: Always show this. If the requester mentions a budget, filter accordingly.
- **Location**: Only factor this in if the requester mentions on-site, local, or timezone needs.
- **Streamtime Job History**: If provided, this is REAL project data from the agency's management system. Use it to identify people who have worked on similar projects, with the same client, or in the same industry. When someone has relevant job history, reference the specific job number (e.g. "[WOOL1349]") and suggest the producer talk to them about that project. This is extremely powerful context — a person who worked on a previous Woolworths campaign is a much stronger match for a new Woolworths brief.

RULES:
1. Always check the internal team first. If a strong internal match exists, lead with them.
2. Always recommend 3 freelancer options alongside any internal recommendations.
3. Only recommend people who appear in the data provided. Never invent people.
4. Never share phone numbers or email addresses in the channel.
5. Keep responses concise and scannable — this is Slack, not an email.
6. If the request is vague, ask a clarifying question before recommending.
7. If an internal team member has worked on a related project or with the same client (based on Comments or Previous Clients), always highlight this — it's extremely valuable context.

FORMAT your responses exactly like this:

🏠 *Internal Team*
[If a match is found:]
*Name* — Role | Level | $X/day
_Why:_ [2-3 sentences — highlight any relevant project history, client experience, or continuity value]

[If no internal match:]
_No strong internal match for this brief — recommending freelancers below._

---

🥇 *#1 — Name*
Category | Level | $X/day
_Why:_ [2-3 sentences — reference capabilities, relevant project experience from Comments, and notable previous clients]

🥈 *#2 — Name*
Category | Level | $X/day
_Why:_ [2-3 sentences]

🥉 *#3 — Name*
Category | Level | $X/day
_Why:_ [2-3 sentences]

💡 *Note:* [Optional — availability, budget considerations, or suggestions about combining internal + freelance resources]`;

// ── Thread history — gives the bot memory in conversations ───────────

async function getThreadHistory(channel, threadTs, botUserId) {
  if (!threadTs) return [];

  try {
    const result = await slack.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20, // last 20 messages in the thread — plenty of context
    });

    const messages = result.messages || [];
    const history = [];

    for (const msg of messages) {
      // Skip the "thinking" messages
      if (msg.text === "🔍 Checking the freelancer roster...") continue;

      // Clean bot mentions from text
      const cleanText = msg.text.replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!cleanText) continue;

      if (msg.bot_id || msg.user === botUserId) {
        history.push({ role: "assistant", content: cleanText });
      } else {
        history.push({ role: "user", content: cleanText });
      }
    }

    return history;
  } catch (error) {
    console.error("Error fetching thread history:", error.message);
    return [];
  }
}

// ── Event deduplication ───────────────────────────────────────────────
// Slack retries events when Socket Mode ack is slow, causing duplicate handler runs.
// This prevents retries from overwriting block-enriched messages with plain text.
const processedEvents = new Map(); // event_ts → timestamp
const EVENT_DEDUP_TTL_MS = 60_000; // keep event IDs for 60 seconds

function isDuplicateEvent(eventTs) {
  // Clean up old entries
  const now = Date.now();
  for (const [ts, addedAt] of processedEvents) {
    if (now - addedAt > EVENT_DEDUP_TTL_MS) processedEvents.delete(ts);
  }
  if (processedEvents.has(eventTs)) {
    console.log(`🔄 Skipping duplicate event: ${eventTs}`);
    return true;
  }
  processedEvents.set(eventTs, now);
  return false;
}

// ── Handle messages that mention the bot ──────────────────────────────

slack.event("app_mention", async ({ event, say }) => {
  if (isDuplicateEvent(event.ts)) return;

  // Strip the bot mention from the message
  const query = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!query) {
    await say({
      text: "Hey! Tell me what kind of project you need a freelancer for and I'll check the roster. For example: _We need a senior motion designer for a 3-week brand campaign with 3D experience._\n\n📄 You can also attach a *PDF brief* or paste a *Google Doc link* and I'll read it for context.\n\nTo log feedback: _review Jane Smith - great work, delivered on time, 9/10_",
      thread_ts: event.thread_ts || event.ts,
    });
    return;
  }

  // Reply in the existing thread if this is a follow-up, or start a new thread
  const threadTs = event.thread_ts || event.ts;

  // Check if this is a review/feedback request
  const wasReview = await handleReview(query, say, threadTs, event.channel);
  if (wasReview) return;

  // Check if this is a talent scout trigger
  if (/^(scout|scan\s*talent|talent\s*scout|find\s*talent|scrape)/i.test(query)) {
    if (!TALENT_SCOUT_CHANNEL || TALENT_SCOUT_SOURCES.length === 0) {
      await say({ text: "⚠️ Talent Scout isn't configured yet. Set `TALENT_SCOUT_CHANNEL` and `TALENT_SCOUT_SOURCES` in Railway.", thread_ts: threadTs });
      return;
    }
    await say({ text: "🔍 Running talent scout now — results will appear in the talent scouting channel shortly...", thread_ts: threadTs });
    runTalentScout().catch((err) => console.warn("🔍 Manual scout error:", err.message));
    return;
  }

  // Show a thinking indicator
  const thinking = await say({
    text: "🔍 Checking the team and freelancer roster...",
    thread_ts: threadTs,
  });

  try {
    // Fetch latest data, Streamtime history, and any attached briefs in parallel
    const [roster, team, streamtime, briefContent] = await Promise.all([
      fetchRoster(),
      fetchTeam(),
      fetchStreamtimeJobHistory(),
      extractBriefContent(event),
    ]);
    const rosterText = formatRosterForPrompt(roster);
    const teamText = formatTeamForPrompt(team);
    const streamtimeText = formatStreamtimeForPrompt(streamtime, roster, team);
    const allData = teamText + "\n" + rosterText + streamtimeText;

    // Build the request text — include brief content if found (cap at 4000 chars to avoid rate limits)
    let requestText = query;
    if (briefContent) {
      const MAX_BRIEF_CHARS = 4000;
      let trimmedBrief = briefContent;
      if (briefContent.length > MAX_BRIEF_CHARS) {
        trimmedBrief = briefContent.substring(0, MAX_BRIEF_CHARS) + "\n\n[Brief truncated — full document was " + briefContent.length + " chars]";
        console.log(`📄 Brief trimmed from ${briefContent.length} to ${MAX_BRIEF_CHARS} chars to stay within rate limits`);
      }
      requestText = `${query}\n\n📄 ATTACHED BRIEF:\n${trimmedBrief}`;
      console.log(`📄 Brief attached (${trimmedBrief.length} chars) — included in prompt`);
    }

    // Check if this is a follow-up in an existing thread
    const isFollowUp = !!event.thread_ts;
    let messages = [];

    if (isFollowUp) {
      // Get the bot's user ID for identifying its own messages
      const authResult = await slack.client.auth.test();
      const botUserId = authResult.user_id;

      // Fetch thread history and build multi-turn conversation
      const threadHistory = await getThreadHistory(
        event.channel,
        event.thread_ts,
        botUserId
      );

      // Start with the roster context, then add the conversation history
      if (threadHistory.length > 0) {
        // Insert roster into the first user message
        const firstMsg = threadHistory[0];
        messages.push({
          role: "user",
          content: `Here is the internal team and freelancer roster:\n${allData}\n\n---\n\n${firstMsg.content}`,
        });

        // Add remaining history (skip first since we merged it above)
        for (let i = 1; i < threadHistory.length; i++) {
          messages.push(threadHistory[i]);
        }

        // Add the new follow-up question (with brief if attached)
        messages.push({
          role: "user",
          content: requestText,
        });
      }
    }

    // Fall back to single message if no thread history
    if (messages.length === 0) {
      messages = [
        {
          role: "user",
          content: `Here is the internal team and freelancer roster:\n${allData}\n\n---\n\nRequest: ${requestText}`,
        },
      ];
    }

    // Ask Claude
    const response = await claudeCreate({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const reply =
      response.content?.[0]?.text || "No recommendation could be generated.";

    // Send the recommendation immediately
    await slack.client.chat.update({
      channel: event.channel,
      ts: thinking.ts,
      text: reply,
    });

    // Portfolio + image enrichment in the background (fire-and-forget)
    const recommendedNames = extractNamesFromReply(reply);
    if (recommendedNames.length > 0) {
      (async () => {
        try {
          const enrichment = await enrichRecommendations(recommendedNames, roster);

          // Always update the main message with portfolio insights if we have them
          if (enrichment.text) {
            await slack.client.chat.update({
              channel: event.channel,
              ts: thinking.ts,
              text: reply + enrichment.text,
            });
          }

          // Post profile photo cards individually in the thread (one message per person)
          const hasImages = enrichment.images && Object.keys(enrichment.images).length > 0;
          if (hasImages) {
            // Diagnostic: test if ANY block works in this thread
            try {
              console.log("📸 TEST: posting hardcoded test block to thread...");
              await slack.client.chat.postMessage({
                channel: event.channel,
                thread_ts: event.ts,
                blocks: [{ type: "section", text: { type: "mrkdwn", text: "📸 *Loading profile photos...*" } }],
                text: "Loading profile photos...",
              });
              console.log("📸 TEST: hardcoded block worked in thread ✅");
            } catch (testErr) {
              console.warn(`📸 TEST: even hardcoded block failed in thread: ${testErr.message}`);
              // Try without thread_ts
              try {
                await slack.client.chat.postMessage({
                  channel: event.channel,
                  blocks: [{ type: "section", text: { type: "mrkdwn", text: "📸 *Loading profile photos...*" } }],
                  text: "Loading profile photos...",
                });
                console.log("📸 TEST: block worked WITHOUT thread_ts ✅ — threading is the issue");
              } catch (testErr2) {
                console.warn(`📸 TEST: block also failed without thread_ts: ${testErr2.message}`);
              }
            }

            const profileCards = buildProfileCardBlocks(reply, enrichment.images);
            for (const card of profileCards) {
              try {
                console.log(`📸 Posting card: ${JSON.stringify(card)}`);
                await slack.client.chat.postMessage({
                  channel: event.channel,
                  thread_ts: event.ts,
                  blocks: [card],
                  text: card.accessory ? `Photo: ${card.accessory.alt_text}` : "Profile photo",
                });
                console.log(`📸 Card posted ✅`);
              } catch (cardErr) {
                console.warn(`📸 Card FAILED: ${cardErr.message}`);
                console.warn(`📸 Failed block JSON: ${JSON.stringify(card)}`);
                // Try without image accessory to isolate the issue
                try {
                  const textOnly = { type: "section", text: card.text };
                  await slack.client.chat.postMessage({
                    channel: event.channel,
                    thread_ts: event.ts,
                    blocks: [textOnly],
                    text: "Profile card (no image)",
                  });
                  console.warn(`📸 Text-only version worked — image URL is the problem: ${card.accessory?.image_url}`);
                } catch (textErr) {
                  console.warn(`📸 Even text-only failed: ${textErr.message}`);
                }
              }
            }
          }
        } catch (e) {
          console.warn("Portfolio enrichment failed:", e.message);
        }
      })();
    }
  } catch (error) {
    console.error("Error processing request:", error);

    await slack.client.chat.update({
      channel: event.channel,
      ts: thinking.ts,
      text: "⚠️ Something went wrong while checking the roster. Please try again in a moment.",
    });
  }
});

// ── Also handle direct messages to the bot ───────────────────────────

slack.event("message", async ({ event, say }) => {
  // Only handle DMs (not channel messages, which are handled by app_mention)
  if (event.channel_type !== "im") return;
  if (event.bot_id) return; // ignore bot messages
  if (isDuplicateEvent(event.ts)) return;

  const query = event.text.trim();

  // Check if this is a review/feedback request
  const wasReview = await handleReview(query, say, null, event.channel);
  if (wasReview) return;

  const thinking = await say({
    text: "🔍 Checking the team and freelancer roster...",
  });

  try {
    // Fetch latest data, Streamtime history, and any attached briefs in parallel
    const [roster, team, streamtime, briefContent] = await Promise.all([
      fetchRoster(),
      fetchTeam(),
      fetchStreamtimeJobHistory(),
      extractBriefContent(event),
    ]);
    const rosterText = formatRosterForPrompt(roster);
    const teamText = formatTeamForPrompt(team);
    const streamtimeText = formatStreamtimeForPrompt(streamtime, roster, team);
    const allData = teamText + "\n" + rosterText + streamtimeText;

    let requestText = query;
    if (briefContent) {
      requestText = `${query}\n\n📄 ATTACHED BRIEF:\n${briefContent}`;
      console.log(`📄 [DM] Brief attached (${briefContent.length} chars) — included in prompt`);
    }

    const response = await claudeCreate({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the internal team and freelancer roster:\n${allData}\n\n---\n\nRequest: ${requestText}`,
        },
      ],
    });

    const reply =
      response.content?.[0]?.text || "No recommendation could be generated.";

    // Send the recommendation immediately
    await slack.client.chat.update({
      channel: event.channel,
      ts: thinking.ts,
      text: reply,
    });

    // Portfolio + image enrichment in the background (fire-and-forget)
    const recommendedNames = extractNamesFromReply(reply);
    if (recommendedNames.length > 0) {
      (async () => {
        try {
          const enrichment = await enrichRecommendations(recommendedNames, roster);

          // Update the main message with portfolio insights
          if (enrichment.text) {
            await slack.client.chat.update({
              channel: event.channel,
              ts: thinking.ts,
              text: reply + enrichment.text,
            });
          }

          // Post profile photo cards individually
          const hasImages = enrichment.images && Object.keys(enrichment.images).length > 0;
          if (hasImages) {
            const profileCards = buildProfileCardBlocks(reply, enrichment.images);
            for (const card of profileCards) {
              try {
                console.log(`📸 Posting DM card: ${JSON.stringify(card).substring(0, 200)}`);
                await slack.client.chat.postMessage({
                  channel: event.channel,
                  thread_ts: thinking.ts,
                  blocks: [card],
                  text: card.accessory ? `Photo: ${card.accessory.alt_text}` : "Profile photo",
                });
              } catch (cardErr) {
                console.warn(`📸 DM card post failed: ${cardErr.message} | Block: ${JSON.stringify(card)}`);
              }
            }
          }
        } catch (e) {
          console.warn("Portfolio enrichment failed:", e.message);
        }
      })();
    }
  } catch (error) {
    console.error("Error processing DM:", error);
    await slack.client.chat.update({
      channel: event.channel,
      ts: thinking.ts,
      text: "⚠️ Something went wrong. Please try again in a moment.",
    });
  }
});

// ── Google Form submission watcher ────────────────────────────────────

// Map form "Primary Discipline" values to the actual tab names in the roster sheet
const CATEGORY_TO_TAB = {
  // Creative Directors
  "creative director": "Creative Directors",
  "cd": "Creative Directors",
  "ecd": "Creative Directors",
  // AD/Designers
  "ad/designer": "AD/Designers",
  "designer": "AD/Designers",
  "art director": "AD/Designers",
  "graphic designer": "AD/Designers",
  "ui designer": "AD/Designers",
  "ux designer": "AD/Designers",
  "ui/ux designer": "AD/Designers",
  "brand designer": "AD/Designers",
  "visual designer": "AD/Designers",
  // Copywriters
  "copywriter": "Copywriters",
  "writer": "Copywriters",
  "content writer": "Copywriters",
  // Animators
  "animator": "Animators",
  "motion designer": "Animators",
  "motion graphics": "Animators",
  "motion": "Animators",
  "2d animator": "Animators",
  // 3D Artists
  "3d artist": "3D Artists",
  "3d animator": "3D Artists",
  "3d designer": "3D Artists",
  "cgi artist": "3D Artists",
  // Developers
  "developer": "Developers",
  "web developer": "Developers",
  "frontend developer": "Developers",
  "backend developer": "Developers",
  "fullstack developer": "Developers",
  // Producers/AM
  "producer/am": "Producers/AM",
  "producer": "Producers/AM",
  "account manager": "Producers/AM",
  "project manager": "Producers/AM",
  // Retouchers
  "retoucher": "Retouchers",
  "photo retoucher": "Retouchers",
  // Photographer/Videographers
  "photographer/videographer": "Photographer/Videographers",
  "photographer": "Photographer/Videographers",
  "videographer": "Photographer/Videographers",
  "dop": "Photographer/Videographers",
  "cinematographer": "Photographer/Videographers",
  // Strategists
  "strategist": "Strategists",
  "strategy": "Strategists",
  "brand strategist": "Strategists",
  // Specialists
  "specialist": "Specialists",
  "other": "Specialists",
};

function resolveTab(category) {
  if (!category) return "Specialists";
  const key = category.toLowerCase().replace(/\s*\(.*?\)\s*/g, "").trim();
  return CATEGORY_TO_TAB[key] || "Specialists";
}

let lastKnownSubmissionCount = null;
const processedSubmissions = new Set(); // Dedup: track timestamps we've already notified about
let isCheckingSubmissions = false; // Prevent overlapping polls
const SUBMISSION_POLL_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

async function checkForNewSubmissions() {
  if (!SUBMISSIONS_SPREADSHEET_ID || !SUBMISSIONS_NOTIFY_CHANNEL) return;
  if (isCheckingSubmissions) return; // Already running — skip this cycle
  isCheckingSubmissions = true;

  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SUBMISSIONS_SPREADSHEET_ID,
      range: "'Form Responses 1'!A1:Z",
    });

    const rows = data.values || [];
    if (rows.length < 2) return; // No data yet (just headers)

    const headers = rows[0].map((h) => h.trim());
    const timestampCol = headers.findIndex((h) => h.toLowerCase() === "timestamp");
    const currentCount = rows.length - 1; // Exclude header row

    // First run — record the count and mark all existing submissions as processed
    if (lastKnownSubmissionCount === null) {
      lastKnownSubmissionCount = currentCount;
      // Pre-populate dedup set with all existing rows so we never re-notify on restart
      if (timestampCol >= 0) {
        for (let i = 1; i < rows.length; i++) {
          const ts = (rows[i][timestampCol] || "").trim();
          if (ts) processedSubmissions.add(ts);
        }
      }
      console.log(`📝 Submissions watcher started — ${currentCount} existing submissions tracked`);
      return;
    }

    // No new submissions
    if (currentCount <= lastKnownSubmissionCount) return;

    // Process new submissions (could be more than one if multiple came in between polls)
    const newRows = rows.slice(lastKnownSubmissionCount + 1);
    console.log(`📝 ${newRows.length} new freelancer submission(s) detected!`);

    for (const row of newRows) {
      // Dedup check — skip if we've already posted about this submission
      const rowTimestamp = timestampCol >= 0 ? (row[timestampCol] || "").trim() : "";
      if (rowTimestamp && processedSubmissions.has(rowTimestamp)) {
        console.log(`📝 Skipping duplicate submission (timestamp: ${rowTimestamp})`);
        continue;
      }

      const entry = {};
      headers.forEach((header, col) => {
        entry[header] = (row[col] || "").trim();
      });

      // Build a Slack notification
      const name = entry["Full Name"] || entry["Name"] || "Unknown";
      const email = entry["Email Address"] || entry["Email"] || "";
      const category = entry["Primary Discipline"] || entry["Category"] || "";
      const level = entry["Experience Level"] || entry["Level"] || "";
      const rate = entry["Day Rate (per 8hr day)"] || entry["Rate"] || "";
      const capabilities = entry["Key Skills & Capabilities"] || entry["Capabilities"] || "";
      const portfolio = entry["Portfolio URL"] || entry["Portfolio"] || "";
      const linkedin = entry["LinkedIn URL"] || entry["LinkedIn"] || "";
      const location = entry["Location (City, Country)"] || entry["Location"] || "";
      const about = entry["Tell us about yourself"] || entry["About"] || "";

      // Build the message text
      let summary = `*${name}*`;
      if (category) summary += ` — ${category}`;
      if (level) summary += ` | ${level}`;
      if (rate) summary += ` | ${rate}/day`;
      summary += `\n`;
      if (location) summary += `📍 ${location}\n`;
      if (capabilities) summary += `🛠️ ${capabilities}\n`;
      if (about) summary += `💬 _"${about.length > 200 ? about.substring(0, 200) + "..." : about}"_\n`;

      let links = "";
      if (portfolio) links += `🔗 <${portfolio.startsWith("http") ? portfolio : "https://" + portfolio}|Portfolio>`;
      if (linkedin) links += `${portfolio ? "  •  " : ""}🔗 <${linkedin.startsWith("http") ? linkedin : "https://" + linkedin}|LinkedIn>`;
      if (email) links += `${portfolio || linkedin ? "  •  " : ""}📧 ${email}`;

      const posted = await slack.client.chat.postMessage({
        channel: SUBMISSIONS_NOTIFY_CHANNEL,
        text: `📬 New Freelancer Application: ${name}`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `📬 *New Freelancer Application*\n\n${summary}` },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: links || "_No links provided_" },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "✅ Add to Roster" },
                style: "primary",
                action_id: "approve_submission",
                value: JSON.stringify({
                  name,
                  email,
                  category,
                  level: level.replace(/\s*\(.*?\)\s*/g, "").trim(),
                  rate,
                  capabilities,
                  portfolio,
                  linkedin,
                  location,
                  about: about.length > 300 ? about.substring(0, 300) : about,
                  clients: entry["Notable Clients or Brands"] || entry["Clients"] || "",
                }),
              },
              {
                type: "button",
                text: { type: "plain_text", text: "❌ Pass" },
                style: "danger",
                action_id: "reject_submission",
              },
            ],
          },
        ],
      });

      if (posted.ts) {
        console.log(`📝 Posted submission for "${name}" (msg ts: ${posted.ts})`);
        // Mark as processed so overlapping instances (during deploys) won't re-post
        if (rowTimestamp) processedSubmissions.add(rowTimestamp);
      }
    }

    lastKnownSubmissionCount = currentCount;
  } catch (err) {
    // Don't crash the bot if submissions sheet isn't set up yet
    if (err.message?.includes("Unable to parse range")) {
      // Sheet tab doesn't exist yet — form hasn't received any responses
      return;
    }
    console.warn("⚠️ Submission watcher error:", err.message);
  } finally {
    isCheckingSubmissions = false;
  }
}

// ── Button handlers for approving/rejecting freelancer submissions ────

slack.action("approve_submission", async ({ body, ack }) => {
  await ack();

  const messageTs = body.message.ts;
  const channel = body.channel.id;
  const approvedBy = body.user.name || body.user.id;

  // Read submission data from the button value (survives bot restarts)
  let submission;
  try {
    submission = JSON.parse(body.actions[0].value);
  } catch (e) {
    submission = null;
  }

  if (!submission) {
    console.log(`ℹ️ Approve clicked but no submission data in button value (msg ts: ${messageTs})`);
    await slack.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: "⚠️ Couldn't read the submission data. You'll need to add them manually.",
    });
    return;
  }

  console.log(`✅ "${submission.name}" approved by ${approvedBy} — adding to roster...`);

  try {
    const tabName = resolveTab(submission.category);

    // Read the headers from that tab so we know the column order
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${tabName}'!A2:Z2`, // Row 2 = headers (row 1 = title)
    });

    const headers = (data.values?.[0] || []).map((h) => h.trim());
    if (headers.length === 0) {
      console.error(`❌ No headers found in tab "${tabName}" row 2`);
      return;
    }

    // Build a row matching the header order
    const newRow = headers.map((header) => {
      const h = header.toLowerCase();
      if (h === "name") return submission.name;
      if (h === "availibility" || h === "availability") return "Available";
      if (h === "level") return submission.level;
      if (h === "capabilites" || h === "capabilities") return submission.capabilities;
      if (h === "reccomendation" || h === "recommendation") return "";
      if (h.includes("cost rate")) return submission.rate;
      if (h.includes("min sell")) return "";
      if (h === "clients") return submission.clients;
      if (h === "portfolio") return submission.portfolio;
      if (h === "linkedin") return submission.linkedin;
      if (h === "email address" || h === "email") return submission.email;
      if (h === "phone number" || h === "phone") return "";
      if (h === "location") return submission.location;
      if (h === "comments") return submission.about ? `[Form submission] ${submission.about}` : "[Added via intake form]";
      if (h === "status") return "New";
      return "";
    });

    // Append the new row to the tab
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${tabName}'!A3`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [newRow],
      },
    });

    console.log(`✅ "${submission.name}" added to "${tabName}" tab`);

    // Bust roster cache
    rosterCache = null;
    cacheTimestamp = 0;

    // Update the original message — replace buttons with confirmation
    const originalBlocks = body.message.blocks || [];
    const updatedBlocks = originalBlocks.filter((b) => b.type !== "actions");
    updatedBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `✅ *Added to ${tabName}* by ${approvedBy}` },
    });

    await slack.client.chat.update({
      channel,
      ts: messageTs,
      blocks: updatedBlocks,
      text: `✅ ${submission.name} added to ${tabName} by ${approvedBy}`,
    });

  } catch (error) {
    console.error(`❌ Failed to add "${submission.name}" to roster:`, error.message);

    let errorMsg = `⚠️ Couldn't add *${submission.name}* to the roster.`;
    if (error.message?.includes("Unable to parse range")) {
      const tabName = resolveTab(submission.category);
      errorMsg += `\n\nThe *${tabName}* tab doesn't exist in the Google Sheet. Create it with the same headers as your other tabs (title in row 1, headers in row 2), then try the button again.`;
    } else {
      errorMsg += ` Error: ${error.message}`;
    }

    await slack.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: errorMsg,
    });
  }
});

slack.action("reject_submission", async ({ body, ack }) => {
  await ack();

  const messageTs = body.message.ts;
  const channel = body.channel.id;
  const rejectedBy = body.user.name || body.user.id;

  // Update the original message — replace buttons with "passed" note
  const originalBlocks = body.message.blocks || [];
  const updatedBlocks = originalBlocks.filter((b) => b.type !== "actions");
  updatedBlocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `❌ *Passed* by ${rejectedBy}` },
  });

  await slack.client.chat.update({
    channel,
    ts: messageTs,
    blocks: updatedBlocks,
    text: `❌ Passed by ${rejectedBy}`,
  });

  console.log(`❌ Submission rejected by ${rejectedBy}`);
});

// ── Talent Scout — weekly scrape of freelancer directories ───────────

const TALENT_SCOUT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const seenTalentNames = new Set(); // In-memory dedup — persisted via Google Sheet tab
let talentScoutRunning = false; // Prevent concurrent runs

// Launch a headless browser for scraping JS-rendered sites
async function launchBrowser() {
  const puppeteer = require("puppeteer");
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  });
}

// Scrape a single directory page for freelancer profile links and basic info
async function scrapeDirectory(url) {
  console.log(`🔍 Talent Scout: scraping ${url}...`);
  let browser;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Navigate and wait for content to render
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    // Extra wait for JS-rendered content
    await new Promise((r) => setTimeout(r, 3000));

    let profiles = [];

    // ── NodePro-specific parsing ──
    if (url.includes("nodepro.com.au")) {
      profiles = await page.evaluate(() => {
        const results = [];
        // Find all artist profile links
        const links = document.querySelectorAll('a[href*="/artist/"]');
        links.forEach((el) => {
          const href = el.getAttribute("href") || "";
          const fullUrl = href.startsWith("http") ? href : `https://nodepro.com.au${href}`;

          // Get the card content — name is usually in a heading or prominent text
          const card = el.closest("[class*='card']") || el.closest("[class*='member']") || el.closest("[class*='artist']") || el;
          const allText = card.innerText.trim().split("\n").map((s) => s.trim()).filter(Boolean);

          // Skip badge/tag text like "NEW", "FEATURED", etc. to find the actual name
          const skipWords = new Set(["new", "featured", "pro", "verified", "top", "hire", "view", "profile"]);
          const meaningfulText = allText.filter((t) => !skipWords.has(t.toLowerCase()) && t.length > 2);

          const name = meaningfulText[0] || "";
          const role = meaningfulText[1] || "";
          const location = allText.find((t) => /sydney|melbourne|brisbane|perth|adelaide|auckland|wellington|australia|nz/i.test(t)) || "";

          // Only include if name looks like an actual person name (has a space = first + last)
          if (name && name.length > 3 && name.length < 60 && name.includes(" ")) {
            results.push({ name, role, location, profileUrl: fullUrl, source: "NodePro" });
          }
        });
        return results;
      });
    } else {
      // ── Generic directory parsing ──
      profiles = await page.evaluate((sourceUrl) => {
        const results = [];
        const links = document.querySelectorAll("a[href]");
        links.forEach((el) => {
          const href = el.getAttribute("href") || "";
          const text = el.innerText.trim();
          if (/\/(profile|artist|talent|member|person|freelancer)\//i.test(href) && text.length > 1 && text.length < 60) {
            const fullUrl = href.startsWith("http") ? href : new URL(href, sourceUrl).href;
            results.push({
              name: text.split("\n")[0]?.trim() || text,
              role: "",
              location: "",
              profileUrl: fullUrl,
              source: new URL(sourceUrl).hostname.replace("www.", ""),
            });
          }
        });
        return results;
      }, url);
    }

    // Deduplicate by profile URL
    const seen = new Set();
    const unique = profiles.filter((p) => {
      if (seen.has(p.profileUrl)) return false;
      seen.add(p.profileUrl);
      return true;
    });

    console.log(`🔍 Talent Scout: found ${unique.length} profiles on ${url}`);
    return unique;
  } catch (err) {
    console.warn(`🔍 Talent Scout: error scraping ${url}:`, err.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Scrape an individual profile page for more detail (reuses an existing browser)
async function scrapeProfile(profileUrl, browser) {
  let page;
  try {
    page = browser ? await browser.newPage() : null;
    if (!page) return null;
    await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));

    const data = await page.evaluate(() => {
      const title = document.title || "";
      const metaDesc = document.querySelector('meta[name="description"]')?.content || "";
      const ogDesc = document.querySelector('meta[property="og:description"]')?.content || "";
      const ogImage = document.querySelector('meta[property="og:image"]')?.content || "";
      const origin = window.location.origin;

      // Helper: make sure image URL is absolute
      function makeAbsolute(url) {
        if (!url) return "";
        if (url.startsWith("http")) return url;
        if (url.startsWith("//")) return "https:" + url;
        if (url.startsWith("/")) return origin + url;
        return origin + "/" + url;
      }

      // Try to find profile image from multiple sources
      let profileImage = makeAbsolute(ogImage);

      // If no og:image or it's a generic site image, look for actual profile photos
      if (!profileImage || profileImage.includes("logo") || profileImage.includes("favicon") || profileImage.includes("og-default") || profileImage.includes("default")) {
        profileImage = "";
      }

      if (!profileImage) {
        // Look for common profile image patterns
        const imgCandidates = [
          // NodePro-specific: headshot images hosted on pockethost with rounded-2xl class
          document.querySelector('img[class*="rounded-2xl"][class*="object-cover"]'),
          document.querySelector('img[src*="pockethost"]'),
          document.querySelector('img[src*="headshot"]'),
          // Generic patterns
          document.querySelector('img[class*="avatar"]'),
          document.querySelector('img[class*="profile"]'),
          document.querySelector('img[class*="photo"]'),
          document.querySelector('img[class*="headshot"]'),
          document.querySelector('img[alt*="profile"]'),
          document.querySelector('.profile img, .avatar img, .hero img'),
          document.querySelector('img[class*="hero"]'),
          document.querySelector('img[class*="banner"]'),
        ];
        for (const img of imgCandidates) {
          if (img && img.src && !img.src.includes("placeholder") && !img.src.includes("default") && !img.src.includes("logo") && !img.src.includes("og-default")) {
            profileImage = makeAbsolute(img.src);
            break;
          }
        }
      }

      // Last resort: find the largest visible image on the page (likely showreel/portfolio thumbnail)
      if (!profileImage) {
        let bestImg = "";
        let bestArea = 0;
        document.querySelectorAll("img").forEach((img) => {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          const area = w * h;
          const src = img.src || "";
          if (area > bestArea && area > 10000 && src && !src.includes("logo") && !src.includes("icon") && !src.includes("placeholder") && !src.includes("data:")) {
            bestArea = area;
            bestImg = src;
          }
        });
        if (bestImg) profileImage = makeAbsolute(bestImg);
      }

      // Remove noise
      document.querySelectorAll("script, style, nav, footer, header").forEach((el) => el.remove());
      const bodyText = document.body.innerText.replace(/\s+/g, " ").trim().substring(0, 3000);

      return { title, description: ogDesc || metaDesc, bodyText, profileImage };
    });

    return data;
  } catch (err) {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Load previously seen talent from Google Sheet to avoid re-posting
async function loadSeenTalent() {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Talent Scout Log'!A:B",
    });
    const rows = data.values || [];
    for (const row of rows) {
      if (row[0]) seenTalentNames.add(normalizeName(row[0]));
    }
    console.log(`🔍 Talent Scout: ${seenTalentNames.size} previously seen profiles loaded`);
  } catch (err) {
    // Tab doesn't exist yet — that's fine, will be created on first run
    if (err.message?.includes("Unable to parse range")) {
      console.log("🔍 Talent Scout: no log sheet yet — will create on first find");
    } else {
      console.warn("🔍 Talent Scout: could not load seen log:", err.message);
    }
  }
}

// Record a talent as "seen" in the Google Sheet log
async function markTalentSeen(name, profileUrl) {
  seenTalentNames.add(normalizeName(name));
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Talent Scout Log'!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[name, profileUrl, new Date().toISOString()]],
      },
    });
  } catch (err) {
    // If the tab doesn't exist, create it
    if (err.message?.includes("Unable to parse range")) {
      try {
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            requests: [{
              addSheet: { properties: { title: "Talent Scout Log" } },
            }],
          },
        });
        // Add headers and this row
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: "'Talent Scout Log'!A1:C2",
          valueInputOption: "RAW",
          requestBody: {
            values: [
              ["Name", "Profile URL", "Date Found"],
              [name, profileUrl, new Date().toISOString()],
            ],
          },
        });
      } catch (createErr) {
        console.warn("🔍 Talent Scout: could not create log sheet:", createErr.message);
      }
    }
  }
}

// Check if a talent is already in our roster
function isInRoster(name, roster) {
  const normalized = normalizeName(name);
  return (roster || []).some((p) => p.Name && normalizeName(p.Name) === normalized);
}

// Main talent scout function
async function runTalentScout() {
  if (!TALENT_SCOUT_CHANNEL || TALENT_SCOUT_SOURCES.length === 0) return;
  if (talentScoutRunning) {
    console.log("🔍 Talent Scout: already running — skipping");
    return;
  }
  talentScoutRunning = true;

  console.log("🔍 Talent Scout: starting weekly scan...");

  try {
    // Load roster for deduplication
    const roster = await fetchRoster();

    // Load seen list from Google Sheet
    await loadSeenTalent();

    // Scrape all configured sources
    const allProfiles = [];
    for (const sourceUrl of TALENT_SCOUT_SOURCES) {
      const profiles = await scrapeDirectory(sourceUrl);
      allProfiles.push(...profiles);
      // Be polite — wait between sites
      if (TALENT_SCOUT_SOURCES.length > 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (allProfiles.length === 0) {
      console.log("🔍 Talent Scout: no profiles found across all sources");
      return;
    }

    // Filter out people already in roster or already seen
    const newProfiles = allProfiles.filter((p) => {
      if (isInRoster(p.name, roster)) return false;
      if (seenTalentNames.has(normalizeName(p.name))) return false;
      return true;
    });

    console.log(`🔍 Talent Scout: ${newProfiles.length} new profiles (${allProfiles.length} total, ${allProfiles.length - newProfiles.length} already known)`);

    if (newProfiles.length === 0) {
      console.log("🔍 Talent Scout: no new talent this week");
      return;
    }

    // Limit to top 10 per week to avoid spamming
    const batch = newProfiles.slice(0, 10);

    // Scrape each profile for more detail, then use Claude to summarise
    // Use a single browser instance for all profile pages
    console.log(`🔍 Talent Scout: enriching ${batch.length} profiles...`);
    let profileBrowser;
    try { profileBrowser = await launchBrowser(); } catch (e) {
      console.warn("🔍 Talent Scout: could not launch browser for profiles:", e.message);
    }
    const enriched = [];
    for (let i = 0; i < batch.length; i++) {
      const profile = batch[i];
      console.log(`🔍 Talent Scout: scraping profile ${i + 1}/${batch.length}: ${profile.name}`);
      const detail = await scrapeProfile(profile.profileUrl, profileBrowser);
      if (detail?.profileImage) {
        console.log(`🔍 Talent Scout: image found for ${profile.name}: ${detail.profileImage.substring(0, 100)}`);
      }
      // Small delay between profile fetches
      await new Promise((r) => setTimeout(r, 500));

      if (detail) {
        // Use Claude to summarise the profile and extract key info
        try {
          const aiResponse = await claudeCreate({
            model: "claude-sonnet-4-20250514",
            max_tokens: 500,
            messages: [{
              role: "user",
              content: `Summarise this freelancer's profile in 2-3 sentences for a creative agency. Extract their specialty/discipline (e.g. "Motion Designer", "Art Director"), location, and notable skills or clients. Keep it concise and useful for someone deciding whether to reach out.

Name: ${profile.name}
Profile URL: ${profile.profileUrl}
Role from listing: ${profile.role || "Unknown"}
Location from listing: ${profile.location || "Unknown"}

Profile page content:
${detail.title ? `Title: ${detail.title}` : ""}
${detail.description ? `Description: ${detail.description}` : ""}
${detail.bodyText ? `Page content: ${detail.bodyText.substring(0, 2000)}` : ""}

Reply in this exact format:
DISCIPLINE: [their main discipline]
LOCATION: [city, country]
SUMMARY: [2-3 sentence summary]`,
            }],
          });

          const aiText = aiResponse.content[0].text;
          const discipline = aiText.match(/DISCIPLINE:\s*(.+)/i)?.[1]?.trim() || profile.role || "Creative";
          const location = aiText.match(/LOCATION:\s*(.+)/i)?.[1]?.trim() || profile.location || "";
          const summary = aiText.match(/SUMMARY:\s*([\s\S]+)/i)?.[1]?.trim() || "";

          enriched.push({
            ...profile,
            discipline,
            location: location || profile.location,
            summary,
            image: detail.profileImage || "",
          });
        } catch (aiErr) {
          // If Claude fails, still include with basic info
          enriched.push({
            ...profile,
            discipline: profile.role || "Creative",
            summary: "",
            image: detail.profileImage || "",
          });
        }
      } else {
        enriched.push({
          ...profile,
          discipline: profile.role || "Creative",
          summary: "",
          image: "",
        });
      }
    }

    // Close the shared browser
    if (profileBrowser) await profileBrowser.close().catch(() => {});
    console.log(`🔍 Talent Scout: enrichment done — ${enriched.length} profiles ready to post`);

    // Post digest header
    await slack.client.chat.postMessage({
      channel: TALENT_SCOUT_CHANNEL,
      text: `🔍 Weekly Talent Scout — ${enriched.length} new find${enriched.length === 1 ? "" : "s"}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🔍 *Weekly Talent Scout — ${enriched.length} new find${enriched.length === 1 ? "" : "s"}*\nScanned ${TALENT_SCOUT_SOURCES.length} director${TALENT_SCOUT_SOURCES.length === 1 ? "y" : "ies"} · ${allProfiles.length} total profiles · ${newProfiles.length} new`,
          },
        },
        { type: "divider" },
      ],
    });

    // Post each profile as a separate message with Add/Pass buttons
    for (const profile of enriched) {
      let text = `*${profile.name}*`;
      if (profile.discipline) text += ` — ${profile.discipline}`;
      text += `\n`;
      if (profile.location) text += `📍 ${profile.location}\n`;
      if (profile.summary) text += `💬 _${profile.summary}_\n`;
      text += `🔗 <${profile.profileUrl}|View Profile> · Source: ${profile.source}`;

      // Build the profile section — with thumbnail if we have an image
      const profileSection = {
        type: "section",
        text: { type: "mrkdwn", text },
      };
      if (profile.image) {
        profileSection.accessory = {
          type: "image",
          image_url: profile.image,
          alt_text: profile.name,
        };
      }

      await slack.client.chat.postMessage({
        channel: TALENT_SCOUT_CHANNEL,
        text: `🔍 New talent: ${profile.name}`,
        blocks: [
          profileSection,
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "✅ Add to Roster" },
                style: "primary",
                action_id: "approve_scout",
                value: JSON.stringify({
                  name: profile.name,
                  category: profile.discipline,
                  portfolio: profile.profileUrl,
                  location: profile.location || "",
                  about: profile.summary || "",
                  source: profile.source,
                }),
              },
              {
                type: "button",
                text: { type: "plain_text", text: "❌ Pass" },
                style: "danger",
                action_id: "reject_scout",
              },
            ],
          },
        ],
      });

      // Mark as seen
      await markTalentSeen(profile.name, profile.profileUrl);

      // Small delay between posts
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log(`🔍 Talent Scout: posted ${enriched.length} new profiles to Slack`);
  } catch (err) {
    console.warn("🔍 Talent Scout error:", err.message);
  } finally {
    talentScoutRunning = false;
  }
}

// ── Talent Scout button handlers ──────────────────────────────────────

slack.action("approve_scout", async ({ body, ack }) => {
  await ack();

  const messageTs = body.message.ts;
  const channel = body.channel.id;
  const approvedBy = body.user.name || body.user.id;

  let profile;
  try {
    profile = JSON.parse(body.actions[0].value);
  } catch (e) {
    profile = null;
  }

  if (!profile) {
    await slack.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: "⚠️ Couldn't read the profile data. You'll need to add them manually.",
    });
    return;
  }

  console.log(`✅ Scout: "${profile.name}" approved by ${approvedBy} — adding to roster...`);

  try {
    const tabName = resolveTab(profile.category);

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${tabName}'!A2:Z2`,
    });

    const headers = (data.values?.[0] || []).map((h) => h.trim());
    if (headers.length === 0) {
      console.error(`❌ No headers found in tab "${tabName}" row 2`);
      return;
    }

    const newRow = headers.map((header) => {
      const h = header.toLowerCase();
      if (h === "name") return profile.name;
      if (h === "availibility" || h === "availability") return "Available";
      if (h === "capabilites" || h === "capabilities") return profile.category || "";
      if (h === "portfolio") return profile.portfolio || "";
      if (h === "location") return profile.location || "";
      if (h === "profile image" || h === "profile image url" || h === "image") return profile.image || "";
      if (h === "comments") return profile.about
        ? `[Talent Scout - ${profile.source}] ${profile.about}`
        : `[Found via Talent Scout - ${profile.source}]`;
      if (h === "status") return "New";
      return "";
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${tabName}'!A3`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRow] },
    });

    console.log(`✅ Scout: "${profile.name}" added to "${tabName}" tab`);
    rosterCache = null;
    cacheTimestamp = 0;

    const originalBlocks = body.message.blocks || [];
    const updatedBlocks = originalBlocks.filter((b) => b.type !== "actions");
    updatedBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `✅ *Added to ${tabName}* by ${approvedBy}` },
    });

    await slack.client.chat.update({
      channel,
      ts: messageTs,
      blocks: updatedBlocks,
      text: `✅ ${profile.name} added to ${tabName} by ${approvedBy}`,
    });
  } catch (error) {
    console.error(`❌ Scout: failed to add "${profile.name}":`, error.message);
    await slack.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `⚠️ Couldn't add *${profile.name}* to the roster. Error: ${error.message}`,
    });
  }
});

slack.action("reject_scout", async ({ body, ack }) => {
  await ack();

  const messageTs = body.message.ts;
  const channel = body.channel.id;
  const rejectedBy = body.user.name || body.user.id;

  const originalBlocks = body.message.blocks || [];
  const updatedBlocks = originalBlocks.filter((b) => b.type !== "actions");
  updatedBlocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `❌ *Passed* by ${rejectedBy}` },
  });

  await slack.client.chat.update({
    channel,
    ts: messageTs,
    blocks: updatedBlocks,
    text: `❌ Passed by ${rejectedBy}`,
  });

  console.log(`❌ Scout: talent passed by ${rejectedBy}`);
});

// ── Start the bot ────────────────────────────────────────────────────

// ── Auto-detect actual tab names from the spreadsheet ─────────────────

async function syncTabNames() {
  try {
    const { data } = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: "sheets.properties.title",
    });

    const actualTabs = data.sheets.map((s) => s.properties.title);
    console.log(`📂 Actual tabs in sheet: [${actualTabs.join(", ")}]`);

    // Check each expected tab and fix the name if there's a close match
    for (let i = 0; i < FREELANCER_TABS.length; i++) {
      const expected = FREELANCER_TABS[i];
      if (actualTabs.includes(expected)) continue; // Exact match — good

      // Try to find a close match (case-insensitive, trimmed)
      const match = actualTabs.find(
        (t) => t.trim().toLowerCase() === expected.trim().toLowerCase()
      );
      if (match) {
        console.log(`🔧 Tab name fix: "${expected}" → "${match}"`);
        FREELANCER_TABS[i] = match;
      } else {
        console.warn(`⚠️ Tab "${expected}" not found in spreadsheet — will be skipped`);
      }
    }

    // Also update the CATEGORY_TO_TAB mapping with corrected names
    for (const [key, val] of Object.entries(CATEGORY_TO_TAB)) {
      if (!actualTabs.includes(val)) {
        const match = actualTabs.find(
          (t) => t.trim().toLowerCase() === val.trim().toLowerCase()
        );
        if (match) CATEGORY_TO_TAB[key] = match;
      }
    }
  } catch (err) {
    console.warn("⚠️ Could not sync tab names:", err.message);
  }
}

(async () => {
  await slack.start(process.env.PORT || 3000);
  console.log("⚡ Freelancer Finder bot is running!");
  console.log("📊 Connected to freelancer spreadsheet");

  // Auto-detect actual tab names to fix any mismatches
  await syncTabNames();
  console.log(`📂 Using tabs: ${FREELANCER_TABS.join(", ")}`);

  if (TEAM_SPREADSHEET_ID) {
    console.log("👥 Internal team sheet connected");
  } else {
    console.log("ℹ️  No internal team sheet configured (set GOOGLE_TEAM_SPREADSHEET_ID to enable)");
  }
  if (STREAMTIME_API_KEY) {
    const stData = await fetchStreamtimeJobHistory();
    if (stData) {
      console.log(`🏢 Streamtime connected — ${stData.totalJobs} jobs, ${Object.keys(stData.personJobs).length} people mapped`);
      // Sync Streamtime users → Team sheet (adds missing people, updates roles)
      await syncStreamtimeToTeamSheet();
    } else {
      console.log("⚠️ Streamtime API key set but could not fetch data");
    }
  } else {
    console.log("ℹ️  Streamtime not configured (set STREAMTIME_API_KEY to enable job history)");
  }
  if (SUBMISSIONS_SPREADSHEET_ID && SUBMISSIONS_NOTIFY_CHANNEL) {
    console.log("📝 Submission watcher active — checking every 5 minutes");
    // Initial check
    await checkForNewSubmissions();
    // Then poll on interval
    setInterval(checkForNewSubmissions, SUBMISSION_POLL_INTERVAL_MS);
  } else {
    console.log("ℹ️  Submission watcher not configured (set GOOGLE_SUBMISSIONS_SPREADSHEET_ID and SUBMISSIONS_NOTIFY_CHANNEL to enable)");
  }
  if (TALENT_SCOUT_CHANNEL && TALENT_SCOUT_SOURCES.length > 0) {
    console.log(`🔍 Talent Scout active — scanning ${TALENT_SCOUT_SOURCES.length} source(s) weekly`);
    console.log(`🔍 Sources: ${TALENT_SCOUT_SOURCES.join(", ")}`);
    // Run first scan 5 min after boot, then weekly
    setTimeout(() => {
      runTalentScout();
      setInterval(runTalentScout, TALENT_SCOUT_INTERVAL_MS);
    }, 5 * 60 * 1000);
  } else {
    console.log("ℹ️  Talent Scout not configured (set TALENT_SCOUT_CHANNEL and TALENT_SCOUT_SOURCES to enable)");
  }

  // Run profile image enrichment in the background (2 min after boot)
  setTimeout(() => {
    enrichProfileImages().catch((err) => console.warn("📸 Image enrichment error:", err.message));
  }, 2 * 60 * 1000);
})();
