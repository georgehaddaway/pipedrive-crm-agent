import { IncomingWebhook } from '@slack/webhook';
import config from '../config/index.js';

/**
 * Post a daily pipeline summary to Slack.
 * Enhanced with flag sections, urgency scores, and stage grouping.
 *
 * @param {Object[]} followUps
 * @param {Object[]} drafts
 * @param {Object[]} flags - Array of { contact, flag } objects
 * @param {Object} [advancements] - Stage advancement results
 * @param {boolean} dryRun
 */
export async function postSummary(followUps, drafts, flags = [], advancements = [], dryRun = false) {
  if (!config.slack.enabled) {
    console.log('Slack not configured, skipping summary post.');
    return;
  }

  const webhook = new IncomingWebhook(config.slack.webhookUrl);

  // Group follow-ups by stage
  const byStage = {};
  for (const fu of followUps) {
    const stage = fu.contact.stage;
    if (!byStage[stage]) byStage[stage] = [];
    byStage[stage].push(fu);
  }

  // Build stage breakdown with urgency scores
  const stageLines = Object.entries(byStage)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([stage, items]) => {
      const label = formatStageName(stage);
      const contacts = items
        .map(fu => `    - ${fu.contact.firstName} ${fu.contact.lastName} (${formatUrgency(fu.urgencyScore)})`)
        .join('\n');
      return `  *${label}* (${items.length}):\n${contacts}`;
    })
    .join('\n\n');

  const modeLabel = dryRun ? ':construction: DRY RUN' : ':white_check_mark: LIVE RUN';
  const now = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${dryRun ? '[DRY RUN] ' : ''}Pipeline Follow-Up Summary`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${modeLabel}  |  ${now}\n\n*${followUps.length}* follow-ups identified  |  *${drafts.filter(d => d.created).length}* drafts created`,
      },
    },
  ];

  // Stage breakdown
  if (stageLines) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*By Stage:*\n${stageLines}`,
      },
    });
  }

  // Stage advancements
  if (advancements.length > 0) {
    const advLines = advancements
      .map(a => `  - ${a.contact.firstName} ${a.contact.lastName}: ${formatStageName(a.fromStage)} → ${formatStageName(a.toStage)} _(${a.trigger})_`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:arrows_counterclockwise: *Stage Advancements (${advancements.length}):*\n${advLines}`,
      },
    });
  }

  // Flags section
  if (flags.length > 0) {
    const flagGroups = groupFlags(flags);
    const flagText = Object.entries(flagGroups)
      .map(([label, items]) => {
        const emoji = getFlagEmoji(items[0].flag.id);
        const details = items.map(f => `  - ${f.flag.detail}`).join('\n');
        return `${emoji} *${label}* (${items.length}):\n${details}`;
      })
      .join('\n\n');

    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:triangular_flag_on_post: *Flags & Alerts:*\n\n${flagText}`,
        },
      }
    );
  }

  // Draft reminder
  if (!dryRun && drafts.length > 0) {
    const createdCount = drafts.filter(d => d.created).length;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:email: *${createdCount} draft${createdCount === 1 ? '' : 's'} ready for review in Gmail.*\nTake 15 minutes to review and send.`,
      },
    });
  }

  await webhook.send({ blocks });
  console.log('Slack summary posted.');
}

/**
 * Post an error alert to Slack.
 * @param {string} context
 * @param {string[]} errors
 */
export async function postError(context, errors) {
  if (!config.slack.enabled) {
    console.log('Slack not configured, skipping error alert.');
    return;
  }

  const webhook = new IncomingWebhook(config.slack.webhookUrl);

  const now = new Date().toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const errorList = errors.map(e => `  - ${e}`).join('\n');

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `:rotating_light: CRM Agent Error — ${context}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${errors.length} error${errors.length === 1 ? '' : 's'}*  |  ${now}\n\n${errorList}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Check logs for details:\n\`tail -50 data/logs/agent-error.log\``,
      },
    },
  ];

  try {
    await webhook.send({ blocks });
    console.log('Slack error alert posted.');
  } catch (err) {
    console.error(`Failed to post error alert to Slack: ${err.message}`);
  }
}

// ── Helpers ──────────────────────────────────────────

function formatStageName(stageKey) {
  return stageKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatUrgency(score) {
  if (score >= 0.8) return `:fire: ${score.toFixed(2)}`;
  if (score >= 0.5) return `:warning: ${score.toFixed(2)}`;
  return `${score.toFixed(2)}`;
}

function groupFlags(flags) {
  const groups = {};
  for (const f of flags) {
    const label = f.flag.label;
    if (!groups[label]) groups[label] = [];
    groups[label].push(f);
  }
  return groups;
}

function getFlagEmoji(flagId) {
  switch (flagId) {
    case 'introducer_nudge': return ':handshake:';
    case 'stale_contact': return ':hourglass:';
    case 'breakup_pending': return ':wave:';
    case 'hot_lead': return ':fire:';
    default: return ':pushpin:';
  }
}
