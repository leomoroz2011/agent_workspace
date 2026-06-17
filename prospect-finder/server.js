require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const NEIGHBORHOODS = {
  'inner-sunset': 'Inner Sunset San Francisco CA',
  'outer-sunset': 'Outer Sunset San Francisco CA',
  'inner-richmond': 'Inner Richmond San Francisco CA',
  'outer-richmond': 'Outer Richmond San Francisco CA'
};

const BUSINESS_LABELS = {
  'barbershops': 'barbershop',
  'pet-groomers': 'pet groomer',
  'cafes': 'cafe'
};

const SOCIAL_OR_DIRECTORY_DOMAINS = [
  'facebook.com', 'instagram.com', 'yelp.com', 'tripadvisor.com',
  'google.com', 'foursquare.com', 'nextdoor.com', 'linktr.ee'
];

function isSocialOrDirectory(url) {
  if (!url) return false;
  return SOCIAL_OR_DIRECTORY_DOMAINS.some(d => url.includes(d));
}

// Rule-based website analysis — no AI needed
function analyzeHtml(html, url) {
  const lower = html.toLowerCase();
  const flaws = [];

  if (!lower.includes('viewport'))
    flaws.push('not mobile-friendly (no viewport tag)');

  const hasBooking = ['book', 'appointment', 'schedule', 'reserv', 'calendly', 'acuity', 'squareup'].some(kw => lower.includes(kw));
  if (!hasBooking)
    flaws.push('no online booking or scheduling');

  const hasContact = ['contact', 'tel:', 'mailto:', 'phone', 'call us'].some(kw => lower.includes(kw));
  if (!hasContact)
    flaws.push('no contact info visible');

  if (lower.includes('cellpadding') || lower.includes('cellspacing'))
    flaws.push('outdated table-based layout');

  if (!lower.includes('<nav') && !lower.includes('navigation') && !lower.includes('menu'))
    flaws.push('no clear navigation');

  const hasModernMeta = lower.includes('og:') || lower.includes('twitter:') || lower.includes('schema');
  if (!hasModernMeta)
    flaws.push('missing modern SEO/social meta tags');

  // Score: start at 10, subtract for each flaw
  const score = Math.max(1, Math.round(10 - flaws.length * 1.6));

  return {
    score,
    flaws,
    eligible: score <= 6,
    summary: flaws.length === 0 ? 'Looks decent' : flaws.slice(0, 2).join(', ')
  };
}

// Template-based cold email in Leo's voice — no AI needed
function buildEmail(prospect, businessType, calendlyUrl) {
  const name = prospect.name;
  const link = calendlyUrl || 'https://calendly.com/leomoroz09';
  const typeLabel = businessType === 'barbershops' ? 'barbershop'
    : businessType === 'pet-groomers' ? 'pet groomer' : 'cafe';

  if (!prospect.hasRealWebsite && !prospect.hasSocialOnly) {
    // No website at all
    return {
      subject: `Quick question for ${name}`,
      body: `Hey,\n\nLooked you up and couldn't find a website for ${name} — figured I'd reach out.\n\nI build websites for ${typeLabel}s in SF and I'm doing my first few for free to build my portfolio. All I ask for back is a testimonial if you like what I make.\n\nWould you be down for a quick 15-min call? ${link}\n\n— Leo`
    };
  }

  if (prospect.hasSocialOnly) {
    // Only social media
    return {
      subject: `${name} — quick thought`,
      body: `Hey,\n\nFound ${name} on social but noticed there's no actual website.\n\nI build websites for ${typeLabel}s in SF and I'm taking on a couple for free right now — just need a testimonial back if you like it. No catch.\n\nIf you're curious, grab a quick call here: ${link}\n\n— Leo`
    };
  }

  // Has a real website but with flaws
  const topFlaw = (prospect.websiteFlaws || [])[0];
  const flawLine = topFlaw
    ? `noticed ${topFlaw}`
    : 'noticed a few things that could be improved';

  return {
    subject: `Checked out ${name}'s website`,
    body: `Hey,\n\nChecked out ${name}'s site — ${flawLine}.\n\nI build websites for ${typeLabel}s in SF and I'd be down to redo yours for free. I'm building my portfolio and just need a testimonial back if you're happy with it.\n\nIf that sounds interesting, here's a quick call link: ${link}\n\n— Leo`
  };
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ foursquare: !!process.env.FOURSQUARE_API_KEY });
});

