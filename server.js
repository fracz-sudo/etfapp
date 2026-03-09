const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── In-memory cache ────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ─── Puppeteer helpers ──────────────────────────────────────────
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.connected) {
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--disable-gpu',
      ],
    };
    
    // Chromium paths are automatically resolved by Puppeteer when installed locally via buildCommand
    browserInstance = await puppeteer.launch(launchOptions);
  }
  return browserInstance;
}

async function newPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1920, height: 1080 });
  // Dismiss cookie consent automatically
  page.on('dialog', async (dialog) => dialog.dismiss());
  return page;
}

async function dismissCookies(page) {
  try {
    await page.waitForSelector('[data-consent-accept], .cookie-consent-accept, #accept-all, button[class*="accept"]', { timeout: 5000 });
    await page.click('[data-consent-accept], .cookie-consent-accept, #accept-all, button[class*="accept"]');
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    // No cookie banner – that's fine
  }
}

// ─── Scrape ETF categories ──────────────────────────────────────
async function scrapeCategories() {
  const cacheKey = 'categories';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const page = await newPage();
  try {
    await page.goto('https://www.justetf.com/en/etf-lists.html', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await dismissCookies(page);

    // Extract category links from the page
    const categories = await page.evaluate(() => {
      const results = [];
      // justetf.com lists categories as links to search pages or guide pages
      const links = document.querySelectorAll('a[href*="/en/search.html"], a[href*="how-to/"]');
      const seen = new Set();

      links.forEach((el) => {
        const name = el.textContent.trim();
        const href = el.getAttribute('href');
        if (name && href && !seen.has(href) && name.length > 1 && name.length < 100) {
          seen.add(href);
          let fullUrl = href;
          if (href.startsWith('/')) {
            fullUrl = 'https://www.justetf.com' + href;
          }
          results.push({ name, url: fullUrl });
        }
      });
      return results;
    });

    setCache(cacheKey, categories);
    return categories;
  } finally {
    await page.close();
  }
}

// ─── Scrape ETF list from a category page ───────────────────────
async function scrapeETFList(categoryUrl) {
  const cacheKey = `list:${categoryUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const page = await newPage();
  try {
    // Navigate to the category / search page
    let url = categoryUrl;
    // If URL is a how-to guide, convert to search URL if needed
    if (url.includes('how-to/')) {
      // Navigate to the guide and find the search link within
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await dismissCookies(page);
      // Try to find a link to the search/screener
      const searchLink = await page.evaluate(() => {
        const el = document.querySelector('a[href*="/en/search.html"]');
        return el ? el.href : null;
      });
      if (searchLink) {
        url = searchLink;
      }
    }

    // If it's already a search page, navigate directly
    if (url.includes('search.html')) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await dismissCookies(page);
    }

    // Wait for the ETF table to load
    await page.waitForSelector('table, .etf-table, [class*="table"]', { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    // Sort by fund size (AUM) descending – click on the fund size column header
    try {
      // Try clicking on AUM / Fund size column to sort
      const sorted = await page.evaluate(() => {
        const headers = Array.from(document.querySelectorAll('th, [role="columnheader"]'));
        for (const h of headers) {
          const text = h.textContent.toLowerCase();
          if (text.includes('fund size') || text.includes('aum') || text.includes('fondgröße')) {
            h.click();
            return true;
          }
        }
        return false;
      });
      if (sorted) {
        await new Promise((r) => setTimeout(r, 1500));
        // Click again to ensure descending sort
        await page.evaluate(() => {
          const headers = Array.from(document.querySelectorAll('th, [role="columnheader"]'));
          for (const h of headers) {
            const text = h.textContent.toLowerCase();
            if (text.includes('fund size') || text.includes('aum') || text.includes('fondgröße')) {
              // Check if already descending, if not click again
              const sortDir = h.getAttribute('aria-sort') || h.className;
              if (!sortDir.includes('desc')) {
                h.click();
              }
              return;
            }
          }
        });
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch {
      // Sorting didn't work – proceed with default order
    }

    // Extract ETF ISINs and basic data from the table
    const etfList = await page.evaluate(() => {
      const rows = [];
      // Find ETF links with ISINs on the page
      const etfLinks = document.querySelectorAll('a[href*="etf-profile.html?isin="]');
      const seen = new Set();

      etfLinks.forEach((link) => {
        const href = link.getAttribute('href');
        const isinMatch = href.match(/isin=([A-Z0-9]{12})/);
        if (isinMatch && !seen.has(isinMatch[1])) {
          const isin = isinMatch[1];
          seen.add(isin);
          const name = link.textContent.trim();

          // Try to find AUM from parent row
          let aum = '';
          const row = link.closest('tr');
          if (row) {
            const cells = row.querySelectorAll('td');
            cells.forEach((cell) => {
              const text = cell.textContent.trim();
              // Look for fund size pattern (number with m or bn)
              if (text.match(/[\d,.]+\s*(m|bn)\b/i)) {
                aum = text;
              }
            });
          }

          rows.push({ isin, name: name || isin, aum });
        }
      });

      return rows;
    });

    // Take first 6 (they should be sorted by AUM)
    const top6 = etfList.slice(0, 6);
    setCache(cacheKey, top6);
    return top6;
  } finally {
    await page.close();
  }
}

// ─── Scrape individual ETF detail page ──────────────────────────
async function scrapeETFDetail(isin) {
  const cacheKey = `etf:${isin}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const page = await newPage();
  try {
    const url = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await dismissCookies(page);

    // Wait for content to load
    await new Promise((r) => setTimeout(r, 2000));

    const detail = await page.evaluate((etfIsin) => {
      const result = {
        name: '',
        isin: etfIsin,
        currency: '',
        ter: '',
        aum: '',
        distribution: '',
        replication: '',
        kidAvailable: '',
        description: '',
      };

      // Name – main heading
      const h1 = document.querySelector('h1');
      if (h1) result.name = h1.textContent.trim();

      // Extract data from key info tables / detail sections
      const allText = document.body.innerText;

      // Helper to find value after a label in document
      function findValue(labels) {
        const allRows = document.querySelectorAll('tr, .val-table-row, [class*="info-row"], [class*="detail-row"], dl dt, dl dd');
        for (const label of labels) {
          // Approach 1: table rows
          const trs = document.querySelectorAll('tr');
          for (const tr of trs) {
            const cells = tr.querySelectorAll('td, th');
            for (let i = 0; i < cells.length - 1; i++) {
              if (cells[i].textContent.trim().toLowerCase().includes(label.toLowerCase())) {
                return cells[i + 1].textContent.trim();
              }
            }
          }

          // Approach 2: dt/dd pairs
          const dts = document.querySelectorAll('dt');
          for (const dt of dts) {
            if (dt.textContent.trim().toLowerCase().includes(label.toLowerCase())) {
              const dd = dt.nextElementSibling;
              if (dd) return dd.textContent.trim();
            }
          }

          // Approach 3: Labeled elements
          const spans = document.querySelectorAll('span, div, p, label');
          for (const span of spans) {
            const text = span.textContent.trim();
            if (text.toLowerCase().includes(label.toLowerCase()) && span.nextElementSibling) {
              const sibling = span.nextElementSibling;
              if (sibling.textContent.trim().length < 200) {
                return sibling.textContent.trim();
              }
            }
          }
        }
        return '';
      }

      result.currency = findValue(['Fund currency', 'Fund CCY', 'Currency']);
      result.ter = findValue(['Total expense ratio', 'TER', 'Ongoing charges']);
      result.aum = findValue(['Fund size', 'AUM', 'Assets under management']);
      result.distribution = findValue(['Distribution policy', 'Use of profits', 'Income treatment']);
      result.replication = findValue(['Replication', 'Index tracking', 'Replication method']);

      // Description – investment strategy
      const descHeaders = document.querySelectorAll('h2, h3, h4, .section-title');
      for (const h of descHeaders) {
        if (h.textContent.toLowerCase().includes('investment strategy') ||
            h.textContent.toLowerCase().includes('description') ||
            h.textContent.toLowerCase().includes('fund description')) {
          // Get the next paragraph / text block
          let sibling = h.nextElementSibling;
          while (sibling) {
            const text = sibling.textContent.trim();
            if (text.length > 30 && text.length < 2000) {
              result.description = text;
              break;
            }
            sibling = sibling.nextElementSibling;
          }
          break;
        }
      }

      // KID – look for document links
      const kidLinks = [];
      const allLinks = document.querySelectorAll('a[href*="kid"], a[href*="KID"], a[href*="kiid"], a[href*="KIID"], a[href*="key-information"]');
      allLinks.forEach((a) => {
        const text = a.textContent.trim();
        if (text) kidLinks.push(text);
      });
      // Also check document section
      const docSection = document.querySelectorAll('a[href*=".pdf"]');
      docSection.forEach((a) => {
        const text = a.textContent.trim().toLowerCase();
        if (text.includes('kid') || text.includes('key information') || text.includes('kiid')) {
          kidLinks.push(a.textContent.trim());
        }
      });
      result.kidAvailable = kidLinks.length > 0 ? `Ano (${kidLinks.join(', ')})` : 'Nedostupný';

      return result;
    }, isin);

    setCache(cacheKey, detail);
    return detail;
  } finally {
    await page.close();
  }
}

// ─── Serve static frontend ─────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ─────────────────────────────────────────────────

// GET /api/categories – list of ETF categories
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await scrapeCategories();
    res.json({ success: true, data: categories });
  } catch (err) {
    console.error('Error fetching categories:', err.message);
    res.status(500).json({ success: false, error: 'Nepodařilo se načíst kategorie. Zkuste to znovu.' });
  }
});

