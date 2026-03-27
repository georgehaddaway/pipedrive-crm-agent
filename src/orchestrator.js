import { mkdirSync, writeFileSync } from 'fs';
import config from './config/index.js';
import { getContacts, getDataSource, pipedriveWriter, getPersonNotes } from './api/pipedrive.js';
import { batchGetLastEmailDates, batchGetRecentThreads, createDraft, getExistingDraftsForContacts } from './gmail/client.js';
import { evaluateContacts, detectStaleContacts } from './rules/engine.js';
import { evaluateAdvancements, applyAdvancement, detectBreakupPending, detectHotLeads } from './rules/advancement.js';
import { evaluateIntroducerNudges } from './rules/introducer.js';
import { renderEmail } from './templates/router.js';
import { postSummary, postError } from './summary/builder.js';
import { enrichContact } from './enrichment/enrichment.js';
import { loadPreviousDealStates, saveDealStates, detectDealChanges } from './rules/deal-state.js';

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

  // ── Step 1b: Detect deal changes ──────────────────
  console.log('Step 1b: Detecting deal changes...');
  let dealChanges = { newDeals: [], stageChanges: [] };
  try {
    const previousStates = loadPreviousDealStates();
    dealChanges = detectDealChanges(contacts, previousStates);
    const totalChanges = dealChanges.newDeals.length + dealChanges.stageChanges.length;
    if (totalChanges > 0) {
      console.log(`  Detected ${dealChanges.newDeals.length} new deal(s), ${dealChanges.stageChanges.length} stage change(s).`);
      if (verbose) {
        for (const c of dealChanges.newDeals) {
          console.log(`    [NEW] ${c.firstName} ${c.lastName} (${c.email}) in ${c.stage}`);
        }
        for (const sc of dealChanges.stageChanges) {
          console.log(`    [MOVED] ${sc.contact.firstName} ${sc.contact.lastName}: ${sc.fromStage} -> ${sc.toStage}`);
        }
      }
    } else {
      console.log('  No deal changes detected since last run.');
    }
  } catch (err) {
    console.warn(`  Deal change detection failed: ${err.message}`);
    errors.push(`Deal change detection failed: ${err.message}`);
  }

  // ── Step 1c: Create tasks for deal changes ────────
  if (!dryRun && config.pipedrive.useApi) {
    const changedContacts = [
      ...dealChanges.newDeals,
      ...dealChanges.stageChanges.map(sc => sc.contact),
    ];

    if (changedContacts.length > 0) {
      console.log('Step 1c: Creating tasks for deal changes...');
      let tasksCreated = 0;

      for (const contact of changedContacts) {
        // Skip excluded stages (committed, etc.) and contacts without deals
        const stageConfig = config.getStageByKey(contact.stage);
        if (!stageConfig || stageConfig.follow_up.threshold_days === null) continue;
        if (!contact.meta?.dealId) continue;

        // Skip contacts with excluded tags
        const excludedTags = config.rules.exclusions.tags || [];
        const hasExcludedTag = contact.tags?.some(t => excludedTags.includes(t.toLowerCase()));
        if (hasExcludedTag) continue;

        try {
          const activityId = await pipedriveWriter.createFollowUpReminder(contact);
          if (activityId) {
            tasksCreated++;
            console.log(`  Task created for ${contact.firstName} ${contact.lastName} in ${contact.stage} (activity ID: ${activityId})`);
          }
        } catch (err) {
          console.warn(`  Task creation failed for ${contact.email}: ${err.message}`);
        }
      }

      if (tasksCreated > 0) {
        console.log(`  Created ${tasksCreated} task(s) for deal changes.`);
      }
    }
  } else if (dryRun && (dealChanges.newDeals.length > 0 || dealChanges.stageChanges.length > 0)) {
    const total = dealChanges.newDeals.length + dealChanges.stageChanges.length;
    console.log(`Step 1c: [DRY RUN] Would create tasks for ${total} deal change(s).`);
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

  // ── Step 2b: Sync Last Outbound Date for new contacts ──
  if (!dryRun && config.pipedrive.useApi && gmailActivity.size > 0) {
    let synced = 0;
    for (const contact of contacts) {
      // Only sync contacts with no lastOutboundDate but with Gmail history
      if (contact.lastOutboundDate) continue;
      const gmailDate = gmailActivity.get(contact.email);
      if (!gmailDate) continue;

      const d = new Date(gmailDate);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      try {
        await pipedriveWriter.updatePersonField(contact.id, 'Last Outbound Date', dateStr);
        synced++;
      } catch { /* non-critical, skip */ }
    }
    if (synced > 0) {
      console.log(`  Synced Last Outbound Date for ${synced} new contact(s).`);
    }
  }

  // ── Step 2c: Check for existing unsent drafts ─────
  let contactsWithDrafts = new Set();
  if (!dryRun && config.gmail.clientId) {
    console.log('Step 2c: Checking for existing unsent drafts...');
    try {
      const allEmails = contacts.map(c => c.email).filter(Boolean);
      contactsWithDrafts = await getExistingDraftsForContacts(allEmails);
      if (contactsWithDrafts.size > 0) {
        console.log(`  Found existing drafts for ${contactsWithDrafts.size} contact(s) — these will be skipped.`);
      } else {
        console.log('  No existing drafts found.');
      }
    } catch (err) {
      console.warn(`  Draft dedup check failed: ${err.message}`);
      errors.push(`Draft dedup check failed: ${err.message}`);
    }
  }

  // ── Step 3: Evaluate follow-up rules ──────────────
  console.log('Step 3/7: Evaluating follow-up rules...');
  let followUps = evaluateContacts(contacts, gmailActivity);

  // Filter out contacts who already have an unsent draft
  if (contactsWithDrafts.size > 0) {
    const beforeCount = followUps.length;
    followUps = followUps.filter(fu => !contactsWithDrafts.has(fu.contact.email.toLowerCase()));
    const skipped = beforeCount - followUps.length;
    if (skipped > 0) {
      console.log(`  Skipped ${skipped} contact(s) with existing unsent drafts.`);
    }
  }

  console.log(`  ${followUps.length} contacts need follow-up (max ${config.rules.global_defaults.max_drafts_per_run} per run).`);

  if (verbose && followUps.length > 0) {
    console.log('\n  Follow-ups:');
    for (const fu of followUps) {
      console.log(`    [${fu.urgencyScore.toFixed(2)}] ${fu.contact.firstName} ${fu.contact.lastName} (${fu.contact.email})`);
      console.log(`           ${fu.reason}`);
    }
    console.log('');
  }

  // ── Step 3b: Fetch email thread history for follow-ups ──
  let emailThreads = new Map();
  if (!dryRun && config.gmail.clientId && followUps.length > 0) {
    console.log('Step 3b: Fetching email history for follow-up contacts...');
    try {
      const followUpEmails = followUps.map(fu => fu.contact.email).filter(Boolean);
      emailThreads = await batchGetRecentThreads(followUpEmails);
      const withHistory = [...emailThreads.values()].filter(r => r.snippets.length > 0).length;
      const withThread = [...emailThreads.values()].filter(r => r.threadInfo).length;
      console.log(`  Fetched email history for ${withHistory}/${followUpEmails.length} contacts (${withThread} with existing threads).`);
    } catch (err) {
      console.warn(`  Email history fetch failed: ${err.message}`);
      console.warn('  Drafts will be composed without prior correspondence context.');
      errors.push(`Email history fetch failed: ${err.message}`);
    }

    // Attach thread history and threading info to each followUp
    for (const followUp of followUps) {
      const result = emailThreads.get(followUp.contact.email) || { snippets: [], threadInfo: null };
      followUp.emailHistory = result.snippets;
      followUp.threadInfo = result.threadInfo;
    }
  } else if (dryRun) {
    console.log('Step 3b: Skipped email history (dry run).');
  }

  // ── Step 3c: Enrich contacts for AI personalization ──
  if (!dryRun && config.anthropic.enabled && followUps.length > 0) {
    console.log('Step 3c: Enriching contacts for AI personalization...');
    let notesCount = 0;
    let webCount = 0;

    for (const followUp of followUps) {
      const { contact } = followUp;

      // Fetch Pipedrive notes in parallel with web enrichment
      const [pipedriveNotes, webEnrichment] = await Promise.all([
        config.pipedrive.useApi ? getPersonNotes(contact.id) : Promise.resolve(''),
        enrichContact(contact),
      ]);

      followUp.pipedriveNotes = pipedriveNotes;
      followUp.webEnrichment = webEnrichment;

      if (pipedriveNotes) notesCount++;
      if (webEnrichment.webSnippets.length > 0) webCount++;
    }

    console.log(`  Enriched ${followUps.length} contacts: ${notesCount} with Pipedrive notes, ${webCount} with web data.`);
  } else if (dryRun) {
    console.log('Step 3c: Skipped contact enrichment (dry run).');
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
          draftId = await createDraft(contact.email, subject, body, followUp.threadInfo || null);
          created = true;
          const replyMode = followUp.threadInfo ? 'reply-in-thread' : 'standalone';
          console.log(`  Draft created for ${contact.email} (ID: ${draftId}, ${replyMode})`);

          // Auto-increment outreach attempts and update last outbound date
          if (contact.id && config.pipedrive.useApi) {
            const newAttempts = (contact.outreachAttempts || 0) + 1;
            const d = new Date();
            const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            await pipedriveWriter.updatePersonField(contact.id, 'Outreach Attempts', newAttempts);
            await pipedriveWriter.updatePersonField(contact.id, 'Last Outbound Date', today);
            console.log(`  Outreach attempts: ${newAttempts}, last outbound: ${today}`);

            // Create Pipedrive follow-up reminder activity
            const activityId = await pipedriveWriter.createFollowUpReminder(contact);
            if (activityId) {
              console.log(`  Pipedrive reminder created (activity ID: ${activityId})`);
            }
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

  // ── Save deal states for next run ─────────────────
  try {
    saveDealStates(contacts);
  } catch (err) {
    console.warn(`  Failed to save deal states: ${err.message}`);
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
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const filename = `${date}.json`;
  const filepath = `${config.paths.runsDir}/${filename}`;
  writeFileSync(filepath, JSON.stringify(report, null, 2));
  console.log(`  Run report saved to ${filepath}`);
}
