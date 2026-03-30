# mccullough-search

Lead website discovery tool using SearXNG. Searches for business websites by name + location, scores results, returns best candidates.

## Features

- **Multi-query search strategy**: Tries business name variations + location
- **Smart scoring**: Prioritizes first-party domains, penalizes directories
- **Batch mode**: Search multiple leads from your CRM database
- **GitHub Actions**: Runs on free GitHub-hosted runners with SearXNG container

## Local Usage

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

## GitHub Actions Usage

```powershell
# Trigger search workflow from local
.\run-search-gh.ps1 -LeadName "Good Charlie's Conroe" -City "Conroe" -State "TX"
```

Or via GitHub UI: Actions → Search Lead → Run workflow

## Environment

- `SEARXNG_URL`: SearXNG endpoint (default: `http://127.0.0.1:8889`)

## Scoring

Results are scored based on:
- **Domain match**: Does URL domain contain business name words? (+10 per word)
- **Title match**: Does title contain business name words? (+5 per word)
- **Exact domain**: Domain exactly matches normalized business name (+50)
- **First-party penalty**: Directory/social domains penalized (-30)
- **Location bonus**: City/state in title or URL (+10)

Minimum score threshold: 15 (default)

## Files

- `search-lead.js` - Main search script
- `run-search-gh.ps1` - PowerShell runner for GitHub Actions
- `.github/workflows/search-lead.yml` - GitHub workflow with SearXNG container