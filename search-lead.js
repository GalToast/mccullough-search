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
const LOCAL_SEARXNG_URL = 'http://127.0.0.1:8889';
const CONFIGURED_SEARXNG_URL = process.env.SEARXNG_URL || LOCAL_SEARXNG_URL;
let activeSearxngUrl = CONFIGURED_SEARXNG_URL;
let searxngConfigCache = null;

// Search engines to use. Empty means discover the instance's enabled general/web engines.
const DEFAULT_ENGINES = [];
const DEFAULT_ENGINE_PROFILE = 'text-primary';

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
];

// Bad signals - results with these should trigger domain probing
const BAD_SIGNALS = [
  'forum', 'forums',           // Discussion forums
  'dictionary', 'definition',   // Dictionary definitions
  'wikipedia', 'wiktionary',  // Encyclopedias  
  'onthisday', 'history.com',  // History sites
  'statista', 'statistics',    // Statistics sites
  'merriam-webster', 'oxford', 'dictionary.com', // Dictionary sites
  'jlaforums', 'tolkien',     // Niche hobby forums
  'studycountry', 'travel',    // Travel guides
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
const BUSINESS_SUFFIXES = new Set([
  'llc', 'inc', 'ltd', 'corp', 'co', 'company', 'group', 'enterprises',
  'enterprise', 'services', 'solutions', 'management', 'holdings'
]);
const GENERIC_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'your', 'our', 'official',
  'website', 'texas', 'tx'
]);
const LOCAL_SITE_HINTS = ['contact', 'about', 'services', 'locations', 'location', 'menu', 'hours'];
const CDN_HOST_PATTERNS = [
  'storage.googleapis.com',
  'googleusercontent.com',
  'cloudfront.net',
  'azureedge.net',
  'akamaihd.net',
  'akamaized.net',
  'fastly.net',
  'fastlylb.net',
  'cdn.',
  'images.',
  'imgix.net',
  'shopifycdn.com',
  'cloudinary.com',
  's3.amazonaws.com',
  '.s3.amazonaws.com',
  '.r2.dev'
];

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

