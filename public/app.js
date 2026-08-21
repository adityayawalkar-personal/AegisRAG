// AegisRAG Dashboard Application Logic

let apiKey = localStorage.getItem('aegisrag_api_key') || '';
let previousCollectorStates = new Map();
let isPollingActive = true;
let pollTimer = null;

// DOM Elements
const chatForm = document.getElementById('chatForm');
const queryInput = document.getElementById('queryInput');
const sendBtn = document.getElementById('sendBtn');
const chatMessages = document.getElementById('chatMessages');
const navTabs = document.querySelectorAll('.nav-tab');
const tabPanels = document.querySelectorAll('.tab-panel');
const refreshHealthBtn = document.getElementById('refreshHealthBtn');
const triggerRunBtn = document.getElementById('triggerRunBtn');
const sourceSelect = document.getElementById('sourceSelect');
const authBadgeDot = document.getElementById('authBadgeDot');
const toastContainer = document.getElementById('toastContainer');

// Modal Elements
const openAuthModalBtn = document.getElementById('openAuthModalBtn');
const authModal = document.getElementById('authModal');
const closeAuthModalBtn = document.getElementById('closeAuthModalBtn');
const modalApiKeyInput = document.getElementById('modalApiKeyInput');
const saveAuthBtn = document.getElementById('saveAuthBtn');
const clearAuthBtn = document.getElementById('clearAuthBtn');

const confirmModal = document.getElementById('confirmModal');
const closeConfirmModalBtn = document.getElementById('closeConfirmModalBtn');
const confirmModalTitle = document.getElementById('confirmModalTitle');
const confirmModalMessage = document.getElementById('confirmModalMessage');
const confirmPromptContainer = document.getElementById('confirmPromptContainer');
const confirmPromptInput = document.getElementById('confirmPromptInput');
const cancelConfirmBtn = document.getElementById('cancelConfirmBtn');
const acceptConfirmBtn = document.getElementById('acceptConfirmBtn');

let confirmResolve = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  updateAuthBadge();
  fetchHealthData();
  fetchIncidentReplay();
  startPolling();
});

function setupEventListeners() {
  // Navigation Tabs
  navTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      navTabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tabPanels.forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const activePanel = document.getElementById(target);
      if (activePanel) activePanel.classList.add('active');

      if (target === 'health-tab') fetchHealthData();
      if (target === 'replay-tab') fetchIncidentReplay();
    });
  });

  // Chat Form Submission
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = queryInput.value.trim();
    if (!query) return;

    appendMessage('user', query);
    queryInput.value = '';

    // Disable input and button while querying
    setQueryLoading(true);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['x-api-key'] = apiKey;

      const res = await fetch('/api/query', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
      });

      if (res.status === 401) {
        appendMessage('system', '⚠️ Unauthorized: API Secret required. Click "API Auth" in the header to enter your API key.');
        openAuthModal();
        return;
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      appendBotResponse(data);
    } catch (err) {
      appendMessage('system', `❌ Error: ${err.message}`);
      showToast(`Query failed: ${err.message}`, 'error');
    } finally {
      setQueryLoading(false);
    }
  });

  // Suggested Queries
  document.querySelectorAll('.suggestion-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      queryInput.value = btn.getAttribute('data-query');
      queryInput.focus();
    });
  });

  // Health Console Actions
  refreshHealthBtn.addEventListener('click', () => {
    fetchHealthData();
    showToast('Telemetry refreshed', 'info');
  });

  triggerRunBtn.addEventListener('click', async () => {
    const selectedSource = sourceSelect.value || 'github-trending';
    triggerRunBtn.disabled = true;
    triggerRunBtn.innerHTML = '<span>Running...</span> <span class="spinner"></span>';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['x-api-key'] = apiKey;

      const res = await fetch('/api/trigger-run', {
        method: 'POST',
        headers,
        body: JSON.stringify({ sourceId: selectedSource }),
      });

      if (res.status === 401) {
        showToast('Unauthorized: API Secret required.', 'warning');
        openAuthModal();
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to trigger run');

      showToast(`Run completed for ${selectedSource}! Outcome: ${data.outcome?.status || 'COMPLETED'}`, 'success');
      fetchHealthData();
      fetchIncidentReplay();
    } catch (err) {
      showToast(`Trigger failed: ${err.message}`, 'error');
    } finally {
      triggerRunBtn.disabled = false;
      triggerRunBtn.innerHTML = 'Trigger Run';
    }
  });

  // Auth Modal
  openAuthModalBtn.addEventListener('click', openAuthModal);
  closeAuthModalBtn.addEventListener('click', closeAuthModal);
  authModal.addEventListener('click', (e) => {
    if (e.target === authModal) closeAuthModal();
  });

  saveAuthBtn.addEventListener('click', () => {
    apiKey = modalApiKeyInput.value.trim();
    if (apiKey) {
      localStorage.setItem('aegisrag_api_key', apiKey);
      showToast('API Auth Secret saved', 'success');
    } else {
      localStorage.removeItem('aegisrag_api_key');
      showToast('API Auth Secret removed', 'info');
    }
    updateAuthBadge();
    closeAuthModal();
  });

  clearAuthBtn.addEventListener('click', () => {
    modalApiKeyInput.value = '';
    apiKey = '';
    localStorage.removeItem('aegisrag_api_key');
    updateAuthBadge();
    showToast('API Secret cleared', 'info');
    closeAuthModal();
  });

  // Confirmation Dialog
  closeConfirmModalBtn.addEventListener('click', () => resolveConfirm(false));
  cancelConfirmBtn.addEventListener('click', () => resolveConfirm(false));
  acceptConfirmBtn.addEventListener('click', () => {
    const isPrompt = confirmPromptContainer.style.display !== 'none';
    if (isPrompt) {
      resolveConfirm(confirmPromptInput.value.trim());
    } else {
      resolveConfirm(true);
    }
  });

  // Keyboard accessibility (Esc to close modals)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (authModal.classList.contains('active')) closeAuthModal();
      if (confirmModal.classList.contains('active')) resolveConfirm(false);
    }
  });
}

