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

const SYSTEM_PROMPT = `You are the Freelancer Finder — an AI assistant for a creative advertising agency. Your job is to recommend the TOP 3 best-fit freelancers from the agency's roster based on project briefs and requirements.

HOW TO RANK CANDIDATES:
When evaluating freelancers against a request, weigh ALL of the following columns — not just the category or job title:
- **Capabilities**: Does their skill set directly match what the project needs?
- **Comments/Notes**: This is critical — it contains details about specific projects they've worked on, niche strengths, software proficiency, working style, and internal feedback. Treat this as the richest signal for fit.
- **Previous Clients**: Have they worked on similar brands, industries, or campaign types? A freelancer who's done work for a comparable client is a stronger match.
- **Level**: Does the seniority match what the project demands? A quick social content job doesn't need a senior CD; a hero brand campaign does.
- **Recommendation**: Internal recommendation score or notes — factor this into confidence.
- **Availability & Status**: Strongly prefer freelancers who are marked as available. Flag availability concerns if recommending someone who may be busy.
- **Cost Rate (per 8hr day)**: Always show this. If the requester mentions a budget, filter accordingly.
- **Location**: Only factor this in if the requester mentions on-site, local, or timezone needs.

RULES:
1. Always recommend exactly 3 candidates, ranked #1 to #3 by overall fit. If fewer than 3 are a reasonable match, recommend as many as fit and explain why there aren't more.
2. Only recommend freelancers who appear in the roster data provided. Never invent people.
3. Never share phone numbers or email addresses in the channel. If someone needs contact details, tell them to check the sheet directly.
4. Keep responses concise and scannable — this is Slack, not an email.
5. If the request is vague (e.g. "I need a designer"), ask a clarifying question about the type of work, budget, timeline, or seniority before recommending.

FORMAT your responses exactly like this:

🥇 *#1 — Name*
Category | Level | $X/day
_Why:_ [2-3 sentences explaining why they're the best fit — reference their specific capabilities, relevant project experience from Comments, and any notable previous clients]

🥈 *#2 — Name*
Category | Level | $X/day
_Why:_ [2-3 sentences]

🥉 *#3 — Name*
Category | Level | $X/day
_Why:_ [2-3 sentences]

💡 *Note:* [Optional — add a brief note about availability, budget considerations, or if the requester should consider combining two freelancers for the project]`;

// ── Handle messages that mention the bot ──────────────────────────────

slack.event("app_mention", async ({ event, say }) => {
  // Strip the bot mention from the message
  const query = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!query) {
    await say({
      text: "Hey! Tell me what kind of project you need a freelancer for and I'll check the roster. For example: _We need a senior motion designer for a 3-week brand campaign with 3D experience._",
      thread_ts: event.ts,
    });
    return;
  }

  // Show a thinking indicator
  const thinking = await say({
    text: "🔍 Checking the freelancer roster...",
    thread_ts: event.ts,
  });

  try {
    // Fetch latest roster data from Google Sheets
    const roster = await fetchRoster();
    const rosterText = formatRosterForPrompt(roster);

    // Ask Claude
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the current freelancer roster:\n${rosterText}\n\n---\n\nRequest: ${query}`,
        },
      ],
    });

    let reply =
      response.content?.[0]?.text || "No recommendation could be generated.";

    // Enrich with LinkedIn data if available
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
    text: "🔍 Checking the freelancer roster...",
  });

  try {
    const roster = await fetchRoster();
    const rosterText = formatRosterForPrompt(roster);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the current freelancer roster:\n${rosterText}\n\n---\n\nRequest: ${query}`,
        },
      ],
    });

    let reply =
      response.content?.[0]?.text || "No recommendation could be generated.";

    // Enrich with LinkedIn data if available
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

// ── Start the bot ────────────────────────────────────────────────────

(async () => {
  await slack.start(process.env.PORT || 3000);
  console.log("⚡ Freelancer Finder bot is running!");
  console.log("📊 Connected to freelancer spreadsheet");
  console.log(`📂 Tabs: ${FREELANCER_TABS.join(", ")}`);
})();