function stripBusinessSuffixes(name) {
  return name
    .replace(/\b(llc|inc|ltd|corp|co|company)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAlphaNum(value) {
  return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getSignificantNameParts(name) {
  const stripped = stripBusinessSuffixes(name.toLowerCase());
  return stripped
    .split(/[^a-z0-9]+/)
    .filter(part => part.length > 2 && !BUSINESS_SUFFIXES.has(part) && !GENERIC_STOPWORDS.has(part));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLeadNameForSearch(name) {
  return cleanName(name || '').replace(/\s+/g, ' ').trim();
}

function getNameVariants(name) {
  const normalized = normalizeLeadNameForSearch(name);
  const stripped = stripBusinessSuffixes(normalized);
  const parts = getSignificantNameParts(normalized);
  const acronym = parts.map(part => part[0]).join('');
  const tailWord = parts.length >= 2 ? parts[parts.length - 1] : '';
  const coreParts = tailWord ? parts.slice(0, -1) : parts;
  const coreAcronym = coreParts.map(part => part[0]).join('');
  const compact = parts.join('');
  return {
    normalized,
    stripped,
    parts,
    acronym,
    coreAcronym,
    tailWord,
    compact
  };
}

function normalizeEngineProfile(profile) {
  const value = (profile || DEFAULT_ENGINE_PROFILE).toLowerCase();
  if (['full', 'full-primary', 'all-primary', 'all'].includes(value)) return 'full-primary';
  return 'text-primary';
}

function isCdnLikeHost(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return CDN_HOST_PATTERNS.some(pattern => normalized === pattern || normalized.includes(pattern));
}

/**
 * Verify a candidate URL by fetching and checking content
 * Returns verification score (0-100) and evidence
 */
async function verifyCandidate(url, leadName, location) {
  return new Promise((resolve) => {
    const candidateDomain = extractDomain(url);
    if (isCdnLikeHost(candidateDomain)) {
      resolve({
        verified: false,
        score: 0,
        reason: 'cdn/asset host rejected'
      });
      return;
    }
    const strongIdentityHost = isStrongFirstPartyMatch(candidateDomain, leadName);

    const client = url.startsWith('https') ? https : http;
    const timeout = 10000; // 10 second timeout
    
    // Use browser-like headers to avoid Cloudflare blocks
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    };
    
    const req = client.get(url, { timeout, headers }, (res) => {
      if (res.statusCode >= 400) {
        resolve({ verified: false, score: 0, reason: `HTTP ${res.statusCode}` });
        return;
      }
      
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const verification = verifyPageContent(body, leadName, location);
        if (!strongIdentityHost && verification.verified) {
          verification.verified = false;
          verification.score = Math.min(verification.score, 20);
          verification.reason = 'weak domain identity';
          verification.evidence = [...(verification.evidence || []), 'weak domain identity'];
        }
        resolve(verification);
      });
    });
    
    req.on('error', (e) => {
      resolve({ verified: false, score: 0, reason: e.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ verified: false, score: 0, reason: 'timeout' });
    });
  });
}

/**
 * Check page content for business name and location matches
 */
function verifyPageContent(html, leadName, location) {
  const leadIdentity = getNameVariants(leadName);
  const text = html.toLowerCase();
  const compactText = normalizeAlphaNum(html);
  const nameLower = leadIdentity.normalized.toLowerCase();
  const strippedName = leadIdentity.stripped;
  const cityLower = (location?.city || '').toLowerCase();
  const stateLower = (location?.state || '').toLowerCase();
  
  let score = 0;
  let evidence = [];
  
  // Check for business name variants
  const nameVariants = [
    nameLower,
    nameLower.replace(/[^a-z0-9]/g, ''), // alphanumeric only
    nameLower.replace(/llc|inc|ltd|corp|co/gi, '').trim(), // without suffix
  ];
  
  for (const variant of nameVariants) {
    if (variant.length > 3 && text.includes(variant)) {
      score += 40;
      evidence.push(`name found: "${variant}"`);
      break;
    }
  }
  
  // Check for partial name match (at least 2 significant words)
  const words = leadIdentity.parts;
  const matchedWords = words.filter(w => text.includes(w));
  const requiredWordMatches = words.length <= 2 ? words.length : 2;
  if (matchedWords.length >= requiredWordMatches && requiredWordMatches > 0) {
    score += 30;
    evidence.push(`partial name: ${matchedWords.join(', ')}`);
  }

  const compactLeadName = normalizeAlphaNum(strippedName);
  const hasCompactNameMatch = compactLeadName.length > 5 && compactText.includes(compactLeadName);
  if (hasCompactNameMatch) {
    score += 35;
    evidence.push('compact name match');
  }

  const acronym = leadIdentity.acronym;
  if (acronym.length >= 3 && compactText.includes(acronym)) {
    score += 15;
    evidence.push(`acronym match: "${acronym}"`);
  }
  
  // Check for city
  if (cityLower && cityLower.length > 2 && text.includes(cityLower)) {
    score += 15;
    evidence.push(`city found: "${cityLower}"`);
  }
  
  // Check for state
  if (stateLower && new RegExp(`\\b${escapeRegex(stateLower)}\\b`, 'i').test(text)) {
    score += 10;
    evidence.push(`state found: "${stateLower}"`);
  }
  
  // Check for business indicators
  const businessIndicators = ['contact', 'about', 'hours', 'menu', 'services', 'phone', 'email', 'location'];
  const foundIndicators = businessIndicators.filter(i => text.includes(i));
  if (foundIndicators.length >= 3) {
    score += 15;
    evidence.push(`business page: ${foundIndicators.slice(0, 3).join(', ')}`);
  }

  const contactHints = LOCAL_SITE_HINTS.filter(hint => text.includes(hint));
  if (contactHints.length >= 2) {
    score += 10;
    evidence.push(`site hints: ${contactHints.slice(0, 2).join(', ')}`);
  }
  
  // Penalize directory/irrelevant pages
  const badSignals = ['yelp', 'yellowpages', 'facebook.com/', 'linkedin.com/', 'directory', 'listing', 'reviews'];
  for (const bad of badSignals) {
    if (text.includes(bad)) {
      score -= 30;
      evidence.push(`directory signal: "${bad}"`);
    }
  }

  if (matchedWords.length === 0 && !hasCompactNameMatch) {
    score -= 40;
    evidence.push('missing business identity');
  }

  if (/\b(storage\.googleapis|cloudfront|azureedge|akamai|fastly|cloudinary|imgix|shopifycdn|cdn)\b/i.test(text)) {
    score -= 80;
    evidence.push('asset host signal');
  }
  
  const verified = score >= 60 && (matchedWords.length >= requiredWordMatches || hasCompactNameMatch);
  
  return {
    verified,
    score: Math.max(0, Math.min(100, score)),
    evidence,
    reason: verified ? 'content verified' : `score ${score} below threshold`
  };
}

/**
 * Query SearXNG API
 */
async function searxngSearch(query, options = {}) {
  const format = 'json';

  async function fetchConfig(baseUrl) {
    const url = new URL(baseUrl);
    url.pathname = '/config';

    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url.toString(), { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse SearXNG config from ${baseUrl}: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`SearXNG config timeout: ${baseUrl}`));
      });
    });
  }

  async function getEnabledSearchEngines(baseUrl) {
    if (options.engines && options.engines.length > 0) {
      return options.engines;
    }
    if (DEFAULT_ENGINES.length > 0) {
      return DEFAULT_ENGINES;
    }
    if (!searxngConfigCache) {
      searxngConfigCache = await fetchConfig(baseUrl);
    }

    const engineProfile = normalizeEngineProfile(options.engineProfile);
    const engineNames = (searxngConfigCache.engines || [])
      .filter(engine => {
        if (!engine.enabled || !Array.isArray(engine.categories)) return false;

        const categories = new Set(engine.categories);
        const hasDiscoveryCategory = categories.has('general') || categories.has('web');
        if (!hasDiscoveryCategory) return false;

        if (engineProfile === 'full-primary') {
          return true;
        }

        const isImageOrVideoLane =
          categories.has('images') ||
          categories.has('videos') ||
          categories.has('news') ||
          /\.(images|videos|news)$/i.test(engine.name);

        return !isImageOrVideoLane;
      })
      .map(engine => engine.name);

    return [...new Set(engineNames)];
  }

  async function fetchFromEndpoint(baseUrl) {
    const engines = await getEnabledSearchEngines(baseUrl);
    const url = new URL(baseUrl);
    url.pathname = '/search';
    url.searchParams.set('q', query);
    url.searchParams.set('format', format);
    if (engines.length > 0) {
      url.searchParams.set('engines', engines.join(','));
    }
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
            reject(new Error(`Failed to parse SearXNG response from ${baseUrl}: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`SearXNG request timeout: ${baseUrl}`));
      });
    });
  }

  try {
    return await fetchFromEndpoint(activeSearxngUrl);
  } catch (error) {
    const shouldFallbackLocal =
      activeSearxngUrl !== LOCAL_SEARXNG_URL &&
      /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|timeout/i.test(error.message);

    if (!shouldFallbackLocal) {
      throw error;
    }

    console.error(`[SEARXNG] ${activeSearxngUrl} unavailable (${error.message}). Falling back to ${LOCAL_SEARXNG_URL}`);
    activeSearxngUrl = LOCAL_SEARXNG_URL;
    return fetchFromEndpoint(activeSearxngUrl);
  }
}

/**
 * Score a search result (higher = better candidate for real business website)
 */
function scoreResult(result, leadName, location) {
  const leadIdentity = getNameVariants(leadName);
  let score = 0;
  const url = result.url || '';
  const title = result.title || '';
  const snippet = result.content || '';
  const domain = extractDomain(url);
  const domainNorm = normalizeDomain(domain);
  const titleLower = title.toLowerCase();
  const snippetLower = snippet.toLowerCase();
  const nameParts = leadIdentity.parts;
  const normalizedLeadName = normalizeAlphaNum(leadIdentity.stripped);
  const acronym = leadIdentity.acronym.toLowerCase();
  const coreAcronym = leadIdentity.coreAcronym.toLowerCase();
  const tailWord = (leadIdentity.tailWord || '').toLowerCase();
  const domainBase = domainNorm.replace(/\.(com|net|org|biz|us)$/i, '');
  const titleCompact = normalizeAlphaNum(title);
  const snippetCompact = normalizeAlphaNum(snippet);
  
  // Penalize directories heavily
  if (DIRECTORY_DOMAINS.some(d => domain.includes(d))) {
    score -= 50;
  }
  
  // Reward if domain contains business name parts
  for (const part of nameParts) {
    if (domainNorm.includes(part)) {
      score += 20;
    }
    if (titleLower.includes(part)) {
      score += 10;
    }
    if (snippetLower.includes(part)) {
      score += 6;
    }
  }

  if (normalizedLeadName.length > 5 && domainNorm.replace(/\.(com|net|org|biz|us)$/i, '').includes(normalizedLeadName)) {
    score += 45;
  }
  if (normalizedLeadName.length > 5 && titleCompact.includes(normalizedLeadName)) {
    score += 25;
  }
  if (acronym.length >= 3) {
    if (domainBase.includes(acronym)) {
      score += 28;
    }
    if (titleLower.includes(acronym) || snippetLower.includes(acronym) || titleCompact.includes(acronym) || snippetCompact.includes(acronym)) {
      score += 12;
    }
  }
  if (coreAcronym.length >= 3 && tailWord && domainBase.includes(coreAcronym) && domainBase.includes(tailWord)) {
    score += 42;
  }
  
  // Reward good signals in domain
  for (const signal of GOOD_SIGNALS) {
    if (domainNorm.includes(signal)) {
      score += 5;
    }
  }
  
  // Penalize obviously unrelated content
  if (titleLower.includes('movie') || titleLower.includes('film')) {
    score -= 30;
  }
  if (titleLower.includes('song') || titleLower.includes('music')) {
    score -= 30;
  }
  
  // Penalize dictionary/encyclopedia sites (common word problem)
  const dictDomains = ['dictionary', 'merriam', 'oxford', 'wikipedia', 'britannica', 'thefreedictionary', 'yourdictionary'];
  for (const dict of dictDomains) {
    if (domain.includes(dict)) {
      score -= 40;
    }
  }
  
  // Penalize unrelated forums/communities
  const forumDomains = ['reddit', 'stackoverflow', 'quora', 'zhihu', 'tolkien', 'minecraft', 'game'];
  for (const forum of forumDomains) {
    if (domain.includes(forum)) {
      score -= 30;
    }
  }
  
  // Penalize academic/journal sites (unlikely local businesses)
  const academicDomains = ['journal', 'research', 'academic', 'sciencedirect', 'springer', 'wiley'];
  for (const acad of academicDomains) {
    if (domain.includes(acad)) {
      score -= 25;
    }
  }
  
  // Penalize recipe/food sites for non-food businesses
  const foodDomains = ['recipe', 'food', 'cooking', 'allrecipes', 'foodnetwork', 'delish'];
  const isFoodBusiness = leadName.toLowerCase().includes('food') || 
                          leadName.toLowerCase().includes('restaurant') ||
                          leadName.toLowerCase().includes('kitchen') ||
                          leadName.toLowerCase().includes('seafood') ||
                          leadName.toLowerCase().includes('bar');
  if (!isFoodBusiness) {
    for (const food of foodDomains) {
      if (domain.includes(food) || titleLower.includes('recipe')) {
        score -= 30;
      }
    }
  }
  
  // Penalize software/tech products for non-tech businesses
  const techDomains = ['github', 'npm', 'pypi', 'docker', 'aws', 'azure'];
  const isTechBusiness = leadName.toLowerCase().includes('software') ||
                          leadName.toLowerCase().includes('tech') ||
                          leadName.toLowerCase().includes('it ') ||
                          leadName.toLowerCase().includes('computer');
  if (!isTechBusiness) {
    for (const tech of techDomains) {
      if (domain.includes(tech)) {
        score -= 25;
      }
    }
  }

  const category = (result.category || '').toLowerCase();
  const engine = (result.engine || '').toLowerCase();
  const isMediaLane = category === 'images' || category === 'videos' || engine.includes('images') || engine.includes('videos');
  const isCdnCandidate = isCdnLikeHost(domainNorm);
  const isLikelyFirstParty =
    (normalizedLeadName.length > 5 && domainBase.includes(normalizedLeadName)) ||
    nameParts.filter(part => domainBase.includes(part)).length >= Math.min(2, Math.max(1, nameParts.length)) ||
    (acronym.length >= 3 && domainBase.includes(acronym));
  if (isCdnCandidate) {
    score -= 120;
  }
  if (isMediaLane && !isLikelyFirstParty) {
    score -= 40;
  } else if (isMediaLane && isLikelyFirstParty) {
    score -= 8;
  }

  const localTerms = [location?.city, location?.state].filter(Boolean).map(v => v.toLowerCase());
  const localMatches = localTerms.filter(term => titleLower.includes(term) || snippetLower.includes(term) || domainNorm.includes(term));
  if (localMatches.length > 0) {
    score += 12 * localMatches.length;
  }

  if (nameParts.length > 0) {
    const matchedIdentityParts = nameParts.filter(part => domainNorm.includes(part) || titleLower.includes(part) || snippetLower.includes(part));
    if (matchedIdentityParts.length === 0) {
      score -= 35;
    } else if (matchedIdentityParts.length === 1 && nameParts.length > 1) {
      score -= 10;
      if (!domainBase.includes(normalizedLeadName) && !(coreAcronym.length >= 3 && tailWord && domainBase.includes(coreAcronym) && domainBase.includes(tailWord))) {
        score -= 25;
      }
    }
  }

  if (domainBase && nameParts.length > 1) {
    const exactSinglePartMatch = nameParts.some(part => domainBase === part);
    if (exactSinglePartMatch) {
      score -= 40;
    }
  }

  if (LOCAL_SITE_HINTS.some(hint => titleLower.includes(hint) || url.toLowerCase().includes(`/${hint}`))) {
    score += 8;
  }
  
  // Base score for having results
  score += 1;
  
  return Math.max(0, score);
}

/**
 * Extract domain from URL
 */
// Normalize domains for comparison (strip www., lower case)
function normalizeDomain(domain) {
  if (!domain) return '';
  return domain.toLowerCase().replace(/^www\./, '');
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
 * Generate likely domain names from a business name
 * Used when search engines fail to find the business
 */
function guessDomains(leadName) {
  const leadIdentity = getNameVariants(leadName);
  const domains = [];
  
  // Common TLDs to try
  const tlds = ['.com', '.net', '.org'];
  
  // Clean the name for domain usage
  let base = leadIdentity.normalized.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special chars
    .replace(/\s+/g, '') // Remove spaces
    .replace(/^(the|a|an)/, ''); // Remove leading articles
  // Strategy 1: Exact name as domain
  for (const tld of tlds) {
    domains.push(`${base}${tld}`);
  }
  
  // Strategy 2: Remove common suffixes
  const suffixes = ['llc', 'inc', 'ltd', 'corp', 'co', 'company', 'tx', 'texas'];
  for (const suffix of suffixes) {
    if (base.endsWith(suffix)) {
      const shortened = base.slice(0, -suffix.length);
      for (const tld of tlds) {
        domains.push(`${shortened}${tld}`);
      }
    }
  }
  
  // Strategy 3: Remove common descriptors (for restaurants, parks, etc.)
  const descriptors = ['oysterbar', 'oysterbarandseafoodkitchen', 'seafoodkitchen', 
                       'rvpark', 'rv', 'park', 'restaurant', 'bar', 'grill'];
  for (const desc of descriptors) {
    if (base.includes(desc)) {
      const cleaned = base.replace(desc, '');
      for (const tld of tlds) {
        domains.push(`${cleaned}${tld}`);
      }
    }
  }
  
  // Strategy 3.6: Remove connecting words (and, or, the, of)
  const connectingRemoved = base.replace(/and|or|the|of/g, '');
  if (connectingRemoved !== base && connectingRemoved.length > 3) {
    for (const tld of tlds) {
      domains.push(`${connectingRemoved}${tld}`);
    }
  }
  
  // Strategy 4: For numbered businesses, try number + keyword combinations
  const numMatch = leadName.match(/^(\d+)\s*(.+)/);
  if (numMatch) {
    const num = numMatch[1];
    const rest = numMatch[2].toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const restNoSpaces = rest.replace(/\s/g, '');
    
    // Number + rest (no spaces)
    for (const tld of tlds) {
      domains.push(`${num}${restNoSpaces}${tld}`);
    }
    
    // Special patterns for speedways
    if (rest.includes('speedway') || rest.includes('race')) {
      for (const tld of tlds) {
        domains.push(`${num}speedwayracing${tld}`);
        domains.push(`${num}speedway${tld}`);
      }
    }
    
    // Special patterns for watersports
    if (rest.includes('water') || rest.includes('boat')) {
      for (const tld of tlds) {
        domains.push(`${num}watersports${tld}`);
        domains.push(`${num}boats${tld}`);
      }
    }
    
    // For RV parks
    if (rest.includes('rv') || rest.includes('park')) {
      for (const tld of tlds) {
        domains.push(`${num}acrewoods${tld}`);
        domains.push(`${num}acrewoodsrvpark${tld}`);
      }
    }
  }
  
  // Strategy 3.5: For multi-word names, try first 1-2 words
  const nameWords = base.match(/[a-z]+/g) || [];
  if (nameWords.length >= 2) {
    // First two words joined
    for (const tld of tlds) {
      domains.push(`${nameWords[0]}${nameWords[1]}${tld}`);
    }
  }
  if (nameWords.length >= 3) {
    // First word only (sometimes works for big brands)
    for (const tld of tlds) {
      domains.push(`${nameWords[0]}${tld}`);
    }
  }
  
  // Strategy 5: Try name parts (first word + second word)
  const words = base.split(/(?=[A-Z])|[\s]+/).filter(w => w.length > 2);
  if (words.length >= 2) {
    // First two words joined
    for (const tld of tlds) {
      domains.push(`${words[0]}${words[1]}${tld}`);
    }
  }

  if (leadIdentity.coreAcronym.length >= 3 && leadIdentity.tailWord) {
    for (const tld of tlds) {
      domains.push(`${leadIdentity.coreAcronym.toLowerCase()}${leadIdentity.tailWord.toLowerCase()}${tld}`);
      domains.push(`${leadIdentity.coreAcronym.toLowerCase()}-${leadIdentity.tailWord.toLowerCase()}${tld}`);
    }
  } else if (leadIdentity.acronym.length >= 3 && words.length > 0) {
    for (const tld of tlds) {
      domains.push(`${leadIdentity.acronym.toLowerCase()}${words[words.length - 1]}${tld}`);
    }
  }
  
  return [...new Set(domains)]; // Dedupe
}

/**
 * Probe a domain to see if it exists and contains business name
 */
async function probeDomain(domain, leadName, location) {
  const url = `https://${domain}`;
  
  return new Promise((resolve) => {
    const timeout = 5000;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    };
    
    const req = https.get(url, { timeout, headers }, (res) => {
      // Even 403/406 means the domain exists (Cloudflare blocking)
      if (res.statusCode >= 400 && res.statusCode !== 403 && res.statusCode !== 406) {
        resolve({ found: false, reason: `HTTP ${res.statusCode}` });
        return;
      }
      
      // For 403/406, domain exists but is protected - still count as found
      if (res.statusCode === 403 || res.statusCode === 406) {
        resolve({ 
          found: true, 
          domain, 
          url,
          confidence: 0.7, // Lower confidence since we can't verify content
          reason: 'domain exists (verification blocked)'
        });
        return;
      }
      
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        // Check if business name appears in content
        const nameParts = leadName.toLowerCase().split(/\s+/).filter(p => p.length > 2);
        const bodyLower = body.toLowerCase();
        
        let matches = 0;
        for (const part of nameParts) {
          if (bodyLower.includes(part)) matches++;
        }
        
        if (matches >= Math.ceil(nameParts.length / 2)) {
          resolve({ 
            found: true, 
            domain, 
            url,
            confidence: matches / nameParts.length,
            reason: 'domain probe matched'
          });
        } else {
          resolve({ found: false, reason: 'content mismatch' });
        }
      });
    });
    
    req.on('error', (e) => {
      resolve({ found: false, reason: e.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ found: false, reason: 'timeout' });
    });
  });
}

