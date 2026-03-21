/**
 * Bulk import contacts from the Satori Power investor email document.
 * Creates persons and deals in Pipedrive with correct pipeline stages.
 *
 * Usage: node scripts/import-contacts.js [--dry-run]
 */
import { config as loadEnv } from 'dotenv';
loadEnv();

const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
const token = process.env.PIPEDRIVE_API_TOKEN;
const dryRun = process.argv.includes('--dry-run');

// Lead Source option IDs (from Pipedrive custom field creation)
const LEAD_SOURCE_OPTIONS = {
  warm_intro: 324,
  mutual_connection: 325,
  conference_meeting: 326,
  conference_lead: 327,
  inbound_inquiry: 328,
  cold_email: 329,
  distribution_list: 330,
};

// Lead Source field key
const LEAD_SOURCE_KEY = 'd435bb1568a79fd0786fc1aaa1a957bcb482b386';
// Outreach Attempts field key
const OUTREACH_ATTEMPTS_KEY = 'c194b45818a556a82bc66a5e00bd99e5c389e6fa';

// Pipedrive stage IDs
const STAGES = {
  follow_up_1: 159,
  follow_up: 160,
  breakup: 161,
  engaged: 162,
  post_meeting: 163,
  due_diligence: 164,
  committed: 165,
  on_hold: 166,
  declined_cold: 167,
};

const PIPELINE_ID = 2;

// ── Contact Data ────────────────────────────────────
// Extracted from satoripower.pdf contact summary table

const contacts = [
  // Contacts with emails from the document
  {
    name: 'Gary Schorr',
    email: 'gary@arietcapital.com',
    org: 'Ariet Capital',
    stage: 'follow_up_1',
    leadSource: 'warm_intro',
    notes: 'SFO via Kiran Patel. Send Power intro.',
  },
  {
    name: 'Michael Klein',
    email: 'mklein@aetos.com',
    org: 'Aetos Alternatives',
    stage: 'breakup',
    leadSource: 'cold_email',
    notes: 'OCIO/Allocator. Permission to close. 3 emails with no response.',
  },
  {
    name: 'Filbert Cua',
    email: 'fcua@aetos.com',
    org: 'Aetos Alternatives',
    stage: 'breakup',
    leadSource: 'cold_email',
    notes: 'OCIO/Allocator. Permission to close.',
  },
  {
    name: 'Kenneth Lubbock',
    email: 'klubbock@montroseadvisors.com',
    org: 'Montrose Advisors',
    stage: 'breakup',
    leadSource: 'warm_intro',
    notes: 'Boutique advisor (~$461M). Known Ken since Corriente days. Permission to close, preserve relationship.',
  },
  {
    name: 'Yomi Adigun',
    email: 'Aadigun@dumac.duke.edu',
    org: 'DUMAC (Duke University)',
    stage: 'breakup',
    leadSource: 'cold_email',
    notes: 'Endowment ($12.3B). Originally engaged in 2020. Permission to close.',
  },
  {
    name: 'Gildas Quinquis',
    email: 'GQuinquis@windroseadvisor.com',
    org: 'Windrose Advisors',
    stage: 'breakup',
    leadSource: 'cold_email',
    notes: 'OCIO/Wealth ($4B). Ask for handoff to team.',
  },
  {
    name: 'David Demeter',
    email: 'dademeter@davidson.edu',
    org: 'Davidson College',
    stage: 'post_meeting',
    leadSource: 'warm_intro',
    notes: 'Endowment. Request feedback. Introduced by Jason Cooper.',
  },
  {
    name: 'Ahmed Deria',
    email: 'Ahmed.Deria@blackstone.com',
    org: 'Blackstone',
    stage: 'due_diligence',
    leadSource: 'cold_email',
    notes: 'Institutional. Nudge on data room.',
  },
  {
    name: 'Brad Holmes',
    email: 'BHolmes@rockco.com',
    org: 'Rockefeller Capital',
    stage: 'follow_up',
    leadSource: 'warm_intro',
    notes: 'Advisor/Institutional. Push for diligence team access. Introduced by Jennifer Nolan.',
  },
  {
    name: 'Peter Kellner',
    email: 'peter.kellner@rglobal.com',
    org: 'Richmond Global',
    stage: 'follow_up',
    leadSource: 'warm_intro',
    notes: 'HNW / Jesuit endowment. Re-engage with his thesis. Introduced by Leo Gasteen at Thales.',
  },
  {
    name: 'Matt Glasofer',
    email: 'matthewg@corbincapital.com',
    org: 'Corbin Capital',
    stage: 'follow_up',
    leadSource: 'warm_intro',
    notes: 'Multi-strategy FoHF. Ask for intro to Rob Zellner.',
  },
  {
    name: 'Rob Zellner',
    email: 'rzellner@corbincapital.com',
    org: 'Corbin Capital',
    stage: 'follow_up',
    leadSource: 'warm_intro',
    notes: 'Multi-strategy FoHF. Target for allocation conversation.',
  },
  {
    name: 'Bruno Caram',
    email: 'bruno.caram@mercurygestao.com.br',
    org: 'Mercury Gestão (Brazil)',
    stage: 'follow_up',
    leadSource: 'conference_meeting',
    notes: 'Wealth Manager. ICLN comparison / asymmetry angle.',
  },
  {
    name: 'Theresa Nardone',
    email: 'theresa.nardone@therockcreekgroup.com',
    org: 'Rock Creek Group',
    stage: 'follow_up',
    leadSource: 'warm_intro',
    notes: 'TRS Partner. Re-engage, approaching $50M.',
  },
  {
    name: 'Jeff Schachter',
    email: 'jeff@crawfordlakecapital.com',
    org: 'Crawford Lake Capital',
    stage: 'engaged',
    leadSource: 'mutual_connection',
    notes: 'Mutual friend / introducer. Ask to nudge Brad Donley.',
  },
  {
    name: 'Jeffrey Chin',
    email: 'jeffrey@247lookout.com',
    org: 'The Observatory',
    stage: 'declined_cold',
    leadSource: 'warm_intro',
    notes: 'Allocator. Declined but warm. Keep on distribution.',
  },
  {
    name: 'Kiran Patel',
    email: 'kiran.patel@krisdan.com',
    org: 'KrisDan Management',
    stage: 'engaged',
    leadSource: 'warm_intro',
    notes: 'SFO (Arthrex family). Introducer for Gary Schorr.',
  },
  {
    name: 'Jason Cooper',
    email: 'jcooper@centerbook.com',
    org: 'Centerbook Partners',
    stage: 'engaged',
    leadSource: 'mutual_connection',
    notes: 'Mutual friend / investor. Introduced David Demeter, reference for Thomas at Kemnay.',
  },
  // Internal / support contacts (not added as deals)
];

