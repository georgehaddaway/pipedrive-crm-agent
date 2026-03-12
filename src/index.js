import cron from 'node-cron';
import config from './config.js';
import { runPipeline } from './orchestrator.js';

// ── Parse CLI flags ─────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes('--dry-run'),
  schedule: args.includes('--schedule'),
  verbose: args.includes('--verbose') || args.includes('-v'),
  help: args.includes('--help') || args.includes('-h'),
};

if (flags.help) {
  console.log(`
JSQ CRM Agent - Automated Investor Follow-Up Pipeline

Usage:
  node src/index.js [options]

Options:
  --dry-run     Preview follow-ups and email drafts without creating Gmail drafts or posting to Slack
  --schedule    Run on a cron schedule (default: ${config.cron})
  --verbose     Show detailed output including email previews
  --help        Show this help message

Setup:
  1. Copy .env.example to .env and fill in credentials
  2. Run 'npm run auth' to complete Gmail OAuth
  3. Place contacts in data/jsq-export.csv (or configure JSQ API)
  4. Run 'npm run dry-run' to preview
  5. Run 'npm start' for scheduled operation
`);
  process.exit(0);
}

// ── Run ─────────────────────────────────────────────
async function main() {
  if (flags.schedule) {
    console.log(`Starting scheduled mode: "${config.cron}"`);
    console.log('Press Ctrl+C to stop.\n');

    // Run once immediately on start
    await runPipeline({ dryRun: flags.dryRun, verbose: flags.verbose });

    // Then schedule
    cron.schedule(config.cron, async () => {
      console.log(`\n[${new Date().toISOString()}] Scheduled run triggered.`);
      await runPipeline({ dryRun: flags.dryRun, verbose: flags.verbose });
    });
  } else {
    // Single run
    const report = await runPipeline({ dryRun: flags.dryRun, verbose: flags.verbose });

    if (report.errors.length > 0) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