/**
 * Detect industry keywords from business name
 * Returns array of relevant industry terms to improve search
 */
function detectIndustry(businessName) {
  const name = businessName.toLowerCase();
  const industries = [];
  
  // Transportation/Logistics
  if (name.includes('transport') || name.includes('trucking') || name.includes('freight') || name.includes('logistics')) {
    industries.push('trucking', 'freight', 'logistics');
  }
  
  // Construction/Contractors
  if (name.includes('contractor') || name.includes('construction') || name.includes('builder') || name.includes('masonry')) {
    industries.push('construction', 'contractor');
  }
  
  // Pest Control
  if (name.includes('pest') || name.includes('exterminat')) {
    industries.push('pest control', 'exterminator');
  }
  
  // Food/Restaurant
  if (name.includes('restaurant') || name.includes('food') || name.includes('kitchen') || name.includes('oyster') || name.includes('seafood') || name.includes('bar')) {
    industries.push('restaurant', 'food');
  }
  
  // Fiber/Telecom
  if (name.includes('fiber') || name.includes('telecom') || name.includes('internet') || name.includes('network')) {
    industries.push('internet', 'telecom', 'fiber');
  }
  
  // RV/Parks
  if (name.includes('rv') || name.includes('park') || name.includes('camp')) {
    industries.push('rv park', 'campground');
  }
  
  // Watersports/Marine
  if (name.includes('water') || name.includes('marine') || name.includes('boat')) {
    industries.push('boat', 'marine', 'watersports');
  }
  
  // Racing/Speedway
  if (name.includes('speedway') || name.includes('race') || name.includes('motor')) {
    industries.push('racing', 'dirt track', 'motorsports');
  }
  
  return industries;
}

