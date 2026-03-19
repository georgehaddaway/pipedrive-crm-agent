/**
 * @typedef {Object} Contact
 * @property {string} id - Unique identifier (Pipedrive person ID)
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} email
 * @property {string} [company] - Organization name
 * @property {string} stage - Pipeline stage key (matches pipeline-stages.json)
 * @property {string} priority - "high" | "medium" | "low"
 * @property {string[]} [tags] - Labels from Pipedrive
 * @property {string} [lastContactDate] - ISO date of last known activity in CRM
 * @property {string} [notes] - Free-text notes from CRM
 * @property {string} [leadSource] - How the contact entered the pipeline (warm_intro, cold_email, etc.)
 * @property {string} [introducerPersonId] - Pipedrive person ID of the introducer
 * @property {string} [lastOutboundDate] - ISO date of most recent outbound email
 * @property {string} [lastInboundDate] - ISO date of most recent inbound reply
 * @property {number} [outreachAttempts] - Count of outreach attempts in current stage
 * @property {string} [investorType] - Classification (family_office, fund_of_funds, etc.)
 * @property {string} [dataRoomAccess] - Data room access status (not_requested, requested, granted, reviewing)
 * @property {boolean} [emailBounced] - Whether the email has bounced
 * @property {Object} [meta] - Additional CRM-specific fields
 * @property {string} [meta.meetingDate]
 * @property {string} [meta.paulMeetingDate]
 * @property {string} [meta.agenda]
 * @property {string[]} [meta.pendingDocuments]
 * @property {string} [meta.lastDiscussionPoint]
 * @property {string} [meta.deadline]
 * @property {number} [meta.dealId] - Pipedrive deal ID used for stage lookup
 * @property {number} [meta.dealValue] - Deal monetary value
 */

/**
 * @typedef {Object} PipelineStage
 * @property {string} key - Stage identifier (matches pipeline-stages.json keys)
 * @property {string} name - Human-readable name
 * @property {number} order - Sort order
 * @property {string} type - Stage type: "active", "won", "on_hold", "lost_cold"
 * @property {number} deal_probability - Win probability percentage
 * @property {Object} follow_up - Follow-up configuration
 * @property {number|null} follow_up.threshold_days
 * @property {number|null} follow_up.max_attempts
 * @property {string} follow_up.cadence
 * @property {Object|null} auto_advance - Auto-advancement rules
 */

/**
 * @typedef {Object} FollowUp
 * @property {Contact} contact
 * @property {string} reason - Human-readable reason for follow-up
 * @property {number} daysSinceLastContact
 * @property {number} urgencyScore - Higher = more urgent (0 to ~1.5)
 * @property {string} templateName - Template routing key
 * @property {number} attemptNumber - Which follow-up attempt this is
 * @property {Object} [stageConfig] - Full stage config from pipeline-stages.json
 */

/**
 * @typedef {Object} StageAdvancement
 * @property {Contact} contact
 * @property {string} fromStage - Previous stage key
 * @property {string} toStage - New stage key
 * @property {string} trigger - What triggered the advancement (no_reply_after_max_attempts, reply_detected)
 * @property {string} action - Action to take (advance_stage)
 */

/**
 * @typedef {Object} SummaryFlag
 * @property {Contact} contact
 * @property {Object} flag
 * @property {string} flag.id - Flag type (introducer_nudge, stale_contact, breakup_pending, hot_lead)
 * @property {string} flag.label - Human-readable label
 * @property {string} flag.detail - Context-specific detail string
 */

/**
 * @typedef {Object} DraftResult
 * @property {string} contactId
 * @property {string} contactEmail
 * @property {string} contactName
 * @property {string} subject
 * @property {string} draftId - Gmail draft ID (empty in dry-run)
 * @property {boolean} created - Whether draft was actually created
 */

/**
 * @typedef {Object} RunReport
 * @property {string} timestamp - ISO timestamp of run
 * @property {number} totalContacts - Contacts evaluated
 * @property {number} followUpsIdentified
 * @property {number} draftsCreated
 * @property {number} stageAdvancements - Number of stage changes applied
 * @property {number} flagsGenerated - Number of summary flags
 * @property {FollowUp[]} followUps
 * @property {DraftResult[]} drafts
 * @property {SummaryFlag[]} flags
 * @property {StageAdvancement[]} advancements
 * @property {boolean} dryRun
 * @property {string[]} errors
 */

export {};
