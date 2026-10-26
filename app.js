const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const titleCase = (value = '') => String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const dateLabel = (value) => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const number = (value) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const money = (amount, currency = 'USD') => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount || 0)); }
  catch { return `${currency} ${number(amount)}`; }
};
const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
const cleanVendor = (name = '') => name.replace(/,\s*(INC\.?|LLC|LTD\.?|LIMITED|CORP\.?)/ig, '').replace(/\s+/g, ' ').trim();
const PAGE_SIZE = 8;

let accounts = [];
let audit = null;
let subscriptionPage = 1;
let transactionPage = 1;
let toastTimer;
let globalMatches = [];

function spendByCurrency(data) {
  const summary = data.audit_metadata?.summary || {};
  return summary.net_confirmed_spend_by_currency || summary.minimum_confirmed_spend_by_currency || {};
}

function renderAccountDirectory() {
  const loaded = accounts.filter((account) => account.data).length;
  $('#accountNavCount').textContent = `${loaded}/9`;
  $('#loadedAccountsLabel').textContent = `${loaded} account file${loaded === 1 ? '' : 's'} loaded`;
  $('#accountGrid').innerHTML = accounts.map((account) => {
    const data = account.data;
    const summary = data?.audit_metadata?.summary || {};
    const spend = Object.entries(data ? spendByCurrency(data) : {});
    const amountList = spend.map(([currency, amount]) => `${currency} ${number(amount)}`).join(' · ');
    const displayName = data ? account.email.split('@')[0] : `Account ${account.accountNumber}`;
    return `<button class="account-card ${data ? 'ready' : 'placeholder'} ${audit?.accountNumber === account.accountNumber ? 'selected' : ''}" data-account="${account.accountNumber}" aria-label="${data ? `View ${escapeHtml(account.email)}` : `Add subscription${account.accountNumber}.json`}">
      <span class="account-card-top"><span class="account-number">${String(account.accountNumber).padStart(2, '0')}</span><span class="account-state ${data ? 'loaded' : ''}">${data ? '● Loaded' : '＋ Add JSON'}</span></span>
      <strong>${escapeHtml(displayName)}</strong><span class="account-email">${escapeHtml(data ? account.email : 'Account file not added')}</span>
      <span class="account-card-bottom">${data ? `${number(summary.unique_subscriptions ?? data.subscriptions?.length)} subscriptions` : 'Waiting for account file'}<b>${data ? escapeHtml(amountList || 'No confirmed spend') : '—'}</b></span>
    </button>`;
  }).join('');
}