/**
 * Build search queries for a lead
 * Try multiple query combinations until we find a match
 */
function buildQueries(leadName, location = {}) {
  const leadIdentity = getNameVariants(leadName);
  const queries = [];
  const city = location.city || '';
  const state = location.state || 'TX';
  const industries = detectIndustry(leadName);
  const strippedName = leadIdentity.stripped;
  const compactName = leadIdentity.parts.join(' ');
  const acronym = leadIdentity.acronym;
  const coreAcronym = leadIdentity.coreAcronym;
  const tailWord = leadIdentity.tailWord;
  const addQuery = (query) => {
    const trimmed = (query || '').trim().replace(/\s+/g, ' ');
    if (trimmed && !queries.includes(trimmed)) {
      queries.push(trimmed);
    }
  };
  
  // Strategy 1: Exact business name + location + industry
  if (city && industries.length > 0) {
    addQuery(`"${leadName}" ${city} ${state} ${industries[0]}`);
  }
  if (city) {
    addQuery(`"${leadName}" ${city} ${state}`);
  }
  
  // Strategy 2: Business name + state + industry
  if (industries.length > 0) {
    addQuery(`"${leadName}" ${state} ${industries[0]}`);
  }
  addQuery(`"${leadName}" ${state}`);
  
  // Strategy 3: Business name with industry context (no location)
  if (industries.length > 0) {
    addQuery(`"${leadName}" ${industries[0]}`);
  }
  
  // Strategy 4: Business name only (for unique names)
  addQuery(`"${leadName}"`);
  if (strippedName !== leadName) {
    addQuery(`"${strippedName}" ${city} ${state}`.trim());
    addQuery(`"${strippedName}"`);
  }
  
  // Strategy 5: Business name + official/local keywords
  addQuery(`"${leadName}" official website`);
  if (city) {
    addQuery(`"${leadName}" ${city} Texas business`);
    addQuery(`${strippedName} ${city} ${state} contact`);
  }
  
  // Strategy 6: Fallback without quotes (broader search)
  if (city) {
    addQuery(`${leadName} ${city} ${industries[0] || ''}`.trim());
    addQuery(`${leadName} ${city} ${state} company`);
    addQuery(`${leadName} ${city} ${state} services`);
  }
  addQuery(`${strippedName} ${state} ${industries[0] || ''}`.trim());
  addQuery(`${strippedName} ${state} company`);
  addQuery(`${strippedName} ${state} contact`);
  if (compactName && compactName !== strippedName.toLowerCase()) {
    addQuery(`${compactName} ${city} ${state}`.trim());
  }
  if (acronym.length >= 3) {
    addQuery(`${acronym} ${city} ${state}`.trim());
    addQuery(`${acronym} ${industries[0] || ''} ${state}`.trim());
  }
  if (coreAcronym.length >= 3 && tailWord) {
    addQuery(`${coreAcronym} ${tailWord} ${city} ${state}`.trim());
    addQuery(`${coreAcronym}${tailWord} ${state}`.trim());
  }
  
  // Strategy 7: For numbered names, try the likely domain name
  const guessedDomains = guessDomains(leadName);
  for (const domain of guessedDomains.slice(0, 3)) {
    addQuery(domain.replace(/\.(com|net|org)$/, '')); // Search for domain without TLD
  }
  
  return queries;
}