function setQueryLoading(isLoading) {
  if (isLoading) {
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span>Querying...</span><span class="spinner" aria-hidden="true"></span>';
    queryInput.disabled = true;
  } else {
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<span>Query RAG</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
    queryInput.disabled = false;
    queryInput.focus();
  }
}

function updateAuthBadge() {
  if (apiKey) {
    authBadgeDot.classList.add('connected');
    openAuthModalBtn.setAttribute('title', 'API Secret Configured');
  } else {
    authBadgeDot.classList.remove('connected');
    openAuthModalBtn.setAttribute('title', 'No API Secret configured — click to configure');
  }
}

function openAuthModal() {
  modalApiKeyInput.value = apiKey;
  authModal.classList.add('active');
  modalApiKeyInput.focus();
}

function closeAuthModal() {
  authModal.classList.remove('active');
}

function showConfirmDialog(title, message) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmModalTitle.textContent = title;
    confirmModalMessage.textContent = message;
    confirmPromptContainer.style.display = 'none';
    acceptConfirmBtn.textContent = 'Confirm';
    confirmModal.classList.add('active');
  });
}

function showPromptDialog(title, message, defaultVal = '') {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmModalTitle.textContent = title;
    confirmModalMessage.textContent = message;
    confirmPromptInput.value = defaultVal;
    confirmPromptContainer.style.display = 'block';
    acceptConfirmBtn.textContent = 'Submit';
    confirmModal.classList.add('active');
    confirmPromptInput.focus();
  });
}

function resolveConfirm(val) {
  confirmModal.classList.remove('active');
  if (confirmResolve) {
    confirmResolve(val);
    confirmResolve = null;
  }
}

// Unified timestamp formatter
function formatTimestamp(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return String(isoString);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(isoString);
  }
}

// Toast Notifications
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Background Polling
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!isPollingActive) return;
    await fetchHealthData(true);
  }, 4000);
}

