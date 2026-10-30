// YouTube Avg Views + Engagement
// Injects two buttons next to Subscribe on channel pages. Everything runs
// client-side against the page's own DOM and the raw watch-page HTML/JSON
// that YouTube already ships to the browser -- no API key, no network calls
// beyond youtube.com itself.

(() => {
  'use strict';

  const IDS = {
    wrapper: 'yavg-button-wrapper',
    avgViews: 'yavg-avgviews-btn',
    engagement: 'yavg-engagement-btn',
  };

  const STATE_CLASSES = ['yavg-idle', 'yavg-working', 'yavg-result', 'yavg-error'];

  // True while a button click handler is running. Used to stop our own
  // in-flight tab navigation (clicking the "Videos" tab) from tearing down
  // the very button whose state we're about to update.
  let operationInProgress = false;

  // ---------------------------------------------------------------------
  // Generic helpers
  // ---------------------------------------------------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  async function waitFor(predicate, { timeout = 8000, interval = 200 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = predicate();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function formatCount(num) {
    if (num === null || num === undefined || isNaN(num)) return 'N/A';
    if (num >= 1e9) return trimZero((num / 1e9).toFixed(1)) + 'B';
    if (num >= 1e6) return trimZero((num / 1e6).toFixed(1)) + 'M';
    if (num >= 1e3) return trimZero((num / 1e3).toFixed(1)) + 'K';
    return String(Math.round(num));
  }

  function trimZero(str) {
    return str.replace(/\.0$/, '');
  }

  // Parses either a compact count ("12.3K", "1.2M") or a plain comma'd
  // integer ("12,345") into a number.
  function parseCompactOrExactNumber(text) {
    if (!text) return null;
    const cleaned = text.replace(/,/g, '').trim();
    const match = cleaned.match(/([\d.]+)\s*([KMB])?/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (isNaN(value)) return null;
    const suffix = (match[2] || '').toUpperCase();
    if (suffix === 'K') return Math.round(value * 1e3);
    if (suffix === 'M') return Math.round(value * 1e6);
    if (suffix === 'B') return Math.round(value * 1e9);
    return Math.round(value);
  }

  function shortError(err) {
    const msg = err && err.message ? err.message : 'Error';
    return msg.length > 26 ? msg.slice(0, 23) + '...' : msg;
  }

  // ---------------------------------------------------------------------
  // Button UI
  // ---------------------------------------------------------------------

  function setButtonState(btn, state, label) {
    STATE_CLASSES.forEach((c) => btn.classList.remove(c));
    btn.classList.add(`yavg-${state}`);
    btn.textContent = label;
    btn.disabled = state === 'working';
  }

  function createButton(id, idleLabel, colorClass) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.className = `yavg-btn ${colorClass} yavg-idle`;
    btn.textContent = idleLabel;
    return btn;
  }

  // Locates the actual Subscribe <button> (not "Subscribed"), scoped to the
  // channel header when possible so we don't match unrelated Subscribe
  // buttons elsewhere on the page (e.g. a "Featured channels" shelf).
  function findSubscribeButtonElement() {
    const headerRoot =
      document.querySelector('#page-header, yt-page-header-renderer, yt-page-header-view-model') || document;
    const candidates = headerRoot.querySelectorAll('button, yt-button-shape, tp-yt-paper-button');
    for (const c of candidates) {
      const label = (c.getAttribute('aria-label') || c.textContent || '').trim();
      if (/^subscribe/i.test(label) && !/subscribed/i.test(label)) return c;
    }
    return null;
  }

  // Finds the element next to which we anchor our buttons. Tries several
  // strategies because YouTube ships different channel header markup and
  // occasionally renames/relayouts elements.
  function findSubscribeAnchor() {
    // Strategy 1: current header (yt-page-header-view-model). The Subscribe
    // button sits inside a per-action wrapper div (.ytFlexibleActionsViewModelAction)
    // that is a flex sibling of the Join/Community action -- anchoring there
    // puts our buttons in the same row with matching spacing.
    const subscribeButton = findSubscribeButtonElement();
    if (subscribeButton) {
      const actionWrapper = subscribeButton.closest('.ytFlexibleActionsViewModelAction');
      if (actionWrapper && actionWrapper.parentElement) return actionWrapper;
    }

    // Strategy 2: classic C4 tabbed header renderer.
    const classic = document.querySelector('ytd-subscribe-button-renderer');
    if (classic && classic.parentElement) return classic;

    // Strategy 3: last resort -- anchor directly on the button itself.
    if (subscribeButton && subscribeButton.parentElement) return subscribeButton;

    return null;
  }

  function isChannelPage() {
    return /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/.*)?$/.test(location.pathname);
  }

  function removeButtons() {
    const existing = document.getElementById(IDS.wrapper);
    if (existing) existing.remove();
  }

  function injectButtons() {
    if (document.getElementById(IDS.wrapper)) return; // already present

    const anchor = findSubscribeAnchor();
    if (!anchor || !anchor.parentElement) return;

    const wrapper = document.createElement('div');
    wrapper.id = IDS.wrapper;
    wrapper.className = 'yavg-wrapper';

    const avgBtn = createButton(IDS.avgViews, 'Avg Views', 'yavg-blue');
    const engBtn = createButton(IDS.engagement, 'Engagement', 'yavg-purple');

    avgBtn.addEventListener('click', () => runOperation(avgBtn, handleAvgViewsClick));
    engBtn.addEventListener('click', () => runOperation(engBtn, handleEngagementClick));

    wrapper.appendChild(avgBtn);
    wrapper.appendChild(engBtn);

    anchor.parentElement.insertBefore(wrapper, anchor.nextSibling);
  }

  async function runOperation(btn, handler) {
    if (operationInProgress) return;
    operationInProgress = true;
    try {
      await handler(btn);
    } finally {
      operationInProgress = false;
    }
  }

  // ---------------------------------------------------------------------
  // SPA navigation handling
  // ---------------------------------------------------------------------

  // Tracks which channel we last injected into (path with the tab suffix
  // stripped), so we can tell a real channel change apart from YouTube
  // simply re-firing yt-page-data-updated a few times while a channel page
  // keeps hydrating after initial load.
  let lastChannelKey = null;

  function getChannelKey() {
    return location.pathname.replace(
      /\/(videos|shorts|streams|playlists|community|channels|about|store|search)\/?$/i,
      ''
    );
  }

  const debouncedRefresh = debounce(() => {
    if (operationInProgress) return; // don't touch buttons mid-operation

    if (!isChannelPage()) {
      removeButtons();
      lastChannelKey = null;
      return;
    }

    const channelKey = getChannelKey();
    const changedChannel = channelKey !== lastChannelKey;
    lastChannelKey = channelKey;

    const existing = document.getElementById(IDS.wrapper);
    if (existing) {
      // Buttons are already in place. Only reset them on an actual channel
      // change -- rebuilding on every hydration-noise event is what caused
      // a button to get silently swapped out from under a user's click.
      if (changedChannel) {
        const avgBtn = document.getElementById(IDS.avgViews);
        const engBtn = document.getElementById(IDS.engagement);
        if (avgBtn) setButtonState(avgBtn, 'idle', 'Avg Views');
        if (engBtn) setButtonState(engBtn, 'idle', 'Engagement');
      }
      return;
    }

    waitFor(() => findSubscribeAnchor(), { timeout: 6000 }).then((anchor) => {
      if (anchor) injectButtons();
    });
  }, 300);

  document.addEventListener('yt-navigate-finish', debouncedRefresh);
  document.addEventListener('yt-page-data-updated', debouncedRefresh);
  debouncedRefresh();

  // ---------------------------------------------------------------------
  // Videos tab navigation
  // ---------------------------------------------------------------------

  function isVideosTabUrl() {
    return /\/videos\/?$/.test(location.pathname);
  }

  function findVideosTabLink() {
    const tabs = document.querySelectorAll(
      'tp-yt-paper-tab, yt-tab-shape, a.yt-simple-endpoint.style-scope.ytd-c4-tabbed-header-renderer'
    );
    for (const tab of tabs) {
      const text = (tab.textContent || '').trim();
      if (/^videos$/i.test(text)) return tab;
    }
    return null;
  }

  async function ensureOnVideosTab() {
    if (!isVideosTabUrl()) {
      const tabLink = findVideosTabLink();
      if (!tabLink) return false;
      tabLink.click();
      const ok = await waitFor(() => isVideosTabUrl() && getVideoTiles().length > 0, {
        timeout: 8000,
        interval: 250,
      });
      if (!ok) return false;
    }
    await ensureLatestSort();
    return true;
  }

  // The Videos tab has a "Latest / Popular / Oldest" sort control, and
  // YouTube remembers a viewer's last-used sort choice across channels. If
  // it's left on "Popular" from browsing some other channel, we'd silently
  // collect that channel's all-time top videos instead of its recent
  // uploads -- badly inflating the average. We force it back to "Latest"
  // (always the first of the three chips, so this works regardless of the
  // page's UI language) before collecting anything.
  function findSortChips() {
    const chipBar = document.querySelector('ytd-rich-grid-renderer #header chip-bar-view-model');
    if (!chipBar) return null;
    const buttons = Array.from(chipBar.querySelectorAll('button'));
    return buttons.length ? buttons : null;
  }

  async function ensureLatestSort() {
    const chips = await waitFor(() => findSortChips(), { timeout: 4000, interval: 200 });
    if (!chips) return; // no sort control found -- proceed with whatever order is already shown

    const latestChip = chips[0];
    if (latestChip.getAttribute('aria-selected') === 'true') return;

    latestChip.click();
    await waitFor(() => latestChip.getAttribute('aria-selected') === 'true', { timeout: 4000, interval: 150 });
    await sleep(800); // let the grid finish re-rendering with the new sort before we read it
  }

  // ---------------------------------------------------------------------
  // Video tile parsing (Videos tab grid)
  // ---------------------------------------------------------------------

  function getVideoTiles() {
    return Array.from(
      document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer')
    );
  }

  function getTileTitleLink(tile) {
    return (
      tile.querySelector('a.ytLockupMetadataViewModelTitle') || // current "lockup" grid layout
      tile.querySelector('a#video-title-link') || // classic layout
      tile.querySelector('a#video-title') ||
      tile.querySelector('a.yt-simple-endpoint#thumbnail') ||
      tile.querySelector('a#thumbnail')
    );
  }

  function getTileVideoId(tile) {
    const link = getTileTitleLink(tile);
    if (!link || !link.href) return null;
    try {
      const url = new URL(link.href, location.origin);
      if (url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/')[2] || null;
      }
      return url.searchParams.get('v');
    } catch (e) {
      return null;
    }
  }

  function isShortTile(tile) {
    const link = getTileTitleLink(tile);
    if (link && link.href && link.href.includes('/shorts/')) return true;

    const overlay = tile.querySelector('ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"]');
    if (overlay) return true;

    // Current layout's duration/format badges render as <badge-shape><div class="ytBadgeShapeText">
    const badges = tile.querySelectorAll(
      '[aria-label], .badge-shape-wiz__text, .ytBadgeShapeText, ytd-badge-supported-renderer'
    );
    for (const b of badges) {
      const text = (b.getAttribute && b.getAttribute('aria-label')) || b.textContent || '';
      if (/^shorts$/i.test(text.trim())) return true;
    }
    return false;
  }

  // Pinned videos show a small "Pinned" badge in most layouts, or (older
  // layout) sit in their own section above the grid with a "Pinned video"
  // header. We check both. (Could not find a live pinned-video example to
  // confirm exact current markup; this text-based heuristic is intentionally
  // broad so it still catches the badge regardless of its class name.)
  function isPinnedTile(tile) {
    const badges = tile.querySelectorAll(
      'ytd-badge-supported-renderer, .badge-shape-wiz__text, .ytBadgeShapeText, badge-shape, [class*="badge"]'
    );
    for (const b of badges) {
      if (/pinned/i.test(b.textContent || '')) return true;
    }
    const section = tile.closest('ytd-item-section-renderer');
    if (section) {
      const header = section.querySelector('#title, .item-section-header-title');
      if (header && /pinned/i.test(header.textContent || '')) return true;
    }
    return false;
  }

  // View counts on tile cards render differently across layouts/locales,
  // so we try several DOM locations in order before giving up.
  function getTileViewCount(tile) {
    // Current "lockup" grid layout: yt-content-metadata-view-model row of spans.
    const newSpans = tile.querySelectorAll('.ytContentMetadataViewModelMetadataText');
    for (const span of newSpans) {
      const text = (span.textContent || '').trim();
      if (/view/i.test(text)) {
        const parsed = parseCompactOrExactNumber(text.replace(/views?/i, ''));
        if (parsed !== null) return parsed;
      }
    }

    // Classic layout metadata line.
    const metaSpans = tile.querySelectorAll('#metadata-line span, .inline-metadata-item, #metadata span');
    for (const span of metaSpans) {
      const text = (span.textContent || '').trim();
      if (/view/i.test(text)) {
        const parsed = parseCompactOrExactNumber(text.replace(/views?/i, ''));
        if (parsed !== null) return parsed;
      }
    }

    const link = getTileTitleLink(tile);
    const ariaLabel = link ? link.getAttribute('aria-label') : null;
    if (ariaLabel) {
      const m = ariaLabel.match(/([\d,.]+\s?[KMB]?)\s+views?/i);
      if (m) {
        const parsed = parseCompactOrExactNumber(m[1]);
        if (parsed !== null) return parsed;
      }
    }

    const anyAria = tile.querySelector('[aria-label*="views" i]');
    if (anyAria) {
      const m2 = (anyAria.getAttribute('aria-label') || '').match(/([\d,.]+\s?[KMB]?)\s+views?/i);
      if (m2) {
        const parsed = parseCompactOrExactNumber(m2[1]);
        if (parsed !== null) return parsed;
      }
    }

    return null;
  }

  async function collectLongFormViewCounts(targetCount) {
    const results = [];
    const seen = new Set();
    let scrollAttempts = 0;
    const maxScrollAttempts = 10;

    while (results.length < targetCount && scrollAttempts <= maxScrollAttempts) {
      const tiles = getVideoTiles();
      for (const tile of tiles) {
        const id = getTileVideoId(tile);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (isShortTile(tile)) continue;
        if (isPinnedTile(tile)) continue;
        const views = getTileViewCount(tile);
        if (views === null) continue;
        results.push(views);
        if (results.length >= targetCount) break;
      }
      if (results.length >= targetCount) break;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(600);
      scrollAttempts++;
    }
    return results;
  }

  function collectCandidateVideoUrls(max) {
    const tiles = getVideoTiles();
    const seen = new Set();
    const urls = [];
    for (const tile of tiles) {
      if (urls.length >= max) break;
      const id = getTileVideoId(tile);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (isShortTile(tile)) continue;
      if (isPinnedTile(tile)) continue;
      urls.push(`https://www.youtube.com/watch?v=${id}`);
    }
    return urls;
  }

  // ---------------------------------------------------------------------
  // Watch-page fetch + embedded JSON parsing (for Engagement)
  // ---------------------------------------------------------------------

  // Extracts the JSON object literal that follows `marker = {` in raw HTML
  // by brace-matching (string/escape aware) rather than a lazy regex, since
  // the blob can be megabytes and contain "};" substrings inside strings.
  function extractJsonAfterMarker(html, marker) {
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    const braceStart = html.indexOf('{', idx);
    if (braceStart === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = braceStart; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = html.slice(braceStart, i + 1);
          try {
            return JSON.parse(jsonStr);
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  // Depth-first search for the first object satisfying `predicate`. Used
  // instead of hardcoded key paths because YouTube's watch-page JSON schema
  // (like/comment renderer nesting) has changed shape multiple times across
  // redesigns; searching by shape/label is more resilient than a fixed path.
  function deepFindFirst(obj, predicate, maxDepth = 40) {
    const stack = [{ node: obj, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (depth > maxDepth || node === null || typeof node !== 'object') continue;
      if (predicate(node)) return node;
      for (const key in node) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          stack.push({ node: node[key], depth: depth + 1 });
        }
      }
    }
    return null;
  }

  function extractViewCountFallback(ytInitialData) {
    const node = deepFindFirst(ytInitialData, (n) => n.viewCount && n.viewCount.simpleText);
    if (node) return parseCompactOrExactNumber(node.viewCount.simpleText);
    return null;
  }

  function extractLikeCount(ytInitialData) {
    // Strategy 1: accessibility label of the form "12,345 likes"
    const likeNode = deepFindFirst(
      ytInitialData,
      (n) => typeof n.label === 'string' && /^[\d,.]+\s+likes?$/i.test(n.label)
    );
    if (likeNode) return parseCompactOrExactNumber(likeNode.label.replace(/\s*likes?$/i, ''));

    // Strategy 2: like toggle button renderer (has a LIKE icon)
    const toggleNode = deepFindFirst(
      ytInitialData,
      (n) => n.defaultIcon && n.defaultIcon.iconType === 'LIKE'
    );
    if (toggleNode) {
      const label =
        (toggleNode.defaultText && toggleNode.defaultText.accessibility &&
          toggleNode.defaultText.accessibility.accessibilityData &&
          toggleNode.defaultText.accessibility.accessibilityData.label) ||
        (toggleNode.accessibilityData && toggleNode.accessibilityData.accessibilityData &&
          toggleNode.accessibilityData.accessibilityData.label);
      if (label) return parseCompactOrExactNumber(label);
      const simple = toggleNode.defaultText && toggleNode.defaultText.simpleText;
      if (simple) return parseCompactOrExactNumber(simple);
    }

    return null;
  }

  // Locates the comments section's continuation token in ytInitialData. It
  // must be matched on BOTH sectionIdentifier and targetId -- the watch page
  // also contains a near-identical continuation for the side "engagement
  // panel" comments UI (targetId "engagement-panel-comments-section") whose
  // continuation response does not include a comment count.
  function findCommentsContinuationToken(ytInitialData) {
    const sectionNode = deepFindFirst(
      ytInitialData,
      (n) => n.targetId === 'comments-section' && n.sectionIdentifier === 'comment-item-section'
    );
    if (!sectionNode) return null;
    const tokenNode = deepFindFirst(sectionNode, (n) => n.continuationCommand && n.continuationCommand.token);
    if (!tokenNode) return null;
    // The token as embedded in the JSON is percent-encoded (e.g. "%3D" for "=").
    return decodeURIComponent(tokenNode.continuationCommand.token);
  }

  // Comment counts are NOT present in the initial watch-page HTML -- YouTube
  // loads the comments panel lazily via a POST to its internal "next"
  // endpoint once the section scrolls into view. We replicate that single
  // request using the continuation token and INNERTUBE_API_KEY already
  // embedded in the page (a public browser key, not a developer API key).
  async function fetchCommentCountViaContinuation(html, ytInitialData) {
    const token = findCommentsContinuationToken(ytInitialData);
    if (!token) return 0; // most likely comments are disabled

    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const versionMatch =
      html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) || html.match(/"clientVersion":"([^"]+)"/);
    const apiKey = apiKeyMatch ? apiKeyMatch[1] : null;
    const clientVersion = versionMatch ? versionMatch[1] : null;
    if (!apiKey || !clientVersion) return 0;

    const res = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/next?key=${apiKey}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion } }, continuation: token }),
    });
    if (!res.ok) return 0;

    const data = await res.json();
    const headerNode = deepFindFirst(data, (n) => n.commentsHeaderRenderer);
    if (!headerNode) return 0;
    const countText = headerNode.commentsHeaderRenderer.countText;
    if (!countText) return 0;
    const text = countText.simpleText || (countText.runs ? countText.runs.map((r) => r.text).join('') : null);
    const parsed = parseCompactOrExactNumber(text);
    return parsed === null ? 0 : parsed;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchVideoMetrics(videoUrl) {
    const res = await fetchWithTimeout(videoUrl, { credentials: 'include' });
    if (!res.ok) throw new Error('fetch failed: ' + res.status);
    const html = await res.text();

    const playerResponse = extractJsonAfterMarker(html, 'ytInitialPlayerResponse');
    const initialData = extractJsonAfterMarker(html, 'ytInitialData');

    let viewCount = null;
    if (playerResponse && playerResponse.videoDetails && playerResponse.videoDetails.viewCount) {
      viewCount = parseInt(playerResponse.videoDetails.viewCount, 10);
    }

    // Primary like-count source: microformat.playerMicroformatRenderer is a
    // stable part of ytInitialPlayerResponse carrying plain numeric strings
    // for both view and like counts -- far more reliable than digging
    // through UI renderer trees for an accessibility label.
    let likeCount = null;
    if (playerResponse && playerResponse.microformat && playerResponse.microformat.playerMicroformatRenderer) {
      const mf = playerResponse.microformat.playerMicroformatRenderer;
      if (mf.likeCount) likeCount = parseInt(mf.likeCount, 10);
      if ((viewCount === null || isNaN(viewCount)) && mf.viewCount) viewCount = parseInt(mf.viewCount, 10);
    }

    if ((viewCount === null || isNaN(viewCount)) && initialData) {
      viewCount = extractViewCountFallback(initialData);
    }
    if ((likeCount === null || isNaN(likeCount)) && initialData) {
      likeCount = extractLikeCount(initialData);
    }

    if (viewCount === null || isNaN(viewCount) || likeCount === null || isNaN(likeCount)) {
      throw new Error('parse failed');
    }

    let commentCount = 0;
    if (initialData) {
      try {
        commentCount = await fetchCommentCountViaContinuation(html, initialData);
      } catch (e) {
        commentCount = 0; // network hiccup on the comments call -- don't fail the whole video over it
      }
    }

    return { viewCount, likeCount, commentCount };
  }

  // ---------------------------------------------------------------------
  // Button click handlers
  // ---------------------------------------------------------------------

  async function handleAvgViewsClick(btn) {
    setButtonState(btn, 'working', 'Loading...');
    try {
      const onTab = await ensureOnVideosTab();
      if (!onTab) throw new Error('Could not open Videos tab');

      const views = await collectLongFormViewCounts(12);
      if (views.length < 12) {
        setButtonState(btn, 'error', `Need 12 videos, found ${views.length}`);
        return;
      }

      // Trimmed mean: drop the single highest and lowest, average the rest.
      const sorted = [...views].sort((a, b) => a - b);
      const trimmed = sorted.slice(1, -1);
      const avg = trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;

      setButtonState(btn, 'result', `Avg Views: ${formatCount(avg)}`);
    } catch (err) {
      setButtonState(btn, 'error', shortError(err));
    }
  }

  async function handleEngagementClick(btn) {
    setButtonState(btn, 'working', 'Loading...');
    try {
      const onTab = await ensureOnVideosTab();
      if (!onTab) throw new Error('Could not open Videos tab');

      const candidates = collectCandidateVideoUrls(8);
      if (candidates.length < 3) {
        setButtonState(btn, 'error', `Only found ${candidates.length} videos`);
        return;
      }

      const validRates = [];
      for (const url of candidates) {
        if (validRates.length >= 6) break;
        try {
          const metrics = await fetchVideoMetrics(url);
          const rate = ((metrics.likeCount + metrics.commentCount) / metrics.viewCount) * 100;
          if (isFinite(rate)) validRates.push(rate);
        } catch (e) {
          // Absorb individual video parse failures and keep going.
        }
      }

      if (validRates.length >= 3) {
        const avg = validRates.reduce((sum, v) => sum + v, 0) / validRates.length;
        const label =
          validRates.length >= 6
            ? `Engagement: ${avg.toFixed(2)}%`
            : `Eng (${validRates.length}/6): ${avg.toFixed(2)}%`;
        setButtonState(btn, 'result', label);
      } else {
        setButtonState(btn, 'error', `Only ${validRates.length}/8 parsed`);
      }
    } catch (err) {
      setButtonState(btn, 'error', shortError(err));
    }
  }
})();
