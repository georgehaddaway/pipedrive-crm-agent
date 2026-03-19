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
    return polishWithAI(subject, body, contact, aiInstructions);
  }

  return { subject, body };
}

/**
 * Use Claude to personalize a rendered email draft.
 * Uses stage-specific AI instructions from template-mapping.json.
 *
 * @param {string} subject
 * @param {string} body
 * @param {Object} contact
 * @param {string|null} aiInstructions - Stage-specific tone/style instructions
 * @returns {Promise<{ subject: string, body: string }>}
 */
async function polishWithAI(subject, body, contact, aiInstructions) {
  try {
    if (!anthropicClient) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
    }

    const notesContext = contact.notes ? `\nNotes from CRM: ${contact.notes}` : '';
    const stageInstructions = aiInstructions
      ? `\nStage-specific tone guidance: ${aiInstructions}`
      : '';

    // Build voice profile instructions if available
    let voiceInstructions = '';
    if (config.voiceProfile) {
      const vp = config.voiceProfile;
      const stageVoice = vp.stage_voice_notes?.[contact.stage] || '';

      voiceInstructions = `
VOICE PROFILE — You must write in this person's exact voice:
- Tone: ${vp.tone.overall}
- Register: ${vp.tone.register}
- Structure: ${vp.structure_patterns.greeting} ${vp.structure_patterns.body}
- Ask style: ${vp.structure_patterns.ask}
- Closing: ${vp.structure_patterns.closing}
- Max length: ${vp.structure_patterns.length}

DO: ${vp.do.join('. ')}
DON'T: ${vp.dont.join('. ')}

Data points to weave in naturally (use 1-2, not all): ${vp.data_points_to_include.join('; ')}
${stageVoice ? `\nVoice for ${contact.stage} stage: ${stageVoice}` : ''}`;
    }

    const response = await anthropicClient.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are rewriting an email draft to match a specific person's writing voice. ${voiceInstructions ? 'Follow the voice profile exactly.' : 'Keep the tone professional and concise.'}
${voiceInstructions}
${stageInstructions}

Contact info:
- Name: ${contact.firstName} ${contact.lastName}
- Company: ${contact.company || 'N/A'}
- Pipeline stage: ${contact.stage}
- Lead source: ${contact.leadSource || 'N/A'}
- Investor type: ${contact.investorType || 'N/A'}${notesContext}

Current draft subject: ${subject}
Current draft body:
${body}

Rewrite this email to match the voice profile. Keep the same intent and core information. Do NOT add facts not present in the draft. Do NOT change the sign-off.

Return your response in this exact format:
SUBJECT: <improved subject line>
BODY:
<improved body text>`,
        },
      ],
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

    console.warn(`AI personalization parse failed for ${contact.email}, using template output.`);
    return { subject, body };
  } catch (err) {
    console.warn(`AI personalization error for ${contact.email}: ${err.message}. Using template output.`);
    return { subject, body };
  }
}

