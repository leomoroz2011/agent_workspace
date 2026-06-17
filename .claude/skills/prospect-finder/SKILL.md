---
name: prospect-finder
description: Run and manage the Prospect Finder tool — finds SF barbershops, pet groomers, or cafes on Google Maps, scores each one for website quality, ranks the top 20 by conversion likelihood, and generates personalized cold emails in Leo's voice. Use when Leo wants to find leads, run outreach research, or generate cold emails for his web design business.
argument-hint: [optional: business type — barbershops | pet-groomers | cafes]
---

# Prospect Finder

This skill helps Leo run, use, and extend the Prospect Finder tool located at `~/Desktop/Agent/prospect-finder/`.

## What the tool does

1. Searches Google Maps (Places API) for barbershops, pet groomers, or cafes in Inner Sunset, Outer Sunset, Inner Richmond, and/or Outer Richmond, San Francisco
2. Checks every business's website — scores quality 1-10 using Claude Haiku
3. Flags businesses with no website, social-only presence, or broken/outdated sites
4. Scans reviews for mentions of needing a website
5. Ranks all prospects by conversion likelihood (top 20)
6. Generates personalized cold emails on-demand in Leo's voice (free website for testimonial offer)
7. Exports everything as a downloadable CSV for Google Sheets

## Setup (one-time)

**1. Get API keys**

Foursquare Places API (free, no billing, no age restriction):
- Go to foursquare.com/developers → sign up with email
- Create an app → copy the API key (starts with `fsq3`)
- Free tier: 200,000 calls/month — more than enough

Anthropic API key: already exists from other projects.

**2. Create the .env file**
```bash
cd ~/Desktop/Agent/prospect-finder
cp .env.example .env
```
Open `.env` and fill in:
```
FOURSQUARE_API_KEY=fsq3your_key_here
ANTHROPIC_API_KEY=your_key_here
```

**3. Install dependencies (only needed once)**
```bash
cd ~/Desktop/Agent/prospect-finder
npm install
```

## Running the tool

```bash
cd ~/Desktop/Agent/prospect-finder
node server.js
```

Then open **http://localhost:3000** in the browser.

## Conversion scoring logic

| Situation | Base score |
|---|---|
| No website | 80% |
| Social media page only (Facebook/Instagram) | 72% |
| Website quality score 1-3/10 | 68% |
| Website quality score 4-5/10 | 52% |
| Website quality score 6-7/10 | 30% |
| Website quality score 8-10/10 | 10% |

Bonuses: +10% if reviews mention needing a website, +5% if rating < 3.5 stars.

## File structure

```
prospect-finder/
  server.js         — Express backend (search, analyze, email gen, serve UI)
  public/
    index.html      — Full frontend (select type, run analysis, view results, emails)
  package.json
  .env.example      — Copy to .env and fill in keys
  .gitignore        — Excludes node_modules and .env
```

## When invoked as a skill

If Leo uses `/prospect-finder`, help him:
- Run the tool if it isn't running (check with `lsof -i :3000`)
- Debug API errors (missing keys, quota issues, Places API billing)
- Extend the tool (add a new neighborhood, change scoring logic, adjust email tone)
- Export and organize results in Google Sheets

## Extending the tool

**Add a new neighborhood:** Edit `NEIGHBORHOODS` object in `server.js`.
**Change email tone:** Edit the prompt in the `/api/email` route in `server.js`.
**Add a new business type:** Add an entry to `BUSINESS_LABELS` in `server.js` and add a card to `index.html`.
**Change scoring weights:** Edit the conversion score block inside the `/api/analyze` route in `server.js`.
