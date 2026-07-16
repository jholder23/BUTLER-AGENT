# Gig Runner – Let Butlor Make Money

Butlor can discover freelance gigs, generate proposals, and queue them for you to apply. You handle identity, payments, and legal.

## What It Does

1. **Discover** – Searches Upwork, Fiverr, Remote.co, We Work Remotely for gigs matching your skills
2. **Propose** – Uses OpenAI to generate tailored proposals for each gig
3. **Queue** – Saves gigs + proposals to `Documents/Butlor/gigs.json`
4. **Execute** – When you win a gig: generates frontend (HTML) or transcribes audio

## How to Run

**In chat:**
- "Go make money"
- "Run gigs"
- "Find freelance gigs for frontend development"
- "Find gigs for transcription"

**What happens:**
- Butlor searches for gigs
- Generates proposals using your profile (`Documents/Butlor/profile.json`)
- Saves to `gigs.json` with URLs and proposal text
- You apply manually at each URL (or set up browser automation later)

## Setup

1. **Profile** – `Documents/Butlor/profile.json`:
   ```json
   {
     "base_resume": "Your resume...",
     "user_context": "5 years frontend, React, TypeScript. Available for 10hr/week."
   }
   ```

2. **OpenAI key** – Required for proposal generation. Add in Butlor settings.

## Queued Gigs

After a run, check `Documents/Butlor/gigs.json`. Each gig has:
- `url` – Link to apply
- `proposal` – Generated proposal text (paste into the platform's form)
- `title`, `snippet` – Gig details

## Execute Work (when you win)

For frontend gigs:
```
POST /gigs/execute
{"type": "frontend", "requirements": "Landing page for a coffee shop with menu"}
```
Output: `Documents/Butlor/gig_deliverables/index.html`

For transcription:
```
POST /gigs/execute
{"type": "transcription", "requirements": "/path/to/audio.wav"}
```
Output: `.txt` file with transcript.

## Next: Browser Automation

To auto-apply (fill forms, submit proposals), Playwright can be added. User would:
1. Log in to Upwork/Fiverr once
2. Run "apply to queued gigs"
3. Butlor fills forms with queued proposals

That's a future enhancement.
