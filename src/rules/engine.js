import config from '../config/index.js';

// ── Business Days ────────────────────────────────────

/**
 * Calculate business days between two dates in the configured timezone.
 * Excludes weekends (Saturday/Sunday).
 * @param {Date} start
 * @param {Date} end
 * @returns {number}
 */
function businessDaysBetween(start, end) {
  let count = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  while (current < endDate) {
    current.setDate(current.getDate() + 1);
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

/**
 * Calculate days since a date, optionally business days only.
 * @param {string|Date} dateStr
 * @param {Date} now
 * @returns {number}
 */
function daysSince(dateStr, now) {
  const date = new Date(dateStr);
  if (config.rules.global_defaults.business_days_only) {
    return businessDaysBetween(date, now);
  }
  return Math.floor((now - date) / (1000 * 60 * 60 * 24));
}

// ── Exclusion Check ──────────────────────────────────

/**
 * Check if a contact should be excluded from follow-ups.
 * @param {Object} contact
 * @returns {{ excluded: boolean, reason?: string }}
 */
function checkExclusions(contact) {
  const { exclusions } = config.rules;

  // No email = skip
  if (!contact.email) {
    return { excluded: true, reason: 'No email address' };
  }

  // Tag-based exclusions
  if (exclusions.tags && contact.tags?.length) {
    const matchingTag = contact.tags.find(tag =>
      exclusions.tags.includes(tag.toLowerCase())
    );
    if (matchingTag) {
      return { excluded: true, reason: `Excluded tag: ${matchingTag}` };
    }
  }

  // Stage-based exclusions
  if (exclusions.stages?.includes(contact.stage)) {
    return { excluded: true, reason: `Excluded stage: ${contact.stage}` };
  }

  // Conditional exclusions
  for (const cond of exclusions.conditions || []) {
    const fieldValue = getFieldValue(contact, cond.field);
    if (evaluateCondition(fieldValue, cond.operator, cond.value)) {
      return { excluded: true, reason: cond.reason || `Condition: ${cond.field} ${cond.operator} ${cond.value}` };
    }
  }

  return { excluded: false };
}

/**
 * Get a field value from a contact, supporting nested field names.
 * @param {Object} contact
 * @param {string} field
 * @returns {*}
 */
function getFieldValue(contact, field) {
  if (field === 'days_since_last_outbound') {
    if (!contact.lastOutboundDate) return Infinity;
    return daysSince(contact.lastOutboundDate, new Date());
  }
  if (field === 'email_bounced') {
    return contact.emailBounced || false;
  }
  return contact[field];
}

/**
 * Evaluate a condition operator.
 * @param {*} fieldValue
 * @param {string} operator
 * @param {*} value
 * @returns {boolean}
 */
function evaluateCondition(fieldValue, operator, value) {
  switch (operator) {
    case 'eq': return fieldValue === value;
    case 'neq': return fieldValue !== value;
    case 'lt': return fieldValue < value;
    case 'gt': return fieldValue > value;
    case 'lte': return fieldValue <= value;
    case 'gte': return fieldValue >= value;
    default: return false;
  }
}

// ── Overdue Check ────────────────────────────────────

/**
 * Check if a contact is overdue for follow-up.
 * @param {Object} contact
 * @param {string|Date|null} lastContactDate
 * @param {Date} now
 * @returns {{ overdue: boolean, daysSince: number, threshold: number }}
 */
function checkOverdue(contact, lastContactDate, now) {
  const threshold = config.rules.overdue_thresholds[contact.stage];
  if (threshold === undefined || threshold === null) {
    return { overdue: false, daysSince: 0, threshold: Infinity };
  }

  // Never contacted = always overdue
  if (!lastContactDate) {
    return { overdue: true, daysSince: Infinity, threshold };
  }

  const days = daysSince(lastContactDate, now);
  return { overdue: days >= threshold, daysSince: days, threshold };
}

// ── Urgency Scoring ──────────────────────────────────

/**
 * Calculate urgency score using the formula:
 * base_urgency * source_multiplier * recency_decay * stage_weight
 *
 * @param {Object} contact
 * @param {number} daysOverdue
 * @param {number} threshold
 * @param {number} daysIdle - Days since any activity
 * @returns {number} Urgency score (0 to ~1.5, before priority adjustment)
 */
function calculateUrgency(contact, daysOverdue, threshold, daysIdle) {
  const scoring = config.rules.urgency_scoring;

  // Base urgency: days_overdue / threshold, capped at 1.0
  const baseUrgency = threshold > 0
    ? Math.min(daysOverdue / threshold, scoring.base_urgency.cap)
    : 0;

  // Source multiplier: lookup from lead_source field
  // null/unknown lead source gets neutral 1.0; cold_email penalty only applies when explicit
  const leadSource = contact.leadSource;
  const sourceMultiplier = (leadSource && scoring.source_multipliers[leadSource]) || 1.0;

  // Recency decay: exponential decay based on idle days
  let recencyDecay = 1.0;
  if (scoring.recency_decay.enabled && daysIdle > 0) {
    const halfLife = scoring.recency_decay.half_life_days;
    recencyDecay = Math.max(
      Math.pow(0.5, daysIdle / halfLife),
      scoring.recency_decay.floor
    );
  }

  // Stage weight
  const stageWeight = scoring.stage_weights[contact.stage] || 0.5;

  return baseUrgency * sourceMultiplier * recencyDecay * stageWeight;
}

// ── Main Evaluation Pipeline ─────────────────────────

/**
 * Evaluate all contacts against follow-up rules and Gmail activity.
 * Implements the 5-step evaluation pipeline:
 * 1. check_exclusions
 * 2. check_overdue
 * 3. calculate_urgency
 * 4. apply_priority_multipliers (adjusts threshold)
 * 5. rank_and_cap
 *
 * @param {Object[]} contacts
 * @param {Map<string, string|null>} gmailActivity - Map of email -> last email ISO date
 * @returns {Object[]} Array of FollowUp objects, sorted by urgency
 */
export function evaluateContacts(contacts, gmailActivity) {
  const now = new Date();
  const { global_defaults } = config.rules;
  const followUps = [];

  for (const contact of contacts) {
    // Step 1: Check exclusions
    const exclusionResult = checkExclusions(contact);
    if (exclusionResult.excluded) continue;

    // Get the stage config
    const stageConfig = config.getStageByKey(contact.stage);
    if (!stageConfig || stageConfig.follow_up.threshold_days === null) continue;

    // Check attempt limits
    const attemptLimit = config.rules.attempt_limits[contact.stage];
    if (attemptLimit !== null && attemptLimit !== undefined) {
      const attempts = contact.outreachAttempts || 0;
      if (attempts >= attemptLimit) continue;
    }

    // Determine last contact date: prefer Gmail data, fall back to CRM data
    const gmailDate = gmailActivity.get(contact.email);
    const lastContactStr = gmailDate || contact.lastContactDate;

    // Step 2: Check overdue
    const overdueResult = checkOverdue(contact, lastContactStr, now);
    if (!overdueResult.overdue) continue;

    // Calculate days idle (for recency decay)
    const daysIdle = lastContactStr
      ? daysSince(lastContactStr, now)
      : 30; // Default idle for never-contacted

    // Step 3: Calculate urgency
    // Use total days since contact (not just days overdue) so contacts at
    // the threshold boundary get a meaningful base urgency of 1.0.
    const totalDays = overdueResult.daysSince === Infinity
      ? overdueResult.threshold * 2 // Never contacted gets 2x threshold
      : overdueResult.daysSince;

    const urgency = calculateUrgency(
      contact,
      totalDays,
      overdueResult.threshold,
      daysIdle
    );

    // Step 4: Priority multiplier (adjusts the final urgency)
    // High priority boosts urgency, low priority reduces it
    let priorityMultiplier = 1.0;
    if (contact.priority === 'high') priorityMultiplier = 1.5;
    if (contact.priority === 'low') priorityMultiplier = 0.5;

    const finalUrgency = urgency * priorityMultiplier;

    // Build reason string
    const reason = overdueResult.daysSince === Infinity
      ? `Never contacted. Stage: ${contact.stage}`
      : `${overdueResult.daysSince} days since last contact (threshold: ${overdueResult.threshold}). Stage: ${contact.stage}`;


    followUps.push({
      contact,
      reason,
      daysSinceLastContact: overdueResult.daysSince === Infinity ? -1 : overdueResult.daysSince,
      urgencyScore: finalUrgency,
      templateName: stageConfig.follow_up.cadence || contact.stage,
      attemptNumber: (contact.outreachAttempts || 0) + 1,
      stageConfig,
    });
  }

  // Step 5: Rank and cap
  followUps.sort((a, b) => b.urgencyScore - a.urgencyScore);

  // Filter below minimum urgency
  const minUrgency = global_defaults.min_urgency_to_draft;
  const filtered = followUps.filter(fu => fu.urgencyScore >= minUrgency);


  // Cap at max drafts per run
  const maxDrafts = global_defaults.max_drafts_per_run;
  return filtered.slice(0, maxDrafts);
}

/**
 * Detect stale contacts (no stage movement in 180+ days, active stage).
 * @param {Object[]} contacts
 * @returns {Object[]} Array of { contact, flag } objects
 */
export function detectStaleContacts(contacts) {
  const staleDays = config.rules.global_defaults.stale_contact_days;
  const now = new Date();
  const flags = [];

  for (const contact of contacts) {
    const stageConfig = config.getStageByKey(contact.stage);
    if (!stageConfig || stageConfig.type !== 'active') continue;

    // Use last activity date or last contact date as proxy for stage movement
    const lastActivity = contact.lastContactDate || contact.lastOutboundDate;
    if (!lastActivity) continue;

    // Use calendar days for stale detection (not business days)
    const days = Math.floor((now - new Date(lastActivity)) / (1000 * 60 * 60 * 24));
    if (days >= staleDays) {
      flags.push({
        contact,
        flag: {
          id: 'stale_contact',
          label: 'Contact may be stale — review needed',
          detail: `${days} days since last activity in ${contact.stage}`,
        },
      });
    }
  }

  return flags;
}
