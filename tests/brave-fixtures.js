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

/**
 * A RICH web answer: the shape Brave sends for an entity query (one request, no extra parameter):
 * an infobox placed in `mixed.side`, FAQ, discussions, video and news blocks placed in
 * `mixed.main` between the results, sitelinks (deep_results.buttons) and a cluster on the top
 * results, and result thumbnails. Hostile values ride along: a javascript: sitelink and
 * profile, and an infobox attribute carrying markup.
 */
function richWeb(q) {
  const site = (i, host, title, desc, path, extra) => webResult(i, Object.assign({
    title, url: 'https://' + host + '/' + path.replace(/^› /, '').replace(/ › /g, '/'),
    description: desc,
    profile: { name: extra && extra.siteName || host, url: 'https://' + host, long_name: host, img: fav(host) },
    meta_url: { scheme: 'https', netloc: host, hostname: host, favicon: fav(host), path },
  }, extra && extra.over || {}));
  const results = [
    site(0, 'claude.ai', '<strong>Claude</strong>', 'Talk with <strong>Claude</strong>, an AI assistant from Anthropic. Write, analyze, code and think through hard problems together.', '', {
      siteName: 'Claude',
      over: {
        deep_results: { buttons: [
          { type: 'button_result', title: 'Log in', url: 'https://claude.ai/login' },
          { type: 'button_result', title: 'Pricing', url: 'https://claude.ai/pricing' },
          { type: 'button_result', title: 'Download apps', url: 'https://claude.ai/download' },
          { type: 'button_result', title: 'Bad button', url: 'javascript:alert(1)' },
          { type: 'button_result', title: 'Claude Code', url: 'https://claude.ai/code' },
          { type: 'button_result', title: 'Help center', url: 'https://support.claude.ai/' },
        ] },
      },
    }),
    site(1, 'www.anthropic.com', 'Meet <strong>Claude</strong> \\ Anthropic', '<strong>Claude</strong> is a family of AI models built by Anthropic to be helpful, honest and harmless, available in apps and through the API.', '› claude', {
      siteName: 'Anthropic',
      over: {
        thumbnail: { src: 'https://imgs.search.brave.com/thumb/anthropic.jpg' },
        cluster_type: 'generic',
        cluster: [
          { title: '<strong>Claude</strong> models overview', url: 'https://www.anthropic.com/claude/models', description: 'Compare the current <strong>Claude</strong> models by speed, price and capability.' },
          { title: 'API pricing', url: 'https://www.anthropic.com/pricing', description: 'Per-token prices for every model, with batch and caching discounts.' },
          { title: 'Bad cluster row', url: 'javascript:void(0)' },
        ],
      },
    }),
    site(2, 'en.wikipedia.org', '<strong>Claude</strong> (language model) - Wikipedia', '<strong>Claude</strong> is a series of large language models developed by Anthropic. The first model was released in March 2023.', '› wiki › Claude_(language_model)', { siteName: 'Wikipedia', over: { thumbnail: { src: 'https://imgs.search.brave.com/thumb/wiki.jpg' } } }),
    site(3, 'docs.anthropic.com', 'Intro to <strong>Claude</strong> - Anthropic docs', 'Get started with the <strong>Claude</strong> API: keys, your first request, streaming, tool use and prompt caching.', '› en › docs › intro', { siteName: 'Anthropic docs' }),
    site(4, 'www.theverge.com', 'Anthropic updates <strong>Claude</strong> with new tools', 'The latest release adds longer context and faster answers, and the apps get a redesigned sidebar.', '› ai › anthropic-claude', { siteName: 'The Verge', over: { age: 'October 2, 2026' } }),
    site(5, 'github.com', 'anthropics/claude-code', 'Claude Code is an agentic coding tool that lives in your terminal, understands your codebase and helps you code faster.', '› anthropics › claude-code', { siteName: 'GitHub' }),
    site(6, 'www.reddit.com', 'r/ClaudeAI', 'A community for discussing <strong>Claude</strong>, Anthropic\'s AI assistant: tips, prompts, news and help.', '› r › ClaudeAI', { siteName: 'Reddit' }),
    site(7, 'apps.apple.com', '<strong>Claude</strong> by Anthropic on the App Store', 'Download <strong>Claude</strong> for iPhone and iPad. Chat, upload files and images, and pick up conversations on any device.', '› app › claude', { siteName: 'App Store' }),
    site(8, 'play.google.com', '<strong>Claude</strong> by Anthropic - Apps on Google Play', 'Claude for Android: your conversations, projects and files, wherever you are.', '› store › apps', { siteName: 'Google Play' }),
    site(9, 'www.zdnet.com', 'What is <strong>Claude AI</strong>, and how does it compare?', 'A plain-English guide to what <strong>Claude</strong> can do, what it costs and how it differs from other assistants.', '› article › what-is-claude', { siteName: 'ZDNET' }),
  ];
  const infobox = {
    type: 'graph',
    results: [{
      type: 'infobox', subtype: 'generic', position: 1,
      title: 'Claude',
      url: 'https://en.wikipedia.org/wiki/Claude_(language_model)',
      description: 'Large language model',
      label: 'AI assistant',
      category: 'Large language model',
      long_desc: 'Claude is a family of large language models developed by Anthropic. The first model was released in March 2023, and later generations added image input, longer context windows, tool use and computer use. Claude is available through a chat interface on the web and in desktop and mobile apps, and to developers through an API and major cloud platforms. Anthropic trains Claude with a method it calls Constitutional AI, in which the model is guided by a written set of principles during training.',
      thumbnail: { src: 'https://imgs.search.brave.com/thumb/claude-ib.jpg' },
      attributes: [['Developer', 'Anthropic'], ['Initial release', 'March 14, 2023'], ['Type', 'Large language model'], ['License', 'Proprietary'], ['Markup', '<b>stays</b> text'], ['Empty', null]],
      profiles: [
        { name: 'X', url: 'https://x.com/claudeai', long_name: 'X (Twitter)', img: fav('x') },
        { name: 'YouTube', url: 'https://www.youtube.com/@anthropic-ai', long_name: 'YouTube', img: fav('youtube') },
        { name: 'Bad', url: 'javascript:alert(2)' },
      ],
      website_url: 'https://claude.ai/',
      profile: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Claude_(language_model)', long_name: 'Wikipedia' },
    }],
  };
  const faq = {
    type: 'faq',
    results: [
      { question: 'Is <strong>Claude</strong> free to use?', answer: 'Yes, there is a free plan with daily limits; paid plans raise the limits and add features.', title: 'Claude pricing explained', url: 'https://www.zdnet.com/article/claude-pricing', meta_url: { scheme: 'https', netloc: 'zdnet.com', hostname: 'www.zdnet.com', favicon: fav('zdnet'), path: '› article' } },
      { question: 'Who makes <strong>Claude</strong>?', answer: 'Claude is developed by Anthropic, an AI safety and research company based in San Francisco.', title: 'About Anthropic', url: 'https://www.anthropic.com/company', meta_url: { scheme: 'https', netloc: 'anthropic.com', hostname: 'www.anthropic.com', favicon: fav('anthropic'), path: '› company' } },
      { question: 'Can <strong>Claude</strong> read files?', answer: 'Claude can read PDFs, images, spreadsheets and code that you upload to a conversation.', title: 'Uploading files', url: 'https://support.claude.ai/files', meta_url: { scheme: 'https', netloc: 'support.claude.ai', hostname: 'support.claude.ai', favicon: fav('claude'), path: '› files' } },
      { question: 'Does <strong>Claude</strong> have an API?', answer: 'Yes. Developers call Claude through the Anthropic API with an API key, billed per token.', title: 'API docs', url: 'https://docs.anthropic.com/en/api', meta_url: { scheme: 'https', netloc: 'docs.anthropic.com', hostname: 'docs.anthropic.com', favicon: fav('docs'), path: '› en › api' } },
    ],
  };
  const discussions = {
    type: 'search',
    results: [0, 1, 2].map((i) => ({
      type: 'discussion',
      title: ['What do you actually use Claude for every day?', 'Claude vs other assistants for long documents', 'Tips for getting better code out of Claude'][i],
      url: 'https://www.reddit.com/r/ClaudeAI/comments/abc' + i,
      description: 'A thread about how people use <strong>Claude</strong> at work and at home.',
      age: (i + 2) + ' days ago',
      meta_url: { scheme: 'https', netloc: 'reddit.com', hostname: 'www.reddit.com', favicon: fav('reddit'), path: '› r › ClaudeAI' },
      data: { forum_name: 'r/ClaudeAI', num_answers: [214, 87, 42][i], score: ['1.2k', '356', '190'][i], title: 'thread', question: '', top_comment: ['Mostly drafting emails and untangling spreadsheets. It saves me an hour a day.', 'It held a 300-page contract in context and found the clause I needed.', 'Give it the failing test first, then ask for the smallest change.'][i] },
    })),
  };
  const vids = videos(q);
  vids.results.forEach((v, i) => { v.title = ['Claude in 100 seconds', 'Building an app with Claude Code', 'Claude vs the rest: a real test', 'How Anthropic trains Claude', 'Claude tips for beginners'][i]; v.video.creator = ['Fireship', 'Anthropic', 'Tech Review', 'Lex Talks', 'Ali Abdaal'][i]; });
  const nws = news(q);
  nws.results = nws.results.slice(0, 4);
  nws.results.forEach((n, i) => { n.title = ['Anthropic releases a new Claude model', 'Claude gets memory across chats', 'How companies are using Claude agents', 'Claude app passes a million downloads'][i]; n.profile.name = ['Reuters', 'The Verge', 'Bloomberg', 'TechCrunch'][i]; });
  const main = [
    { type: 'web', index: 0, all: false }, { type: 'web', index: 1, all: false },
    { type: 'news', all: true },
    { type: 'web', index: 2, all: false }, { type: 'web', index: 3, all: false },
    { type: 'faq', all: true },
    { type: 'web', index: 4, all: false },
    { type: 'videos', all: true },
    { type: 'web', index: 5, all: false }, { type: 'web', index: 6, all: false },
    { type: 'discussions', all: true },
    { type: 'web', index: 7, all: false }, { type: 'web', index: 8, all: false }, { type: 'web', index: 9, all: false },
  ];
  return {
    type: 'search',
    query: { original: q, spellcheck_off: true, more_results_available: true, is_navigational: true },
    mixed: { type: 'mixed', main, top: [], side: [{ type: 'infobox', all: true }] },
    web: { type: 'search', results, family_friendly: true },
    infobox, faq, discussions,
    videos: { type: 'videos', results: vids.results },
    news: { type: 'news', results: nws.results },
  };
}

module.exports = { web, news, videos, richWeb, error, ERRORS, rateHeaders, webResult };