/**
 * Search for a lead's website
 */
async function searchLead(leadName, location = {}, options = {}) {
  const normalizedLeadName = normalizeLeadNameForSearch(leadName);
  const queries = buildQueries(normalizedLeadName, location);
  const results = [];
  const maxQueries = options.maxQueries || 8;
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
            score: scoreResult(r, normalizedLeadName, location),
            domain: extractDomain(r.url),
            query: query
          }))
          .filter(r => r.score >= minScore)
          .sort((a, b) => b.score - a.score);
        
        results.push(...scored);
        
        // If we found a high-quality result, stop searching
        if (i >= 2 && scored.length > 0 && scored[0].score >= 65 &&
            !BAD_SIGNALS.some(bad => (scored[0].domain || '').toLowerCase().includes(bad))) {
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
  
  // FALLBACK: Domain probing for numbered/obscure businesses
  // If search engines didn't find good results OR no results verified, try probing likely domains directly
  const guessedDomains = guessDomains(normalizedLeadName);
  
  // Check if any result contains bad signals (forums, dictionaries, etc.)
  const hasBadResults = results.some(r => 
    r.domain && BAD_SIGNALS.some(bad => r.domain.toLowerCase().includes(bad))
  );
  
  const needsProbing = results.length === 0 || results.every(r => r.score < 20) || hasBadResults;
  
  if (needsProbing && guessedDomains.length > 0) {
    console.error(`[FALLBACK] Trying domain probing for: ${guessedDomains.slice(0, 5).join(', ')}`);
    
    for (const domain of guessedDomains.slice(0, 5)) {
      try {
        const probe = await probeDomain(domain, normalizedLeadName, location);
        if (probe.found) {
          console.error(`[FALLBACK] Domain probe hit: ${domain}`);
          results.push({
            url: probe.url,
            title: leadName,
            score: 30 + Math.round(probe.confidence * 20), // 30-50 score range
            domain: domain,
            query: `domain_probe:${domain}`,
            source: 'domain_probe'
          });
        }
      } catch (e) {
        // Ignore probe failures
      }
      await new Promise(resolve => setTimeout(resolve, 200));
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
  
  // Verify top candidates by fetching and checking content
  const topCandidates = unique.slice(0, 5);
  const verifiedCandidates = [];
  
  if (options.verify !== false && topCandidates.length > 0) {
    for (const candidate of topCandidates) {
      try {
        const verification = await verifyCandidate(candidate.url, normalizedLeadName, location);
        candidate.verification = verification;
        candidate.verifiedScore = candidate.score + verification.score;
        candidate.verified = verification.verified;
        
        if (verification.verified) {
          verifiedCandidates.push(candidate);
        }
        
        // Small delay between verification requests
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        candidate.verification = { verified: false, score: 0, reason: error.message };
      }
    }
  }
  
  // Second pass: If nothing verified, try domain probing with guessed domains
  if (verifiedCandidates.length === 0 && guessedDomains && guessedDomains.length > 0) {
    console.error(`[FALLBACK-2] No verified results, trying domain probing...`);
    
    for (const domain of guessedDomains.slice(0, 8)) {
      // Skip if we already have this domain in results
      if (seenDomains.has(normalizeDomain(domain))) continue;
      
      try {
        const probe = await probeDomain(domain, normalizedLeadName, location);
        if (probe.found) {
          console.error(`[FALLBACK-2] Domain probe hit: ${domain}`);
          const newCandidate = {
            url: probe.url,
            title: leadName,
            score: 30 + Math.round(probe.confidence * 20),
            domain: domain,
            query: `domain_probe:${domain}`,
            source: 'domain_probe',
            verification: { verified: probe.confidence > 0.5, score: Math.round(probe.confidence * 50) }
          };
          unique.push(newCandidate);
          if (probe.confidence > 0.5) {
            verifiedCandidates.push(newCandidate);
          }
        }
      } catch (e) {
        // Ignore probe failures
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  // Prefer verified candidates, then fall back to unverified
  const finalCandidates = verifiedCandidates.length > 0 
    ? verifiedCandidates.sort((a, b) => b.verifiedScore - a.verifiedScore)
    : unique.slice(0, 10);
  
  return {
    leadName: normalizedLeadName,
    location,
    engineProfile: normalizeEngineProfile(options.engineProfile),
    queriesAttempted: Math.min(maxQueries, queries.length),
    totalResults: results.length,
    verifiedCount: verifiedCandidates.length,
    candidates: finalCandidates.slice(0, 10),
    bestMatch: finalCandidates[0] || null,
    status: verifiedCandidates.length > 0 ? 'verified_match' : 
            unique.length > 0 ? 'found_candidates' : 'no_match'
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
      maxQueries: args.maxQueries ? parseInt(args.maxQueries) : 8,
      minScore: args.minScore ? parseInt(args.minScore) : 15,
      engineProfile: args['engine-profile'] || DEFAULT_ENGINE_PROFILE
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
    
    const result = await searchLead(lead.cleanName, lead.location, {
      engineProfile: args['engine-profile'] || DEFAULT_ENGINE_PROFILE
    });
    
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
          minScore: 20,   // Higher threshold for batch
          engineProfile: args['engine-profile'] || DEFAULT_ENGINE_PROFILE
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
  --max-queries  Max search queries per lead (default: 8)
  --min-score    Minimum score threshold (default: 15)
  --engine-profile Engine pool: text-primary or full-primary
  --json       Output full JSON result

Environment:
  SEARXNG_URL  SearXNG endpoint (default: http://127.0.0.1:8889)
`);
}

main().catch(console.error);
