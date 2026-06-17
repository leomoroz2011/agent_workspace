require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  'google.com', 'foursquare.com', 'nextdoor.com'
];

function isSocialOrDirectory(url) {
  if (!url) return false;
  return SOCIAL_OR_DIRECTORY_DOMAINS.some(d => url.includes(d));
}

// Health check — confirms API keys are present
app.get('/api/health', (req, res) => {
  res.json({
    googlePlaces: !!process.env.GOOGLE_PLACES_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY
  });
});

// Search Google Places for businesses in selected neighborhoods
app.post('/api/search', async (req, res) => {
  const { businessType, neighborhoods } = req.body;

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return res.status(400).json({ error: 'GOOGLE_PLACES_API_KEY not set in .env file' });
  }

  try {
    const allBusinesses = [];
    const seen = new Set();

    for (const hood of neighborhoods) {
      const query = `${BUSINESS_LABELS[businessType]} in ${NEIGHBORHOODS[hood]}`;

      const { data } = await axios.post(
        'https://places.googleapis.com/v1/places:searchText',
        { textQuery: query, maxResultCount: 20 },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
            'X-Goog-FieldMask': [
              'places.id',
              'places.displayName',
              'places.formattedAddress',
              'places.websiteUri',
              'places.rating',
              'places.userRatingCount',
              'places.nationalPhoneNumber',
              'places.reviews'
            ].join(',')
          }
        }
      );

      for (const p of (data.places || [])) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          allBusinesses.push({
            id: p.id,
            name: p.displayName?.text || 'Unknown',
            address: p.formattedAddress || '',
            website: p.websiteUri || null,
            phone: p.nationalPhoneNumber || '',
            rating: p.rating || null,
            reviewCount: p.userRatingCount || 0,
            reviews: (p.reviews || []).map(r => r.text?.text || '').filter(Boolean)
          });
        }
      }
    }

    res.json({ businesses: allBusinesses });
  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Analyze one business: website quality check + conversion score
app.post('/api/analyze', async (req, res) => {
  const { business } = req.body;

  const effectiveWebsite = business.website && !isSocialOrDirectory(business.website)
    ? business.website
    : null;

  const hasSocialOnly = business.website && isSocialOrDirectory(business.website);

  let websiteResult = null;

  if (effectiveWebsite) {
    let htmlSnippet = '';
    try {
      const r = await axios.get(effectiveWebsite, {
        timeout: 7000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; site-checker/1.0)' },
        maxRedirects: 3,
        maxContentLength: 300000
      });
      htmlSnippet = (r.data || '').toString().slice(0, 3500);
    } catch {
      htmlSnippet = '';
    }

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        messages: [{
          role: 'user',
          content: `Rate this small business website quality on a 1-10 scale (10=excellent modern site, 1=broken/terrible/no content).

${htmlSnippet
  ? `HTML (first 3500 chars):\n${htmlSnippet}`
  : `URL: ${effectiveWebsite}\nNote: Could not fetch page content — site may be slow or blocking.`}

Look for red flags: no mobile viewport meta tag, no online booking or contact form, outdated HTML structure (tables for layout, font tags), missing or broken navigation, no clear service info, generic template text, no social proof.

Reply with ONLY raw JSON, no markdown or backticks:
{"score":5,"flaws":["no mobile viewport","no booking"],"eligible":true,"summary":"Outdated, no booking"}`
        }]
      });

      const text = msg.content[0].text.trim()
        .replace(/^```json\n?/, '').replace(/\n?```$/, '');
      websiteResult = JSON.parse(text);
    } catch {
      websiteResult = {
        score: 5,
        flaws: ['Could not fully analyze'],
        eligible: true,
        summary: 'Analysis incomplete'
      };
    }
  }

  // Scan reviews for mentions of needing a website or online presence
  const allReviewText = business.reviews.join(' ').toLowerCase();
  const reviewMentionsWebsite = [
    'website', 'online booking', 'book online', "can't find", 'hard to find',
    'no website', 'social media only', 'instagram only', 'not online'
  ].some(kw => allReviewText.includes(kw));

  // Calculate conversion score
  let conversionScore = 0;

  if (!business.website) {
    // No website at all — easiest sell
    conversionScore = 80;
  } else if (hasSocialOnly) {
    // Only has Facebook/Instagram — nearly as easy
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

// Generate a cold email for a single prospect
app.post('/api/email', async (req, res) => {
  const { prospect, businessType, calendlyUrl } = req.body;

  let situation = '';
  if (!prospect.hasWebsite) {
    situation = `${prospect.name} has no website at all.${prospect.reviewMentionsWebsite ? ' Some reviewers mentioned having trouble finding them online.' : ''}`;
  } else if (prospect.hasSocialOnly) {
    situation = `${prospect.name} only has a Facebook or social media page — no real website.`;
  } else {
    const topFlaws = (prospect.websiteFlaws || []).slice(0, 3).join(', ') || 'general quality issues';
    situation = `${prospect.name} has a website but it needs work: ${topFlaws}. Site quality: ${prospect.websiteScore}/10.`;
  }

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 450,
      messages: [{
        role: 'user',
        content: `You're ghostwriting a cold email for Leo, a 14-year-old entrepreneur in San Francisco who builds websites.

Target business: ${prospect.name} (${businessType}) at ${prospect.address}
Situation: ${situation}
Leo's offer: He builds websites for ${businessType}s for FREE — he only asks for a testimonial if they're happy with the result. No catch, no contract.
CTA: Book a free 15-min call at ${calendlyUrl || 'https://calendly.com/leomoroz09'}

Leo's writing rules (follow these exactly):
- Body is 4-6 sentences MAX. Short. Every sentence earns its place.
- Casual confidence — sounds like a sharp teenager, not a marketing agency
- First sentence is specific to THIS business (what he noticed when he looked them up)
- Never uses: "I hope this finds you well", "I am reaching out", "I wanted to", "synergy", "leverage", "solutions"
- Free offer is stated simply — doesn't oversell or beg
- Ends with "— Leo" only, no last name, no title, no "Best regards"
- Subject line: specific and low-pressure, NOT "Free Website Offer!!" style

Reply with ONLY raw valid JSON, no markdown, no backticks:
{"subject":"the subject line","body":"the email body"}`
      }]
    });

    const text = msg.content[0].text.trim()
      .replace(/^```json\n?/, '').replace(/\n?```$/, '');
    res.json(JSON.parse(text));
  } catch (err) {
    console.error('Email gen error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nProspect Finder running at http://localhost:${PORT}\n`);
});
