import Handlebars from 'handlebars';
import { readFileSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import config from '../config.js';

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

/**
 * Render an email from a template using follow-up context.
 *
 * @param {import('../pipedrive/types.js').FollowUp} followUp
 * @returns {Promise<{ subject: string, body: string }>}
 */
export async function renderEmail(followUp) {
  loadTemplates();

  const { contact, templateName } = followUp;
  const template = templateCache.get(templateName);

  if (!template) {
    throw new Error(
      `Template "${templateName}" not found. Available: ${[...templateCache.keys()].join(', ')}`
    );
  }

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
    // Meta fields for specialized templates
    meetingDate: contact.meta?.meetingDate,
    agenda: contact.meta?.agenda,
    pendingDocuments: contact.meta?.pendingDocuments,
    lastDiscussionPoint: contact.meta?.lastDiscussionPoint,
    deadline: contact.meta?.deadline,
    notes: contact.notes,
  };

  const rendered = template(context);

  // Extract subject from the first line (format: "Subject: ...")
  const lines = rendered.split('\n');
  let subject = '';
  let bodyStart = 0;

  if (lines[0].startsWith('Subject:')) {
    subject = lines[0].replace('Subject:', '').trim();
    // Skip the blank line after subject
    bodyStart = lines[1]?.trim() === '' ? 2 : 1;
  }

  const body = lines.slice(bodyStart).join('\n').trim();

  // Optional: AI-powered personalization
  if (config.anthropic.enabled) {
    return polishWithAI(subject, body, contact);
  }

  return { subject, body };
}

/**
 * Use Claude to lightly personalize a rendered email draft.
 * Keeps the structure and intent, adds natural touches.
 *
 * @param {string} subject
 * @param {string} body
 * @param {import('../pipedrive/types.js').Contact} contact
 * @returns {Promise<{ subject: string, body: string }>}
 */
async function polishWithAI(subject, body, contact) {
  try {
    if (!anthropicClient) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
    }

    const notesContext = contact.notes ? `\nNotes from CRM: ${contact.notes}` : '';

    const response = await anthropicClient.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are an email writing assistant for a hedge fund investor relations professional. Lightly personalize this email draft to feel more natural and human while keeping the same structure, tone, and intent. Do NOT change the core ask or add information not present. Keep it professional and concise.

Contact info:
- Name: ${contact.firstName} ${contact.lastName}
- Company: ${contact.company || 'N/A'}
- Pipeline stage: ${contact.stage}
- Priority: ${contact.priority}${notesContext}

Current draft subject: ${subject}
Current draft body:
${body}

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

    // Fallback to original if parsing fails
    console.warn(`AI personalization parse failed for ${contact.email}, using template output.`);
    return { subject, body };
  } catch (err) {
    console.warn(`AI personalization error for ${contact.email}: ${err.message}. Using template output.`);
    return { subject, body };
  }
}