// Search Foursquare for businesses
app.post('/api/search', async (req, res) => {
  const { businessType, neighborhoods } = req.body;

  if (!process.env.FOURSQUARE_API_KEY) {
    return res.status(400).json({ error: 'FOURSQUARE_API_KEY not set in .env file' });
  }

  try {
    const allBusinesses = [];
    const seen = new Set();

    for (const hood of neighborhoods) {
      const { data } = await axios.get(
        'https://api.foursquare.com/v3/places/search',
        {
          params: {
            query: BUSINESS_LABELS[businessType],
            near: NEIGHBORHOODS[hood],
            limit: 20,
            fields: 'fsq_id,name,location,website,tel,rating,stats'
          },
          headers: {
            'Authorization': process.env.FOURSQUARE_API_KEY,
            'Accept': 'application/json'
          }
        }
      );

      for (const p of (data.results || [])) {
        if (!seen.has(p.fsq_id)) {
          seen.add(p.fsq_id);
          allBusinesses.push({
            id: p.fsq_id,
            name: p.name || 'Unknown',
            address: p.location?.formatted_address || '',
            website: p.website || null,
            phone: p.tel || '',
            rating: p.rating ? p.rating / 2 : null, // normalize 0-10 → 0-5
            reviewCount: p.stats?.total_ratings || 0,
            reviews: []
          });
        }
      }
    }

    res.json({ businesses: allBusinesses });
  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// Analyze one business
app.post('/api/analyze', async (req, res) => {
  const { business } = req.body;

  // Fetch tips/reviews from Foursquare
  let reviews = [];
  if (business.id && process.env.FOURSQUARE_API_KEY) {
    try {
      const { data } = await axios.get(
        `https://api.foursquare.com/v3/places/${business.id}/tips`,
        {
          params: { limit: 10, fields: 'text' },
          headers: { 'Authorization': process.env.FOURSQUARE_API_KEY, 'Accept': 'application/json' }
        }
      );
      reviews = (data.results || []).map(t => t.text || '').filter(Boolean);
    } catch { /* no reviews available */ }
  }

  const effectiveWebsite = business.website && !isSocialOrDirectory(business.website)
    ? business.website : null;
  const hasSocialOnly = !!(business.website && isSocialOrDirectory(business.website));

  let websiteResult = null;

  if (effectiveWebsite) {
    let html = '';
    try {
      const r = await axios.get(effectiveWebsite, {
        timeout: 7000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; site-checker/1.0)' },
        maxRedirects: 3,
        maxContentLength: 300000
      });
      html = (r.data || '').toString().slice(0, 5000);
    } catch { /* site unreachable */ }

    websiteResult = html
      ? analyzeHtml(html, effectiveWebsite)
      : { score: 4, flaws: ['website not loading or unreachable'], eligible: true, summary: 'Site unreachable' };
  }

  // Scan tips for website mentions
  const allTipText = reviews.join(' ').toLowerCase();
  const reviewMentionsWebsite = [
    'website', 'online booking', 'book online', "can't find", 'hard to find',
    'no website', 'social media only', 'instagram only', 'not online'
  ].some(kw => allTipText.includes(kw));

  // Conversion score
  let conversionScore = 0;
  if (!business.website) {
    conversionScore = 80;
  } else if (hasSocialOnly) {
    conversionScore = 72;
  } else {
    const q = websiteResult?.score || 5;
    if (q <= 3) conversionScore = 68;
    else if (q <= 5) conversionScore = 52;
    else if (q <= 7) conversionScore = 30;
    else conversionScore = 10;
  }
  if (reviewMentionsWebsite) conversionScore += 10;
  if (business.rating && business.rating < 3.5) conversionScore += 5;
  conversionScore = Math.min(95, conversionScore);

  res.json({
    ...business,
    reviews,
    hasRealWebsite: !!effectiveWebsite,
    hasSocialOnly,
    hasWebsite: !!business.website,
    websiteScore: websiteResult?.score ?? null,
    websiteFlaws: websiteResult?.flaws ?? [],
    websiteEligible: websiteResult?.eligible ?? false,
    websiteSummary: websiteResult?.summary ?? '',
    reviewMentionsWebsite,
    conversionScore
  });
});

// Generate cold email from templates (no AI)
app.post('/api/email', (req, res) => {
  const { prospect, businessType, calendlyUrl } = req.body;
  try {
    res.json(buildEmail(prospect, businessType, calendlyUrl));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nProspect Finder → http://localhost:${PORT}\n`);
});
