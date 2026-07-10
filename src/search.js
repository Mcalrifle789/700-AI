// Real web search for the /search skill. Dispatches to the provider the user
// configured in `700 setup`. For now only DuckDuckGo (keyless) is wired up and
// verified; additional providers are parked on the `search-all-providers`
// branch until search monetization lands (after the wallet is built).
const UA = '700-AI/1.17.8';
const enc = encodeURIComponent;

export async function webSearch(searchCfg, query, { limit = 6 } = {}) {
  if (!searchCfg || !searchCfg.id || searchCfg.id === 'none') {
    throw new Error('No search provider configured. Run 700 setup and pick one.');
  }
  const q = (query || '').trim();
  if (!q) throw new Error('Empty query.');
  if (searchCfg.id !== 'duckduckgo') throw new Error(`Unsupported search provider: ${searchCfg.id}`);
  return duckduckgo(q, limit);
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

// DuckDuckGo Instant Answer API — no key, but limited (abstracts + related topics).
async function duckduckgo(q, limit) {
  const res = await fetch(`https://api.duckduckgo.com/?q=${enc(q)}&format=json&no_html=1&skip_disambig=1`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const json = await res.json();
  const out = [];
  if (json.AbstractText) {
    out.push({ title: json.Heading || q, url: json.AbstractURL || '', snippet: json.AbstractText });
  }
  const walk = (arr) => {
    for (const t of arr || []) {
      if (t.Topics) walk(t.Topics);
      else if (t.FirstURL && t.Text) out.push({ title: t.Text.split(' - ')[0], url: t.FirstURL, snippet: clean(t.Text) });
    }
  };
  walk(json.RelatedTopics);
  walk(json.Results);
  return out.slice(0, limit);
}
