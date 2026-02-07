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
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  }),
});

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const TEAM_SPREADSHEET_ID = process.env.GOOGLE_TEAM_SPREADSHEET_ID || null;
const SUBMISSIONS_SPREADSHEET_ID = process.env.GOOGLE_SUBMISSIONS_SPREADSHEET_ID || null;
const SUBMISSIONS_NOTIFY_CHANNEL = process.env.SUBMISSIONS_NOTIFY_CHANNEL || null;

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
    const summaryResponse = await anthropic.messages.create({
      model: "claude-haiku-3-20240307",
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
      text: "Hey! Tell me what kind of project you need a freelancer for and I'll check the roster. For example: _We need a senior motion designer for a 3-week brand campaign with 3D experience._",
      thread_ts: event.thread_ts || event.ts,
    });
    return;
  }

  // Reply in the existing thread if this is a follow-up, or start a new thread
  const threadTs = event.thread_ts || event.ts;

  // Show a thinking indicator
  const thinking = await say({
    text: "🔍 Checking the team and freelancer roster...",
    thread_ts: threadTs,
  });

  try {
    // Fetch latest data from both sheets
    const [roster, team] = await Promise.all([fetchRoster(), fetchTeam()]);
    const rosterText = formatRosterForPrompt(roster);
    const teamText = formatTeamForPrompt(team);
    const allData = teamText + "\n" + rosterText;

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
    const response = await anthropic.messages.create({
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

  const thinking = await say({
    text: "🔍 Checking the team and freelancer roster...",
  });

  try {
    // Fetch latest data from both sheets
    const [roster, team] = await Promise.all([fetchRoster(), fetchTeam()]);
    const rosterText = formatRosterForPrompt(roster);
    const teamText = formatTeamForPrompt(team);
    const allData = teamText + "\n" + rosterText;

    const response = await anthropic.messages.create({
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

let lastKnownSubmissionCount = null;
const SUBMISSION_POLL_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

async function checkForNewSubmissions() {
  if (!SUBMISSIONS_SPREADSHEET_ID || !SUBMISSIONS_NOTIFY_CHANNEL) return;

  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SUBMISSIONS_SPREADSHEET_ID,
      range: "'Form Responses 1'!A1:Z",
    });

    const rows = data.values || [];
    if (rows.length < 2) return; // No data yet (just headers)

    const headers = rows[0].map((h) => h.trim());
    const currentCount = rows.length - 1; // Exclude header row

    // First run — just record the count, don't spam old submissions
    if (lastKnownSubmissionCount === null) {
      lastKnownSubmissionCount = currentCount;
      console.log(`📝 Submissions watcher started — ${currentCount} existing submissions`);
      return;
    }

    // No new submissions
    if (currentCount <= lastKnownSubmissionCount) return;

    // Process new submissions (could be more than one if multiple came in between polls)
    const newRows = rows.slice(lastKnownSubmissionCount + 1);
    console.log(`📝 ${newRows.length} new freelancer submission(s) detected!`);

    for (const row of newRows) {
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

      let message = `📬 *New Freelancer Application*\n\n`;
      message += `*${name}*`;
      if (category) message += ` — ${category}`;
      if (level) message += ` | ${level}`;
      if (rate) message += ` | ${rate}/day`;
      message += `\n`;
      if (location) message += `📍 ${location}\n`;
      if (capabilities) message += `🛠️ ${capabilities}\n`;
      if (about) message += `💬 _"${about.length > 200 ? about.substring(0, 200) + "..." : about}"_\n`;
      message += `\n`;
      if (portfolio) message += `🔗 <${portfolio.startsWith("http") ? portfolio : "https://" + portfolio}|Portfolio>`;
      if (linkedin) message += `${portfolio ? "  •  " : ""}🔗 <${linkedin.startsWith("http") ? linkedin : "https://" + linkedin}|LinkedIn>`;
      if (email) message += `${portfolio || linkedin ? "  •  " : ""}📧 ${email}`;
      message += `\n\n_React with ✅ to add to the roster, or ❌ to pass._`;

      await slack.client.chat.postMessage({
        channel: SUBMISSIONS_NOTIFY_CHANNEL,
        text: message,
      });
    }

    lastKnownSubmissionCount = currentCount;
  } catch (err) {
    // Don't crash the bot if submissions sheet isn't set up yet
    if (err.message?.includes("Unable to parse range")) {
      // Sheet tab doesn't exist yet — form hasn't received any responses
      return;
    }
    console.warn("⚠️ Submission watcher error:", err.message);
  }
}

// ── Start the bot ────────────────────────────────────────────────────

(async () => {
  await slack.start(process.env.PORT || 3000);
  console.log("⚡ Freelancer Finder bot is running!");
  console.log("📊 Connected to freelancer spreadsheet");
  console.log(`📂 Tabs: ${FREELANCER_TABS.join(", ")}`);
  if (TEAM_SPREADSHEET_ID) {
    console.log("👥 Internal team sheet connected");
  } else {
    console.log("ℹ️  No internal team sheet configured (set GOOGLE_TEAM_SPREADSHEET_ID to enable)");
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
