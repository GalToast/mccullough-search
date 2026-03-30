/**
 * Lead Website Discovery via SearXNG
 * 
 * Takes a lead name + location, searches SearXNG for their website,
 * scores results, and returns best candidates.
 * 
 * Usage:
 *   node search-lead.js --lead "BLUE SKIES & SUNSHINE" --city "Willis" --state "TX"
 *   node search-lead.js --lead-id 1010 --db ../crm.sqlite
 *   node search-lead.js --batch --limit 10 --db ../crm.sqlite
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// SearXNG endpoint (localhost for dev, will be docker in GitHub Actions)
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://127.0.0.1:8889';

// Search engines to use (weighted for quality)
const DEFAULT_ENGINES = ['google', 'bing', 'duckduckgo', 'mojeek'];

// Business directory domains to deprioritize (not real websites)
const DIRECTORY_DOMAINS = [
  'linkedin.com',
  'facebook.com',
  'yelp.com',
  'yellowpages.com',
  'manta.com',
  'bizapedia.com',
  'buzzfile.com',      // business directory
  'houzz.com',
  'homeadvisor.com',
  'angi.com',
  'thumbtack.com',
  'nextdoor.com',
  'mapquest.com',
  'foursquare.com',
  'superpages.com',
  'whitepages.com',
  'imdb.com',          // entertainment directory
  'wikipedia.org',
  'buzzfeed.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'pinterest.com',
  'crunchbase.com',
  'glassdoor.com',
  'indeed.com',
  'ziprecruiter.com',
  'bbb.org',           // Better Business Bureau
  'opencorporates.com',
  'corporationwiki.com',
  'sunbiz.org',        // Florida corp registry
  'sos.state.tx.us',   // Texas SOS
  'texas.gov',
  'tn.gov',            // Tennessee (seen in profiles)
  'dnb.com',           // Dun & Bradstreet
  'hoovers.com',       // business info
  'rocketreach.co',    // contact lookup
  'contactout.com',    // contact lookup
  'signalhire.com',    // contact lookup
  'lead411.com',       // lead database
  'pitchbook.com',     // private market data
];

// High-quality signals in domain names
const GOOD_SIGNALS = [
  '.com',
  'official',
  'inc',
  'llc',
  'corp',
  'company',
  'services',
  'solutions',
  'group',
  'enterprises',
];

// Regex to clean slugified names
const SLUG_PATTERN = /^(\d+)-(.+)$/;

/**
 * Parse CLI args
 */
function parseArgs() {
  const args = {};
  const raw = process.argv.slice(2);
  
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith('--')) {
      const key = raw[i].slice(2);
      const value = raw[i + 1] && !raw[i + 1].startsWith('--') ? raw[i + 1] : true;
      args[key] = value;
      if (value !== true) i++;
    }
  }
  
  return args;
}

/**
 * Clean slugified name to real business name
 * e.g., "1010-blue-skies-and-sunshine" -> "BLUE SKIES & SUNSHINE"
 */
function cleanName(rawName) {
  // If it matches the slug pattern, extract the name part
  const match = rawName.match(SLUG_PATTERN);
  let name = match ? match[2] : rawName;
  
  // Replace hyphens with spaces
  name = name.replace(/-/g, ' ');
  
  // Title case or preserve original casing if it looks like a proper name
  // Handle common business suffixes
  name = name.replace(/\bllc\b/gi, 'LLC');
  name = name.replace(/\binc\b/gi, 'Inc');
  name = name.replace(/\bltd\b/gi, 'Ltd');
  name = name.replace(/\bcorp\b/gi, 'Corp');
  name = name.replace(/\bco\b/gi, 'Co');
  
  // Handle & and and
  name = name.replace(/\band\b/gi, '&');
  
  return name.trim();
}

/**
 * Query SearXNG API
 */
