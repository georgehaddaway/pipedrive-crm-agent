import { mkdirSync, writeFileSync } from 'fs';
import config from './config.js';
import { getContacts, getDataSource } from './pipedrive/client.js';
import { batchGetLastEmailDates, createDraft } from './gmail/client.js';
import { evaluateContacts } from './engine/rules.js';
import { renderEmail } from './engine/templates.js';
import { postSummary } from './slack/notifier.js';

/**
 * Run the full pipeline: fetch contacts, evaluate rules, draft emails, notify Slack.
 *
 * @param {Object} options
 * @param {boolean} [options.dryRun=false] - If true, skip Gmail draft creation and Slack posting
 * @param {boolean} [options.verbose=false] - If true, log detailed output
 * @returns {Promise<import('./pipedrive/types.js').RunReport>}
 */
export async function runPipeline(options = {}) {
  const { dryRun = false, verbose = false } = options;
  const startTime = Date.now();
  const errors = [];

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Pipedrive CRM Agent - ${dryRun ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Data source: ${getDataSource()}`);
  console.log(`${'='.repeat(60)}\n`);

  // ── Step 1: Fetch contacts ────────────────────────
  console.log('Step 1/5: Fetching contacts...');
  let contacts;
  try {
    contacts = await getContacts();
    console.log(`  Found ${contacts.length} contacts.`);
  } catch (err) {
    console.error(`  Failed to fetch contacts: ${err.message}`);
    errors.push(`Contact fetch failed: ${err.message}`);
    return buildReport([], [], [], dryRun, errors);
  }

  if (contacts.length === 0) {
    console.log('  No contacts found. Nothing to do.');
    return buildReport(contacts, [], [], dryRun, errors);
  }

  // ── Step 2: Check Gmail activity ──────────────────
  console.log('Step 2/5: Checking Gmail activity...');
  let gmailActivity = new Map();

  if (!dryRun && config.gmail.clientId) {
    try {
      const emails = contacts.map(c => c.email).filter(Boolean);
      gmailActivity = await batchGetLastEmailDates(emails);
      const found = [...gmailActivity.values()].filter(Boolean).length;
      console.log(`  Checked ${emails.length} contacts, found Gmail history for ${found}.`);
    } catch (err) {
      console.warn(`  Gmail activity check failed: ${err.message}`);
      console.warn('  Falling back to CRM-only last contact dates.');
      errors.push(`Gmail activity check failed: ${err.message}`);
    }
  } else if (dryRun) {
    console.log('  Skipped (dry run - using CRM dates only).');
  } else {
    console.log('  Skipped (Gmail not configured).');
  }

  // ── Step 3: Evaluate follow-up rules ──────────────
  console.log('Step 3/5: Evaluating follow-up rules...');
  const followUps = evaluateContacts(contacts, gmailActivity);
  console.log(`  ${followUps.length} contacts need follow-up.`);

  if (verbose && followUps.length > 0) {
    console.log('\n  Follow-ups:');
    for (const fu of followUps) {
      console.log(`    [${fu.urgencyScore}/10] ${fu.contact.firstName} ${fu.contact.lastName} (${fu.contact.email})`);
      console.log(`           ${fu.reason}`);
    }
    console.log('');
  }

  if (followUps.length === 0) {
    console.log('  No follow-ups needed. Pipeline is clean.');
    return buildReport(contacts, followUps, [], dryRun, errors);
  }

  // ── Step 4: Render and create drafts ──────────────
  console.log('Step 4/5: Rendering emails and creating drafts...');
  /** @type {import('./pipedrive/types.js').DraftResult[]} */
  const drafts = [];

  for (const followUp of followUps) {
    const { contact } = followUp;

    try {
      const { subject, body } = await renderEmail(followUp);

      if (verbose || dryRun) {
        console.log(`\n  --- Draft for ${contact.firstName} ${contact.lastName} ---`);
        console.log(`  To: ${contact.email}`);
        console.log(`  Subject: ${subject}`);
        if (dryRun) {
          console.log(`  Body preview: ${body.slice(0, 150)}...`);
        }
      }

      let draftId = '';
      let created = false;

      if (!dryRun) {
        try {
          draftId = await createDraft(contact.email, subject, body);
          created = true;
          console.log(`  Draft created for ${contact.email} (ID: ${draftId})`);
        } catch (err) {
          console.error(`  Failed to create draft for ${contact.email}: ${err.message}`);
          errors.push(`Draft failed for ${contact.email}: ${err.message}`);
        }
      } else {
        console.log(`  [DRY RUN] Would create draft for ${contact.email}`);
      }

      drafts.push({
        contactId: contact.id,
        contactEmail: contact.email,
        contactName: `${contact.firstName} ${contact.lastName}`,
        subject,
        draftId,
        created,
      });
    } catch (err) {
      console.error(`  Template render failed for ${contact.email}: ${err.message}`);
      errors.push(`Template render failed for ${contact.email}: ${err.message}`);
    }
  }

  const createdCount = drafts.filter(d => d.created).length;
  console.log(`\n  ${dryRun ? 'Would create' : 'Created'} ${dryRun ? drafts.length : createdCount} drafts.`);

  // ── Step 5: Slack summary ─────────────────────────
  console.log('Step 5/5: Posting Slack summary...');
  if (!dryRun) {
    try {
      await postSummary(followUps, drafts, dryRun);
    } catch (err) {
      console.warn(`  Slack post failed: ${err.message}`);
      errors.push(`Slack post failed: ${err.message}`);
    }
  } else {
    console.log('  Skipped (dry run).');
  }

  // ── Save run report ───────────────────────────────
  const report = buildReport(contacts, followUps, drafts, dryRun, errors);
  try {
    saveRunReport(report);
  } catch (err) {
    console.warn(`  Failed to save run report: ${err.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Complete in ${elapsed}s. ${errors.length > 0 ? `${errors.length} error(s).` : 'No errors.'}`);
  console.log(`${'='.repeat(60)}\n`);

  return report;
}

/**
 * @param {import('./pipedrive/types.js').Contact[]} contacts
 * @param {import('./pipedrive/types.js').FollowUp[]} followUps
 * @param {import('./pipedrive/types.js').DraftResult[]} drafts
 * @param {boolean} dryRun
 * @param {string[]} errors
 * @returns {import('./pipedrive/types.js').RunReport}
 */
function buildReport(contacts, followUps, drafts, dryRun, errors) {
  return {
    timestamp: new Date().toISOString(),
    totalContacts: contacts.length,
    followUpsIdentified: followUps.length,
    draftsCreated: drafts.filter(d => d.created).length,
    followUps: followUps.map(fu => ({
      ...fu,
      contact: {
        id: fu.contact.id,
        firstName: fu.contact.firstName,
        lastName: fu.contact.lastName,
        email: fu.contact.email,
        stage: fu.contact.stage,
        priority: fu.contact.priority,
      },
    })),
    drafts,
    dryRun,
    errors,
  };
}

/**
 * Save a JSON run report to data/runs/.
 * @param {import('./pipedrive/types.js').RunReport} report
 */
function saveRunReport(report) {
  mkdirSync(config.paths.runsDir, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}.json`;
  const filepath = `${config.paths.runsDir}/${filename}`;
  writeFileSync(filepath, JSON.stringify(report, null, 2));
  console.log(`  Run report saved to ${filepath}`);
}
