// tests/brave-fixtures.js — recorded shapes of Brave Search API answers, for bravesearch-harness.js
// and bravesearch-e2e.js. Field names and nesting follow Brave's public API reference
// (api-dashboard.search.brave.com, Web/News/Video search responses and the ErrorResponse model);
// the values are made up. Two hostile rows ride along on purpose: a javascript: link (must be
// dropped) and a description carrying <script>/<img onerror> (must reach the page as text).
'use strict';

const fav = (host) => 'https://imgs.search.brave.com/fav/' + host + '.png';

function webResult(i, over) {
  return Object.assign({
    type: 'search_result',
    subtype: 'generic',
    title: 'Quartz crystal <strong>result</strong> number ' + i,
    url: 'https://example' + i + '.com/articles/quartz-' + i,
    is_source_local: false,
    is_source_both: false,
    description: 'A <strong>quartz</strong> crystal is a piece of silicon dioxide &amp; it keeps time in watch number ' + i + '.',
    page_age: '2026-10-0' + ((i % 9) + 1) + 'T10:00:00',
    age: (i + 1) + ' days ago',
    language: 'en',
    family_friendly: true,
    profile: { name: 'Example ' + i, url: 'https://example' + i + '.com', long_name: 'example' + i + '.com', img: fav('example' + i) },
    meta_url: { scheme: 'https', netloc: 'example' + i + '.com', hostname: 'example' + i + '.com', favicon: fav('example' + i), path: '› articles › quartz-' + i },
  }, over || {});
}

function web(q, count) {
  const results = [];
  for (let i = 0; i < count; i++) results.push(webResult(i));
  // hostile rows
  results.push(webResult(98, { title: 'Bad link', url: 'javascript:alert(1)' }));
  results.push(webResult(99, {
    title: 'Escapes <em>fine</em>',
    url: 'https://hostile.example/x',
    description: 'Text <script>window.__pwned=1</script> and <img src=x onerror="window.__pwned=2"> stays text with <strong>bold</strong>.',
    meta_url: { scheme: 'https', netloc: 'hostile.example', hostname: 'hostile.example', favicon: 'http://insecure.example/f.png', path: '› x' },
  }));
  return {
    type: 'search',
    query: { original: q, show_strict_warning: false, is_navigational: false, is_news_breaking: false, spellcheck_off: true, country: 'us', bad_results: false, should_fallback: false, postal_code: '', city: '', header_country: '', more_results_available: true, state: '' },
    mixed: { type: 'mixed', main: results.map((_, i) => ({ type: 'web', index: i, all: false })), top: [], side: [] },
    web: { type: 'search', results, family_friendly: true },
  };
}

function news(q) {
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push({
      type: 'news_result',
      title: 'Quartz news story ' + i,
      url: 'https://news' + i + '.example/story-' + i,
      description: 'Reporters looked at <strong>quartz</strong> today, story ' + i + '.',
      age: (i + 1) + ' hours ago',
      page_age: '2026-10-14T0' + i + ':00:00',
      breaking: i === 0,
      meta_url: { scheme: 'https', netloc: 'news' + i + '.example', hostname: 'news' + i + '.example', favicon: fav('news' + i), path: '› story-' + i },
      thumbnail: { src: 'https://imgs.search.brave.com/thumb/news' + i + '.jpg' },
      profile: { name: 'News Desk ' + i },
    });
  }
  return { type: 'news', query: { original: q, spellcheck_off: true, more_results_available: false }, results };
}

function videos(q) {
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push({
      type: 'video_result',
      title: 'How quartz watches work, part ' + (i + 1),
      url: 'https://www.youtube.com/watch?v=quartz' + i,
      description: 'A <strong>quartz</strong> movement explained, part ' + (i + 1) + '.',
      age: 'March ' + (i + 1) + ', 2026',
      page_age: '2026-03-0' + (i + 1) + 'T00:00:00',
      video: { duration: (i + 3) + ':0' + i, views: 1234567 * (i + 1), creator: 'Watch Channel ' + i, publisher: 'YouTube' },
      meta_url: { scheme: 'https', netloc: 'youtube.com', hostname: 'www.youtube.com', favicon: fav('youtube'), path: '› watch' },
      thumbnail: { src: 'https://imgs.search.brave.com/thumb/video' + i + '.jpg', original: 'https://i.ytimg.com/vi/quartz' + i + '/hqdefault.jpg' },
    });
  }
  return { type: 'videos', query: { original: q, spellcheck_off: true, more_results_available: false }, results };
}

/** Brave's ErrorResponse model. */
function error(status, code, detail, meta) {
  return { type: 'ErrorResponse', error: { id: '6f1c0f0e-0000-4000-8000-00000000' + String(status).padStart(4, '0'), status, code, detail, meta: meta || {} }, time: 1760400000 };
}

const ERRORS = {
  badKey: () => error(422, 'SUBSCRIPTION_TOKEN_INVALID', 'The provided subscription token is invalid.', { component: 'authentication' }),
  rate: () => error(429, 'RATE_LIMITED', 'Request rate limit exceeded for plan.', { plan: 'Free', rate_limit: 1, rate_current: 2, quota_limit: 2000, quota_current: 15, component: 'rate_limiter' }),
  quota: () => error(429, 'RATE_LIMITED', 'Request rate limit exceeded for plan.', { plan: 'Free', rate_limit: 1, rate_current: 1, quota_limit: 2000, quota_current: 2000, component: 'rate_limiter' }),
};

/** Brave's rate headers: "per-second, per-month". */
function rateHeaders(remainingMonth) {
  return {
    'X-RateLimit-Limit': '1, 2000',
    'X-RateLimit-Policy': '1;w=1, 2000;w=2592000',
    'X-RateLimit-Remaining': '0, ' + remainingMonth,
    'X-RateLimit-Reset': '1, 1419704',
  };
}

module.exports = { web, news, videos, error, ERRORS, rateHeaders, webResult };