async function searxngSearch(query, options = {}) {
  const engines = options.engines || DEFAULT_ENGINES;
  const format = 'json';
  
  const url = new URL(SEARXNG_URL);
  url.pathname = '/search';
  url.searchParams.set('q', query);
  url.searchParams.set('format', format);
  url.searchParams.set('engines', engines.join(','));
  
  // Add language preference
  url.searchParams.set('language', 'en');
  
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    
    const req = client.get(url.toString(), { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Failed to parse SearXNG response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SearXNG request timeout'));
    });
  });
}

/**
 * Score a search result (higher = better candidate for real business website)
 */
function scoreResult(result, leadName, location) {
  let score = 0;
  const url = result.url || '';
  const title = result.title || '';
  const domain = extractDomain(url);
  
  // Penalize directories heavily
  if (DIRECTORY_DOMAINS.some(d => domain.includes(d))) {
    score -= 50;
  }
  
  // Reward if domain contains business name parts
  const nameParts = leadName.toLowerCase().split(/\s+/).filter(p => p.length > 2);
  for (const part of nameParts) {
    if (domain.toLowerCase().includes(part)) {
      score += 20;
    }
    if (title.toLowerCase().includes(part)) {
      score += 10;
    }
  }
  
  // Reward good signals in domain
  for (const signal of GOOD_SIGNALS) {
    if (domain.toLowerCase().includes(signal)) {
      score += 5;
    }
  }
  
  // Penalize obviously unrelated content
  if (title.toLowerCase().includes('movie') || title.toLowerCase().includes('film')) {
    score -= 30;
  }
  if (title.toLowerCase().includes('song') || title.toLowerCase().includes('music')) {
    score -= 30;
  }
  
  // Base score for having results
  score += 1;
  
  return Math.max(0, score);
}

/**
 * Extract domain from URL
 */
function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return '';
  }
}

/**
 * Build search queries for a lead
 * Try multiple query combinations until we find a match
 */
function buildQueries(leadName, location = {}) {
  const queries = [];
  const city = location.city || '';
  const state = location.state || 'TX';
  const zip = location.zip || '';
  
  // Strategy 1: Exact business name + location
  if (city) {
    queries.push(`"${leadName}" ${city} ${state}`);
  }
  
  // Strategy 2: Business name + state
  queries.push(`"${leadName}" ${state}`);
  
  // Strategy 3: Business name + zip
  if (zip) {
    queries.push(`"${leadName}" ${zip}`);
  }
  
  // Strategy 4: Business name only (for unique names)
  queries.push(`"${leadName}"`);
  
  // Strategy 5: Business name + website keyword
  queries.push(`"${leadName}" official website`);
  
  // Strategy 6: Fallback without quotes (broader search)
  if (city) {
    queries.push(`${leadName} ${city}`);
  }
  
  return queries;
}

/**
 * Search for a lead's website
 */
