require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SEEN_FILE = path.join(__dirname, 'seen-prospects.json');

const NEIGHBORHOODS = {
  'inner-sunset':    'Inner Sunset San Francisco CA',
  'outer-sunset':    'Outer Sunset San Francisco CA',
  'inner-richmond':  'Inner Richmond San Francisco CA',
  'outer-richmond':  'Outer Richmond San Francisco CA',
  'mission':         'Mission District San Francisco CA',
  'castro':          'Castro San Francisco CA',
  'noe-valley':      'Noe Valley San Francisco CA',
  'haight':          'Haight-Ashbury San Francisco CA',
  'lower-haight':    'Lower Haight San Francisco CA',
  'north-beach':     'North Beach San Francisco CA',
  'marina':          'Marina District San Francisco CA',
  'pacific-heights': 'Pacific Heights San Francisco CA',
  'fillmore':        'Fillmore neighborhood Western Addition San Francisco CA',
  'bernal-heights':  'Bernal Heights San Francisco CA',
  'excelsior':       'Excelsior San Francisco CA',
  'portola':         'Portola San Francisco CA',
  'bayview':         'Bayview San Francisco CA',
  'potrero-hill':    'Potrero Hill San Francisco CA',
  'dogpatch':        'Dogpatch San Francisco CA',
  'glen-park':       'Glen Park San Francisco CA',
  'west-portal':     'West Portal San Francisco CA',
  'soma':            'SoMa San Francisco CA',
  'tenderloin':      'Tenderloin San Francisco CA',
  'chinatown':       'Chinatown San Francisco CA',
  'visitacion-valley': 'Visitacion Valley San Francisco CA'
};

const BUSINESS_LABELS = {
  'barbershops':  'barbershop',
  'pet-groomers': 'pet groomer',
  'cafes':        'cafe'
};

const YELP_CATEGORIES = {
  'barbershops':  'barbers',
  'pet-groomers': 'grooming',
  'cafes':        'coffee'
};

function normalizeName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function searchYelp(category, location) {
  const { data } = await axios.get('https://api.yelp.com/v3/businesses/search', {
    headers: { Authorization: `Bearer ${process.env.YELP_API_KEY}` },
    params: { categories: category, location, limit: 50, sort_by: 'best_match' }
  });
  return (data.businesses || []).map(b => ({
    id: `yelp_${b.id}`,
    name: b.name || 'Unknown',
    address: [b.location?.address1, b.location?.city].filter(Boolean).join(', '),
    website: null,
    phone: b.display_phone || b.phone || '',
    rating: b.rating || null,
    reviewCount: b.review_count || 0,
    source: 'yelp'
  }));
}

const SOCIAL_DOMAINS = [
  'facebook.com', 'instagram.com', 'yelp.com', 'tripadvisor.com',
  'google.com', 'foursquare.com', 'nextdoor.com', 'linktr.ee'
];

// Booking platforms — if any appear in the HTML, the site already has real booking
const BOOKING_PLATFORMS = [
  'vagaro.com', 'fresha.com', 'booksy.com', 'styleseat.com',
  'glossgenius.com', 'mindbodyonline.com', 'schedulicity.com',
  'acuityscheduling.com', 'calendly.com', 'squareup.com', 'square.site',
  'setmore.com', 'simplybook.me', 'appointy.com', 'resurva.com',
  'boulevard.app', 'zenoti.com', 'genbook.com', 'shortcuts.net',
  'timely.com', 'booker.com', 'salonbiz.com', 'meevo.com'
];

function isSocial(url) {
  return url ? SOCIAL_DOMAINS.some(d => url.includes(d)) : false;
}

