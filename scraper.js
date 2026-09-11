const { chromium } = require('patchright');
const fs = require('fs');
const path = require('path');

const wordpressUrl = process.env.WORDPRESS_URL || 'https://guildera.ai';
const uploadKey = process.env.WORDPRESS_UPLOAD_KEY || '';
const configJson = process.env.CONFIG_JSON || '{}';
const config = JSON.parse(configJson);

console.log('=== ENV ===');
console.log('SOURCE_TYPE:', process.env.SOURCE_TYPE);
console.log('TARGET:', process.env.TARGET);
console.log('MAX_RESULTS:', process.env.MAX_RESULTS);
console.log('MEDIA_ONLY:', process.env.MEDIA_ONLY);

const sourceType = process.env.SOURCE_TYPE || config.source_type || 'user';
const target = process.env.TARGET || config.target || '';
const maxResults = parseInt(process.env.MAX_RESULTS || config.max_results, 10) || 10;
const mediaOnly = (process.env.MEDIA_ONLY === 'true') || (config.media_only === true);
const keyHash = process.env.KEY_HASH || config.key_hash || '';
console.log('KEY_HASH (first 12):', keyHash ? keyHash.substring(0, 12) + '...' : 'EMPTY');
const startDate = process.env.START_DATE || config.start_date || '';
const endDate = process.env.END_DATE || config.end_date || '';
const rawQuery = process.env.RAW_QUERY || config.raw_query || '';
const minLikes = parseInt(process.env.MIN_LIKES || config.min_likes || '0', 10) || 0;
const minRetweets = parseInt(process.env.MIN_RETWEETS || config.min_retweets || '0', 10) || 0;
const minReplies = parseInt(process.env.MIN_REPLIES || config.min_replies || '0', 10) || 0;
const minViews = parseInt(process.env.MIN_VIEWS || config.min_views || '0', 10) || 0;
const sourceAccount = process.env.SOURCE_ACCOUNT || config.source_account || '';
const sortBy = process.env.SORT_BY || config.sort_by || 'default';
const filterReplies = process.env.FILTER_REPLIES || config.filter_replies || 'all';

if (!wordpressUrl || !uploadKey) {
  console.error('Missing WORDPRESS_URL or WORDPRESS_UPLOAD_KEY');
  process.exit(1);
}

if (!target && !rawQuery) {
  console.error('Missing target or raw_query in env or CONFIG_JSON');
  process.exit(1);
}

function parseEngagementNum(str) {
  if (!str) return 0;
  str = String(str).replace(/,/g, '').trim();
  const match = str.match(/([\d.]+)\s*([KkMm]?)/);
  if (!match) return 0;
  let num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  if (suffix === 'K') num *= 1000;
  else if (suffix === 'M') num *= 1000000;
  return Math.round(num);
}

