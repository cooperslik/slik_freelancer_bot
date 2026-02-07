require("dotenv").config();
const { App } = require("@slack/bolt");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const cheerio = require("cheerio");

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

const sheets = google.sheets({
  version: "v4",
  auth: new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  }),
});

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const TEAM_SPREADSHEET_ID = process.env.GOOGLE_TEAM_SPREADSHEET_ID || null;
const SUBMISSIONS_SPREADSHEET_ID = process.env.GOOGLE_SUBMISSIONS_SPREADSHEET_ID || null;
const SUBMISSIONS_NOTIFY_CHANNEL = process.env.SUBMISSIONS_NOTIFY_CHANNEL || null;
const STREAMTIME_API_KEY = process.env.STREAMTIME_API_KEY || null;
const STREAMTIME_API_BASE = "https://api.streamtime.net/v1";

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

    // 4b. Find people in the sheet who are no longer in Streamtime → mark Inactive
    const markedInactive = [];
    if (statusCol >= 0) {
      for (const [normalized, rowIdx] of existingNames) {
        if (activeStreamtimeNames.has(normalized)) continue; // Still active

        const currentStatus = (rows[rowIdx][statusCol] || "").trim();
        if (currentStatus.toLowerCase() === "inactive") continue; // Already marked

        const name = (rows[rowIdx][nameCol] || "").trim();
        markedInactive.push({ name, rowIdx });
      }
    }

    // 5. Append new users to the sheet
    if (newUsers.length > 0) {
      const newRows = newUsers.map((u) => {
        const row = new Array(headers.length).fill("");
        if (nameCol >= 0) row[nameCol] = u.name;
        if (roleCol >= 0) row[roleCol] = u.role;
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

    // 7. Mark departed team members as Inactive
    for (const departed of markedInactive) {
      const colLetter = colIndexToLetter(statusCol);
      const sheetRow = departed.rowIdx + 1;

      await sheets.spreadsheets.values.update({
        spreadsheetId: TEAM_SPREADSHEET_ID,
        range: `${colLetter}${sheetRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [["Inactive"]] },
      });
    }

    if (markedInactive.length > 0) {
      console.log(`🔄 Marked ${markedInactive.length} team member(s) as Inactive: ${markedInactive.map((u) => u.name).join(", ")}`);
    }

    if (newUsers.length === 0 && updatedRoles.length === 0 && markedInactive.length === 0) {
      console.log("🔄 Streamtime sync: team sheet already up to date");
    }

    // Bust team cache since we may have changed the sheet
    if (newUsers.length > 0 || updatedRoles.length > 0 || markedInactive.length > 0) {
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

async function scrapePortfolio(portfolioUrl) {
  if (!portfolioUrl) return null;

  // Clean and validate the URL
  let url = portfolioUrl.trim();
  if (!url.startsWith("http")) url = "https://" + url;

  // Check cache
  const cached = portfolioCache.get(url);
  if (cached && Date.now() - cached.timestamp < PORTFOLIO_CACHE_TTL_MS) {
    return cached.data;
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
    let pageText = stripHtmlToText(html);

    // Truncate to ~3000 chars — enough context for a summary, not so much that it's wasteful
    if (pageText.length > 3000) {
      pageText = pageText.substring(0, 3000) + "...";
    }

    if (pageText.length < 50) return null; // Too little content to summarise

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

    const summary = summaryResponse.content?.[0]?.text || null;
    if (!summary || summary.includes("INSUFFICIENT_DATA")) return null;

    // Cache the result
    portfolioCache.set(url, { data: summary, timestamp: Date.now() });
    return summary;
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
async function enrichWithPortfolios(names, roster) {
  const matches = [];
  for (const name of names) {
    const person = roster.find(
      (p) => p.Name && p.Name.toLowerCase() === name.toLowerCase()
    );
    if (person) {
      const portfolioUrl = person.Portfolio || "";
      if (portfolioUrl) {
        matches.push({ name: person.Name, url: portfolioUrl });
      }
    }
  }

  if (matches.length === 0) return "";

  // Fetch all portfolios in parallel
  const results = await Promise.all(
    matches.map(async (m) => {
      const summary = await scrapePortfolio(m.url);
      if (!summary) return null;
      return { name: m.name, summary, url: m.url };
    })
  );

  const validResults = results.filter((r) => r !== null);
  if (validResults.length === 0) return "";

  let text = "\n\n🎨 *Portfolio Insights*\n";
  for (const r of validResults) {
    text += `• *${r.name}*: ${r.summary} (<${r.url}|View portfolio>)\n`;
  }
  return text;
}

// ── Combined enrichment ───────────────────────────────────────────────

async function enrichRecommendations(names, roster) {
  return await enrichWithPortfolios(names, roster);
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

// ── Handle messages that mention the bot ──────────────────────────────

slack.event("app_mention", async ({ event, say }) => {
  // Strip the bot mention from the message
  const query = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!query) {
    await say({
      text: "Hey! Tell me what kind of project you need a freelancer for and I'll check the roster. For example: _We need a senior motion designer for a 3-week brand campaign with 3D experience._\n\nYou can also log feedback: _review Jane Smith - great work, delivered on time, 9/10_",
      thread_ts: event.thread_ts || event.ts,
    });
    return;
  }

  // Reply in the existing thread if this is a follow-up, or start a new thread
  const threadTs = event.thread_ts || event.ts;

  // Check if this is a review/feedback request
  const wasReview = await handleReview(query, say, threadTs, event.channel);
  if (wasReview) return;

  // Show a thinking indicator
  const thinking = await say({
    text: "🔍 Checking the team and freelancer roster...",
    thread_ts: threadTs,
  });

  try {
    // Fetch latest data from both sheets + Streamtime
    const [roster, team, streamtime] = await Promise.all([
      fetchRoster(),
      fetchTeam(),
      fetchStreamtimeJobHistory(),
    ]);
    const rosterText = formatRosterForPrompt(roster);
    const teamText = formatTeamForPrompt(team);
    const streamtimeText = formatStreamtimeForPrompt(streamtime, roster, team);
    const allData = teamText + "\n" + rosterText + streamtimeText;

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

        // Add the new follow-up question
        messages.push({
          role: "user",
          content: query,
        });
      }
    }

    // Fall back to single message if no thread history
    if (messages.length === 0) {
      messages = [
        {
          role: "user",
          content: `Here is the internal team and freelancer roster:\n${allData}\n\n---\n\nRequest: ${query}`,
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

    let reply =
      response.content?.[0]?.text || "No recommendation could be generated.";

    // Enrich with portfolio data
    const recommendedNames = extractNamesFromReply(reply);
    if (recommendedNames.length > 0) {
      const enrichment = await enrichRecommendations(recommendedNames, roster);
      reply += enrichment;
    }

    // Update the "thinking" message with the actual response
    await slack.client.chat.update({
      channel: event.channel,
      ts: thinking.ts,
      text: reply,
    });
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

  const query = event.text.trim();

  // Check if this is a review/feedback request
  const wasReview = await handleReview(query, say, null, event.channel);
  if (wasReview) return;

  const thinking = await say({
    text: "🔍 Checking the team and freelancer roster...",
  });

  try {
    // Fetch latest data from both sheets + Streamtime
    const [roster, team, streamtime] = await Promise.all([
      fetchRoster(),
      fetchTeam(),
      fetchStreamtimeJobHistory(),
    ]);
    const rosterText = formatRosterForPrompt(roster);
    const teamText = formatTeamForPrompt(team);
    const streamtimeText = formatStreamtimeForPrompt(streamtime, roster, team);
    const allData = teamText + "\n" + rosterText + streamtimeText;

    const response = await claudeCreate({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the internal team and freelancer roster:\n${allData}\n\n---\n\nRequest: ${query}`,
        },
      ],
    });

    let reply =
      response.content?.[0]?.text || "No recommendation could be generated.";

    // Enrich with portfolio data
    const recommendedNames = extractNamesFromReply(reply);
    if (recommendedNames.length > 0) {
      const enrichment = await enrichRecommendations(recommendedNames, roster);
      reply += enrichment;
    }

    await slack.client.chat.update({
      channel: event.channel,
      ts: thinking.ts,
      text: reply,
    });
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
})();
