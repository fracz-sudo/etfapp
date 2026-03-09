// ─── DOM Elements ───────────────────────────────────────────────
const categoriesLoading = document.getElementById('categoriesLoading');
const categoriesError = document.getElementById('categoriesError');
const categoriesErrorText = document.getElementById('categoriesErrorText');
const categoriesGrid = document.getElementById('categoriesGrid');
const retryCategories = document.getElementById('retryCategories');

const resultsSection = document.getElementById('resultsSection');
const resultsTitle = document.getElementById('resultsTitle');
const resultsSubtitle = document.getElementById('resultsSubtitle');
const resultsLoading = document.getElementById('resultsLoading');
const resultsError = document.getElementById('resultsError');
const resultsErrorText = document.getElementById('resultsErrorText');
const retryResults = document.getElementById('retryResults');
const etfCards = document.getElementById('etfCards');
const summaryTableWrap = document.getElementById('summaryTableWrap');
const summaryTableBody = document.getElementById('summaryTableBody');

const backBtn = document.getElementById('backBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');

let currentCategoryUrl = null;
let currentCategoryName = null;

// ─── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadCategories();
});

retryCategories.addEventListener('click', loadCategories);
retryResults.addEventListener('click', () => {
  if (currentCategoryUrl) loadETFs(currentCategoryUrl, currentCategoryName);
});
backBtn.addEventListener('click', showCategories);
clearCacheBtn.addEventListener('click', clearCache);

// ─── Load Categories ────────────────────────────────────────────
async function loadCategories() {
  categoriesLoading.style.display = 'flex';
  categoriesError.style.display = 'none';
  categoriesGrid.style.display = 'none';

  try {
    const res = await fetch('/api/categories');
    const json = await res.json();

    if (!json.success) throw new Error(json.error || 'Neznámá chyba');

    renderCategories(json.data);
  } catch (err) {
    categoriesLoading.style.display = 'none';
    categoriesError.style.display = 'flex';
    categoriesErrorText.textContent = err.message || 'Nepodařilo se načíst kategorie.';
  }
}

function renderCategories(categories) {
  categoriesLoading.style.display = 'none';
  categoriesGrid.style.display = 'grid';
  categoriesGrid.innerHTML = '';

  categories.forEach((cat) => {
    const card = document.createElement('div');
    card.className = 'category-card';
    card.innerHTML = `
      <span class="name">${escapeHTML(cat.name)}</span>
      <span class="arrow">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </span>
    `;
    card.addEventListener('click', () => {
      currentCategoryUrl = cat.url;
      currentCategoryName = cat.name;
      loadETFs(cat.url, cat.name);
    });
    categoriesGrid.appendChild(card);
  });
}

// ─── Load ETFs for a category ───────────────────────────────────
async function loadETFs(url, name) {
  // Show results section, hide categories
  document.getElementById('categoriesSection').style.display = 'none';
  resultsSection.style.display = 'block';

  // Update title
  resultsTitle.textContent = name;
  resultsSubtitle.textContent = 'Top 6 ETF fondů dle AUM';

  // Show loading
  resultsLoading.style.display = 'flex';
  resultsError.style.display = 'none';
  etfCards.innerHTML = '';
  summaryTableWrap.style.display = 'none';

  try {
    const res = await fetch(`/api/etfs?url=${encodeURIComponent(url)}`);
    const json = await res.json();

    if (!json.success) throw new Error(json.error || 'Neznámá chyba');

    if (!json.data || json.data.length === 0) {
      resultsLoading.style.display = 'none';
      etfCards.innerHTML = `
        <div class="results-loading" style="padding: 40px;">
          <p style="color: var(--text-secondary);">V této kategorii nebyly nalezeny žádné ETF fondy.</p>
        </div>
      `;
      return;
    }

    renderETFs(json.data);
  } catch (err) {
    resultsLoading.style.display = 'none';
    resultsError.style.display = 'flex';
    resultsErrorText.textContent = err.message || 'Nepodařilo se načíst ETF fondy.';
  }
}

function renderETFs(etfs) {
  resultsLoading.style.display = 'none';
  etfCards.innerHTML = '';

  etfs.forEach((etf, i) => {
    const card = document.createElement('div');
    card.className = 'etf-card';

    card.innerHTML = `
      <div class="etf-card-header">
        <span class="etf-card-rank">${i + 1}</span>
        <span class="etf-card-name">${escapeHTML(etf.name || 'N/A')}</span>
        <br>
        <span class="etf-card-isin">${escapeHTML(etf.isin)}</span>
      </div>
      <div class="etf-card-body">
        <div class="etf-params">
          <div class="etf-param">
            <span class="etf-param-label">Měna fondu</span>
            <span class="etf-param-value">${escapeHTML(etf.currency || 'N/A')}</span>
          </div>
          <div class="etf-param">
            <span class="etf-param-label">TER</span>
            <span class="etf-param-value">${escapeHTML(etf.ter || 'N/A')}</span>
          </div>
          <div class="etf-param">
            <span class="etf-param-label">AUM (mil. EUR)</span>
            <span class="etf-param-value">${escapeHTML(etf.aum || 'N/A')}</span>
          </div>
          <div class="etf-param">
            <span class="etf-param-label">Distribuce výnosů</span>
            <span class="etf-param-value">${escapeHTML(etf.distribution || 'N/A')}</span>
          </div>
          <div class="etf-param">
            <span class="etf-param-label">Replikační metoda</span>
            <span class="etf-param-value">${escapeHTML(etf.replication || 'N/A')}</span>
          </div>
          <div class="etf-param">
            <span class="etf-param-label">KID</span>
            <span class="etf-param-value">${escapeHTML(etf.kidAvailable || 'N/A')}</span>
          </div>
        </div>
      </div>
      ${etf.description ? `
      <div class="etf-card-description">
        <div class="desc-label">Popis fondu</div>
        <p>${escapeHTML(etf.description)}</p>
      </div>
      ` : ''}
    `;

    etfCards.appendChild(card);
  });

  // Render summary table
  renderSummaryTable(etfs);
}

function renderSummaryTable(etfs) {
  summaryTableBody.innerHTML = '';

  etfs.forEach((etf) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHTML(etf.name || 'N/A')}</td>
      <td><code style="color: var(--accent-light); font-size: 0.82rem;">${escapeHTML(etf.isin)}</code></td>
      <td>${escapeHTML(etf.currency || 'N/A')}</td>
      <td>${escapeHTML(etf.ter || 'N/A')}</td>
      <td>${escapeHTML(etf.aum || 'N/A')}</td>
      <td>${escapeHTML(etf.distribution || 'N/A')}</td>
      <td>${escapeHTML(etf.replication || 'N/A')}</td>
    `;
    summaryTableBody.appendChild(row);
  });

  summaryTableWrap.style.display = 'block';
}

// ─── Show categories (back) ─────────────────────────────────────
function showCategories() {
  resultsSection.style.display = 'none';
  document.getElementById('categoriesSection').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Clear cache ────────────────────────────────────────────────
async function clearCache() {
  try {
    const res = await fetch('/api/cache/clear');
    const json = await res.json();
    if (json.success) {
      clearCacheBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Vymazáno!
      `;
      setTimeout(() => {
        clearCacheBtn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          Cache
        `;
      }, 2000);
    }
  } catch {
    // silently fail
  }
}

// ─── Utility ────────────────────────────────────────────────────
function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