async function searchLead(leadName, location = {}, options = {}) {
  const queries = buildQueries(leadName, location);
  const results = [];
  const maxQueries = options.maxQueries || 3;
  const minScore = options.minScore || 15;
  
  for (let i = 0; i < Math.min(maxQueries, queries.length); i++) {
    const query = queries[i];
    
    try {
      const response = await searxngSearch(query, options);
      
      if (response.results && response.results.length > 0) {
        // Score and filter results
        const scored = response.results
          .map(r => ({
            ...r,
            score: scoreResult(r, leadName, location),
            domain: extractDomain(r.url),
            query: query
          }))
          .filter(r => r.score >= minScore)
          .sort((a, b) => b.score - a.score);
        
        results.push(...scored);
        
        // If we found a high-quality result, stop searching
        if (scored.length > 0 && scored[0].score >= 40) {
          break;
        }
      }
    } catch (error) {
      console.error(`Query "${query}" failed: ${error.message}`);
    }
    
    // Small delay between queries to avoid rate limiting
    if (i < maxQueries - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Deduplicate by domain, keeping highest scored
  const unique = [];
  const seenDomains = new Set();
  
  for (const r of results.sort((a, b) => b.score - a.score)) {
    if (!seenDomains.has(r.domain)) {
      seenDomains.add(r.domain);
      unique.push(r);
    }
  }
  
  return {
    leadName,
    location,
    queriesAttempted: Math.min(maxQueries, queries.length),
    totalResults: results.length,
    candidates: unique.slice(0, 10),
    bestMatch: unique[0] || null,
    status: unique.length > 0 ? 'found_candidates' : 'no_match'
  };
}

/**
 * SQLite helper (simple, no dependencies)
 */
function querySQLite(dbPath, sql) {
  // We'll shell out to sqlite3 CLI for simplicity
  // In production, would use better-sqlite3 or similar
  const { execSync } = require('child_process');
  
  try {
    const result = execSync(`sqlite3 "${dbPath}" "${sql}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    
    return result.trim().split('\n').filter(line => line.length > 0);
  } catch (error) {
    throw new Error(`SQLite query failed: ${error.message}`);
  }
}

/**
 * Load lead from database
 */
function loadLeadFromDB(dbPath, leadId) {
  const rows = querySQLite(dbPath, 
    `SELECT lead_id, name, status, profile_path FROM leadops_leads WHERE lead_id = ${leadId}`
  );
  
  if (!rows.length) {
    throw new Error(`Lead ${leadId} not found`);
  }
  
  const [id, name, status, profilePath] = rows[0].split('|');
  
  // Load profile to get address/location
  let location = {};
  if (profilePath && fs.existsSync(profilePath)) {
    const profileContent = fs.readFileSync(profilePath, 'utf8');
    
    // Parse address from profile
    const addressMatch = profileContent.match(/Address:\s*(.+)/);
    if (addressMatch) {
      const addressParts = addressMatch[1].split(',');
      // Extract city and state from address
      if (addressParts.length >= 2) {
        const cityState = addressParts[addressParts.length - 2].trim();
        const stateZip = addressParts[addressParts.length - 1].trim();
        location.city = cityState;
        location.state = stateZip.split(/\s+/)[0] || 'TX';
        location.zip = stateZip.match(/\d{5}/)?.[0] || '';
        location.fullAddress = addressMatch[1];
      }
    }
  }
  
  return {
    leadId: parseInt(id),
    rawName: name,
    cleanName: cleanName(name),
    status,
    profilePath,
    location
  };
}

/**
 * Main entry point
 */
async function main() {
  const args = parseArgs();
  
  // Single lead by name
  if (args.lead) {
    const leadName = args.lead;
    const location = {
      city: args.city || '',
      state: args.state || 'TX',
      zip: args.zip || ''
    };
    
    console.log(`Searching for: "${leadName}"`);
    if (location.city) console.log(`Location: ${location.city}, ${location.state}`);
    
    const result = await searchLead(leadName, location, {
      maxQueries: args.maxQueries ? parseInt(args.maxQueries) : 3,
      minScore: args.minScore ? parseInt(args.minScore) : 15
    });
    
    console.log('\n=== RESULTS ===');
    console.log(`Status: ${result.status}`);
    console.log(`Queries attempted: ${result.queriesAttempted}`);
    console.log(`Candidates found: ${result.candidates.length}`);
    
    if (result.bestMatch) {
      console.log('\n=== BEST MATCH ===');
      console.log(`Score: ${result.bestMatch.score}`);
      console.log(`Domain: ${result.bestMatch.domain}`);
      console.log(`URL: ${result.bestMatch.url}`);
      console.log(`Title: ${result.bestMatch.title}`);
      console.log(`Query: ${result.bestMatch.query}`);
    }
    
    if (result.candidates.length > 1) {
      console.log('\n=== TOP CANDIDATES ===');
      result.candidates.slice(0, 5).forEach((c, i) => {
        console.log(`${i + 1}. [${c.score}] ${c.domain} - ${c.title}`);
        console.log(`   ${c.url}`);
      });
    }
    
    // Output JSON if requested
    if (args.json) {
      console.log('\n=== JSON OUTPUT ===');
      console.log(JSON.stringify(result, null, 2));
    }
    
    return;
  }
  
  // Lead from database
  if (args['lead-id'] && args.db) {
    const dbPath = path.resolve(args.db);
    const lead = loadLeadFromDB(dbPath, args['lead-id']);
    
    console.log(`Lead ID: ${lead.leadId}`);
    console.log(`Raw name: ${lead.rawName}`);
    console.log(`Clean name: ${lead.cleanName}`);
    console.log(`Location: ${lead.location.city || 'N/A'}, ${lead.location.state}`);
    console.log(`Address: ${lead.location.fullAddress || 'N/A'}`);
    
    const result = await searchLead(lead.cleanName, lead.location);
    
    console.log('\n=== RESULTS ===');
    console.log(`Status: ${result.status}`);
    
    if (result.bestMatch) {
      console.log('\n=== BEST MATCH ===');
      console.log(`Score: ${result.bestMatch.score}`);
      console.log(`URL: ${result.bestMatch.url}`);
    }
    
    if (args.json) {
      console.log('\n=== JSON OUTPUT ===');
      console.log(JSON.stringify({ lead, result }, null, 2));
    }
    
    return;
  }
  
  // Batch search
  if (args.batch && args.db) {
    const dbPath = path.resolve(args.db);
    const limit = args.limit ? parseInt(args.limit) : 10;
    const status = args.status || 'research';
    
    // Get leads needing research
    const rows = querySQLite(dbPath,
      `SELECT lead_id, name FROM leadops_leads 
       WHERE status = '${status}' 
       AND (website IS NULL OR website = '')
       AND disqualified = 0
       LIMIT ${limit}`
    );
    
    console.log(`\nBatch searching ${rows.length} leads with status='${status}'...\n`);
    
    const results = [];
    
    for (const row of rows) {
      const [leadId, rawName] = row.split('|');
      const cleanNameStr = cleanName(rawName);
      
      console.log(`[${leadId}] ${cleanNameStr}`);
      
      try {
        const lead = loadLeadFromDB(dbPath, leadId);
        const searchResult = await searchLead(lead.cleanName, lead.location, {
          maxQueries: 2,  // Faster for batch
          minScore: 20    // Higher threshold for batch
        });
        
        results.push({
          leadId: parseInt(leadId),
          rawName,
          cleanName: cleanNameStr,
          ...searchResult
        });
        
        if (searchResult.bestMatch) {
          console.log(`  ✓ Found: ${searchResult.bestMatch.domain} (score: ${searchResult.bestMatch.score})`);
        } else {
          console.log(`  ✗ No match`);
        }
      } catch (error) {
        console.log(`  ✗ Error: ${error.message}`);
      }
      
      // Delay between leads
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Summary
    const found = results.filter(r => r.bestMatch).length;
    console.log(`\n=== SUMMARY ===`);
    console.log(`Total: ${results.length}`);
    console.log(`Found: ${found}`);
    console.log(`No match: ${results.length - found}`);
    
    if (args.json) {
      console.log('\n=== JSON OUTPUT ===');
      console.log(JSON.stringify(results, null, 2));
    }
    
    return;
  }
  
  // No valid args - show help
  console.log(`
Lead Website Discovery via SearXNG

Usage:
  node search-lead.js --lead "BUSINESS NAME" --city "City" --state "TX"
  node search-lead.js --lead-id 1010 --db path/to/crm.sqlite
  node search-lead.js --batch --limit 10 --db path/to/crm.sqlite

Options:
  --lead       Business name to search
  --city       City for location context
  --state      State (default: TX)
  --zip        ZIP code for location context
  --lead-id    Lead ID from database
  --db         Path to SQLite database
  --batch      Run batch search on multiple leads
  --limit      Number of leads for batch (default: 10)
  --status     Filter by status for batch (default: research)
  --max-queries  Max search queries per lead (default: 3)
  --min-score    Minimum score threshold (default: 15)
  --json       Output full JSON result

Environment:
  SEARXNG_URL  SearXNG endpoint (default: http://127.0.0.1:8889)
`);
}

main().catch(console.error);