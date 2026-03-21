#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Pipedrive CRM Agent — Launch Agent Wrapper
//
// This script is called by launchd every 10 minutes while
// the Mac is awake. It is idempotent:
//   1. Skips if outside business hours (before 7 AM or after 9 PM)
//   2. Skips weekends
//   3. Skips if today's run file already exists
//   4. Auto-pulls from git and installs deps before running
//
// The 10-minute interval ensures the agent runs shortly after
// the Mac wakes from sleep, even if it missed the 7 AM window.
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
const hour = now.getHours(); // local time
const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

// ── Skip outside business hours ────────────────────────
if (hour < 7 || hour >= 21) {
  process.exit(0); // Silent exit — no log spam overnight
}

// ── Skip weekends ──────────────────────────────────────
if (day === 0 || day === 6) {
  process.exit(0); // Silent exit — no log spam on weekends
}

// ── Skip if today's run already completed ──────────────
const runFile = join(RUNS_DIR, `${today}.json`);
if (existsSync(runFile)) {
  process.exit(0); // Silent exit — already ran today
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