// html     = first 15k of page  (phrase + structure checks — reliable at this size)
// fullHtml = full page up to 200k (booking platform detection only)
function analyzeHtml(html, fullHtml) {
  const lower = html.toLowerCase();
  const fullLower = (fullHtml || html).toLowerCase();
  const flaws = [];
  const goodSignals = [];

  // ── Booking platform: scan full page ─────────────────────────
  // Any linked booking platform means they have real booking — hard exclude
  const hasPlatformBooking = BOOKING_PLATFORMS.some(p => fullLower.includes(p));
  if (hasPlatformBooking) {
    return { score: 9, flaws: [], goodSignals: ['professional booking platform'], eligible: false };
  }

  // ── Everything below uses first 15k only ─────────────────────

  // Booking phrase — specific CTAs, not just the word "book"
  const hasBookingPhrase = /book\s*now|book\s*online|book\s*an?\s*appoint|schedule\s*online|online\s*booking|request\s*an?\s*appoint/.test(lower);
  if (!hasBookingPhrase) flaws.push('no online booking');

  // Mobile
  if (!lower.includes('viewport')) flaws.push('not mobile-friendly');

  // Contact
  if (!['tel:', 'mailto:', 'get in touch', 'contact us'].some(k => lower.includes(k))) {
    flaws.push('no contact info');
  }

  // Old/outdated HTML — structural, reliable regardless of HTML size
  if (lower.includes('cellpadding') || lower.includes('cellspacing')) flaws.push('table-based layout');
  if (lower.includes('<font ')) flaws.push('outdated font tags');
  if (/bgcolor\s*=/.test(lower)) flaws.push('outdated bgcolor');

  // Navigation
  const hasNav = lower.includes('<nav') || /(class|id)=["'][^"']*\bnav\b/i.test(html) || lower.includes('role="navigation"');
  if (!hasNav) flaws.push('no navigation');

  // Content
  const textLen = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  if (textLen < 250) flaws.push('almost no content');

  // Good signals — informational only, do NOT add to score
  // (a Wix site without booking is exactly who we're calling — bonuses were filtering them out)
  if (lower.includes('static.squarespace.com') || lower.includes('sqsp.net')) goodSignals.push('squarespace');
  if (lower.includes('static.wixstatic.com') || lower.includes('wixsite.com')) goodSignals.push('wix');
  if (lower.includes('webflow.io') || lower.includes('webflow.com')) goodSignals.push('webflow');
  if (lower.includes('googletagmanager.com') || lower.includes("gtag('config")) goodSignals.push('analytics');

  // multiplier 2.5: 0 flaws → 10 (filtered), 1 flaw → 7.5→8 (borderline), 2 flaws → 5 (eligible)
  const score = Math.max(1, Math.min(10, Math.round(10 - flaws.length * 2.5)));
  return { score, flaws, goodSignals, eligible: score <= 8 };
}

// ── Seen-list helpers ─────────────────────────────────────────────
// Format: { ids: [...], names: [...] }
// ids   = place_id or "name|address" strings from SerpAPI
// names = plain business names (case-insensitive) for pre-seeding
function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    if (Array.isArray(raw)) return { ids: raw, names: [] }; // legacy compat
    return { ids: raw.ids || [], names: raw.names || [] };
  } catch {
    return { ids: [], names: [] };
  }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2), 'utf8');
}

function isSeen(id, name, seen) {
  if (seen.ids.includes(id)) return true;
  const n = (name || '').toLowerCase().trim();
  return seen.names.some(s => s.toLowerCase().trim() === n);
}

