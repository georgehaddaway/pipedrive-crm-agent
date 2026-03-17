import { IncomingWebhook } from '@slack/webhook';
import config from '../config.js';

/**
 * Post a daily pipeline summary to Slack.
 *
 * @param {import('../pipedrive/types.js').FollowUp[]} followUps
 * @param {import('../pipedrive/types.js').DraftResult[]} drafts
 * @param {boolean} dryRun
 */
export async function postSummary(followUps, drafts, dryRun) {
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

  // Build stage breakdown
  const stageLines = Object.entries(byStage)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([stage, items]) => {
      const label = stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return `  *${label}*: ${items.length} contact${items.length === 1 ? '' : 's'}`;
    })
    .join('\n');

  // High-priority contacts
  const highPriority = followUps
    .filter(fu => fu.contact.priority === 'high')
    .map(fu => `  - ${fu.contact.firstName} ${fu.contact.lastName} (${fu.contact.company || 'N/A'}) - ${fu.reason}`)
    .join('\n');

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

  if (stageLines) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*By Stage:*\n${stageLines}`,
      },
    });
  }

  if (highPriority) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*:fire: High Priority:*\n${highPriority}`,
      },
    });
  }

  if (!dryRun && drafts.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:email: *${drafts.filter(d => d.created).length} drafts ready for review in Gmail.*\nTake 15 minutes to review and send.`,
      },
    });
  }

  await webhook.send({ blocks });
  console.log('Slack summary posted.');
}

/**
 * Post an error alert to Slack when the agent encounters failures.
 *
 * @param {string} context - Where the error occurred (e.g. "Pipeline Run", "Fatal Crash")
 * @param {string[]} errors - List of error messages
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

  const errorList = errors
    .map(e => `  • ${e}`)
    .join('\n');

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
    // If Slack itself fails, we can only log it
    console.error(`Failed to post error alert to Slack: ${err.message}`);
  }
}
