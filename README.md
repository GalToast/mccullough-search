# McCullough Search

AI-first local-business intelligence support tool for finding and verifying first-party business websites.

This repo is a deterministic search and scoring stage in the broader McCullough Digital operating system. Its role is intentionally narrow: take messy lead names, search with structured variations, rank candidate websites, and hand off clear evidence to downstream human or AI-assisted review workflows.

## What This Demonstrates

- **Search strategy design:** Multi-query discovery using business-name variants, location context, and SearXNG.
- **Deterministic scoring:** First-party domains are rewarded while directories, social profiles, forums, registries, CDN hosts, and unrelated content are penalized.
- **Verification discipline:** Candidate pages are inspected for business-name, location, and local-business signals before being treated as usable.
- **Batch operations:** CRM SQLite slices can be searched by status with configurable limits.
- **Free-runner automation:** GitHub Actions can launch an ephemeral SearXNG container and run the same workflow without paid search APIs.
- **Review handoff:** Ambiguous results are not hidden; they are pushed into a verification queue for human or AI-assisted follow-up.

## How It Fits the Portfolio

```text
lead list / CRM slice
  -> website discovery and scoring
  -> verification queue
  -> website audit / lead intelligence / client delivery
```

`mccullough-search` supports the same operating pattern as the larger portfolio repos: convert noisy public signals into a bounded decision surface that a human operator can inspect.

## Usage

### Local Search

```bash
# Single lead search
node search-lead.js --lead "Good Charlie's Conroe" --city "Conroe" --state "TX"

# Search with min score threshold
node search-lead.js --lead "Northern Tool and Equipment" --city "Conroe" --state "TX" --min-score 20

# JSON output
node search-lead.js --lead "Good Charlie's" --city "Conroe" --state "TX" --json

# Batch search from CRM database
node search-lead.js --batch --limit 10 --db ../crm.sqlite --status research
```

### GitHub Actions

```powershell
# Trigger search workflow from local
.\run-search-gh.ps1 -LeadName "Good Charlie's Conroe" -City "Conroe" -State "TX"
```

Or via GitHub UI: Actions → Search Lead → Run workflow

### Test Harness

```bash
node test-harness.js --ground-truth ground-truth-fresh.json
```

The harness compares search output against known domains and writes review artifacts such as `test-results.json` and `verification-queue.json`.

## Environment

- `SEARXNG_URL`: SearXNG endpoint (default: `http://127.0.0.1:8889`)

## Scoring Signals

Results are scored based on:
- **Domain match**: Does URL domain contain business name words? (+10 per word)
- **Title match**: Does title contain business name words? (+5 per word)
- **Exact domain**: Domain exactly matches normalized business name (+50)
- **First-party penalty**: Directory/social domains penalized (-30)
- **Location bonus**: City/state in title or URL (+10)

Minimum score threshold: 15 (default)

## Files

- `search-lead.js` - Search, scoring, verification, JSON output, and batch mode
- `test-harness.js` - Ground-truth validation and hit-rate reporting
- `run-search-gh.ps1` - PowerShell runner for GitHub Actions
- `ground-truth-fresh.json` - Known-answer dataset for validation
- `verification-queue.json` - Ambiguous or missed cases queued for review
- `.github/workflows/search-lead.yml` - GitHub workflow with SearXNG container

## Why It Matters

For AI-adjacent roles, this repo shows a useful supporting pattern: keep fuzzy discovery work inspectable. The code creates a repeatable first-pass answer, preserves uncertainty, and passes structured evidence into the next review step instead of pretending every search result is equally trustworthy.
