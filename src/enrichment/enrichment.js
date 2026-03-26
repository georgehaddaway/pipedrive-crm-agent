import config from '../config/index.js';

// ── In-Memory Cache ──────────────────────────────────

/** @type {Map<string, { webSnippets: string[] }>} email -> enrichment result */
const enrichmentCache = new Map();

/**
 * Enrich a contact with web search data about their company and role.
 * Uses DuckDuckGo search to fetch relevant snippets. No API keys required.
 * Never throws - returns empty enrichment on any failure.
 *
 * @param {Object} contact - Contact object with firstName, lastName, company, email
 * @returns {Promise<{ webSnippets: string[] }>}
 */
export async function enrichContact(contact) {
  if (!config.enrichment.enabled) {
    return { webSnippets: [] };
  }

  const cacheKey = contact.email?.toLowerCase();
  if (cacheKey && enrichmentCache.has(cacheKey)) {
    return enrichmentCache.get(cacheKey);
  }

  const result = { webSnippets: [] };

  try {
    const query = buildSearchQuery(contact);
    if (!query) return result;

    const snippets = await duckDuckGoSearch(query);
    result.webSnippets = snippets;

    // Cache the result for this run
    if (cacheKey) enrichmentCache.set(cacheKey, result);
  } catch (err) {
    console.warn(`  Web enrichment failed for ${contact.email}: ${err.message}`);
  }

  return result;
}

/**
 * Build a search query from contact data.
 * Prioritizes company + name for best results.
 *
 * @param {Object} contact
 * @returns {string|null}
 */
function buildSearchQuery(contact) {
  const parts = [];

  if (contact.firstName && contact.lastName) {
    parts.push(`${contact.firstName} ${contact.lastName}`);
  }

  if (contact.company) {
    parts.push(contact.company);
  }

  // Need at least company or full name to get useful results
  if (parts.length === 0) return null;

  return parts.join(' ');
}

/**
 * Search DuckDuckGo and extract result snippets from the HTML response.
 * No API key required.
 *
 * @param {string} query
 * @returns {Promise<string[]>} Array of snippet strings (max 5)
 */
async function duckDuckGoSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
    },
  });

  if (!res.ok) {
    console.warn(`  DuckDuckGo search error: ${res.status} ${res.statusText}`);
    return [];
  }

  const html = await res.text();

  // Parse result snippets from the DuckDuckGo HTML response
  const snippets = [];
  const resultRegex = /<a class="result__a"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let match;
  while ((match = resultRegex.exec(html)) !== null && snippets.length < 5) {
    const title = stripHtml(match[1]).trim();
    const snippet = stripHtml(match[2]).trim();
    if (title && snippet) {
      snippets.push(`${title} - ${snippet}`);
    }
  }

  // Fallback: try simpler snippet extraction if regex above didn't match
  if (snippets.length === 0) {
    const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    while ((match = snippetRegex.exec(html)) !== null && snippets.length < 5) {
      const text = stripHtml(match[1]).trim();
      if (text && text.length > 20) {
        snippets.push(text);
      }
    }
  }

  return snippets;
}

/**
 * Strip HTML tags from a string.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
}

/**
 * Clear the enrichment cache. Useful between runs.
 */
export function clearEnrichmentCache() {
  enrichmentCache.clear();
}
