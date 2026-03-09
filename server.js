const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
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
    browserInstance = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
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

// ─── Scrape ETF list and details via API interception ───────────
async function scrapeETFList(categoryUrl) {
  const cacheKey = `list:${categoryUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const page = await newPage();
  try {
    let url = categoryUrl;
    if (url.includes('how-to/')) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await dismissCookies(page);
      const searchLink = await page.evaluate(() => {
        const el = document.querySelector('a[href*="/en/search.html"]');
        return el ? el.href : null;
      });
      if (searchLink) {
        url = searchLink;
      }
    }

    // Set up network interception to catch the GraphQL / API response
    let etfData = null;
    page.on('response', async (response) => {
      const resUrl = response.url();
      if (resUrl.includes('/api/etfs') || resUrl.includes('search.html')) {
        try {
          const json = await response.json();
          if (json && json.data && Array.isArray(json.data)) {
            etfData = json.data;
          } else if (Array.isArray(json)) {
             etfData = json;
          }
        } catch {
          // Not a JSON response, ignore
        }
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await dismissCookies(page);
    
    // Fallback: If API interception didn't catch it, extract JSON from the page source variable
    if (!etfData || etfData.length === 0) {
      etfData = await page.evaluate(() => {
        // justETF often embeds the initial list state in a script tag
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          if (script.textContent.includes('window.vueData')) {
             try {
                const match = script.textContent.match(/window\.vueData\s*=\s*({.*});/);
                if (match && match[1]) {
                   const data = JSON.parse(match[1]);
                   if (data && data.etfs) return data.etfs;
                }
             } catch(e) {}
          }
        }
        
        // If no JSON, fallback to scraping text from the DOM directly
        const rows = document.querySelectorAll('.etf-table tbody tr');
        return Array.from(rows).map(row => {
           const link = row.querySelector('a[href*="isin="]');
           const tds = row.querySelectorAll('td');
           const val = (index) => tds[index] ? tds[index].textContent.trim() : 'N/A';
           
           if (!link) return null;
           const isinMatch = link.href.match(/isin=([A-Z0-9]{12})/);
           
           return {
              isin: isinMatch ? isinMatch[1] : 'N/A',
              name: link.textContent.trim(),
              ter: val(4) || 'N/A',
              fundSize: val(5) || 'N/A'
           };
        }).filter(Boolean);
      });
    }

    // Ensure we have data
    if (!etfData || etfData.length === 0) return [];

    // Sort by fund size (AUM) descending if possible
    etfData.sort((a, b) => {
      let aumA = a.fundSize || a.aum || 0;
      let aumB = b.fundSize || b.aum || 0;
      // parse '1,234 m' to number
      const parseAum = (val) => {
         if (typeof val === 'number') return val;
         if (typeof val !== 'string') return 0;
         let num = parseFloat(val.replace(/[^\d.]/g, ''));
         if (val.toLowerCase().includes('bn')) num *= 1000;
         return num;
      };
      return parseAum(aumB) - parseAum(aumA);
    });

    const top6 = etfData.slice(0, 6).map(etf => {
       // Map to our expected format
       return {
          isin: etf.isin,
          name: etf.name || etf.fundName || etf.isin,
          ter: etf.ter || (etf.terRatio ? etf.terRatio + '%' : 'N/A'),
          aum: etf.fundSize || etf.aum || 'N/A',
          currency: etf.fundCurrency || etf.currency || 'N/A',
          distribution: etf.distributionPolicy || etf.distribution || 'N/A',
          replication: etf.replicationMethod || etf.replication || 'N/A',
          kidAvailable: 'N/A (Nelze ověřit ze seznamu)',
          description: etf.description || 'Detaily nebyly zjištěny ke zrychlení načítání.'
       };
    });

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

    // Get list of ETFs in category (now includes all details via API interception)
    const etfList = await scrapeETFList(categoryUrl);
    if (!etfList || etfList.length === 0) {
      return res.json({ success: true, data: [], message: 'V této kategorii nebyly nalezeny žádné ETF fondy.' });
    }

    // Since scrapeETFList now extracts rich data, we can just return it instantly!
    // We completely skip the 6x scrapeETFDetail calls which caused the 1-minute timeout on Render Free tier.
    res.json({ success: true, data: etfList });
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
