# McCullough Search - Development Memory

## Mission
Build a lead website discovery tool using SearXNG that achieves **85%+ hit rate** for finding correct business websites from lead names + location.

## Current Status
| Date | Hit Rate | Notes |
|------|----------|-------|
| 2026-03-30 08:30 | **~10%** (real leads) | Real-world test exposed major issues |
| 2026-03-30 08:15 | 100% (6/6 test leads) | Domain probing - but test was rigged |
| 2026-03-30 08:12 | 83.3% (5/6) | Added second-pass probing |
| 2026-03-30 08:06 | 66.7% (4/6) | Fixed domain guessing for suffixes |
| 2026-03-30 07:55 | 33.3% (2/6) | Added domain probing fallback |
| 2026-03-30 07:53 | 16.7% (1/6) | Added browser headers |
| 2026-03-30 07:00 | 0% (0/6) | Baseline - SearXNG only |

---

## Real-World Test Results (2026-03-30 08:25)

Pulled 20 random leads from `research` status queue. **Manual verification by assistant:**

| Lead ID | Business Name | Search Result | Verdict | Issue |
|---------|---------------|---------------|---------|-------|
| 1075 | BP Transportation Inc | statista.com (BP oil stats) | ❌ WRONG | "BP" matches oil company |
| 7626 | TJMC LLC | tjmcllc.com (TJM Consulting) | ⚠️ UNCERTAIN | Domain exists but no TX/location on site |
| 7450 | THE NEON ROUGE LLC | cathe.com (glycogen article) | ❌ WRONG | "Rouge" matching unrelated content |
| 2972 | Getright Fiber LLC | getright.com (download manager) | ❌ WRONG | "Getright" matches old software |
| 6484 | Systematic Contractors LLC | merriam-webster.com (dictionary) | ❌ WRONG | Common word = dictionary results |
| 2632 | FAIRWAY MASONRY LLC | NOT FOUND | ❌ MISS | No candidates at all |
| 3961 | JTH III MANAGEMENT LLC | jthlighting.com | ⚠️ UNCERTAIN | Could be related? Needs research |
| 3055 | GONDOR CALLS FOR PEST CONTROL | tolkienforum.com | ❌ WRONG | "Gondor" = Lord of the Rings |
| 3068 | GOODZ IN THE WOODZ LLC | thecountrybasket.com (Norwegian recipe) | ❌ WRONG | "Woodz" matching unrelated |

**Real-world hit rate: ~0-10%** (depending on how you count UNCERTAIN)

---

## Root Cause Analysis

### Problem 1: Generic/Common Words
- "Systematic" → dictionary definitions
- "Gondor" → Tolkien references
- "BP" → oil company
- These pollute search results

### Problem 2: Domain Guessing Fails for Most
- Most small businesses DON'T have `businessname.com`
- They might have:
  - `business-name-tx.com`
  - `facebook.com/businessname`
  - `yelp.com/biz/businessname`
  - No website at all

### Problem 3: SearXNG Engines Don't Index Local TX Businesses
- Google/Bing/DDG via SearXNG favor:
  - Large national brands
  - Wikipedia/dictionary pages
  - Popular content
- Local Texas LLCs don't rank

---

## What's Working (Niche Cases)
1. **Numbered businesses with obvious domains** - `105speedwayracing.com`, `1845solutions.com`
2. **Unique names** - `goodcharlies.com` (once we found the right query)

---

## Potential Solutions

### Option A: Better Search Queries
- Add industry keywords: `"BP Transportation" trucking freight Texas`
- Use owner names when available from profile
- Try multiple query variations

### Option B: Alternative Data Sources
- Texas Secretary of State business search
- Yelp/Google Maps API for local businesses
- LinkedIn company search
- Facebook Business pages

### Option C: Accept Lower Hit Rate
- Many businesses legitimately have NO website
- Focus on finding the ones that DO exist
- Queue the rest for manual research

### Option D: Hybrid Approach
1. Try SearXNG search with smart queries
2. Try domain probing for likely names
3. Check if Facebook/Yelp page exists
4. Mark as "no web presence found" if all fail

---

## Next Steps
1. Improve query generation with industry keywords
2. Add Facebook/Yelp detection (even if not ideal, better than nothing)
3. Test on another batch of 20 leads
4. Consider integrating Texas SoS business lookup

## Files
- `search-lead.js` - Main search script with domain probing
- `test-harness.js` - Test runner with 6 sample leads
- `MEMORY.md` - This file
- `.github/workflows/search-lead.yml` - GitHub Actions workflow (untested)