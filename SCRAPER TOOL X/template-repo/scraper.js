const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
let ws;
try { ws = require('ws'); } catch(e) {}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
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
const startDate = process.env.START_DATE || config.start_date || '';
const endDate = process.env.END_DATE || config.end_date || '';
const rawQuery = process.env.RAW_QUERY || config.raw_query || '';
const minLikes = parseInt(process.env.MIN_LIKES || config.min_likes || '0', 10) || 0;
const minRetweets = parseInt(process.env.MIN_RETWEETS || config.min_retweets || '0', 10) || 0;
const minReplies = parseInt(process.env.MIN_REPLIES || config.min_replies || '0', 10) || 0;
const minViews = parseInt(process.env.MIN_VIEWS || config.min_views || '0', 10) || 0;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

if (!target && !rawQuery) {
  console.error('Missing target or raw_query in env or CONFIG_JSON');
  process.exit(1);
}

const supabaseOptions = {};
if (ws) supabaseOptions.realtime = { transport: ws };
const supabase = createClient(supabaseUrl, supabaseKey, supabaseOptions);

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
      let tagText = target.replace('#', '').trim();
      let tag = tagText.split(/\s+/)[0];
      let q = `%23${encodeURIComponent(tag)}`;
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
    case 'keyword': {
      let kwQuery = target;
      if (!/\b(since|until):/i.test(kwQuery)) {
        if (startDate) kwQuery += ` since:${startDate}`;
        if (endDate) kwQuery += ` until:${endDate}`;
      }
      let q = encodeURIComponent(kwQuery);
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
  await page.waitForTimeout(8000);

  const collectedIds = new Set();
  const posts = [];
  let scrollAttempts = 0;
  const maxScrollAttempts = maxResults * 2;
  let consecutiveEmptyScrolls = 0;

  let username = target.replace('@', '').trim();
  // For cashtag/hashtag, use the tag symbol as the display name
  if (sourceType === 'cashtag') {
    const tagPart = target.replace('$', '').trim().split(/\s+/)[0];
    username = '$' + tagPart;
  } else if (sourceType === 'hashtag') {
    const tagPart = target.replace('#', '').trim().split(/\s+/)[0];
    username = '#' + tagPart;
  } else if (rawQuery) {
    const fromMatch = rawQuery.match(/\bfrom[:\s]+@?(\w+)/i);
    if (fromMatch) {
      username = fromMatch[1];
    } else {
      // No from: in raw query — extract first word that looks like a handle, or use "search"
      const firstWord = rawQuery.split(/\s+/)[0] || '';
      const cleanWord = firstWord.replace(/[@:]/g, '').trim();
      if (cleanWord && cleanWord.length > 1 && /^[a-zA-Z0-9_]+$/.test(cleanWord) && !/^(since|until|filter|min_|exact|any|none|to|mention|lang)$/i.test(cleanWord)) {
        username = cleanWord;
      } else {
        username = 'search';
      }
    }
  }

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

        const tweetUrl = href
          ? `https://x.com${href}`
          : `https://x.com/${tweetAuthor}/status/unknown-${Date.now()}-${i}`;

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

        // Extract actual author handle from tweet URL (e.g., /handle/status/123)
        let tweetAuthor = username;
        if (href) {
          const parts = href.split('/');
          if (parts.length >= 2 && parts[1]) {
            tweetAuthor = parts[1].replace('@', '');
          }
        }

        if (tweetId && collectedIds.has(tweetId)) continue;
        if (tweetId) collectedIds.add(tweetId);

        let retweetCount = 0, likeCount = 0, replyCount = 0, quoteCount = 0, viewCount = 0;
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

        try {
          const viewEl = tweet.locator('a[href*="/analytics"]').first();
          const viewCount2 = await viewEl.count({ timeout: 500 });
          if (viewCount2) {
            const viewText = await viewEl.textContent({ timeout: 500 });
            const viewMatch = (viewText || '').match(/([\d,.]+[KkMm]?)/);
            if (viewMatch) viewCount = parseEngagementNum(viewMatch[1]);
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

        let isVerified = false;
        try {
          const verifiedBadge = tweet.locator('[aria-label="Verified account"], [aria-label="Verified"], svg[viewBox="0 0 22 22"]');
          const vCount = await verifiedBadge.count({ timeout: 1000 });
          isVerified = vCount > 0;
        } catch(e) {}

        let authorAvatar = '';
        try {
          const avatarImg = tweet.locator('img[src*="pbs.twimg.com/profile_images"]').first();
          const avCount = await avatarImg.count({ timeout: 1000 });
          if (avCount > 0) {
            const src = await avatarImg.getAttribute('src', { timeout: 1000 });
            if (src) authorAvatar = src.split('?')[0] + '?format=jpg&name=normal';
          }
        } catch(e) {}

        posts.push({
          tweet_id: tweetId || `unknown-${Date.now()}-${i}`,
          author: tweetAuthor,
          username: `@${tweetAuthor}`,
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
          api_key_hash: keyHash,
          author_avatar: authorAvatar,
          is_verified: isVerified,
        });
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
      if (consecutiveEmptyScrolls >= 5) {
        console.log('5 consecutive empty scrolls — no more posts available');
        break;
      }
    } else {
      consecutiveEmptyScrolls = 0;
    }
    if (posts.length >= maxResults) break;
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(4000);
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

  console.log(`Saving ${unique.length} posts to Supabase...`);

  if (unique.length > 0) {
    const { data, error } = await supabase
      .from('scraped_posts')
      .insert(unique);

    if (error) {
      console.log('SUPABASE ERROR:', error.message);
      console.log('Error details:', JSON.stringify(error));
    } else {
      console.log(`SUCCESS! ${unique.length} posts saved.`);
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
