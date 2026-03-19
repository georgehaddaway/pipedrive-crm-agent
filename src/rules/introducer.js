import config from '../config/index.js';

/**
 * Evaluate contacts for introducer re-engagement flags.
 * 
 * Logic:
 * - Contact must have `introducer_person_id` set
 * - Contact must be in a whitelisted stage (engaged, post_meeting, due_diligence)
 * - Contact must have been silent for > 21 days
 * 
 * This NEVER auto-emails the introducer. It produces flags for the daily summary only.
 *
 * @param {Object[]} contacts
 * @param {Map<string, string|null>} gmailActivity
 * @returns {Object[]} Array of { contact, flag } objects
 */
export function evaluateIntroducerNudges(contacts, gmailActivity) {
  const tracking = config.rules.introducer_tracking;
  if (!tracking?.enabled) return [];

  const { re_engage_introducer_after_silent_days, re_engage_stage_whitelist } = tracking;
  const now = new Date();
  const flags = [];

  for (const contact of contacts) {
    // Must have an introducer
    if (!contact.introducerPersonId) continue;

    // Must be in a whitelisted stage
    if (!re_engage_stage_whitelist.includes(contact.stage)) continue;

    // Check how long they've been silent
    const gmailDate = gmailActivity.get(contact.email);
    const lastContact = gmailDate || contact.lastContactDate;

    if (!lastContact) {
      // Never contacted but has introducer in an advanced stage - flag it
      flags.push(buildFlag(contact, 'never contacted'));
      continue;
    }

    const daysSilent = Math.floor((now - new Date(lastContact)) / (1000 * 60 * 60 * 24));

    if (daysSilent > re_engage_introducer_after_silent_days) {
      flags.push(buildFlag(contact, `${daysSilent} days silent`));
    }
  }

  return flags;
}

/**
 * Build an introducer nudge flag.
 * @param {Object} contact
 * @param {string} detail
 * @returns {{ contact: Object, flag: Object }}
 */
function buildFlag(contact, detail) {
  return {
    contact,
    flag: {
      id: 'introducer_nudge',
      label: config.rules.introducer_tracking.summary_label,
      detail: `${contact.firstName} ${contact.lastName} in ${contact.stage} (${detail})`,
      introducerPersonId: contact.introducerPersonId,
    },
  };
}