// ── Routes ────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  try {
    const seen = loadSeen();
    res.json({
      serpapi: !!process.env.SERPAPI_KEY,
      yelp: !!process.env.YELP_API_KEY,
      seen: seen.ids.length + seen.names.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/seen', (req, res) => {
  try {
    const seen = loadSeen();
    res.json({ count: seen.ids.length + seen.names.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark prospects as seen (by id and/or name)
app.post('/api/seen', (req, res) => {
  try {
    const { ids, names } = req.body;
    const seen = loadSeen();
    for (const id of (ids || []))     { if (!seen.ids.includes(id))     seen.ids.push(id); }
    for (const name of (names || [])) { if (!seen.names.includes(name)) seen.names.push(name); }
    saveSeen(seen);
    res.json({ total: seen.ids.length + seen.names.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/seen', (req, res) => {
  try {
    saveSeen({ ids: [], names: [] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search — filters out already-seen prospects
app.post('/api/search', async (req, res) => {
  try {
    const { businessType, neighborhoods } = req.body;

    if (!process.env.SERPAPI_KEY && !process.env.YELP_API_KEY)
      return res.status(400).json({ error: 'No API keys configured — add SERPAPI_KEY or YELP_API_KEY to .env' });
    if (!businessType || !neighborhoods || !neighborhoods.length)
      return res.status(400).json({ error: 'businessType and neighborhoods are required' });

    const seen = loadSeen();
    const businesses = [];
    const dedupeId = new Set();
    const dedupeName = new Set(); // cross-source dedup by normalized name
    let skipped = 0;

    // Google Maps via SerpAPI
    if (process.env.SERPAPI_KEY) {
      for (const hood of neighborhoods) {
        const label = BUSINESS_LABELS[businessType];
        const location = NEIGHBORHOODS[hood];
        if (!label || !location) continue;

        const { data } = await axios.get('https://serpapi.com/search.json', {
          params: { engine: 'google_maps', q: `${label} in ${location}`, type: 'search', api_key: process.env.SERPAPI_KEY }
        });

        for (const p of (data.local_results || [])) {
          const id = p.place_id || `${p.title}|${p.address}`;
          if (dedupeId.has(id)) continue;
          const norm = normalizeName(p.title);
          if (dedupeName.has(norm)) continue;
          dedupeId.add(id);
          dedupeName.add(norm);
          if (isSeen(id, p.title, seen)) { skipped++; continue; }
          businesses.push({
            id,
            name: p.title || 'Unknown',
            address: p.address || '',
            website: p.website || null,
            phone: p.phone || '',
            rating: p.rating || null,
            reviewCount: p.reviews || 0,
            source: 'google'
          });
        }
      }
    }

    // Yelp
    if (process.env.YELP_API_KEY) {
      for (const hood of neighborhoods) {
        const category = YELP_CATEGORIES[businessType];
        const location = NEIGHBORHOODS[hood];
        if (!category || !location) continue;

        try {
          const yelpResults = await searchYelp(category, location);
          for (const p of yelpResults) {
            if (dedupeId.has(p.id)) continue;
            const norm = normalizeName(p.name);
            if (dedupeName.has(norm)) continue;
            dedupeId.add(p.id);
            dedupeName.add(norm);
            if (isSeen(p.id, p.name, seen)) { skipped++; continue; }
            businesses.push(p);
          }
        } catch (err) {
          console.error(`Yelp error (${hood}):`, err.message);
        }
      }
    }

    res.json({ businesses, skipped });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Analyze one business
app.post('/api/analyze', async (req, res) => {
  try {
    const { business } = req.body;
    if (!business) return res.status(400).json({ error: 'business is required' });

    const effectiveWebsite = business.website && !isSocial(business.website) ? business.website : null;
    const hasSocialOnly = !!(business.website && isSocial(business.website));

    let websiteResult = null;
    if (effectiveWebsite) {
      let html = '';
      try {
        const r = await axios.get(effectiveWebsite, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; site-checker/1.0)' },
          maxRedirects: 5, maxContentLength: 2000000
        });
        html = (r.data || '').toString().slice(0, 200000);
      } catch { /* unreachable site */ }
      // Pass full HTML for booking platform detection, first 15k for phrase/structure checks
      websiteResult = html
        ? analyzeHtml(html.slice(0, 15000), html)
        : { score: 4, flaws: ['website not loading'], eligible: true };
    }

    let conversionScore = 0;
    if (!business.website)        conversionScore = 80;
    else if (hasSocialOnly)        conversionScore = 72;
    else {
      const q = websiteResult?.score || 5;
      if (q <= 2)      conversionScore = 70;  // terrible — basically no site
      else if (q <= 5) conversionScore = 58;  // bad site
      else if (q <= 8) conversionScore = 45;  // any site with 1+ flaws — worth a shot
      else             conversionScore = 0;   // perfect site (0 flaws) — filtered out
    }
    if (business.rating && business.rating < 3.5) conversionScore = Math.min(conversionScore + 5, 80);
    conversionScore = Math.min(95, conversionScore);

    res.json({
      ...business,
      hasRealWebsite: !!effectiveWebsite,
      hasSocialOnly,
      websiteScore: websiteResult?.score ?? null,
      websiteFlaws: websiteResult?.flaws ?? [],
      conversionScore
    });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Export clean CSV
app.post('/api/export', (req, res) => {
  try {
    const { prospects, businessType } = req.body;
    const FOLDER_MAP = { 'barbershops': 'Barbershop Prospects', 'pet-groomers': 'Pet Groomer Prospects', 'cafes': 'Cafe Prospects' };
    const folderName = FOLDER_MAP[businessType] || 'Prospects';
    const folderPath = path.join(__dirname, '..', folderName);
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(folderPath, `${folderName} — ${date}.csv`);

    const rows = [['Rank', 'Business Name', 'Address', 'Phone', 'Has Website', 'Site Score', 'Conversion %', 'Source']];
    (prospects || []).forEach((p, i) => {
      rows.push([
        i + 1, p.name, p.address, p.phone || '',
        p.hasRealWebsite ? 'Yes' : (p.hasSocialOnly ? 'Social Only' : 'No'),
        p.websiteScore != null ? p.websiteScore : '',
        p.conversionScore + '%',
        p.source === 'yelp' ? 'Yelp' : 'Google'
      ]);
    });

    const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(filePath, csv, 'utf8');
    res.json({ success: true, fileName: path.basename(filePath), folder: folderName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\nProspect Finder → http://localhost:${PORT}\n`));
