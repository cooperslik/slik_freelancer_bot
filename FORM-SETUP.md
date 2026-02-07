# Freelancer Intake Form — Setup Guide

## Step 1: Create the Google Form

Go to [forms.google.com](https://forms.google.com) and create a new form. Name it something like **"Join Our Freelancer Roster"** or **"Freelancer Expression of Interest"**.

Add these questions in order:

| # | Question | Type | Required? | Options (if dropdown) |
|---|----------|------|-----------|----------------------|
| 1 | **Full Name** | Short text | Yes | — |
| 2 | **Email Address** | Short text | Yes | — |
| 3 | **Primary Discipline** | Dropdown | Yes | Creative Director, AD/Designer, Copywriter, Animator, 3D Artist, Developer, Producer/AM, Retoucher, Photographer/Videographer, Strategist, Specialist, Other |
| 4 | **Experience Level** | Dropdown | Yes | Junior (0-2 years), Mid (3-5 years), Senior (6-10 years), Lead (10+ years) |
| 5 | **Key Skills & Capabilities** | Long text | Yes | — |
| 6 | **Day Rate (per 8hr day)** | Short text | Yes | — |
| 7 | **Portfolio URL** | Short text | Yes | — |
| 8 | **LinkedIn URL** | Short text | No | — |
| 9 | **Phone Number** | Short text | No | — |
| 10 | **Location (City, Country)** | Short text | Yes | — |
| 11 | **Notable Clients or Brands** | Long text | No | — |
| 12 | **Tell us about yourself** | Long text | No | — |

**Tips:**
- For "Email Address", use Google Forms' built-in email validation (click the three dots → Response validation → "Text" → "Email")
- For the portfolio/LinkedIn URLs, add validation for "URL" to make sure people paste proper links
- Add a short description at the top: *"We're always looking for talented freelancers to join our roster. Fill out this form and we'll be in touch if there's a fit."*

## Step 2: Link the Form to a Google Sheet

1. In the form editor, click the **Responses** tab at the top
2. Click the green **Google Sheets** icon (or "Link to Sheets")
3. Choose **"Create a new spreadsheet"** — name it something like "Freelancer Applications"
4. This creates a sheet with a "Form Responses 1" tab that auto-fills whenever someone submits

## Step 3: Share the Sheet with the Service Account

1. Open the newly created Google Sheet
2. Click **Share**
3. Paste your service account email (the same `GOOGLE_SERVICE_ACCOUNT_EMAIL` from your `.env`)
4. Set to **Viewer** access — the bot only needs to read
5. Click Send

## Step 4: Get the Sheet ID

The spreadsheet ID is the long string in the URL between `/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/THIS_PART_HERE/edit#gid=0
                                       ^^^^^^^^^^^^^^^
```

Copy that string.

## Step 5: Add Environment Variables to Railway

Go to your Railway dashboard → your bot service → Variables tab. Add:

```
GOOGLE_SUBMISSIONS_SPREADSHEET_ID=paste-the-sheet-id-here
SUBMISSIONS_NOTIFY_CHANNEL=paste-slack-channel-id-here
```

To get the Slack channel ID:
1. Right-click the channel in Slack where you want notifications
2. Click **"View channel details"**
3. Scroll to the bottom — the Channel ID is there (starts with `C`)

## Step 6: Push & Test

1. Push the updated code to GitHub (Railway auto-deploys)
2. Check Railway logs — you should see: `📝 Submission watcher active — checking every 5 minutes`
3. Open the Google Form and submit a test entry
4. Wait up to 5 minutes — a notification should appear in your Slack channel

## What the Slack Notification Looks Like

```
📬 New Freelancer Application

Jane Smith — Animator | Senior (6-10 years) | $850/day
📍 Melbourne, Australia
🛠️ 2D/3D animation, After Effects, Cinema 4D, character animation
💬 "I've been freelancing for 7 years across advertising and entertainment..."

🔗 Portfolio  •  🔗 LinkedIn  •  📧 jane@example.com

React with ✅ to add to the roster, or ❌ to pass.
```

## Step 7: Post the Form Link in Facebook Groups

Copy the form's share link (click **Send** in the form editor → copy the link) and post it in your freelancer Facebook groups. Something like:

> 🎨 We're a creative agency always on the lookout for talented freelancers — designers, animators, 3D artists, copywriters, developers, and more. If you'd like to be on our radar for upcoming projects, drop your details here: [form link]

## Notes

- The bot checks for new submissions every **5 minutes** — not instant, but quick enough
- On first startup, it counts existing submissions and only alerts on *new* ones (no spam from old entries)
- If the "Form Responses 1" tab doesn't exist yet (no one has submitted), the bot quietly skips — no errors
- Adding someone to your actual freelancer roster is still manual (the bot just alerts you)