// ── API Helpers ─────────────────────────────────────

async function apiPost(endpoint, body) {
  const res = await fetch(
    `https://${domain}.pipedrive.com/api/v1${endpoint}?api_token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return res.json();
}

async function apiGet(endpoint) {
  const res = await fetch(
    `https://${domain}.pipedrive.com/api/v1${endpoint}?api_token=${token}`
  );
  return res.json();
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Import Logic ────────────────────────────────────

async function importContacts() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Contact Import ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`  ${contacts.length} contacts to import`);
  console.log(`${'='.repeat(60)}\n`);

  // Check for existing persons to avoid duplicates
  const existingRes = await apiGet('/persons?limit=500');
  const existingEmails = new Set();
  for (const person of existingRes.data || []) {
    for (const email of person.email || []) {
      existingEmails.add(email.value.toLowerCase());
    }
  }

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const contact of contacts) {
    const emailLower = contact.email.toLowerCase();

    if (existingEmails.has(emailLower)) {
      console.log(`  SKIP: ${contact.name} (${contact.email}) - already exists`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY RUN] Would create: ${contact.name} (${contact.email}) → ${contact.stage}`);
      created++;
      continue;
    }

    try {
      // Create person
      const personBody = {
        name: contact.name,
        email: [contact.email],
        [OUTREACH_ATTEMPTS_KEY]: 0,
      };

      // Set lead source if available
      if (contact.leadSource && LEAD_SOURCE_OPTIONS[contact.leadSource]) {
        personBody[LEAD_SOURCE_KEY] = LEAD_SOURCE_OPTIONS[contact.leadSource];
      }

      const personRes = await apiPost('/persons', personBody);
      if (!personRes.success) {
        console.error(`  ERROR creating person ${contact.name}: ${JSON.stringify(personRes)}`);
        errors++;
        continue;
      }

      const personId = personRes.data.id;
      await sleep(200); // Rate limit

      // Create deal
      const dealBody = {
        title: `${contact.org || contact.name} - Satori Power`,
        person_id: personId,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGES[contact.stage],
      };

      const dealRes = await apiPost('/deals', dealBody);
      if (!dealRes.success) {
        console.error(`  ERROR creating deal for ${contact.name}: ${JSON.stringify(dealRes)}`);
        errors++;
        continue;
      }

      // Add notes if present
      if (contact.notes) {
        await sleep(200);
        await apiPost('/notes', {
          content: contact.notes,
          person_id: personId,
          deal_id: dealRes.data.id,
        });
      }

      console.log(`  ✔ ${contact.name} (${contact.email}) → ${contact.stage} [Person: ${personId}, Deal: ${dealRes.data.id}]`);
      created++;
      await sleep(200);
    } catch (err) {
      console.error(`  ERROR: ${contact.name}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Results: ${created} created, ${skipped} skipped, ${errors} errors`);
  console.log(`${'='.repeat(60)}\n`);
}

importContacts().catch(console.error);
