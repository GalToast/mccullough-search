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
const { execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

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
const ENGINE_PROFILES = ['text-primary', 'full-primary'];

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
if (args['compare-engine-profiles']) {
  console.log(`Engine profile comparison: ${ENGINE_PROFILES.join(' vs ')}`);
}
console.log(`\n`);

function buildArgs(test, engineProfile) {
  const cmdArgs = [SCRIPT_PATH, '--lead', test.name];
  if (test.city) cmdArgs.push('--city', test.city);
  if (test.state) cmdArgs.push('--state', test.state);
  cmdArgs.push('--min-score', '10', '--engine-profile', engineProfile, '--json');
  return cmdArgs;
}

async function runSingleTest(test, engineProfile) {
  const cmdArgs = buildArgs(test, engineProfile);

  try {
    const { stdout, stderr } = await execFileAsync('node', cmdArgs, {
      encoding: 'utf8',
      timeout: 60000,
      cwd: __dirname,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024
    });
    const output = `${stdout || ''}${stderr || ''}`;
    const jsonMatch = output.match(/=== JSON OUTPUT ===\s*(\{[\s\S]*\})/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[1]);
      const bestMatch = result.bestMatch;
      const foundDomain = bestMatch?.domain?.toLowerCase().replace(/^www\./, '') || 'none';
      const verified = bestMatch?.verification?.verified || false;
      const expectedNorm = test.expectedDomain.toLowerCase().replace(/^www\./, '');
      let verdict = '';

      if (foundDomain === expectedNorm) {
        verdict = 'HIT';
      } else if (verified) {
        verdict = 'WRONG_BUT_VERIFIED';
      } else {
        verdict = 'MISS';
      }

      return {
        leadId: test.leadId,
        name: test.name,
        engineProfile,
        expectedDomain: test.expectedDomain,
        foundDomain,
        verified,
        verdict,
        bestMatchScore: bestMatch?.score ?? null,
        totalResults: result.totalResults,
        candidates: result.candidates?.slice(0, 3).map(c => ({
          domain: c.domain,
          score: c.score,
          verified: c.verification?.verified,
          engine: c.engine,
          category: c.category
        })) || []
      };
    }

    return {
      leadId: test.leadId,
      name: test.name,
      engineProfile,
      expectedDomain: test.expectedDomain,
      foundDomain: 'parse_error',
      verified: false,
      verdict: 'ERROR',
      error: output.slice(0, 500)
    };
  } catch (e) {
    return {
      leadId: test.leadId,
      name: test.name,
      engineProfile,
      expectedDomain: test.expectedDomain,
      foundDomain: 'error',
      verified: false,
      verdict: 'ERROR',
      error: e.message
    };
  }
}

function summarize(results) {
  const hits = results.filter(r => r.verdict === 'HIT').length;
  const pending = results.filter(r => r.verdict === 'WRONG_BUT_VERIFIED').length;
  const misses = results.length - hits - pending;
  return {
    hits,
    misses,
    pending,
    hitRate: results.length > 0 ? (hits / results.length) : 0
  };
}

async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= tasks.length) return;
      results[current] = await tasks[current]();
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function main() {
  const compareProfiles = Boolean(args['compare-engine-profiles']);
  const profilesToRun = compareProfiles ? ENGINE_PROFILES : [args['engine-profile'] || 'text-primary'];
  const concurrency = Math.max(1, parseInt(args.concurrency || (compareProfiles ? 4 : 2), 10));
  console.log(`Concurrency: ${concurrency}`);

  const taskDescriptors = [];
  for (const test of testCases) {
    for (const engineProfile of profilesToRun) {
      taskDescriptors.push({ test, engineProfile });
    }
  }

  const results = await runWithConcurrency(
    taskDescriptors.map(({ test, engineProfile }) => async () => {
      const result = await runSingleTest(test, engineProfile);
      console.log(`\n----------------------------------------`);
      console.log(`Testing: ${test.name} (Lead ${test.leadId})`);
      console.log(`Expected: ${test.expectedDomain}`);
      console.log(`Profile: ${engineProfile}`);
      console.log(`Found: ${result.foundDomain}`);
      console.log(`Verified: ${result.verified}`);
      console.log(`Verdict: ${result.verdict}`);
      if (result.bestMatchScore != null) {
        console.log(`Score: ${result.bestMatchScore}`);
      }
      return result;
    }),
    concurrency
  );

  console.log(`\n========================================`);
  console.log(`SUMMARY`);
  console.log(`========================================`);
  const summaries = {};
  for (const engineProfile of profilesToRun) {
    summaries[engineProfile] = summarize(results.filter(r => r.engineProfile === engineProfile));
    console.log(`${engineProfile}: ${summaries[engineProfile].hits} hits, ${summaries[engineProfile].misses} misses, ${summaries[engineProfile].pending} pending, hit rate ${(summaries[engineProfile].hitRate * 100).toFixed(1)}%`);
  }
  console.log(`\n`);

  const outputPath = path.join(__dirname, 'test-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalTests: testCases.length,
    compareProfiles,
    profiles: profilesToRun,
    concurrency,
    summaries,
    results
  }, null, 2));

  console.log(`Results saved to: ${outputPath}`);

  const verificationQueue = results.filter(r => r.verdict !== 'HIT');
  if (verificationQueue.length > 0) {
    const queuePath = path.join(__dirname, 'verification-queue.json');
    fs.writeFileSync(queuePath, JSON.stringify(verificationQueue, null, 2));
    console.log(`\nVerification queue saved to: ${queuePath}`);
    console.log(`Items requiring manual verification: ${verificationQueue.length}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