// Chat UI Rendering
function appendMessage(role, text) {
  const msg = document.createElement('div');
  msg.className = `message ${role}-message`;
  msg.innerHTML = `<div class="message-content">${escapeHtml(text)}</div>`;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendRecoveryBanner(collectorName, schemaVersion) {
  const msg = document.createElement('div');
  msg.className = 'message recovery-notice';
  msg.innerHTML = `
    <div class="message-content">
      <strong>🎉 Knowledge Base Recovered:</strong> Collector <code>${escapeHtml(collectorName)}</code> transitioned to <strong>RECOVERED</strong>. Stale extractions purged and schema updated to <code>v${escapeHtml(schemaVersion)}</code>. Ask questions to verify fresh citations!
    </div>
  `;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendBotResponse(data) {
  const msg = document.createElement('div');
  msg.className = 'message bot-message';

  // Format citations properly: escape HTML first, then match and convert citation patterns
  let formattedAnswer = escapeHtml(data.answer);
  formattedAnswer = formattedAnswer.replace(
    /\[Source:\s*([^\]|]+)\s*\|\s*Last Verified:\s*([^\]]+)\]/g,
    (match, sourceUrl, lastVerified) => {
      const cleanUrl = sourceUrl.trim();
      const cleanDate = formatTimestamp(lastVerified.trim());
      return `<span class="inline-citation">📍 <a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a> <span class="citation-date">(${cleanDate})</span></span>`;
    }
  );

  let citationsHtml = '';
  if (data.citations && data.citations.length > 0) {
    citationsHtml = `
      <div class="citation-badge-list" aria-label="Verified Citations">
        ${data.citations
          .map(
            (c) => `
            <a href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="citation-badge" title="Verified at ${formatTimestamp(c.lastVerifiedAt)}">
              <span>🔗 ${escapeHtml(c.sourceUrl)}</span>
              <span class="citation-date">(${formatTimestamp(c.lastVerifiedAt)})</span>
            </a>`
          )
          .join('')}
      </div>
    `;
  }

  msg.innerHTML = `
    <div class="message-content">${formattedAnswer}</div>
    ${citationsHtml}
  `;

  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Health Data Fetching & Polling Diff Check
async function fetchHealthData(isPoll = false) {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return;
    const data = await res.json();

    // 1. Check for State Transitions (Heal Recovery Detection)
    if (data.collectors && Array.isArray(data.collectors)) {
      data.collectors.forEach((col) => {
        const prevState = previousCollectorStates.get(col.collector_id);
        if (prevState && prevState.status !== col.status) {
          if (col.status === 'RECOVERED' || (prevState.status === 'HEALING' && col.status === 'HEALTHY')) {
            appendRecoveryBanner(col.name || col.collector_id, col.schema_version);
            showToast(`Collector ${col.name} recovered successfully!`, 'success');
            fetchIncidentReplay();
          }
        }
        previousCollectorStates.set(col.collector_id, {
          status: col.status,
          schema_version: col.schema_version,
          name: col.name,
        });
      });

      // Update source select dropdown if needed
      updateSourceSelector(data.collectors);
    }

    // 2. Update Metrics Cards
    document.getElementById('metricTotalChunks').textContent = data.knowledge_base?.total_chunks ?? '0';
    document.getElementById('metricBm25').textContent = `BM25 & Vector Index Active (${data.knowledge_base?.total_documents ?? 0} docs)`;

    const primaryCollector = data.collectors?.[0];
    if (primaryCollector) {
      const statusEl = document.getElementById('metricCollectorStatus');
      statusEl.textContent = primaryCollector.status;
      statusEl.className = `metric-value status-${primaryCollector.status.toLowerCase()}`;
      document.getElementById('metricCircuitBreaker').textContent = `Circuit Breaker: ${primaryCollector.consecutive_failures || 0}/3 Strikes`;
    }

    const lastRun = data.recent_runs?.[0];
    if (lastRun) {
      document.getElementById('metricSentinelStatus').textContent = lastRun.status;
      document.getElementById('metricLastValidated').textContent = `Validated: ${formatTimestamp(lastRun.completed_at)}`;
    }

    // 3. Render Registered Collectors
    renderCollectors(data.collectors || []);

    // 4. Render Pending Heals
    renderPendingHeals(data.pending_heals || []);
  } catch (err) {
    if (!isPoll) console.error('Failed to fetch health telemetry:', err);
  }
}

function updateSourceSelector(collectors) {
  const currentVal = sourceSelect.value;
  const optionsHtml = collectors
    .map((c) => `<option value="${escapeHtml(c.source_id)}">Source: ${escapeHtml(c.name || c.source_id)} (${escapeHtml(c.source_id)})</option>`)
    .join('');

  if (sourceSelect.innerHTML !== optionsHtml) {
    sourceSelect.innerHTML = optionsHtml;
    if (currentVal) sourceSelect.value = currentVal;
  }
}

function renderCollectors(collectors) {
  const container = document.getElementById('collectorCardsContainer');
  if (collectors.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);">No collectors registered.</p>';
    return;
  }

  container.innerHTML = collectors
    .map(
      (c) => `
    <div class="collector-card">
      <div>
        <strong>${escapeHtml(c.name || c.collector_id)}</strong>
        <div style="font-size:12px; color:var(--text-muted); font-family:'JetBrains Mono', monospace;">
          ID: ${escapeHtml(c.collector_id)} | Schema: v${escapeHtml(c.schema_version)} | Target: ${escapeHtml(c.target_url)}
        </div>
      </div>
      <div>
        <span class="status-badge status-${escapeHtml(c.status.toLowerCase())}">${escapeHtml(c.status)}</span>
      </div>
    </div>
  `
    )
    .join('');
}