// GET /api/etfs?url=<categoryUrl> – top 6 ETFs from a category
app.get('/api/etfs', async (req, res) => {
  try {
    const categoryUrl = req.query.url;
    if (!categoryUrl) {
      return res.status(400).json({ success: false, error: 'Chybí parametr url.' });
    }

    // Step 1: Get list of ETFs in category
    const etfList = await scrapeETFList(categoryUrl);
    if (!etfList || etfList.length === 0) {
      return res.json({ success: true, data: [], message: 'V této kategorii nebyly nalezeny žádné ETF fondy.' });
    }

    // Step 2: Get details for each ETF (up to 6)
    const details = [];
    for (const etf of etfList.slice(0, 6)) {
      try {
        const detail = await scrapeETFDetail(etf.isin);
        // If name wasn't found on detail page, use name from list
        if (!detail.name && etf.name) detail.name = etf.name;
        // If AUM wasn't found on detail page, use from list
        if (!detail.aum && etf.aum) detail.aum = etf.aum;
        details.push(detail);
      } catch (err) {
        console.error(`Error fetching detail for ${etf.isin}:`, err.message);
        details.push({
          name: etf.name || etf.isin,
          isin: etf.isin,
          currency: 'N/A',
          ter: 'N/A',
          aum: etf.aum || 'N/A',
          distribution: 'N/A',
          replication: 'N/A',
          kidAvailable: 'N/A',
          description: 'Nepodařilo se načíst detaily.',
        });
      }
    }

    res.json({ success: true, data: details });
  } catch (err) {
    console.error('Error fetching ETFs:', err.message);
    res.status(500).json({ success: false, error: 'Nepodařilo se načíst ETF fondy. Zkuste to znovu.' });
  }
});

// GET /api/cache/clear – clear cache
app.get('/api/cache/clear', (req, res) => {
  cache.clear();
  res.json({ success: true, message: 'Cache vymazána.' });
});

// ─── Start server ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 ETF Screener běží na http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
