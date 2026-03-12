/**
 * @typedef {Object} Contact
 * @property {string} id - Unique identifier
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} email
 * @property {string} [company] - Organization name
 * @property {string} stage - Pipeline stage key (matches rules.json)
 * @property {string} priority - "high" | "medium" | "low"
 * @property {string[]} [tags] - Labels/tags from CRM
 * @property {string} [lastContactDate] - ISO date of last known contact in CRM
 * @property {string} [notes] - Free-text notes from CRM
 * @property {Object} [meta] - Additional CRM-specific fields
 * @property {string} [meta.meetingDate]
 * @property {string} [meta.agenda]
 * @property {string[]} [meta.pendingDocuments]
 * @property {string} [meta.lastDiscussionPoint]
 * @property {string} [meta.deadline]
 */

/**
 * @typedef {Object} PipelineStage
 * @property {string} key - Stage identifier (matches rules.json keys)
 * @property {string} label - Human-readable name
 * @property {number} order - Sort order
 */

/**
 * @typedef {Object} Activity
 * @property {string} contactId
 * @property {string} type - "email" | "meeting" | "call" | "note"
 * @property {string} date - ISO date
 * @property {string} [summary]
 */

/**
 * @typedef {Object} FollowUp
 * @property {Contact} contact
 * @property {string} reason - Human-readable reason for follow-up
 * @property {number} daysSinceLastContact
 * @property {number} urgencyScore - Higher = more urgent (0-10)
 * @property {string} templateName - Template file to use
 * @property {number} attemptNumber - Which follow-up attempt this is
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
 * @property {FollowUp[]} followUps
 * @property {DraftResult[]} drafts
 * @property {boolean} dryRun
 * @property {string[]} errors
 */

export {};
