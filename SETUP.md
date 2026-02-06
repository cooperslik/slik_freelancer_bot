# Freelancer Finder — Slack Bot Setup Guide

A step-by-step guide to get your freelancer recommendation bot running in Slack.

**Time required:** ~1 hour for first-time setup.

---

## Prerequisites

- A Slack workspace where you have admin/app-install permissions
- A Google account that owns or has access to the freelancer spreadsheet
- Node.js 18+ installed on your computer (download from https://nodejs.org)
- A credit card for the Claude API (usage will be a few dollars/month at most)

---

## Step 1: Get a Claude API Key

1. Go to https://console.anthropic.com
2. Sign up or log in
3. Go to **API Keys** and click **Create Key**
4. Copy the key (starts with `sk-ant-...`) — you'll need it later
5. Add a small amount of credit ($10 is plenty to start)

---

## Step 2: Create a Google Service Account

This lets the bot read your Google Sheet without needing your personal login.

1. Go to https://console.cloud.google.com
2. Create a new project (e.g., "Freelancer Bot")
3. In the left sidebar, go to **APIs & Services > Library**
4. Search for **Google Sheets API** and click **Enable**
5. Go to **APIs & Services > Credentials**
6. Click **+ CREATE CREDENTIALS > Service Account**
7. Name it something like `freelancer-bot`
8. Click **Done** (skip the optional permissions steps)
9. Click on the service account you just created
10. Go to the **Keys** tab
11. Click **Add Key > Create New Key > JSON**
12. A JSON file will download — keep it safe, you'll need two values from it:
    - `client_email` (looks like `freelancer-bot@your-project.iam.gserviceaccount.com`)
    - `private_key` (the long key string)

### Share your Google Sheet with the service account

13. Open your freelancer Google Sheet
14. Click **Share**
15. Paste the `client_email` from step 12
16. Set permission to **Viewer** (read-only is fine)
17. Click **Send**

This is what gives the bot access to read your sheet. Your sheet stays private — only this service account can read it.

---

## Step 3: Create the Slack App

1. Go to https://api.slack.com/apps
2. Click **Create New App > From Scratch**
3. Name it `Freelancer Finder` (or whatever you like)
4. Select your workspace
5. Click **Create App**

### Enable Socket Mode

6. In the left sidebar, go to **Socket Mode**
7. Toggle it **ON**
8. It will ask you to create an App-Level Token — name it `socket-token`
9. Add the scope `connections:write`
10. Click **Generate**
11. Copy the token (starts with `xapp-...`) — this is your `SLACK_APP_TOKEN`

### Set Bot Permissions

12. Go to **OAuth & Permissions** in the left sidebar
13. Under **Bot Token Scopes**, add these scopes:
    - `app_mentions:read` — so the bot can see when someone @mentions it
    - `chat:write` — so the bot can post messages
    - `im:history` — so the bot can read DMs
    - `im:read` — so the bot can see DM conversations

### Enable Events

14. Go to **Event Subscriptions** in the left sidebar
15. Toggle **ON**
16. Under **Subscribe to bot events**, add:
    - `app_mention`
    - `message.im`
17. Click **Save Changes**

### Install the App

18. Go to **Install App** in the left sidebar
19. Click **Install to Workspace**
20. Authorise the permissions
21. Copy the **Bot User OAuth Token** (starts with `xoxb-...`) — this is your `SLACK_BOT_TOKEN`

### Get the Signing Secret

22. Go to **Basic Information**
23. Under **App Credentials**, copy the **Signing Secret** — this is your `SLACK_SIGNING_SECRET`

---

## Step 4: Configure and Run the Bot

1. Download/clone the bot project files
2. Open a terminal in the project folder
3. Install dependencies:

```bash
npm install
```

4. Copy the example env file:

```bash
cp .env.example .env
```

5. Edit `.env` and fill in your values:

```
SLACK_BOT_TOKEN=xoxb-your-token-from-step-21
SLACK_SIGNING_SECRET=your-secret-from-step-22
SLACK_APP_TOKEN=xapp-your-token-from-step-11
ANTHROPIC_API_KEY=sk-ant-your-key-from-step-1
GOOGLE_SPREADSHEET_ID=1U27IH0j48cRYhvz2WPsfh1GR6wf2VSBcN1bPPS4cke0
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYourKeyHere\n-----END PRIVATE KEY-----\n"
```

**Note on the private key:** Open the JSON file from Step 2 and copy the `private_key` value. Keep the quotes and `\n` characters intact.

6. Start the bot:

```bash
npm start
```

You should see:
```
⚡ Freelancer Finder bot is running!
📊 Reading from spreadsheet: 1U27IH0j48cRYhvz2WPsfh1GR6wf2VSBcN1bPPS4cke0
📂 Tabs: Creative Directors, AD/Designers, Copywriters, ...
```

---

## Step 5: Test It

1. In Slack, create a channel called `#freelancer-finder` (or use any channel)
2. Invite the bot: type `/invite @Freelancer Finder`
3. Try a message:

```
@Freelancer Finder We need a senior motion designer for a 3-week brand campaign, ideally with 3D experience and under $1000/day
```

The bot should respond with recommendations from your roster within a few seconds.

You can also DM the bot directly for private queries.

---

## Step 6: Deploy (Keep It Running 24/7)

Running the bot on your laptop works for testing, but you'll want it running all the time. Here are the simplest options:

### Option A: Railway (Recommended — simplest)

1. Push your project to a GitHub repo (make sure `.env` is in `.gitignore`!)
2. Go to https://railway.app and sign in with GitHub
3. Click **New Project > Deploy from GitHub Repo**
4. Select your repo
5. Go to **Variables** and add all your `.env` values
6. Railway will auto-deploy. Done.

**Cost:** Free tier gives you 500 hours/month. Paid plan is $5/month for always-on.

### Option B: Render

1. Push to GitHub
2. Go to https://render.com
3. Create a new **Background Worker**
4. Connect your repo
5. Set the **Build Command** to `npm install`
6. Set the **Start Command** to `npm start`
7. Add environment variables in the dashboard

**Cost:** Free tier available. Paid starts at $7/month.

### Option C: Run on a spare machine

If you have an always-on Mac Mini or similar at the office:

```bash
# Install pm2 to keep it running
npm install -g pm2

# Start the bot
pm2 start index.js --name freelancer-bot

# Make it auto-restart on reboot
pm2 startup
pm2 save
```

---

## Optional: Enable LinkedIn Status Checking

The bot can check the LinkedIn profiles of recommended freelancers to see if they appear to be freelancing or employed full-time. This is powered by [Proxycurl](https://nubela.co/proxycurl), a legitimate LinkedIn data API.

1. Go to https://nubela.co/proxycurl and create an account
2. You get **100 free credits** on signup (each profile lookup = 1 credit)
3. Copy your API key from the dashboard
4. Add it to your `.env`:

```
PROXYCURL_API_KEY=your-proxycurl-key
```

5. Restart the bot

When enabled, the bot appends a LinkedIn status section after its recommendations:

```
📋 LinkedIn Status (may not be up to date)
• Jane Smith: ✅ Appears freelance/available — "Freelance Motion Designer | 3D & Brand"
• John Doe: ⚠️ Currently at SomeAgency as Senior Designer — "Creative Lead at SomeAgency"
• Alex Chen: ℹ️ Status unclear
Note: LinkedIn profiles may not reflect current availability — always confirm directly.
```

**Cost:** ~$0.01 per profile lookup. At 3 profiles per query and a few queries per day, this is roughly $1-2/month.

**Without Proxycurl:** The bot works perfectly fine without it — it just won't include the LinkedIn status section.

---

## Updating the Freelancer Roster

Just edit the Google Sheet as normal. The bot reads the latest data every time someone asks a question — there's nothing to sync or refresh.

If you add a completely new tab/category, add the tab name to the `FREELANCER_TABS` array in `index.js`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't respond | Check it's invited to the channel. Check terminal for errors. |
| "Could not read spreadsheet" | Make sure you shared the sheet with the service account email. |
| "Invalid API key" | Double-check your `.env` values — no extra spaces or quotes. |
| Bot responds slowly | First request may take 3-5 seconds (reading sheet + AI). This is normal. |
| Rate limit errors | You're sending too many requests. The free Claude tier has limits — upgrade if needed. |

---

## Costs Summary

| Service | Cost |
|---|---|
| Claude API | ~$2-5/month at typical agency query volume |
| Railway hosting | Free or $5/month |
| Google Sheets API | Free |
| Slack | Free (uses your existing workspace) |
| Proxycurl (optional) | ~$1-2/month for LinkedIn lookups |
| **Total** | **~$5-12/month** |
