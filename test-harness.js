#!/usr/bin/env node
/**
 * Test Harness for Lead Search Script
 * 
 * Runs batch searches against known leads and outputs results
 * for manual verification. Tracks hit rate.
 * 
 * Usage:
 *   node test-harness.js --ground-truth ground-truth.json
 *   node test-harness.js --db ../crm.sqlite --limit 20 --status ready
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Parse args
const args = process.argv.slice(2).reduce((acc, arg) => {
  if (arg.startsWith('--')) {
    const [key, value] = arg.split('=');
    acc[key.slice(2)] = value || true;
  }
  return acc;
}, {});

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://127.0.0.1:8889';
const SCRIPT_PATH = path.join(__dirname, 'search-lead.js');

// Ground truth file format: [{ leadId, name, city, state, expectedWebsite, expectedDomain }]
let testCases = [];

if (args['ground-truth']) {
  // Load from JSON file
  testCases = JSON.parse(fs.readFileSync(args['ground-truth'], 'utf8'));
} else if (args['db'] && args['limit']) {
  // Query from database - get leads with known websites for testing
  const dbPath = args['db'];
  const limit = parseInt(args['limit']) || 10;
  const status = args['status'] || 'ready';
  
  // Use sqlite3 CLI to query
  const query = `SELECT lead_id, name, website FROM leadops_leads WHERE status = '${status}' AND website IS NOT NULL AND website != '' AND website NOT LIKE '%offline%' LIMIT ${limit}`;
  
  try {
    const output = execSync(`sqlite3 "${dbPath}" "${query}"`, { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    
    testCases = lines.map(line => {
      const [id, name, website] = line.split('|');
      // Extract domain from website
      const domain = website.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      return {
        leadId: parseInt(id),
        name: name,
        website: website,
        expectedDomain: domain
      };
    });
  } catch (e) {
    console.error(`Failed to query database: ${e.message}`);
    process.exit(1);
  }
} else {
  // Default: use hardcoded test cases
  testCases = [
    { leadId: 9, name: '105 SPEEDWAY', expectedDomain: '105speedwayracing.com' },
    { leadId: 22, name: 'Good Charlie\'s Oyster Bar', city: 'Conroe', state: 'TX', expectedDomain: 'goodcharlies.com' },
    { leadId: 3, name: 'Northern Tool and Equipment', city: 'Conroe', state: 'TX', expectedDomain: 'northerntool.com' },
    { leadId: 1, name: '1845 SOLUTIONS', expectedDomain: '1845solutions.com' },
    { leadId: 10, name: '1097 WATER SPORTS INC.', expectedDomain: '1097watersports.com' },
    { leadId: 12, name: '12 Acre Woods RV Park, LLC', expectedDomain: '12acrewoodsrvpark.com' },
  ];
}

console.log(`\n========================================`);
console.log(`LEAD SEARCH TEST HARNESS`);
console.log(`========================================`);
console.log(`Test cases: ${testCases.length}`);
console.log(`SearXNG: ${SEARXNG_URL}`);
console.log(`\n`);

// Run tests
const results = [];
let hits = 0;
let misses = 0;
let pending = 0;

for (const test of testCases) {
  console.log(`\n----------------------------------------`);
  console.log(`Testing: ${test.name} (Lead ${test.leadId})`);
  console.log(`Expected: ${test.expectedDomain}`);
  console.log(`----------------------------------------`);
  
  // Build command
  const cmdParts = ['node', SCRIPT_PATH, '--lead', `"${test.name}"`];
  if (test.city) cmdParts.push('--city', test.city);
  if (test.state) cmdParts.push('--state', test.state);
  cmdParts.push('--min-score', '10', '--json');
  
  const cmd = cmdParts.join(' ');
  
  try {
    const output = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
    
    // Parse JSON from output (it's after "=== JSON OUTPUT ===" marker)
    const jsonMatch = output.match(/=== JSON OUTPUT ===\s*(\{[\s\S]*\})/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[1]);
      
      // Check if best match domain matches expected
      const bestMatch = result.bestMatch;
      const foundDomain = bestMatch?.domain?.toLowerCase().replace(/^www\./, '') || 'none';
      const verified = bestMatch?.verification?.verified || false;
      
      // Normalize expected domain too
      const expectedNorm = test.expectedDomain.toLowerCase().replace(/^www\./, '');
      
      // Determine if it's a hit
      let isHit = false;
      let verdict = '';
      
      if (foundDomain === expectedNorm) {
        isHit = true;
        verdict = 'HIT';
        hits++;
      } else if (verified) {
        // Verified but wrong domain - need manual check
        verdict = 'WRONG_BUT_VERIFIED';
        pending++;
      } else {
        verdict = 'MISS';
        misses++;
      }
      
      console.log(`Found: ${foundDomain}`);
      console.log(`Verified: ${verified}`);
      console.log(`Verdict: ${verdict}`);
      
      results.push({
        leadId: test.leadId,
        name: test.name,
        expectedDomain: test.expectedDomain,
        foundDomain,
        verified,
        verdict,
        candidates: result.candidates?.slice(0, 3).map(c => ({
          domain: c.domain,
          score: c.score,
          verified: c.verification?.verified
        }))
      });
      
    } else {
      console.log(`No JSON output found`);
      console.log(output.slice(0, 500));
      misses++;
      results.push({
        leadId: test.leadId,
        name: test.name,
        expectedDomain: test.expectedDomain,
        foundDomain: 'parse_error',
        verified: false,
        verdict: 'ERROR'
      });
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
    misses++;
    results.push({
      leadId: test.leadId,
      name: test.name,
      expectedDomain: test.expectedDomain,
      foundDomain: 'error',
      verified: false,
      verdict: 'ERROR',
      error: e.message
    });
  }
}

// Summary
console.log(`\n========================================`);
console.log(`SUMMARY`);
console.log(`========================================`);
console.log(`Hits: ${hits}`);
console.log(`Misses: ${misses}`);
console.log(`Pending (need manual verification): ${pending}`);
console.log(`Hit Rate: ${testCases.length > 0 ? ((hits / testCases.length) * 100).toFixed(1) : 0}%`);
console.log(`\n`);

// Output results JSON for manual verification queue
const outputPath = path.join(__dirname, 'test-results.json');
fs.writeFileSync(outputPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  totalTests: testCases.length,
  hits,
  misses,
  pending,
  hitRate: testCases.length > 0 ? (hits / testCases.length) : 0,
  results
}, null, 2));

console.log(`Results saved to: ${outputPath}`);

// Generate verification queue for manual inspection
const verificationQueue = results.filter(r => r.verdict !== 'HIT');
if (verificationQueue.length > 0) {
  const queuePath = path.join(__dirname, 'verification-queue.json');
  fs.writeFileSync(queuePath, JSON.stringify(verificationQueue, null, 2));
  console.log(`\nVerification queue saved to: ${queuePath}`);
  console.log(`Items requiring manual verification: ${verificationQueue.length}`);
}