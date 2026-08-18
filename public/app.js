// AegisRAG Dashboard Application Logic

function getAuthHeader() {
  const input = document.getElementById('apiKeyInput');
  return input ? input.value.trim() : 'aegisrag-secret-token-2026';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 1. Tab Navigation
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));

    tab.classList.add('active');
    const targetId = tab.getAttribute('data-tab');
    const targetPanel = document.getElementById(targetId);
    if (targetPanel) targetPanel.classList.add('active');

    if (targetId === 'health-tab') fetchHealthData();
    if (targetId === 'replay-tab') fetchIncidentReplay();
  });
});

// 2. Query Suggestions
document.querySelectorAll('.suggestion-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const query = btn.getAttribute('data-query');
    const input = document.getElementById('queryInput');
    if (input) {
      input.value = query;
      document.getElementById('chatForm').dispatchEvent(new Event('submit'));
    }
  });
});

// 3. Chat Q&A Handling
const chatForm = document.getElementById('chatForm');
const chatMessages = document.getElementById('chatMessages');

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const queryInput = document.getElementById('queryInput');
  const query = queryInput.value.trim();
  if (!query) return;

  // Render User Message
  appendMessage('user', query);
  queryInput.value = '';

  // Render Loading Indicator
  const loadingMsgId = appendMessage('bot', '<em>Searching hybrid vector + BM25 index and generating verified answer...</em>');

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getAuthHeader(),
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      const err = await res.json();
      updateMessage(loadingMsgId, `⚠️ Query Error (${res.status}): ${escapeHtml(err.message || 'Request failed')}`);
      return;
    }

    const data = await res.json();
    let formattedAnswer = escapeHtml(data.answer);

    // Format inline citations nicely
    formattedAnswer = formattedAnswer.replace(
      /\[Source:\s*([^\]|]+)\s*\|\s*Last Verified:\s*([^\]]+)\]/g,
      '<span class="inline-citation">📍 <a href="$1" target="_blank" rel="noopener">$1</a> ($2)</span>'
    );

    let badgesHtml = '';
    if (data.citations && data.citations.length > 0) {
      badgesHtml = '<div class="citation-badge-list">';
      data.citations.forEach((c) => {
        badgesHtml += `<a href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener" class="citation-badge">🔗 ${escapeHtml(c.sourceUrl)} (${escapeHtml(new Date(c.lastVerifiedAt).toLocaleDateString())})</a>`;
      });
      badgesHtml += '</div>';
    }

    updateMessage(loadingMsgId, formattedAnswer + badgesHtml);
  } catch (err) {
    updateMessage(loadingMsgId, `⚠️ Network error: ${escapeHtml(err.message)}`);
  }
});

function appendMessage(role, htmlContent) {
  const msgDiv = document.createElement('div');
  const msgId = 'msg-' + Math.random().toString(36).slice(2, 9);
  msgDiv.id = msgId;
  msgDiv.className = `message ${role}-message`;
  msgDiv.innerHTML = `<div class="message-content">${htmlContent}</div>`;
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return msgId;
}

function updateMessage(msgId, newHtmlContent) {
  const el = document.getElementById(msgId);
  if (el) {
    el.innerHTML = `<div class="message-content">${newHtmlContent}</div>`;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

// 4. Health Console Telemetry
async function fetchHealthData() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('metricTotalChunks').textContent = data.totalChunksIndexed || 0;
    document.getElementById('metricBm25').textContent = `BM25 Vocabulary: ${data.bm25IndexSize || 0} docs`;

    const c0 = data.collectors && data.collectors[0];
    if (c0) {
      const statusEl = document.getElementById('metricCollectorStatus');
      statusEl.textContent = c0.state;
      statusEl.className = `metric-value status-${c0.state.toLowerCase()}`;

      document.getElementById('metricCircuitBreaker').textContent = c0.circuitBreakerTripped
        ? '⚡ Tripped (DEGRADED_PERMANENT)'
        : `Breaker OK (${c0.consecutiveFailures}/3 strikes)`;

      const lastStatus = c0.latestStatus;
      if (lastStatus) {
        document.getElementById('metricSentinelStatus').textContent = lastStatus.status;
        document.getElementById('metricLastValidated').textContent = `Validated: ${new Date(lastStatus.validated_at).toLocaleTimeString()}`;
      }
    }

    renderCollectors(data.collectors || []);
    renderPendingHeals(data.collectors || []);
  } catch (err) {
    console.error('Failed to fetch health data:', err);
  }
}

function renderCollectors(collectors) {
  const container = document.getElementById('collectorCardsContainer');
  if (!container) return;

  if (collectors.length === 0) {
    container.innerHTML = '<p class="text-muted">No collectors configured.</p>';
    return;
  }

  container.innerHTML = collectors
    .map((c) => {
      const stateClass = `status-${c.state.toLowerCase()}`;
      return `
      <div class="collector-card">
        <div>
          <h4>${escapeHtml(c.name)} <span class="status-badge ${stateClass}">${escapeHtml(c.state)}</span></h4>
          <p style="font-size:12px; color:var(--text-secondary); margin-top:4px;">ID: <code>${escapeHtml(c.collectorId)}</code> | Target: <a href="${escapeHtml(c.targetUrl)}" target="_blank">${escapeHtml(c.targetUrl)}</a></p>
        </div>
        <div style="text-align:right;">
          <p style="font-size:12px; color:var(--text-muted);">Consecutive Failures: ${c.consecutiveFailures}</p>
          <p style="font-size:12px; color:var(--text-muted);">${c.latestRun ? `Last Run: ${c.latestRun.status} (${c.latestRun.row_count} rows)` : 'No runs yet'}</p>
        </div>
      </div>
    `;
    })
    .join('');
}