function renderSummary() {
  const meta = audit.audit_metadata || {};
  const summary = meta.summary || {};
  const range = meta.date_range_covered || {};
  $('#auditDate').textContent = `Audited ${dateLabel(meta.audit_date)}`;
  $('#dateRange').textContent = `${dateLabel(range.start)} — ${dateLabel(range.end)}`;
  $('#selectedAccountLabel').textContent = `· Account ${audit.accountNumber}`;
  $('#subNavCount').textContent = summary.unique_subscriptions ?? audit.subscriptions.length;
  const kpis = [
    { label: 'Subscriptions found', value: summary.unique_subscriptions ?? audit.subscriptions.length, foot: `${number(summary.unique_vendors)} unique vendors`, icon: '▤' },
    { label: 'Successful payments', value: summary.confirmed_successful_transactions ?? 0, foot: 'Confirmed from billing evidence', icon: '↗' },
    { label: 'Failed attempts', value: summary.failed_payment_attempts ?? 0, foot: 'May include repeated retries', icon: '⌁' },
    { label: 'Ledger records', value: summary.total_ledger_records ?? audit.transactions.length, foot: `${number(summary.duplicate_records_removed)} duplicate records removed`, icon: '▦' },
  ];
  $('#kpiGrid').innerHTML = kpis.map((item) => `<article class="kpi-card"><div class="kpi-label">${escapeHtml(item.label)}<span class="kpi-icon">${item.icon}</span></div><div class="kpi-value">${number(item.value)}</div><div class="kpi-foot">${escapeHtml(item.foot)}</div></article>`).join('');
  const currencies = Object.entries(spendByCurrency(audit));
  $('#currencyCards').innerHTML = currencies.map(([currency, amount]) => `<div class="currency-card"><div class="currency-label"><span class="currency-code">${escapeHtml(currency)}</span> Net confirmed spend</div><strong class="currency-amount">${money(amount, currency)}</strong></div>`).join('');
  $('#subscriptionCount').textContent = summary.unique_subscriptions ?? audit.subscriptions.length;
  $('#transactionCount').textContent = audit.transactions.length;
  const statuses = [...new Set(audit.subscriptions.map((item) => item.subscription_status || 'unknown'))].sort();
  $('#statusFilter').innerHTML = '<option value="all">All statuses</option>' + statuses.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(titleCase(status))}</option>`).join('');
}

function renderSubscriptions() {
  const query = $('#subscriptionSearch').value.trim().toLowerCase();
  const status = $('#statusFilter').value;
  const items = audit.subscriptions.filter((item) => `${item.vendor_name} ${item.product_name} ${item.plan_name} ${item.subscription_id}`.toLowerCase().includes(query) && (status === 'all' || (item.subscription_status || 'unknown') === status)).sort((a, b) => String(b.last_payment_date || '').localeCompare(String(a.last_payment_date || '')));
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  subscriptionPage = Math.min(subscriptionPage, pages);
  const current = items.slice((subscriptionPage - 1) * PAGE_SIZE, subscriptionPage * PAGE_SIZE);
  $('#subscriptionRows').innerHTML = current.length ? current.map((item) => `<tr><td><div class="vendor-cell"><span class="vendor-mark">${escapeHtml(initials(item.vendor_name))}</span><span><span class="vendor-name">${escapeHtml(item.vendor_name)}</span><span class="vendor-sub">${escapeHtml(item.product_name || item.subscription_id)}</span></span></div></td><td>${escapeHtml(item.plan_name || '—')}</td><td><span class="status-pill ${escapeHtml(item.subscription_status || 'unknown')}">${escapeHtml(titleCase(item.subscription_status || 'unknown'))}</span></td><td>${dateLabel(item.last_payment_date)}</td><td>${number(item.total_confirmed_payments)}</td><td class="align-right amount">${money(item.net_confirmed_spend, item.currency)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-state">No subscriptions match this search.</td></tr>';
  $('#subscriptionFooter').innerHTML = `<span>Showing ${items.length ? (subscriptionPage - 1) * PAGE_SIZE + 1 : 0}–${Math.min(subscriptionPage * PAGE_SIZE, items.length)} of ${items.length}</span><span class="pager"><button class="page-button" data-page="sub-prev" ${subscriptionPage <= 1 ? 'disabled' : ''}>‹</button><span>${subscriptionPage} / ${pages}</span><button class="page-button" data-page="sub-next" ${subscriptionPage >= pages ? 'disabled' : ''}>›</button></span>`;
}

