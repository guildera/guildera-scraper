const { chromium } = require('playwright');
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
console.log('=== CONFIG from JSON ===');
console.log(JSON.stringify(config, null, 2));

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

function extractDateFromText(text) {
  if (!text) return '';
  const months = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
  const patterns = [
    /(\w{3})\s+(\d{1,2}),?\s+(\d{4})/,
    /(\w{3})\s+(\d{1,2})\s+(\d{4})/,
    /(\d{1,2})\s+(\w{3})\s+(\d{4})/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      let month, day, year;
      if (months[m[1]]) {
        month = months[m[1]]; day = parseInt(m[2]); year = parseInt(m[3]);
      } else if (months[m[2]]) {
        month = months[m[2]]; day = parseInt(m[1]); year = parseInt(m[3]);
      }
      if (month && day && year && year > 2010 && year < 2030) {
        return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toISOString();
      }
    }
  }
  return '';
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  let storageStatePath = path.join(__dirname, 'state.json');
  if (process.env.X_STATE) {
    storageStatePath = path.join(__dirname, 'state-ci.json');
    fs.writeFileSync(storageStatePath, Buffer.from(process.env.X_STATE, 'base64').toString());
  }

  const contextOptions = {
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  };

  if (fs.existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  let url = '';

  if (rawQuery) {
    url = `https://x.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=live`;
    console.log(`Advanced search query: ${rawQuery}`);
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
      url = `https://x.com/search?q=${q}&src=typed_query&f=live`;
      break;
    }
    case 'keyword': {
      let q = encodeURIComponent(target);
      if (startDate) q += `%20since:${startDate}`;
      if (endDate) q += `%20until:${endDate}`;
      if (minLikes > 0) q += `%20min_faves:${minLikes}`;
      if (minRetweets > 0) q += `%20min_retweets:${minRetweets}`;
      if (minReplies > 0) q += `%20min_replies:${minReplies}`;
      url = `https://x.com/search?q=${q}&src=typed_query&f=live`;
      break;
    }
    case 'cashtag': {
      let tagText = target.replace('$', '').trim();
      let tag = tagText.split(/\s+/)[0];
      let q = `%24${encodeURIComponent(tag)}`;
      const sinceMatch = target.match(/\bsince:(\S+)/i);
      const untilMatch = target.match(/\buntil:(\S+)/i);
      if (sinceMatch) q += `%20since:${sinceMatch[1]}`;
      else if (startDate) q += `%20since:${startDate}`;
      if (untilMatch) q += `%20until:${untilMatch[1]}`;
      else if (endDate) q += `%20until:${endDate}`;
      if (minLikes > 0) q += `%20min_faves:${minLikes}`;
      if (minRetweets > 0) q += `%20min_retweets:${minRetweets}`;
      if (minReplies > 0) q += `%20min_replies:${minReplies}`;
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
  await page.waitForTimeout(4000);

  const collectedIds = new Set();
  const posts = [];
  let scrollAttempts = 0;
  const maxScrollAttempts = maxResults * 2;
  let consecutiveEmptyScrolls = 0;
  const username = target.replace('@', '').trim();

  async function extractPostsFromDOM() {
    const articleCount = await page.locator('article').count();
    let newCount = 0;
    for (let i = 0; i < articleCount; i++) {
      if (posts.length >= maxResults) break;
      try {
        const tweet = page.locator('article').nth(i);
        const text = await tweet.innerText({ timeout: 5000 });
        if (!text || text.length < 10) continue;

        let href = '';
        try {
          const linkEl = tweet.locator('a[href*="/status/"]').first();
          href = await linkEl.getAttribute('href', { timeout: 5000 });
        } catch(e) {}

        let tweetAuthor = username;
        let tweetHandle = `@${username}`;
        if (href) {
          const parts = href.split('/status/');
          if (parts[0]) {
            const handle = parts[0].replace(/^\//, '').trim();
            if (handle) {
              tweetAuthor = handle;
              tweetHandle = `@${handle}`;
            }
          }
        }

        const tweetUrl = href
          ? `https://x.com${href}`
          : `https://x.com/${username}/status/unknown-${Date.now()}-${i}`;

        let postTime = '';
        const timeSelectors = ['time', '[datetime]', 'span[data-testid="Time"]'];
        for (const sel of timeSelectors) {
          try {
            const el = tweet.locator(sel).first();
            postTime = await el.getAttribute('datetime', { timeout: 3000 });
            if (postTime) break;
          } catch(e) {}
        }
        if (!postTime) {
          try {
            const timeText = await tweet.locator('time').first().textContent({ timeout: 2000 });
            if (timeText) postTime = timeText.trim();
          } catch(e) {}
        }
        if (!postTime || postTime.length < 5) {
          postTime = extractDateFromText(text);
        }
        if (!postTime) {
          postTime = new Date().toISOString();
        }

        let hasMedia = false;
        const mediaUrls = [];
        let authorAvatar = '';
        let isVerified = false;
        try {
          const avatarEl = tweet.locator('img[src*="profile_images"]').first();
          const avatarSrc = await avatarEl.getAttribute('src', { timeout: 2000 });
          if (avatarSrc) authorAvatar = avatarSrc.split('?')[0];
        } catch(e) {}
        try {
          const verifiedEl = tweet.locator('[aria-label="Verified account"], [aria-label="Verified"]').first();
          isVerified = await verifiedEl.count({ timeout: 1000 }) > 0;
        } catch(e) {}
        try {
          const imgEls = tweet.locator('img[src*="pbs.twimg.com/media"], img[src*="pbs.twimg.com/card_media"], img[src*="pbs.twimg.com/ext_tw_video"]');
          const imgCount = await imgEls.count({ timeout: 2000 });
          for (let m = 0; m < imgCount; m++) {
            const src = await imgEls.nth(m).getAttribute('src', { timeout: 1000 });
            if (src && !src.includes('profile_images') && !src.includes('emoji')) {
              mediaUrls.push(src.split('?')[0]);
            }
          }
          const hasVideo = (await tweet.locator('[data-testid="videoPlayer"], [data-testid="videoPlayerContainer"]').count({ timeout: 1000 })) > 0;
          if (hasVideo) {
            try {
              const videoSrc = await tweet.locator('[data-testid="videoPlayer"] video').getAttribute('src', { timeout: 1000 });
              if (videoSrc) mediaUrls.push(videoSrc);
            } catch(e) {}
          }
          hasMedia = mediaUrls.length > 0 || text.includes('pic.twitter.com');
        } catch(e) {}

        if (mediaOnly && !hasMedia) continue;

        const tweetId = href
          ? href.split('/status/')[1]?.split('?')[0]
          : null;

        if (tweetId && collectedIds.has(tweetId)) continue;
        if (tweetId) collectedIds.add(tweetId);

        let retweetCount = 0, likeCount = 0, replyCount = 0, quoteCount = 0;
        try {
          const groupEl = tweet.locator('[role="group"]').first();
          const hasGroup = await groupEl.count({ timeout: 2000 });
          if (hasGroup) {
            const groupText = await groupEl.innerText({ timeout: 2000 });
            const nums = groupText.match(/[\d,.]+[KkMm]?/g) || [];
            if (nums.length >= 4) {
              replyCount = parseEngagementNum(nums[0]);
              retweetCount = parseEngagementNum(nums[1]);
              likeCount = parseEngagementNum(nums[2]);
              quoteCount = parseEngagementNum(nums[3]);
            } else if (nums.length >= 2) {
              likeCount = parseEngagementNum(nums[0]);
              retweetCount = parseEngagementNum(nums[1]);
            }
          }
        } catch(e) {}
        if (retweetCount === 0 && likeCount === 0 && replyCount === 0) {
          const testids = ['reply', 'retweet', 'like', 'unlike'];
          for (const tid of testids) {
            try {
              const el = tweet.locator(`[data-testid="${tid}"]`).first();
              const cnt = await el.count({ timeout: 500 });
              if (cnt) {
                const label = await el.getAttribute('aria-label', { timeout: 500 });
                const textContent = await el.textContent({ timeout: 500 });
                const val = parseEngagementNum(label || textContent || '');
                if (tid === 'reply') replyCount = val;
                else if (tid === 'retweet') retweetCount = val;
                else if (tid === 'like' || tid === 'unlike') likeCount = val;
              }
            } catch(e2) {}
          }
          try {
            const quoteEl = tweet.locator('[data-testid="quote"]').first();
            const cnt = await quoteEl.count({ timeout: 500 });
            if (cnt) {
              const label = await quoteEl.getAttribute('aria-label', { timeout: 500 });
              quoteCount = parseEngagementNum(label || '');
            }
          } catch(e2) {}
        }

        // ─── VIEWS EXTRACTION (robust) ───
        let viewCount = 0;
        try {
          const viewAnchor = tweet.locator('a[href*="/analytics"]').first();
          if (await viewAnchor.count({ timeout: 1000 })) {
            const vText = await viewAnchor.innerText({ timeout: 1000 });
            const m = (vText || '').match(/([\d.,]+[KkMm]?)\s*Views/i);
            if (m) viewCount = parseEngagementNum(m[1]);
          }
        } catch(e) {}
        if (!viewCount) {
          try {
            const viewEl = tweet.locator('span:has-text("Views"), div:has-text("Views"), a:has-text("Views")').last();
            if (await viewEl.count({ timeout: 1000 })) {
              const vText = await viewEl.innerText({ timeout: 1000 });
              const m = (vText || '').match(/([\d.,]+[KkMm]?)\s*Views/i);
              if (m) viewCount = parseEngagementNum(m[1]);
            }
          } catch(e) {}
        }
        if (!viewCount) {
          try {
            const m = text.match(/([\d.,]+[KkMm]?)\s*Views/i);
            if (m) viewCount = parseEngagementNum(m[1]);
          } catch(e) {}
        }

        posts.push({
          tweet_id: tweetId || `unknown-${Date.now()}-${i}`,
          author: tweetAuthor,
          username: tweetHandle,
          text: text.substring(0, 2000),
          created_at: postTime || new Date().toISOString(),
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
          api_key_hash: keyHash,
        });
        if (i === 0 || viewCount > 0) console.log(`  Post ${i}: views=${viewCount} likes=${likeCount} rt=${retweetCount}`);
        newCount++;
      } catch (err) {
        console.log(`  Extract error: ${err.message}`);
      }
    }
    return newCount;
  }

  while (scrollAttempts < maxScrollAttempts && posts.length < maxResults) {
    const newPosts = await extractPostsFromDOM();
    console.log(`Scroll ${scrollAttempts + 1}: +${newPosts} new (total: ${posts.length}/${maxResults})`);
    if (newPosts === 0) {
      consecutiveEmptyScrolls++;
      if (consecutiveEmptyScrolls >= 3) {
        console.log('3 consecutive empty scrolls — no more posts available');
        break;
      }
    } else {
      consecutiveEmptyScrolls = 0;
    }
    if (posts.length >= maxResults) break;
    await page.evaluate(() => window.scrollBy(0, 2400));
    await page.waitForTimeout(1500);
    scrollAttempts++;
  }
  console.log(`Final collection: ${posts.length} posts`);

  const seen = new Set();
  let unique = posts.filter(p => {
    if (seen.has(p.tweet_id)) return false;
    seen.add(p.tweet_id);
    return true;
  });

  const beforeFilter = unique.length;
  if (minViews > 0) unique = unique.filter(p => (p.view_count || 0) >= minViews);
  if (unique.length < beforeFilter) console.log(`View filter: ${beforeFilter} -> ${unique.length} posts (min_views=${minViews})`);

  console.log(`Saving ${unique.length} posts to WordPress (${wordpressUrl})...`);

  // Convert each post to the WP save_posts format
  const toSave = unique.map(p => {
    let mediaUrlsArr = [];
    try { mediaUrlsArr = p.media_urls ? JSON.parse(p.media_urls) : []; } catch(e) {}
    return {
      api_key_hash: keyHash,
      post_id: String(p.tweet_id).startsWith('unknown-') ? '' : String(p.tweet_id),
      author_id: '',
      author_username: p.username ? p.username.replace('@', '') : (p.author || ''),
      author_name: p.author || '',
      text: p.text || '',
      created_at: p.created_at || '',
      like_count: p.like_count || 0,
      retweet_count: p.retweet_count || 0,
      reply_count: p.reply_count || 0,
      quote_count: p.quote_count || 0,
      view_count: p.view_count || 0,
      bookmark_count: 0,
      impression_count: 0,
      media_urls: mediaUrlsArr,
      urls: [],
      hashtags: [],
      mentions: [],
      is_reply: false,
      is_retweet: false,
      is_quote: false,
      language: '',
      source: 'x',
    };
  });

  if (toSave.length > 0) {
    try {
      const resp = await fetch(`${wordpressUrl}/wp-admin/admin-ajax.php?action=guildera_scraper_save_posts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Key': uploadKey,
        },
        body: JSON.stringify({
          posts: toSave,
        }),
      });
      const text = await resp.text();
      console.log(`WordPress save_posts response (${resp.status}): ${text.substring(0, 500)}`);
    } catch (err) {
      console.log(`WordPress save_posts error: ${err.message}`);
    }
  } else {
    console.log('No posts to save.');
  }

  await context.close();
  await browser.close();

  if (process.env.X_STATE && fs.existsSync(storageStatePath)) {
    fs.unlinkSync(storageStatePath);
  }
})();
