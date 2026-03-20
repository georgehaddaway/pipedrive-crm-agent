#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Pipedrive CRM Agent — Launch Agent Wrapper
//
// This script is called by launchd. It is idempotent:
//   1. Skips weekends
//   2. Skips if today's run file already exists
//   3. Auto-pulls from git and installs deps before running
//
// Safe to trigger on both schedule (7 AM) and login (RunAtLoad).
// ──────────────────────────────────────────────────────────

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const RUNS_DIR = join(PROJECT_DIR, 'data', 'runs');

const now = new Date();
const day = now.getDay(); // 0=Sun, 6=Sat
const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

// ── Skip weekends ──────────────────────────────────────
if (day === 0 || day === 6) {
  console.log(`[${now.toISOString()}] Skipping: weekend.`);
  process.exit(0);
}

// ── Skip if today's run already completed ──────────────
const runFile = join(RUNS_DIR, `${today}.json`);
if (existsSync(runFile)) {
  console.log(`[${now.toISOString()}] Skipping: today's run (${today}) already exists.`);
  process.exit(0);
}

console.log('============================================');
console.log(`Agent run started: ${now.toISOString()}`);
console.log('============================================');

// ── Auto-update from GitHub ────────────────────────────
try {
  const pullOutput = execSync('git pull origin main --ff-only', {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    timeout: 30_000,
  });
  console.log('Git pull:', pullOutput.trim());
} catch (err) {
  console.log('Warning: git pull failed. Running with existing code.');
}

// ── Install dependencies ───────────────────────────────
try {
  execSync('npm install --production', {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    timeout: 60_000,
  });
  console.log('Dependencies checked.');
} catch (err) {
  console.log('Warning: npm install failed. Running with existing deps.');
}

// ── Run the agent ──────────────────────────────────────
console.log('Starting agent...');
const { runPipeline } = await import('../src/orchestrator.js');
const { postError } = await import('../src/summary/builder.js');

try {
  const report = await runPipeline({ dryRun: false, verbose: false });
  if (report.errors.length > 0) {
    process.exit(1);
  }
} catch (err) {
  console.error('Fatal error:', err);
  await postError('Fatal Crash', [err.message || String(err)]);
  process.exit(1);
}