function renderTransactions() {
  const query = $('#transactionSearch').value.trim().toLowerCase();
  const items = audit.transactions.filter((item) => `${item.vendor_name} ${item.product_name} ${item.transaction_id} ${item.email_subject} ${item.transaction_status} ${item.transaction_type}`.toLowerCase().includes(query)).sort((a, b) => String(b.transaction_date || '').localeCompare(String(a.transaction_date || '')));
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  transactionPage = Math.min(transactionPage, pages);
  const current = items.slice((transactionPage - 1) * PAGE_SIZE, transactionPage * PAGE_SIZE);
  $('#transactionRows').innerHTML = current.length ? current.map((item) => {
    const status = String(item.transaction_status || 'unknown').toLowerCase();
    const amount = item.net_transaction_amount ?? item.amount ?? 0;
    return `<tr><td><div class="vendor-cell"><span class="vendor-mark">${escapeHtml(initials(cleanVendor(item.vendor_name)))}</span><span><span class="vendor-name">${escapeHtml(cleanVendor(item.vendor_name))}</span><span class="vendor-sub">${escapeHtml(item.product_name || item.subscription_id || '')}</span></span></div></td><td>${dateLabel(item.transaction_date)}</td><td><span class="type-pill">${escapeHtml(titleCase(item.transaction_type || 'payment'))}</span></td><td><span class="status-pill ${escapeHtml(status)}">${escapeHtml(titleCase(status))}</span></td><td class="mono">${escapeHtml(item.payment_reference || item.transaction_id || '—')}</td><td class="align-right amount ${Number(amount) < 0 ? 'negative' : ''}">${money(amount, item.currency)}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-state">No transactions match this search.</td></tr>';
  $('#transactionFooter').innerHTML = `<span>Showing ${items.length ? (transactionPage - 1) * PAGE_SIZE + 1 : 0}–${Math.min(transactionPage * PAGE_SIZE, items.length)} of ${items.length}</span><span class="pager"><button class="page-button" data-page="txn-prev" ${transactionPage <= 1 ? 'disabled' : ''}>‹</button><span>${transactionPage} / ${pages}</span><button class="page-button" data-page="txn-next" ${transactionPage >= pages ? 'disabled' : ''}>›</button></span>`;
}

function renderChart() {
  const currency = $('#currencyFilter').value;
  const grouped = new Map();
  audit.monthly_spending.filter((row) => row.currency === currency).forEach((row) => grouped.set(row.month, (grouped.get(row.month) || 0) + Number(row.net_confirmed_spend ?? row.net_spend ?? 0)));
  const months = [...grouped.keys()].sort();
  const values = months.map((month) => grouped.get(month));
  const step = Math.max(1, Math.ceil(Math.max(...values, 0) / 4 / 10) * 10);
  const axisMax = step * 4;
  $('#chartTotal').textContent = money(values.reduce((sum, value) => sum + value, 0), currency);
  $('#yAxis').innerHTML = [4, 3, 2, 1, 0].map((part) => `<span>${number(step * part)}</span>`).join('');
  $('#spendChart').innerHTML = months.map((month, index) => {
    const height = values[index] ? Math.max(2, values[index] / axisMax * 100) : 0;
    return `<div class="bar-group"><div class="bar" style="height:${height}%"><span class="bar-tooltip">${month} · ${money(values[index], currency)}</span></div><span class="month-label">${new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short' })}</span></div>`;
  }).join('') || '<div class="empty-state">No monthly spend recorded in this currency.</div>';
}

function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2400); }

function selectAccount(accountNumber) {
  audit = accounts.find((account) => account.accountNumber === accountNumber)?.data;
  audit.accountNumber = accountNumber;
  subscriptionPage = 1; transactionPage = 1;
  $('#subscriptionSearch').value = ''; $('#transactionSearch').value = '';
  renderAccountDirectory();
  const currencies = [...new Set(audit.monthly_spending.map((row) => row.currency))];
  $('#currencyFilter').innerHTML = currencies.map((currency) => `<option value="${escapeHtml(currency)}">${escapeHtml(currency)}</option>`).join('');
  renderSummary(); renderSubscriptions(); renderTransactions(); renderChart();
}

