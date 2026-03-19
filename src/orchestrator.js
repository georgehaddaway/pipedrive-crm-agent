import { mkdirSync, writeFileSync } from 'fs';
import config from './config/index.js';
import { getContacts, getDataSource, pipedriveWriter } from './api/pipedrive.js';
import { batchGetLastEmailDates, createDraft } from './gmail/client.js';
import { evaluateContacts, detectStaleContacts } from './rules/engine.js';
import { evaluateAdvancements, applyAdvancement, detectBreakupPending, detectHotLeads } from './rules/advancement.js';
import { evaluateIntroducerNudges } from './rules/introducer.js';
import { renderEmail } from './templates/router.js';
import { postSummary, postError } from './summary/builder.js';

/**
 * Run the full pipeline: fetch contacts, evaluate rules, advance stages,
 * draft emails, collect flags, notify Slack.
 *
 * @param {Object} options
 * @param {boolean} [options.dryRun=false] - If true, skip Gmail draft creation, Slack posting, and stage writes
 * @param {boolean} [options.verbose=false] - If true, log detailed output
 * @returns {Promise<Object>} RunReport
 */
export async function runPipeline(options = {}) {
  const { dryRun = false, verbose = false } = options;
  const startTime = Date.now();
  const errors = [];

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Pipedrive CRM Agent - ${dryRun ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Data source: ${getDataSource()}`);
  console.log(`  Pipeline: ${config.pipeline.pipeline.name} (ID: ${config.pipedrive.pipelineId})`);
  console.log(`${'='.repeat(60)}\n`);

  // ── Step 1: Fetch contacts ────────────────────────
  console.log('Step 1/7: Fetching contacts...');
  let contacts;
  try {
    contacts = await getContacts();
    console.log(`  Found ${contacts.length} contacts.`);
  } catch (err) {
    console.error(`  Failed to fetch contacts: ${err.message}`);
    errors.push(`Contact fetch failed: ${err.message}`);
    return buildReport([], [], [], [], [], dryRun, errors);
  }

  if (contacts.length === 0) {
    console.log('  No contacts found. Nothing to do.');
    return buildReport(contacts, [], [], [], [], dryRun, errors);
  }

  // ── Step 2: Check Gmail activity ──────────────────
  console.log('Step 2/7: Checking Gmail activity...');
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
  console.log('Step 3/7: Evaluating follow-up rules...');
  const followUps = evaluateContacts(contacts, gmailActivity);
  console.log(`  ${followUps.length} contacts need follow-up (max ${config.rules.global_defaults.max_drafts_per_run} per run).`);

  if (verbose && followUps.length > 0) {
    console.log('\n  Follow-ups:');
    for (const fu of followUps) {
      console.log(`    [${fu.urgencyScore.toFixed(2)}] ${fu.contact.firstName} ${fu.contact.lastName} (${fu.contact.email})`);
      console.log(`           ${fu.reason}`);
    }
    console.log('');
  }

  // ── Step 4: Evaluate stage advancements ───────────
  console.log('Step 4/7: Evaluating stage advancements...');
  const pendingAdvancements = evaluateAdvancements(contacts, gmailActivity);
  console.log(`  ${pendingAdvancements.length} stage advancement(s) identified.`);

  const appliedAdvancements = [];
  if (!dryRun && pendingAdvancements.length > 0) {
    for (const advancement of pendingAdvancements) {
      const success = await applyAdvancement(advancement, pipedriveWriter);
      if (success) appliedAdvancements.push(advancement);
    }
    console.log(`  Applied ${appliedAdvancements.length}/${pendingAdvancements.length} advancement(s).`);
  } else if (dryRun && pendingAdvancements.length > 0) {
    console.log('  [DRY RUN] Would advance:');
    for (const a of pendingAdvancements) {
      console.log(`    ${a.contact.firstName} ${a.contact.lastName}: ${a.fromStage} → ${a.toStage} (${a.trigger})`);
    }
  }

  // ── Step 5: Render and create drafts ──────────────
  console.log('Step 5/7: Rendering emails and creating drafts...');
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

          // Auto-increment outreach attempts and update last outbound date
          if (contact.id && config.pipedrive.useApi) {
            const newAttempts = (contact.outreachAttempts || 0) + 1;
            const today = new Date().toISOString().split('T')[0];
            await pipedriveWriter.updatePersonField(contact.id, 'Outreach Attempts', newAttempts);
            await pipedriveWriter.updatePersonField(contact.id, 'Last Outbound Date', today);
            console.log(`  Outreach attempts: ${newAttempts}, last outbound: ${today}`);
          }
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

  // ── Step 6: Collect flags ─────────────────────────
  console.log('Step 6/7: Collecting flags...');
  const allFlags = [
    ...evaluateIntroducerNudges(contacts, gmailActivity),
    ...detectStaleContacts(contacts),
    ...detectBreakupPending(contacts),
    ...detectHotLeads(contacts),
  ];
  console.log(`  ${allFlags.length} flag(s) generated.`);

  if (verbose && allFlags.length > 0) {
    for (const f of allFlags) {
      console.log(`    [${f.flag.id}] ${f.flag.detail}`);
    }
  }

  // ── Step 7: Slack summary ─────────────────────────
  console.log('Step 7/7: Posting Slack summary...');
  if (!dryRun) {
    try {
      await postSummary(followUps, drafts, allFlags, appliedAdvancements, dryRun);
    } catch (err) {
      console.warn(`  Slack post failed: ${err.message}`);
      errors.push(`Slack post failed: ${err.message}`);
    }
  } else {
    console.log('  Skipped (dry run).');
  }

  // ── Save run report ───────────────────────────────
  const report = buildReport(contacts, followUps, drafts, allFlags, appliedAdvancements, dryRun, errors);
  try {
    saveRunReport(report);
  } catch (err) {
    console.warn(`  Failed to save run report: ${err.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Complete in ${elapsed}s. ${errors.length > 0 ? `${errors.length} error(s).` : 'No errors.'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Alert on errors
  if (errors.length > 0 && !dryRun) {
    await postError('Pipeline Run', errors);
  }

  return report;
}

/**
 * Build a structured run report.
 */
function buildReport(contacts, followUps, drafts, flags, advancements, dryRun, errors) {
  return {
    timestamp: new Date().toISOString(),
    totalContacts: contacts.length,
    followUpsIdentified: followUps.length,
    draftsCreated: drafts.filter(d => d.created).length,
    stageAdvancements: advancements.length,
    flagsGenerated: flags.length,
    followUps: followUps.map(fu => ({
      ...fu,
      contact: {
        id: fu.contact.id,
        firstName: fu.contact.firstName,
        lastName: fu.contact.lastName,
        email: fu.contact.email,
        stage: fu.contact.stage,
        priority: fu.contact.priority,
        leadSource: fu.contact.leadSource,
      },
      stageConfig: undefined, // Don't serialize full config
    })),
    drafts,
    flags: flags.map(f => ({
      contactEmail: f.contact.email,
      contactName: `${f.contact.firstName} ${f.contact.lastName}`,
      ...f.flag,
    })),
    advancements: advancements.map(a => ({
      contactEmail: a.contact.email,
      fromStage: a.fromStage,
      toStage: a.toStage,
      trigger: a.trigger,
    })),
    dryRun,
    errors,
  };
}

/**
 * Save a JSON run report to data/runs/.
 */
function saveRunReport(report) {
  mkdirSync(config.paths.runsDir, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}.json`;
  const filepath = `${config.paths.runsDir}/${filename}`;
  writeFileSync(filepath, JSON.stringify(report, null, 2));
  console.log(`  Run report saved to ${filepath}`);
}
