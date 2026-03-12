import config from '../config.js';

/**
 * Evaluate all contacts against follow-up rules and Gmail activity.
 *
 * @param {import('../jsq/types.js').Contact[]} contacts
 * @param {Map<string, string|null>} gmailActivity - Map of email -> last email ISO date
 * @returns {import('../jsq/types.js').FollowUp[]}
 */
export function evaluateContacts(contacts, gmailActivity) {
  const { stages, priorityOverrides, globalExclusions } = config.rules;
  const now = new Date();
  const followUps = [];

  for (const contact of contacts) {
    // Skip excluded contacts
    if (shouldExclude(contact, globalExclusions)) continue;

    const stageRule = stages[contact.stage];
    if (!stageRule || stageRule.followUpDays === null) continue;

    // Determine last contact date: prefer Gmail data, fall back to CRM data
    const gmailDate = gmailActivity.get(contact.email);
    const lastContactStr = gmailDate || contact.lastContactDate;

    if (!lastContactStr) {
      // Never contacted - always flag for follow-up
      followUps.push(createFollowUp(contact, stageRule, Infinity, now));
      continue;
    }

    const lastContact = new Date(lastContactStr);
    const daysSince = Math.floor((now - lastContact) / (1000 * 60 * 60 * 24));

    // Apply priority multiplier to threshold
    const priorityConfig = priorityOverrides[contact.priority] || { multiplier: 1 };
    const adjustedThreshold = Math.round(stageRule.followUpDays * priorityConfig.multiplier);

    if (daysSince >= adjustedThreshold) {
      followUps.push(createFollowUp(contact, stageRule, daysSince, now));
    }
  }

  // Sort by urgency (most urgent first)
  followUps.sort((a, b) => b.urgencyScore - a.urgencyScore);

  return followUps;
}

/**
 * Check if a contact should be excluded from follow-ups.
 * @param {import('../jsq/types.js').Contact} contact
 * @param {Object} exclusions
 * @returns {boolean}
 */
function shouldExclude(contact, exclusions) {
  if (!contact.email) return true;

  if (exclusions.doNotContactTags && contact.tags) {
    const hasExcludedTag = contact.tags.some(tag =>
      exclusions.doNotContactTags.includes(tag.toLowerCase())
    );
    if (hasExcludedTag) return true;
  }

  return false;
}

/**
 * Create a FollowUp object from evaluation results.
 * @param {import('../jsq/types.js').Contact} contact
 * @param {Object} stageRule
 * @param {number} daysSince
 * @param {Date} now
 * @returns {import('../jsq/types.js').FollowUp}
 */
function createFollowUp(contact, stageRule, daysSince, now) {
  // Calculate urgency score (0-10)
  // Higher when: more days overdue, higher priority, fewer remaining attempts
  let urgency = 5;

  // Days overdue factor
  if (daysSince === Infinity) {
    urgency += 2; // Never contacted is fairly urgent
  } else {
    const overdueDays = daysSince - stageRule.followUpDays;
    urgency += Math.min(overdueDays * 0.5, 3);
  }

  // Priority factor
  if (contact.priority === 'high') urgency += 2;
  if (contact.priority === 'low') urgency -= 2;

  urgency = Math.max(0, Math.min(10, Math.round(urgency)));

  const reason = daysSince === Infinity
    ? `Never contacted. Stage: ${contact.stage}`
    : `${daysSince} days since last contact (threshold: ${stageRule.followUpDays}). Stage: ${contact.stage}`;

  return {
    contact,
    reason,
    daysSinceLastContact: daysSince === Infinity ? -1 : daysSince,
    urgencyScore: urgency,
    templateName: stageRule.templateName,
    attemptNumber: 1, // Could be enhanced with run history tracking
  };
}