function renderGlobalSearch() {
  const input = $('#globalSearch');
  const query = input.value.trim().toLowerCase();
  const results = $('#globalResults');
  if (!query) { results.hidden = true; globalMatches = []; return; }
  globalMatches = accounts.filter((account) => account.data).flatMap((account) => account.data.subscriptions.map((subscription) => ({ account, subscription }))).filter(({ subscription }) => `${subscription.vendor_name} ${subscription.product_name} ${subscription.plan_name} ${subscription.category} ${subscription.subscription_id}`.toLowerCase().includes(query)).slice(0, 10);
  results.innerHTML = globalMatches.length ? globalMatches.map(({ account, subscription }, index) => {
    const evidence = paymentEvidence(account.data, subscription);
    const status = statusSummary(subscription.subscription_status, evidence.length);
    const emails = evidence.slice(0, 3).map((transaction) => transaction.gmail_message_link
      ? `<a class="evidence-mail" href="${escapeHtml(transaction.gmail_message_link)}" target="_blank" rel="noopener"><span>✉</span><span>${escapeHtml(transaction.email_subject || `${titleCase(transaction.transaction_type || 'payment')} email`)}<small>${dateLabel(transaction.transaction_date)} · ${money(transaction.net_transaction_amount ?? transaction.amount, transaction.currency)}</small></span><span>↗</span></a>`
      : `<div class="evidence-mail no-link"><span>✉</span><span>${escapeHtml(transaction.email_subject || `${titleCase(transaction.transaction_type || 'payment')} email`)}<small>${dateLabel(transaction.transaction_date)} · ${money(transaction.net_transaction_amount ?? transaction.amount, transaction.currency)}</small></span></div>`).join('');
    return `<article class="global-result-card"><button class="global-result" type="button" data-search-result="${index}"><span class="result-mark">${escapeHtml(initials(subscription.vendor_name))}</span><span class="result-main"><strong>${escapeHtml(subscription.vendor_name)}</strong><small>${escapeHtml(subscription.plan_name || subscription.product_name || 'Subscription')}</small></span><span class="result-account">Account ${account.accountNumber}<small>${escapeHtml(account.email)}</small></span><span class="result-spend">${money(subscription.net_confirmed_spend, subscription.currency)}</span></button><div class="result-evidence"><span class="evidence-status ${status.className}">${escapeHtml(status.label)}</span><span class="evidence-caption">${evidence.length ? `${evidence.length} paid email${evidence.length === 1 ? '' : 's'} found` : 'No confirmed paid email found'}</span>${emails || '<span class="evidence-none">No matching purchase email in this account file.</span>'}</div></article>`;
  }).join('') : '<div class="search-empty">No matching tools found in the loaded accounts.</div>';
  results.hidden = false;
}

function openGlobalResult(index) {
  const match = globalMatches[index];
  if (!match) return;
  selectAccount(match.account.accountNumber);
  $('#globalSearch').value = '';
  $('#globalResults').hidden = true;
  $('#subscriptionSearch').value = match.subscription.vendor_name || match.subscription.product_name || '';
  $('#statusFilter').value = 'all';
  const sortedMatches = audit.subscriptions.filter((item) => `${item.vendor_name} ${item.product_name} ${item.plan_name} ${item.subscription_id}`.toLowerCase().includes($('#subscriptionSearch').value.toLowerCase())).sort((a, b) => String(b.last_payment_date || '').localeCompare(String(a.last_payment_date || '')));
  const resultIndex = Math.max(0, sortedMatches.findIndex((item) => item.subscription_id === match.subscription.subscription_id));
  subscriptionPage = Math.floor(resultIndex / PAGE_SIZE) + 1;
  renderSubscriptions();
  $('#subscriptions').scrollIntoView({ behavior: 'smooth' });
}

function paymentEvidence(data, subscription) {
  const transactions = data.transactions || [];
  const related = transactions.filter((transaction) => {
    if (transaction.subscription_id && subscription.subscription_id && transaction.subscription_id === subscription.subscription_id) return true;
    const vendor = String(transaction.vendor_name || '').toLowerCase();
    const target = String(subscription.vendor_name || '').toLowerCase();
    return vendor && target && (vendor === target || vendor.includes(target) || target.includes(vendor));
  });
  return related.filter((transaction) => {
    const status = String(transaction.transaction_status || '').toLowerCase();
    const type = String(transaction.transaction_type || '').toLowerCase();
    const amount = Number(transaction.net_transaction_amount ?? transaction.amount ?? 0);
    return /succeed|success|paid|confirmed_paid/.test(status) || (amount > 0 && /payment|charge|purchase|invoice/.test(type) && !/failed|refund|credit/.test(status));
  }).sort((a, b) => String(b.transaction_date || '').localeCompare(String(a.transaction_date || '')));
}

