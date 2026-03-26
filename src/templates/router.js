import Handlebars from 'handlebars';
import { readFileSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import config from '../config/index.js';

/** @type {Map<string, Handlebars.TemplateDelegate>} */
const templateCache = new Map();

/** @type {import('@anthropic-ai/sdk').default | null} */
let anthropicClient = null;

/**
 * Load all .hbs templates from the templates directory into cache.
 */
function loadTemplates() {
  if (templateCache.size > 0) return;

  const dir = config.paths.templates;
  const files = readdirSync(dir).filter(f => f.endsWith('.hbs'));

  for (const file of files) {
    const name = basename(file, '.hbs');
    const source = readFileSync(resolve(dir, file), 'utf-8');
    templateCache.set(name, Handlebars.compile(source));
  }

  console.log(`Loaded ${templateCache.size} email templates: ${[...templateCache.keys()].join(', ')}`);
}

// ── Template Resolution ──────────────────────────────

/**
 * Resolve which template file to use based on stage and contact context.
 * Uses the template-mapping.json config to route by lead_source, attempt_number, etc.
 *
 * @param {Object} followUp
 * @returns {string} Template name (without .hbs extension)
 */
function resolveTemplateName(followUp) {
  const { contact, attemptNumber } = followUp;
  const stageMapping = config.templateMapping.stages[contact.stage];

  if (!stageMapping) {
    // Fallback: use stage key directly
    return contact.stage;
  }

  const { selection, templates } = stageMapping;

  switch (selection) {
    case 'by_lead_source': {
      const source = contact.leadSource || 'default';
      const templateFile = templates[source] || templates.default;
      return basename(templateFile, '.hbs');
    }

    case 'by_attempt_number': {
      const attempt = String(attemptNumber || 1);
      const templateFile = templates[attempt] || templates.default;
      return basename(templateFile, '.hbs');
    }

    case 'by_deal_context': {
      const context = contact.dealContext || 'default';
      const templateFile = templates[context] || templates.default;
      return basename(templateFile, '.hbs');
    }

    case 'by_data_room_access': {
      const access = contact.dataRoomAccess || 'default';
      const templateFile = templates[access] || templates.default;
      return basename(templateFile, '.hbs');
    }

    case 'single':
    default: {
      const templateFile = templates.default;
      return basename(templateFile, '.hbs');
    }
  }
}

// ── Email Rendering ──────────────────────────────────

/**
 * Render an email from a template using follow-up context.
 * Routes to the correct template based on stage + contact data.
 *
 * @param {Object} followUp
 * @returns {Promise<{ subject: string, body: string }>}
 */
export async function renderEmail(followUp) {
  loadTemplates();

  const templateName = resolveTemplateName(followUp);
  const template = templateCache.get(templateName);

  if (!template) {
    throw new Error(
      `Template "${templateName}" not found. Available: ${[...templateCache.keys()].join(', ')}`
    );
  }

  const { contact } = followUp;

  // Build template context
  const context = {
    firstName: contact.firstName,
    lastName: contact.lastName,
    fullName: `${contact.firstName} ${contact.lastName}`.trim(),
    email: contact.email,
    company: contact.company,
    stage: contact.stage,
    fundName: config.sender.fundName,
    senderName: config.sender.name,
    daysSinceLastContact: followUp.daysSinceLastContact,
    attemptNumber: followUp.attemptNumber,
    // CRM fields
    leadSource: contact.leadSource,
    investorType: contact.investorType,
    // Meta fields
    meetingDate: contact.meta?.meetingDate || contact.meta?.paulMeetingDate,
    agenda: contact.meta?.agenda,
    pendingDocuments: contact.meta?.pendingDocuments,
    lastDiscussionPoint: contact.meta?.lastDiscussionPoint,
    deadline: contact.meta?.deadline,
    dataRoomAccess: contact.dataRoomAccess,
    notes: contact.notes,
  };

  const rendered = template(context);

  // Extract subject from the first line (format: "Subject: ...")
  const lines = rendered.split('\n');
  let subject = '';
  let bodyStart = 0;

  if (lines[0].startsWith('Subject:')) {
    subject = lines[0].replace('Subject:', '').trim();
    bodyStart = lines[1]?.trim() === '' ? 2 : 1;
  }

  const body = lines.slice(bodyStart).join('\n').trim();

  // AI polish (stage-specific instructions from template mapping)
  const stageMapping = config.templateMapping.stages[contact.stage];
  const shouldPolish = stageMapping?.ai_polish !== false && config.anthropic.enabled;

  if (shouldPolish) {
    const aiInstructions = stageMapping?.ai_instructions || null;
    const emailHistory = followUp.emailHistory || [];
    const pipedriveNotes = followUp.pipedriveNotes || '';
    const webEnrichment = followUp.webEnrichment || { webSnippets: [] };
    const result = await polishWithAI(subject, body, contact, followUp, aiInstructions, emailHistory, pipedriveNotes, webEnrichment);
    return { subject: cleanSubject(result.subject), body: result.body };
  }

  return { subject: cleanSubject(subject), body };
}

// ── Subject Line Sanitizer ───────────────────────────

/**
 * Strip encoding artifacts, em-dashes, and other problematic characters
 * from subject lines. These cause garbled display (e.g. "â€"") when
 * Gmail encodes them.
 *
 * @param {string} subject
 * @returns {string}
 */
function cleanSubject(subject) {
  return subject
    // Replace em-dash (U+2014) and en-dash (U+2013) with hyphen
    .replace(/[\u2014\u2013]/g, '-')
    // Replace common UTF-8 mojibake for em-dash
    .replace(/â€"/g, '-')
    .replace(/â€"/g, '-')
    // Replace smart quotes with straight quotes
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    // Remove any remaining non-ASCII that isn't a letter
    .replace(/[^\x20-\x7E\u00C0-\u024F]/g, '')
    .trim();
}

// ── AI Polish ────────────────────────────────────────

/**
 * Use Claude to personalize a rendered email draft.
 * Uses a structured prompt with the voice profile as a system message
 * and the draft + contact context as the user message.
 *
 * @param {string} subject
 * @param {string} body
 * @param {Object} contact
 * @param {Object} followUp - Full follow-up context (attemptNumber, daysSince, etc.)
 * @param {string|null} aiInstructions - Stage-specific tone/style instructions
 * @param {Array<{ direction: string, date: string, subject: string, snippet: string }>} emailHistory - Recent emails with this contact
 * @param {string} pipedriveNotes - Concatenated Pipedrive notes for the contact
 * @param {{ webSnippets: string[] }} webEnrichment - Web search enrichment data
 * @returns {Promise<{ subject: string, body: string }>}
 */
async function polishWithAI(subject, body, contact, followUp, aiInstructions, emailHistory = [], pipedriveNotes = '', webEnrichment = { webSnippets: [] }) {
  try {
    if (!anthropicClient) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
    }

    const vp = config.voiceProfile || {};
    const stageVoice = vp.stage_voice_notes?.[contact.stage] || '';

    // ── System message: voice profile ──────────────
    const systemMessage = `You are ghostwriting investor outreach emails for ${vp.sender || 'the sender'}, ${vp.role || ''} at ${vp.firm || ''}.

<voice>
Tone: ${vp.tone?.overall || 'Professional and direct'}
Register: ${vp.tone?.register || 'Conversational'}
Warmth: ${vp.tone?.warmth_level || 'Moderate'}
</voice>

<structure>
Greeting: ${vp.structure_patterns?.greeting || 'First name only'}
Opening: ${vp.structure_patterns?.opening || 'Set context in 1-2 sentences'}
Body: ${vp.structure_patterns?.body || '2-3 short paragraphs'}
Ask: ${vp.structure_patterns?.ask || 'Small and low-pressure'}
Closing: ${vp.structure_patterns?.closing || 'Take care, [name]'}
Length: ${vp.structure_patterns?.length || '100-200 words'}
</structure>

<rules>
DO:
${(vp.do || []).map(d => `- ${d}`).join('\n')}

DON'T:
${(vp.dont || []).map(d => `- ${d}`).join('\n')}
</rules>

<data_points>
Available data points to weave in naturally (use at most 1-2, not all):
${(vp.data_points_to_include || []).map(d => `- ${d}`).join('\n')}
</data_points>

<subject_line_rules>
- Use plain hyphens (-), NEVER em-dashes or special characters
- Keep short and direct
- Follow these patterns: ${(vp.example_subject_lines || []).join(', ')}
</subject_line_rules>

${vp.few_shot_examples?.length ? `<examples>\nThese are real emails written by ${vp.sender}. Match this style exactly:\n\n${vp.few_shot_examples.map((ex, i) => `--- Example ${i + 1} ---\nSubject: ${ex.subject}\n${ex.body}`).join('\n\n')}\n</examples>` : ''}`;

    // ── User message: draft + context ──────────────
    const userMessage = `<contact>
Name: ${contact.firstName} ${contact.lastName}
Company: ${contact.company || 'Unknown'}
Stage: ${contact.stage}
Lead source: ${contact.leadSource || 'Unknown'}
Investor type: ${contact.investorType || 'Unknown'}
Outreach attempt: ${followUp.attemptNumber || 1}
Days since last contact: ${followUp.daysSinceLastContact || 'Unknown'}
${contact.notes ? `CRM notes: ${contact.notes}` : ''}
</contact>

${pipedriveNotes ? `<pipedrive_notes>
The following are internal CRM notes about this contact (most recent first). Use any relevant details to make the email feel more personal and contextual, but do NOT reference the notes directly or reveal that you have internal notes.
${pipedriveNotes}
</pipedrive_notes>

` : ''}${webEnrichment.webSnippets.length > 0 ? `<web_research>
The following are web search results about this contact and/or their company. Use any relevant details to add a natural, personal touch (e.g., reference a recent company milestone or shared interest), but do NOT make it obvious you researched them. Use at most 1-2 subtle references.
${webEnrichment.webSnippets.join('\n')}
</web_research>

` : ''}${emailHistory.length > 0 ? `<prior_correspondence>
Below are the most recent emails exchanged with this contact (newest first). Review them carefully.
${emailHistory.map((msg, i) => `--- ${msg.direction === 'sent' ? 'WE SENT' : 'THEY SENT'} (${msg.date ? new Date(msg.date).toLocaleDateString() : 'unknown date'}) ---
Subject: ${msg.subject}
${msg.snippet}`).join('\n\n')}
</prior_correspondence>

` : ''}${stageVoice ? `<stage_guidance>\n${stageVoice}\n</stage_guidance>\n` : ''}${aiInstructions ? `<tone_guidance>\n${aiInstructions}\n</tone_guidance>\n` : ''}
<draft>
Subject: ${subject}

${body}
</draft>

Rewrite this draft in ${vp.sender || 'the sender'}'s voice. Rules:
1. Keep the same intent and core information
2. Do NOT invent facts, meetings, or details not in the draft, contact notes, CRM notes, or web research
3. The sign-off MUST be "Take care,\\n${vp.sender || config.sender?.name || 'James'}"
4. Subject line must use plain hyphens (-), never em-dashes or special characters
5. Do NOT use exclamation marks
6. Keep it under 200 words
7. Review the prior correspondence above (if any). Do NOT repeat the same message or talking points already sent. Write a natural continuation of the conversation. If they replied, acknowledge what they said.
8. If CRM notes or web research provide relevant context, weave in at most 1-2 natural references. Never reveal your data sources.

Return ONLY this format, nothing else:
SUBJECT: <subject line>
BODY:
<email body>`;

    const response = await anthropicClient.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: systemMessage,
      messages: [{ role: 'user', content: userMessage }],
    });

    const aiText = response.content[0]?.text || '';
    const subjectMatch = aiText.match(/SUBJECT:\s*(.+)/);
    const bodyMatch = aiText.match(/BODY:\s*\n([\s\S]+)/);

    if (subjectMatch && bodyMatch) {
      return {
        subject: subjectMatch[1].trim(),
        body: bodyMatch[1].trim(),
      };
    }

    console.warn(`  AI polish parse failed for ${contact.email}, using template output.`);
    return { subject, body };
  } catch (err) {
    console.warn(`  AI polish error for ${contact.email}: ${err.message}. Using template output.`);
    return { subject, body };
  }
}

