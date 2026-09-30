'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const searchLead = require('../search-lead.js');
const harness = require('../test-harness.js');

describe('search-lead.js parseArgs', () => {
  it('honors kebab-case flags via camelCase aliases (--max-queries, --min-score)', () => {
    const a = searchLead.parseArgs(['--lead', 'X', '--max-queries', '3', '--min-score', '20']);
    assert.equal(a.maxQueries, '3');
    assert.equal(a.minScore, '20');
    // original keys still present for existing readers
    assert.equal(a['max-queries'], '3');
    assert.equal(a['min-score'], '20');
  });

  it('accepts camelCase flags directly', () => {
    const a = searchLead.parseArgs(['--maxQueries', '5']);
    assert.equal(a.maxQueries, '5');
  });

  it('accepts --key=value form', () => {
    const a = searchLead.parseArgs(['--engine-profile=full-primary']);
    assert.equal(a['engine-profile'], 'full-primary');
    assert.equal(a.engineProfile, 'full-primary');
  });

  it('handles boolean flags without consuming the next flag', () => {
    const a = searchLead.parseArgs(['--lead', 'X', '--json', '--batch']);
    assert.equal(a.lead, 'X');
    assert.equal(a.json, true);
    assert.equal(a.batch, true);
  });

  it('does not treat a following flag as a value', () => {
    const a = searchLead.parseArgs(['--lead', '--json']);
    assert.equal(a.lead, true);
    assert.equal(a.json, true);
  });
});

describe('test-harness.js parseTestArgs', () => {
  it('accepts space-separated --ground-truth <file> (the README form)', () => {
    const a = harness.parseTestArgs(['--ground-truth', 'examples/ground-truth.sample.json']);
    assert.equal(a['ground-truth'], 'examples/ground-truth.sample.json');
    assert.equal(a.groundTruth, 'examples/ground-truth.sample.json');
  });

  it('still accepts --key=value form', () => {
    const a = harness.parseTestArgs(['--ground-truth=x.json', '--compare-engine-profiles']);
    assert.equal(a['ground-truth'], 'x.json');
    assert.equal(a['compare-engine-profiles'], true);
    assert.equal(a.compareEngineProfiles, true);
  });
});

describe('SQL input validation', () => {
  it('assertLeadId accepts plain integers', () => {
    assert.equal(searchLead.assertLeadId('1010'), '1010');
    assert.equal(searchLead.assertLeadId(42), '42');
  });

  it('assertLeadId rejects SQL injection attempts', () => {
    for (const bad of ['1; DROP TABLE leadops_leads', "1' OR '1'='1", '', '10 OR 1=1']) {
      assert.throws(() => searchLead.assertLeadId(bad), /unsafe lead ID/);
    }
  });

  it('assertStatusToken accepts simple words', () => {
    assert.equal(searchLead.assertStatusToken('research'), 'research');
    assert.equal(harness.assertStatusToken('ready'), 'ready');
  });

  it('assertStatusToken rejects SQL injection attempts', () => {
    assert.throws(() => searchLead.assertStatusToken("a' OR '1'='1"), /unsafe status/);
    assert.throws(() => harness.assertStatusToken('x; DROP TABLE y'), /unsafe status/);
  });
});

describe('querySQLite (no-shell sqlite3 invocation)', () => {
  it('runs queries and returns rows', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-test-')), 'leads.db');
    execFileSync('sqlite3', [dbPath, 'CREATE TABLE t(id INTEGER, name TEXT); INSERT INTO t VALUES (1, \'Acme\');']);
    const rows = searchLead.querySQLite(dbPath, 'SELECT id, name FROM t WHERE id = 1');
    assert.deepEqual(rows, ['1|Acme']);
  });

  it('handles db paths containing spaces (argv array, no shell quoting)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms test dir-'));
    const dbPath = path.join(dir, 'my leads.db');
    execFileSync('sqlite3', [dbPath, 'CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (7);']);
    const rows = searchLead.querySQLite(dbPath, 'SELECT id FROM t');
    assert.deepEqual(rows, ['7']);
  });

  it('does not execute shell metacharacters in the db path', () => {
    const marker = path.join(os.tmpdir(), 'ms-pwned-marker');
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    assert.throws(() => searchLead.querySQLite(`"; touch ${marker}; echo "`, 'select 1'));
    assert.equal(fs.existsSync(marker), false, 'shell command must not have run');
  });

  it('surfaces sqlite errors as Error', () => {
    assert.throws(() => searchLead.querySQLite('/tmp/does-not-exist-dir/x.db', 'select 1'), /SQLite query failed/);
  });
});