function renderPendingHeals(collectors) {
  const container = document.getElementById('pendingHealsContainer');
  if (!container) return;

  const pendingAttempts = [];
  collectors.forEach((c) => {
    (c.healAttempts || []).forEach((h) => {
      if (h.status === 'AWAITING_APPROVAL') {
        pendingAttempts.push({ collector: c, attempt: h });
      }
    });
  });

  if (pendingAttempts.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No pending heal attempts awaiting operator approval. System is operating normally.</p>';
    return;
  }

  container.innerHTML = pendingAttempts
    .map(({ collector, attempt }) => {
      let previewFormatted = escapeHtml(attempt.preview_result || 'No preview returned');
      try {
        previewFormatted = JSON.stringify(JSON.parse(attempt.preview_result), null, 2);
      } catch {}

      return `
      <div class="heal-card">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>Heal Attempt for ${escapeHtml(collector.name)} (Attempt #${attempt.attempt_number})</strong>
          <span class="status-badge status-healing">AWAITING APPROVAL</span>
        </div>
        <p style="font-size:13px; color:var(--text-secondary);"><strong>Gemma AI Repair Diagnosis:</strong> "${escapeHtml(attempt.heal_description)}"</p>
        <div>
          <span style="font-size:12px; color:var(--text-muted);">Preview Extraction Result:</span>
          <pre class="preview-box">${escapeHtml(previewFormatted)}</pre>
        </div>
        <div class="btn-group" style="margin-top:6px;">
          <button class="approve-btn" onclick="handleApproveHeal('${escapeHtml(attempt.attempt_id)}')">Approve Repair</button>
          <button class="reject-btn" onclick="handleRejectHeal('${escapeHtml(attempt.attempt_id)}')">Reject Repair</button>
        </div>
      </div>
    `;
    })
    .join('');
}

window.handleApproveHeal = async function (attemptId) {
  if (!confirm('Are you sure you want to approve this heal repair?')) return;
  try {
    const res = await fetch('/api/heal/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': getAuthHeader() },
      body: JSON.stringify({ attemptId }),
    });
    if (res.ok) {
      alert('Heal approved successfully! Collector state transitioned to RECOVERED.');
      fetchHealthData();
    } else {
      const err = await res.json();
      alert(`Approval error: ${err.message}`);
    }
  } catch (err) {
    alert(`Request error: ${err.message}`);
  }
};

window.handleRejectHeal = async function (attemptId) {
  const reason = prompt('Reason for rejecting repair:', 'Manual rejection by operator');
  if (!reason) return;
  try {
    const res = await fetch('/api/heal/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': getAuthHeader() },
      body: JSON.stringify({ attemptId, reason }),
    });
    if (res.ok) {
      alert('Heal rejected. Strike recorded against circuit breaker.');
      fetchHealthData();
    } else {
      const err = await res.json();
      alert(`Rejection error: ${err.message}`);
    }
  } catch (err) {
    alert(`Request error: ${err.message}`);
  }
};

// Trigger Collector Run Button
document.getElementById('triggerRunBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('triggerRunBtn');
  btn.disabled = true;
  btn.textContent = 'Running Collector...';
  try {
    const res = await fetch('/api/trigger-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': getAuthHeader() },
      body: JSON.stringify({ sourceId: 'github-trending' }),
    });
    const data = await res.json();
    alert(`Run completed with status: ${data.run?.status || 'UNKNOWN'}. Sentinel: ${data.sentinelReport?.status || 'N/A'}`);
    fetchHealthData();
  } catch (err) {
    alert(`Trigger error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Trigger Collector Run';
  }
});

document.getElementById('refreshHealthBtn')?.addEventListener('click', fetchHealthData);

// 5. Incident Replay Visualizer
async function fetchIncidentReplay() {
  const container = document.getElementById('incidentTimeline');
  if (!container) return;

  try {
    const res = await fetch('/api/incident-replay');
    if (!res.ok) return;
    const data = await res.json();

    if (!data.timeline || data.timeline.length === 0) {
      container.innerHTML = '<p class="text-muted">No recent incident events recorded in SQLite logs.</p>';
      return;
    }

    container.innerHTML = data.timeline
      .map((item) => {
        let detailsHtml = '';
        if (item.details) {
          detailsHtml = `<pre style="font-size:11px; background:var(--bg-primary); padding:8px; border-radius:4px; margin-top:6px; color:#a5d6ff;">${escapeHtml(JSON.stringify(item.details, null, 2))}</pre>`;
        }

        return `
        <div class="timeline-item">
          <div class="timeline-content">
            <div class="timeline-time">${escapeHtml(new Date(item.timestamp).toLocaleString())}</div>
            <div class="timeline-title">${escapeHtml(item.title)}</div>
            ${detailsHtml}
          </div>
        </div>
      `;
      })
      .join('');
  } catch (err) {
    container.innerHTML = `<p style="color:var(--accent-rose);">Failed to load incident replay: ${escapeHtml(err.message)}</p>`;
  }
}

// Initial health fetch
fetchHealthData();
