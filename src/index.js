import config from './config/index.js';
import { runPipeline } from './orchestrator.js';
import { postError } from './summary/builder.js';

// ── Parse CLI flags ─────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes('--dry-run'),
  verbose: args.includes('--verbose') || args.includes('-v'),
  help: args.includes('--help') || args.includes('-h'),
};

if (flags.help) {
  console.log(`
Pipedrive CRM Agent - Automated Investor Follow-Up Pipeline

Usage:
  node src/index.js [options]

Options:
  --dry-run     Preview follow-ups and email drafts without creating Gmail drafts or posting to Slack
  --verbose     Show detailed output including email previews
  --help        Show this help message

Scheduling:
  The agent runs once and exits. Use macOS launchd for recurring runs:
    bash scripts/launchd-setup.sh install     Install scheduled agent
    bash scripts/launchd-setup.sh uninstall   Remove scheduled agent
    bash scripts/launchd-setup.sh status      Check schedule status

Setup:
  1. Copy .env.example to .env and fill in credentials
  2. Set PIPEDRIVE_API_TOKEN and PIPEDRIVE_COMPANY_DOMAIN (or use CSV fallback)
  3. Run 'npm run auth' to complete Gmail OAuth
  4. Run 'npm run dry-run' to preview
  5. Run 'npm run setup-schedule' to install the macOS Launch Agent
`);
  process.exit(0);
}

// ── Run ─────────────────────────────────────────────
async function main() {
  const report = await runPipeline({ dryRun: flags.dryRun, verbose: flags.verbose });

  if (report.errors.length > 0) {
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await postError('Fatal Crash', [err.message || String(err)]);
  process.exit(1);
});