function renderPendingHeals(heals) {
  const container = document.getElementById('pendingHealsContainer');
  if (heals.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No pending heals. System is operating nominally.</p>';
    return;
  }

  container.innerHTML = heals
    .map((h) => {
      let previewFormatted = 'No preview payload';
      try {
        if (h.preview_payload) {
          const parsed = JSON.parse(h.preview_payload);
          previewFormatted = JSON.stringify(parsed, null, 2);
        }
      } catch {
        previewFormatted = h.preview_payload;
      }

      return `
      <div class="heal-card">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>Self-Healing Candidate #${escapeHtml(h.attempt_number)}</strong>
            <span style="font-size:12px; color:var(--text-muted); margin-left:8px;">(Attempt ID: ${escapeHtml(h.attempt_id)})</span>
          </div>
          <span class="status-badge status-healing">AWAITING APPROVAL</span>
        </div>

        <p style="font-size:13px; color:var(--text-secondary);">
          <strong>Gemma AI Repair Diagnosis:</strong> "${escapeHtml(h.heal_description)}"
        </p>

        <div style="font-size:12px; color:var(--text-muted);">Preview Extractions (Synthesized CSS Selectors):</div>
        <pre class="preview-box">${escapeHtml(previewFormatted)}</pre>

        <div class="btn-group" style="margin-top:6px;">
          <button class="approve-btn" onclick="approveHeal('${escapeHtml(h.attempt_id)}')">Approve & Recover</button>
          <button class="reject-btn" onclick="rejectHeal('${escapeHtml(h.attempt_id)}')">Reject Repair</button>
        </div>
      </div>
    `;
    })
    .join('');
}

// Global functions for inline onclick handlers
window.approveHeal = async function (attemptId) {
  const confirmed = await showConfirmDialog(
    'Approve Scraper Repair',
    'Are you sure you want to approve this heal candidate? This will update the collector schema and transition state to RECOVERED.'
  );
  if (!confirmed) return;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    const res = await fetch('/api/heal/approve', {
      method: 'POST',
      headers,
      body: JSON.stringify({ attemptId }),
    });

    if (res.status === 401) {
      showToast('Unauthorized: API Secret required to approve.', 'warning');
      openAuthModal();
      return;
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Approval failed');

    showToast('Heal approved! Collector is now RECOVERED.', 'success');
    fetchHealthData();
    fetchIncidentReplay();
  } catch (err) {
    showToast(`Approval failed: ${err.message}`, 'error');
  }
};

window.rejectHeal = async function (attemptId) {
  const reason = await showPromptDialog('Reject Scraper Repair', 'Enter rejection reason (will record a strike on the circuit breaker):', 'Candidate extracted invalid data.');
  if (reason === null) return;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    const res = await fetch('/api/heal/reject', {
      method: 'POST',
      headers,
      body: JSON.stringify({ attemptId, reason }),
    });

    if (res.status === 401) {
      showToast('Unauthorized: API Secret required to reject.', 'warning');
      openAuthModal();
      return;
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Rejection failed');

    showToast('Heal candidate rejected.', 'info');
    fetchHealthData();
    fetchIncidentReplay();
  } catch (err) {
    showToast(`Rejection failed: ${err.message}`, 'error');
  }
};

// Incident Replay Timeline
async function fetchIncidentReplay() {
  try {
    const res = await fetch('/api/incident-replay');
    if (!res.ok) return;
    const data = await res.json();

    const container = document.getElementById('incidentTimeline');
    if (!data.timeline || data.timeline.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);">No incident events recorded yet.</p>';
      return;
    }

    container.innerHTML = data.timeline
      .map(
        (event) => `
      <div class="timeline-item">
        <div class="timeline-content">
          <div class="timeline-time">${formatTimestamp(event.timestamp)}</div>
          <div class="timeline-title">${escapeHtml(event.title)}</div>
          <div style="font-size:13px; color:var(--text-secondary);">${escapeHtml(event.description)}</div>
        </div>
      </div>
    `
      )
      .join('');
  } catch (err) {
    console.error('Failed to load incident timeline:', err);
  }
}

// HTML Escaping Utility
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