(async () => {
  const proxyHost = process.env.PROXY_HOST || '';
  const proxyPort = process.env.PROXY_PORT || '';
  const proxyUser = process.env.PROXY_USER || '';
  const proxyPass = process.env.PROXY_PASS || '';

  const launchOptions = {
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  if (proxyHost && proxyPort) {
    launchOptions.proxy = {
      server: `http://${proxyHost}:${proxyPort}`,
      username: proxyUser || undefined,
      password: proxyPass || undefined
    };
    console.log(`Using proxy: ${proxyHost}:${proxyPort}`);
  }

  const browser = await chromium.launch(launchOptions);

  let storageStatePath = path.join(__dirname, 'state.json');
  if (process.env.X_STATE) {
    storageStatePath = path.join(__dirname, 'state-ci.json');
    fs.writeFileSync(storageStatePath, Buffer.from(process.env.X_STATE, 'base64').toString());
  }

  const contextOptions = { viewport: { width: 1280, height: 900 } };
  if (fs.existsSync(storageStatePath)) contextOptions.storageState = storageStatePath;

  const context = await browser.newContext(contextOptions);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  let url = '';
  // Build X search operators
  let searchOps = '';
  if (filterReplies === 'posts') searchOps += '%20-is:quote%20-is:reply';
  else if (filterReplies === 'posts_include_quotes') searchOps += '%20-is:reply';
  else if (filterReplies === 'replies') searchOps += '%20-is:quote%20is:reply';
  if (mediaOnly) searchOps += '%20has:media';

  if (rawQuery) {
    // Append filter to raw query
    const sep = rawQuery.includes('-is:') ? '' : '%20';
    url = `https://x.com/search?q=${encodeURIComponent(rawQuery)}${searchOps}&src=typed_query&f=live`;
  } else {
    switch (sourceType) {
      case 'user': {
        const username = target.replace('@', '').trim();
        url = `https://x.com/${username}`;
        break;
      }
      case 'hashtag': {
        const tag = target.replace('#', '').trim();
        let q = `%23${encodeURIComponent(tag)}`;
        if (startDate) q += `%20since:${startDate}`;
        if (endDate) q += `%20until:${endDate}`;
        if (minLikes > 0) q += `%20min_faves:${minLikes}`;
        if (minRetweets > 0) q += `%20min_retweets:${minRetweets}`;
        if (minReplies > 0) q += `%20min_replies:${minReplies}`;
        q += searchOps;
        url = `https://x.com/search?q=${q}&src=typed_query&f=live`;
        break;
      }
      case 'keyword': {
        let q = encodeURIComponent(target);
        if (sourceAccount) q += `%20from:${sourceAccount.replace('@', '')}`;
        if (startDate) q += `%20since:${startDate}`;
        if (endDate) q += `%20until:${endDate}`;
        if (minLikes > 0) q += `%20min_faves:${minLikes}`;
        if (minRetweets > 0) q += `%20min_retweets:${minRetweets}`;
        if (minReplies > 0) q += `%20min_replies:${minReplies}`;
        q += searchOps;
        url = `https://x.com/search?q=${q}&src=typed_query&f=live`;
        break;
      }
      case 'cashtag': {
        let tagText = target.replace('$', '').trim();
        let tag = tagText.split(/\s+/)[0];
        let q = `%24${encodeURIComponent(tag)}`;
        if (sourceAccount) q += `%20from:${sourceAccount.replace('@', '')}`;
        const sinceMatch = target.match(/\bsince:(\S+)/i);
        const untilMatch = target.match(/\buntil:(\S+)/i);
        if (sinceMatch) q += `%20since:${sinceMatch[1]}`;
        else if (startDate) q += `%20since:${startDate}`;
        if (untilMatch) q += `%20until:${untilMatch[1]}`;
        else if (endDate) q += `%20until:${endDate}`;
        if (minLikes > 0) q += `%20min_faves:${minLikes}`;
        if (minRetweets > 0) q += `%20min_retweets:${minRetweets}`;
        if (minReplies > 0) q += `%20min_replies:${minReplies}`;
        q += searchOps;
        url = `https://x.com/search?q=${q}&src=typed_query&f=live`;
        break;
      }
      case 'url': {
        url = target.startsWith('http') ? target : `https://x.com/${target}`;
        break;
      }
      default:
        url = `https://x.com/${target.replace('@', '')}`;
    }
  }

  console.log(`Scraping: ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for first article to appear (up to 10s) instead of fixed 4s
  try {
    await page.waitForSelector('article', { timeout: 10000 });
    console.log('Articles loaded');
  } catch (e) {
    console.log('No articles found after 10s, checking page state...');
    const loginWall = await page.locator('[data-testid="loginButton"], [data-testid="signupButton"]').count();
    if (loginWall > 0) {
      console.log('ERROR: Login wall detected. X_STATE cookies expired.');
    }
  }

  const collectedIds = new Set();
  let posts = [];
  let scrollAttempts = 0;
  const collectTarget = maxResults;
  const maxScrollAttempts = collectTarget * 3;
  let consecutiveEmptyScrolls = 0;
  const username = target.replace('@', '').trim();

  // ─── BATCH EXTRACTION: runs entirely in browser, ONE round-trip ───
  async function extractPostsFromDOM() {
    const newPosts = await page.evaluate(({ username, existingIds }) => {
      const articles = document.querySelectorAll('article');
      const results = [];

      for (const article of articles) {
        try {
          // Text
          const text = (article.innerText || '').trim();
          if (!text || text.length < 10) continue;

          // Link + tweet ID
          let href = '';
          const linkEl = article.querySelector('a[href*="/status/"]');
          if (linkEl) href = linkEl.getAttribute('href') || '';

          let tweetAuthor = username;
          let tweetHandle = '@' + username;
          if (href) {
            const parts = href.split('/status/');
            if (parts[0]) {
              const handle = parts[0].replace(/^\//, '').trim();
              if (handle) { tweetAuthor = handle; tweetHandle = '@' + handle; }
            }
          }

          const tweetUrl = href ? 'https://x.com' + href : '';

          // Tweet ID
          let tweetId = '';
          if (href) {
            const idPart = href.split('/status/')[1];
            if (idPart) tweetId = idPart.split('?')[0];
          }
          if (!tweetId) tweetId = 'unknown-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

          // Skip already collected
          if (existingIds.includes(tweetId)) continue;

          // Time
          let postTime = '';
          const timeEl = article.querySelector('time');
          if (timeEl) postTime = timeEl.getAttribute('datetime') || timeEl.textContent || '';
          if (!postTime || postTime.length < 5) {
            const m = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/);
            if (m) postTime = m[0];
          }
          if (!postTime) postTime = new Date().toISOString();

          // Avatar
          let authorAvatar = '';
          const avatarEl = article.querySelector('img[src*="profile_images"]');
          if (avatarEl) authorAvatar = (avatarEl.getAttribute('src') || '').split('?')[0];

          // Verified
          const isVerified = !!article.querySelector('[aria-label="Verified account"], [aria-label="Verified"]');

          // Media
          const mediaUrls = [];
          const imgs = article.querySelectorAll('img[src*="pbs.twimg.com/media"], img[src*="pbs.twimg.com/card_media"], img[src*="pbs.twimg.com/ext_tw_video"]');
          for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            if (src && !src.includes('profile_images') && !src.includes('emoji')) {
              mediaUrls.push(src.split('?')[0]);
            }
          }
          const videoEl = article.querySelector('[data-testid="videoPlayer"] video, [data-testid="videoPlayerContainer"] video');
          if (videoEl) {
            const vs = videoEl.getAttribute('src');
            if (vs) mediaUrls.push(vs);
          }
          const hasMedia = mediaUrls.length > 0 || text.includes('pic.twitter.com');

          // Engagement from [role="group"] — use LAST group (outer post, not quoted post)
          let likeCount = 0, retweetCount = 0, replyCount = 0, quoteCount = 0;
          const groupEls = article.querySelectorAll('[role="group"]');
          // Debug: log all groups found for quoted posts
          if (groupEls.length > 1) {
            const allGroupTexts = [];
            for (let g = 0; g < groupEls.length; g++) {
              allGroupTexts.push('g' + g + '="' + (groupEls[g].innerText || '').substring(0, 60).replace(/\n/g, ' ') + '"');
            }
            console.log('  MULTI-GROUP (' + groupEls.length + '): ' + allGroupTexts.join(' | '));
          }
          const groupEl = groupEls.length > 0 ? groupEls[groupEls.length - 1] : null;
          const groupIndex = groupEls.length > 0 ? groupEls.length - 1 : -1;
          if (groupEl) {
            const groupText = groupEl.innerText || '';
            const nums = groupText.match(/[\d,.]+[KkMm]?/g) || [];
            if (nums.length >= 4) {
              likeCount = nums[0]; retweetCount = nums[1]; replyCount = nums[2]; quoteCount = nums[3];
            } else if (nums.length === 3) {
              likeCount = nums[0]; replyCount = nums[1]; retweetCount = nums[2];
            } else if (nums.length === 2) {
              likeCount = nums[0]; replyCount = nums[1];
            }
          }

          // Engagement fallback: data-testid
          if (!likeCount && !retweetCount && !replyCount) {
            for (const tid of ['reply', 'retweet', 'like', 'unlike']) {
              const el = article.querySelector('[data-testid="' + tid + '"]');
              if (el) {
                const val = el.getAttribute('aria-label') || el.textContent || '';
                if (tid === 'reply') replyCount = val;
                else if (tid === 'retweet') retweetCount = val;
                else if (tid === 'like' || tid === 'unlike') likeCount = val;
              }
            }
            const quoteEl = article.querySelector('[data-testid="quote"]');
            if (quoteEl) quoteCount = quoteEl.getAttribute('aria-label') || '';
          }

          // Views — try strategies
          let viewCount = 0;
          // Check if this is a quoted post or retweet (views unreliable for these)
          const isQuotedPost = !!article.querySelector('[data-testid="quote"], article');
          const isRetweet = text.includes('reposted') || text.includes('Reposted');
          const skipViewFallback = isQuotedPost || isRetweet;

          // Strategy 1: analytics link (most reliable, use LAST for quoted posts)
          const viewAnchors = article.querySelectorAll('a[href*="/analytics"]');
          const viewAnchor = viewAnchors.length > 0 ? viewAnchors[viewAnchors.length - 1] : null;
          if (viewAnchor) {
            const vt = viewAnchor.innerText || '';
            const vm = vt.match(/([\d.,]+[KkMm]?)\s*Views/i);
            if (vm) viewCount = vm[1];
          }
          // Strategy 2-4: only for regular posts (unreliable for quoted/retweeted posts)
          if (!viewCount && !skipViewFallback) {
            // Strategy 2: aria-label
            const viewAria = article.querySelector('[aria-label*="view" i], [aria-label*="View" i]');
            if (viewAria) {
              const label = viewAria.getAttribute('aria-label') || '';
              const vm = label.match(/([\d.,]+[KkMm]?)\s*[Vv]iew/i);
              if (vm) viewCount = vm[1];
            }
            // Strategy 3: text with "Views"
            if (!viewCount) {
              const allEls = article.querySelectorAll('span, div, a');
              for (const el of allEls) {
                const t = el.textContent || '';
                if (/[\d.,]+[KkMm]?\s*[Vv]iew/i.test(t)) {
                  const vm = t.match(/([\d.,]+[KkMm]?)\s*[Vv]iew/i);
                  if (vm) { viewCount = vm[1]; break; }
                }
              }
            }
            // Strategy 4: regex on post text
            if (!viewCount) {
              const vm = text.match(/([\d.,]+[KkMm]?)\s*Views/i);
              if (vm) viewCount = vm[1];
            }
          }

          results.push({
            tweet_id: tweetId,
            author: tweetAuthor,
            username: tweetHandle,
            text: text.substring(0, 2000),
            created_at: postTime,
            url: tweetUrl,
            retweet_count: retweetCount,
            like_count: likeCount,
            reply_count: replyCount,
            quote_count: quoteCount,
            view_count: viewCount,
            has_media: hasMedia,
            media_urls: mediaUrls.length > 0 ? JSON.stringify(mediaUrls) : '',
            author_avatar: authorAvatar,
            is_verified: isVerified,
            _debug_groups: groupEls.length,
            _debug_groupIdx: groupIndex,
          });
        } catch (e) {
          // skip broken article
        }
      }
      return results;
    }, { username, existingIds: Array.from(collectedIds) });

    // Process results in Node.js (parsing, filtering, dedup)
    let added = 0;
    for (const raw of newPosts) {
      if (posts.length >= collectTarget) break;
      if (collectedIds.has(raw.tweet_id)) continue;
      collectedIds.add(raw.tweet_id);

      // Parse engagement numbers (returned as strings from browser)
      const likeCount = parseEngagementNum(raw.like_count);
      const retweetCount = parseEngagementNum(raw.retweet_count);
      const replyCount = parseEngagementNum(raw.reply_count);
      const quoteCount = parseEngagementNum(raw.quote_count);
      const viewCount = parseEngagementNum(raw.view_count);

      // Debug: log engagement for posts with multiple groups
      if (raw._debug_groups > 1) {
        console.log('  POST groups=' + raw._debug_groups + ' idx=' + raw._debug_groupIdx + ' likes=' + likeCount + ' rt=' + retweetCount + ' replies=' + replyCount + ' views=' + viewCount + ' text=' + raw.text.substring(0, 50).replace(/\n/g, ' '));
      }

      // Media filter
      if (mediaOnly && !raw.has_media) continue;

      // Pre-filter by sort_by thresholds
      if (sortBy === 'likes' && likeCount < 3) continue;
      if (sortBy === 'retweets' && retweetCount < 2) continue;
      if (sortBy === 'views' && viewCount < 200) continue;
      if (sortBy === 'engagement') {
        const weightedEng = likeCount * 1.0 + replyCount * 1.5 + viewCount * 0.001;
        if (weightedEng < 3) continue;
      }

      posts.push({ ...raw, like_count: likeCount, retweet_count: retweetCount, reply_count: replyCount, quote_count: quoteCount, view_count: viewCount });
      added++;
    }
    return added;
  }

  while (scrollAttempts < maxScrollAttempts && posts.length < collectTarget) {
    const prevCount = posts.length;
    const newPosts = await extractPostsFromDOM();
    console.log(`Scroll ${scrollAttempts + 1}: +${newPosts} (total: ${posts.length}/${collectTarget})`);
    if (newPosts === 0) {
      consecutiveEmptyScrolls++;
      if (consecutiveEmptyScrolls >= 5) {
        console.log('5 consecutive empty scrolls — no more posts');
        break;
      }
    } else {
      consecutiveEmptyScrolls = 0;
    }
    if (posts.length >= collectTarget) break;
    await page.evaluate(() => window.scrollBy(0, 2400));
    await page.waitForTimeout(1000);
    scrollAttempts++;
  }
  console.log(`Final collection: ${posts.length} posts`);

  // Post-collection filters
  const beforeFilter = posts.length;
  if (minLikes > 0) posts = posts.filter(p => p.like_count >= minLikes);
  if (posts.length < beforeFilter) console.log(`Like filter: ${beforeFilter} -> ${posts.length} (min_likes=${minLikes})`);

  const beforeViewFilter = posts.length;
  if (minViews > 0) posts = posts.filter(p => p.view_count >= minViews);
  if (posts.length < beforeViewFilter) console.log(`View filter: ${beforeViewFilter} -> ${posts.length} (min_views=${minViews})`);

  if (posts.length > maxResults) posts = posts.slice(0, maxResults);

  console.log(`Saving ${posts.length} posts to WordPress...`);

  const toSave = posts.map(p => ({
    api_key_hash: keyHash,
    post_id: String(p.tweet_id).startsWith('unknown-') ? '' : String(p.tweet_id),
    author_id: '',
    author_username: p.username ? p.username.replace('@', '') : (p.author || ''),
    author_name: p.author || '',
    author_avatar: p.author_avatar || '',
    text: p.text || '',
    created_at: p.created_at || '',
    like_count: p.like_count || 0,
    retweet_count: p.retweet_count || 0,
    reply_count: p.reply_count || 0,
    quote_count: p.quote_count || 0,
    view_count: p.view_count || 0,
    bookmark_count: 0,
    impression_count: 0,
    media_urls: (() => { try { return p.media_urls ? JSON.parse(p.media_urls) : []; } catch(e) { return []; } })(),
    urls: [],
    hashtags: [],
    mentions: [],
    is_reply: false,
    is_retweet: false,
    is_quote: false,
    is_verified: p.is_verified || false,
    language: '',
    source: 'x',
    search_query: process.env.SEARCH_QUERY || '',
  }));

  if (toSave.length > 0) {
    try {
      const resp = await fetch(`${wordpressUrl}/wp-admin/admin-ajax.php?action=guildera_scraper_save_posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Key': uploadKey },
        body: JSON.stringify({ posts: toSave }),
      });
      console.log(`save_posts response: ${resp.status}`);
    } catch (err) {
      console.log(`save_posts error: ${err.message}`);
    }
  } else {
    console.log('No posts to save.');
    try {
      await fetch(`${wordpressUrl}/wp-admin/admin-ajax.php?action=guildera_scraper_scrape_complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Key': uploadKey },
        body: JSON.stringify({ api_key_hash: keyHash, search_query: process.env.SEARCH_QUERY || '', posts_found: 0 }),
      });
    } catch (err) {}
  }

  await context.close();
  await browser.close();
  if (process.env.X_STATE && fs.existsSync(storageStatePath)) fs.unlinkSync(storageStatePath);
})();
