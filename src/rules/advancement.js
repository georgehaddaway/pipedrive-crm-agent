import config from '../config/index.js';

/**
 * Evaluate which contacts should be auto-advanced to a new stage.
 * 
 * Auto-advancement rules:
 * - Stages 1-3 (initial_outreach, follow_up, breakup): fully automated on no-reply after max attempts
 * - Reply detected from stages 1-3 or on_hold: auto-advance to engaged
 * - Stages 4+ (engaged onward): NEVER auto-advanced, flag only
 *
 * @param {Object[]} contacts - Enriched contacts with outreach attempt counts
 * @param {Map<string, string|null>} gmailActivity - Map of email -> last email ISO date
 * @returns {Object[]} Array of advancement actions: { contact, fromStage, toStage, trigger, action }
 */
export function evaluateAdvancements(contacts, gmailActivity) {
  if (!config.rules.auto_stage_advancement?.enabled) return [];

  const rules = config.rules.auto_stage_advancement.rules;
  const advancements = [];

  for (const contact of contacts) {
    for (const rule of rules) {
      const applicable = isRuleApplicable(rule, contact, gmailActivity);
      if (!applicable) continue;

      advancements.push({
        contact,
        fromStage: contact.stage,
        toStage: rule.to,
        trigger: rule.trigger,
        action: rule.action,
      });

      // Only one advancement per contact per run
      break;
    }
  }

  return advancements;
}

/**
 * Check if an advancement rule applies to a contact.
 * @param {Object} rule
 * @param {Object} contact
 * @param {Map<string, string|null>} gmailActivity
 * @returns {boolean}
 */
function isRuleApplicable(rule, contact, gmailActivity) {
  // Check if contact is in the right source stage
  const fromStages = Array.isArray(rule.from) ? rule.from : [rule.from];
  if (!fromStages.includes(contact.stage)) return false;

  if (rule.trigger === 'no_reply_after_max_attempts') {
    return checkNoReplyMaxAttempts(contact);
  }

  if (rule.trigger === 'reply_detected') {
    return checkReplyDetected(contact, gmailActivity);
  }

  return false;
}

/**
 * Check if a contact has exhausted max attempts with no reply.
 * @param {Object} contact
 * @returns {boolean}
 */
function checkNoReplyMaxAttempts(contact) {
  const attemptLimit = config.rules.attempt_limits[contact.stage];
  if (attemptLimit === null || attemptLimit === undefined) return false;

  const attempts = contact.outreachAttempts || 0;

  // Must have reached or exceeded the limit
  if (attempts < attemptLimit) return false;

  // Must not have received a recent reply
  // If they have a recent inbound date after the last outbound, they replied
  if (contact.lastInboundDate && contact.lastOutboundDate) {
    const inbound = new Date(contact.lastInboundDate);
    const outbound = new Date(contact.lastOutboundDate);
    if (inbound > outbound) return false; // They replied
  }

  return true;
}

/**
 * Check if a reply has been detected for a contact.
 * A reply is detected when Gmail shows inbound activity from the contact
 * that is more recent than the last outbound email.
 * @param {Object} contact
 * @param {Map<string, string|null>} gmailActivity
 * @returns {boolean}
 */
function checkReplyDetected(contact, gmailActivity) {
  // Check Gmail for recent activity
  const gmailDate = gmailActivity.get(contact.email);
  if (!gmailDate) return false;

  // If we have both inbound and outbound dates, check if inbound is more recent
  if (contact.lastOutboundDate) {
    const gmailActivityDate = new Date(gmailDate);
    const lastOutbound = new Date(contact.lastOutboundDate);
    return gmailActivityDate > lastOutbound;
  }

  // If we have a last inbound date on the contact, that counts
  if (contact.lastInboundDate) return true;

  return false;
}

/**
 * Apply a stage advancement to Pipedrive.
 * Updates the deal stage, resets outreach attempts, and logs an activity note.
 *
 * @param {Object} advancement - { contact, fromStage, toStage, trigger, action }
 * @param {Object} pipedriveClient - Pipedrive API client with update methods
 * @returns {Promise<boolean>} Success
 */
export async function applyAdvancement(advancement, pipedriveClient) {
  const { contact, fromStage, toStage, trigger } = advancement;
  const dealId = contact.meta?.dealId;

  if (!dealId) {
    console.warn(`  Cannot advance ${contact.email}: no deal ID`);
    return false;
  }

  try {
    // 1. Update deal stage
    const newStageId = config.getPipedriveStageId(toStage);
    if (!newStageId) {
      console.error(`  Cannot advance ${contact.email}: no Pipedrive ID for stage '${toStage}'`);
      return false;
    }

    await pipedriveClient.updateDealStage(dealId, newStageId);

    // 2. Reset outreach attempts
    if (contact.id) {
      await pipedriveClient.updatePersonField(contact.id, 'outreach_attempts', 0);
    }

    // 3. Log activity note
    const noteText = `[CRM Agent] Auto-advanced from "${fromStage}" to "${toStage}" (trigger: ${trigger})`;
    await pipedriveClient.addActivityNote(dealId, noteText);

    console.log(`  Stage advanced: ${contact.email} ${fromStage} → ${toStage} (${trigger})`);
    return true;
  } catch (err) {
    console.error(`  Stage advancement failed for ${contact.email}: ${err.message}`);
    return false;
  }
}

/**
 * Generate summary flags for contacts that are near max attempts but not yet advanced.
 * These are "breakup pending" flags for the daily summary.
 * @param {Object[]} contacts
 * @returns {Object[]}
 */
export function detectBreakupPending(contacts) {
  const flags = [];

  for (const contact of contacts) {
    if (contact.stage !== 'follow_up') continue;

    const attemptLimit = config.rules.attempt_limits.follow_up;
    const attempts = contact.outreachAttempts || 0;

    if (attempts >= attemptLimit) {
      flags.push({
        contact,
        flag: {
          id: 'breakup_pending',
          label: 'Breakup email queued',
          detail: `${attempts}/${attemptLimit} attempts exhausted in follow_up`,
        },
      });
    }
  }

  return flags;
}

/**
 * Detect hot leads (due_diligence stage with recent activity).
 * @param {Object[]} contacts
 * @returns {Object[]}
 */
export function detectHotLeads(contacts) {
  const flags = [];
  const now = new Date();

  for (const contact of contacts) {
    if (contact.stage !== 'due_diligence') continue;

    const lastActivity = contact.lastContactDate || contact.lastOutboundDate;
    if (!lastActivity) continue;

    const days = Math.floor((now - new Date(lastActivity)) / (1000 * 60 * 60 * 24));
    if (days < 7) {
      flags.push({
        contact,
        flag: {
          id: 'hot_lead',
          label: 'High-priority — due diligence active',
          detail: `Last activity ${days} day${days === 1 ? '' : 's'} ago`,
        },
      });
    }
  }

  return flags;
}