function statusSummary(statusValue, paidCount) {
  const status = String(statusValue || 'unknown').toLowerCase();
  if (/active_until_period_end/.test(status)) return { label: 'Active through period end · renewal cancelled', className: 'ending' };
  if (/cancel|terminat|expired/.test(status)) return { label: `Cancellation/status · ${titleCase(status)}`, className: 'ending' };
  if (/active|trial/.test(status) && !/inactive|not_active/.test(status)) return { label: `Active · ${titleCase(status)}`, className: 'active' };
  if (/fail|past_due/.test(status)) return { label: `Payment issue · ${titleCase(status)}`, className: 'issue' };
  if (paidCount) return { label: 'Purchased · active status unconfirmed', className: 'purchased' };
  return { label: `Status · ${titleCase(status)}`, className: 'unknown' };
}

function bindEvents() {
  $('#subscriptionSearch').addEventListener('input', () => { subscriptionPage = 1; renderSubscriptions(); });
  $('#statusFilter').addEventListener('change', () => { subscriptionPage = 1; renderSubscriptions(); });
  $('#transactionSearch').addEventListener('input', () => { transactionPage = 1; renderTransactions(); });
  $('#currencyFilter').addEventListener('change', renderChart);
  $('#globalSearch').addEventListener('input', renderGlobalSearch);
  $('#globalSearch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); openGlobalResult(0); }
    if (event.key === 'Escape') { event.currentTarget.value = ''; $('#globalResults').hidden = true; }
  });
  $('#globalResults').addEventListener('click', (event) => {
    const result = event.target.closest('[data-search-result]');
    if (result) openGlobalResult(Number(result.dataset.searchResult));
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' || event.key === '/') {
      if (event.target.matches('input, textarea, select')) return;
      event.preventDefault(); $('#globalSearch').focus();
    }
  });
  $('#accountGrid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-account]'); if (!button) return;
    const account = accounts.find((item) => item.accountNumber === Number(button.dataset.account));
    if (!account?.data) { showToast(`Add subscription${account.accountNumber}.json to connect this account`); return; }
    selectAccount(account.accountNumber); $('#overview').scrollIntoView({ behavior: 'smooth' });
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]'); if (!button || button.disabled) return;
    if (button.dataset.page.startsWith('sub-')) { subscriptionPage += button.dataset.page === 'sub-next' ? 1 : -1; renderSubscriptions(); }
    else { transactionPage += button.dataset.page === 'txn-next' ? 1 : -1; renderTransactions(); }
  });
  const sections = [...document.querySelectorAll('main section[id], main#overview')];
  const navLinks = [...document.querySelectorAll('.side-nav a')];
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const id = entry.target.id || 'overview';
    navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${id}` || (id === 'spending' && link.getAttribute('href') === '#overview')));
  }), { rootMargin: '-20% 0px -70% 0px' });
  sections.forEach((section) => observer.observe(section));
}

async function init() {
  try {
    const results = await Promise.all(Array.from({ length: 9 }, async (_, index) => {
      const accountNumber = index + 1;
      const candidates = [`subscription${accountNumber}.json`, `subscriptions${accountNumber}.json`];
      for (const sourceFile of candidates) {
        try {
          const response = await fetch(`./${sourceFile}`);
          if (response.ok) return { accountNumber, data: await response.json(), sourceFile };
        } catch { /* Try the alternate supported filename. */ }
      }
      return { accountNumber, data: null, sourceFile: null };
    }));
    accounts = results.map(({ accountNumber, data, sourceFile }) => ({ accountNumber, data, sourceFile, email: data?.audit_metadata?.accounts_audited?.[0] || `Account ${accountNumber}` }));
    renderAccountDirectory();
    const firstAvailable = accounts.find((account) => account.data);
    if (!firstAvailable) throw new Error('No account files found. Add subscription1.json through subscription9.json, or the plural subscriptionsN.json variants.');
    selectAccount(firstAvailable.accountNumber);
    bindEvents();
  } catch (error) {
    console.error(error);
    document.querySelector('.page-wrap').innerHTML = `<section class="load-error"><div class="error-mark">!</div><h1>Couldn’t load the account data</h1><p>${escapeHtml(error.message)} Open this page through a local web server so the browser can read JSON files.</p><code>python3 -m http.server 8000</code><p>Then visit <strong>http://localhost:8000</strong>.</p></section>`;
  }
}

init();
