import React, { useEffect, useState, useMemo, useCallback } from 'react';


interface HistoryVersion {
  id: number;
  record_id: string;
  summary_text: string | null;
  summary_model: string | null;
  summary_updated_at: string | null;
  labels: any;
  ocr_text: string | null;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  created_at: string;
}

interface QueueStatus {
  paused: boolean;
  pending: number;
  processing: {
    zai: number;
  };
  adaptiveConcurrency: {
    current: number;
    min: number;
    max: number;
    maxReached: number;
    consecutiveSuccesses: number;
    totalSuccesses: number;
    totalRateLimitHits: number;
    recentHistory: Array<{ time: number; concurrency: number; reason: string }>;
  };
  rateLimits: {
    zai: { used: number; limit: number };
  };
  deadLetterCount: number;
  deadLetterQueue: Array<{
    recordId: string;
    fileName: string;
    lastError?: string;
    retries: number;
  }>;
}

interface QueueItem {
  recordId: string;
  fileName: string;
  fileType: string;
  retries: number;
  enrichmentType: string;
  createdAt: number;
}

const BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '');

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error' | 'info'; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  const bg = type === 'success' ? '#2e7d32' : type === 'error' ? '#c62828' : '#1565c0';
  return (
    <div style={{
      position: 'fixed', top: 16, right: 16, zIndex: 9999, background: bg, color: '#fff',
      padding: '10px 20px', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      fontSize: 14, maxWidth: 400, cursor: 'pointer',
    }} onClick={onClose}>
      {message}
    </div>
  );
}

export default function Enrichments() {
  const [token, setToken] = useState(localStorage.getItem('admin_token') || '');
  const [tokenInput, setTokenInput] = useState(localStorage.getItem('admin_token') || '');
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [unsummarizedCount, setUnsummarizedCount] = useState<number | null>(null);
  const [backfillLimit, setBackfillLimit] = useState('100');
  const [forceReenrich, setForceReenrich] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [recentSummaries, setRecentSummaries] = useState<Array<{ record_id: string; original_file_name: string; summary_text: string; summary_model: string; summary_updated_at: string; file_type: string; mime_type?: string; metadata?: any }>>([]);
  const [historyRecordId, setHistoryRecordId] = useState<string | null>(null);
  const [historyVersions, setHistoryVersions] = useState<HistoryVersion[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedHistoryVersions, setExpandedHistoryVersions] = useState<number[]>([]);
  const [concurrencyInput, setConcurrencyInput] = useState('5');
  const [incrementInput, setIncrementInput] = useState('1');
  const [minInput, setMinInput] = useState('1');
  const [maxInput, setMaxInput] = useState('20');

  const headers = useMemo(() => token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {}, [token]);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
  }, []);

  async function loadStatus() {
    if (!token) return;
    try {
      setLoading(true);
      const res = await fetch(`${BASE}/api/enrichments/queue-status`, { headers });
      if (!res.ok) throw new Error(res.status === 401 ? 'Invalid token' : 'Failed to load status');
      const data = await res.json();
      setStatus(data);
      setError('');
      if (data.adaptiveConcurrency) {
        setConcurrencyInput(String(data.adaptiveConcurrency.current));
        setMinInput(String(data.adaptiveConcurrency.min));
        setMaxInput(String(data.adaptiveConcurrency.max));
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }

  async function loadRecentSummaries() {
    if (!token) return;
    try {
      const res = await fetch(`${BASE}/api/enrichments/recent-summaries?limit=20`, { headers });
      if (res.ok) {
        const data = await res.json();
        setRecentSummaries(data.summaries || []);
      }
    } catch {}
  }

  async function loadUnsummarizedCount() {
    if (!token) return;
    try {
      const res = await fetch(`${BASE}/api/enrichments/unsummarized-count`, { headers });
      if (res.ok) {
        const data = await res.json();
        setUnsummarizedCount(data.count);
      }
    } catch {}
  }

  async function loadQueueItems() {
    if (!token) return;
    try {
      const res = await fetch(`${BASE}/api/enrichments/queue-items`, { headers });
      if (res.ok) {
        const data = await res.json();
        setQueueItems(data.items || []);
      }
    } catch {}
  }

  function formatRelativeTime(ts: number) {
    const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  async function loadHistory(recordId: string) {
    if (!token) return;
    try {
      setHistoryRecordId(recordId);
      setHistoryLoading(true);
      setExpandedHistoryVersions([]);
      const res = await fetch(`${BASE}/api/enrichments/history/${recordId}`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to load history');
      setHistoryVersions(data.versions || []);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load history', 'error');
      setHistoryRecordId(null);
      setHistoryVersions([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function revertVersion(recordId: string, versionId: number) {
    if (!token) return;
    try {
      setActionLoading(`revert-${versionId}`);
      const res = await fetch(`${BASE}/api/enrichments/revert/${recordId}/${versionId}`, {
        method: 'POST',
        headers,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to revert version');
      showToast(data.message || `Reverted to version ${versionId}`, 'success');
      await loadHistory(recordId);
      await loadRecentSummaries();
      await loadStatus();
    } catch (err: any) {
      showToast(err?.message || 'Failed to revert version', 'error');
    } finally {
      setActionLoading('');
    }
  }

  async function deleteVersion(versionId: number, recordId: string) {
    if (!token) return;
    const ok = window.confirm(`Delete version ${versionId}? This cannot be undone.`);
    if (!ok) return;

    try {
      setActionLoading(`delete-${versionId}`);
      const res = await fetch(`${BASE}/api/enrichments/history/${versionId}`, {
        method: 'DELETE',
        headers,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to delete version');
      showToast(data.message || 'Version deleted', 'success');
      await loadHistory(recordId);
      await loadRecentSummaries();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete version', 'error');
    } finally {
      setActionLoading('');
    }
  }

  function toggleHistoryExpand(versionId: number) {
    setExpandedHistoryVersions(prev => prev.includes(versionId)
      ? prev.filter(id => id !== versionId)
      : [...prev, versionId]);
  }

  useEffect(() => {
    loadStatus();
    loadUnsummarizedCount();
    loadRecentSummaries();
    loadQueueItems();
  }, [token]);

  useEffect(() => {
    if (!isPolling || !token) return;
    const timer = setInterval(() => {
      loadStatus();
      loadUnsummarizedCount();
      loadRecentSummaries();
      loadQueueItems();
    }, 4000);
    return () => clearInterval(timer);
  }, [isPolling, token]);

  async function startBackfill() {
    if (!token) return;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      setActionLoading('backfill');
      const limit = Math.max(1, Math.min(Number(backfillLimit) || 100, 1000));
      const forceQ = forceReenrich ? '&force=true' : '';
      const res = await fetch(`${BASE}/api/enrichments/enrich-all?limit=${limit}${forceQ}`, {
        method: 'POST',
        headers,
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed');
      showToast(`Queued ${data.queued} attachments (${data.failed} failed)`, data.failed > 0 ? 'error' : 'success');
      setIsPolling(true);
      await loadStatus();
      await loadUnsummarizedCount();
      await loadQueueItems();
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        showToast('Backfill start timed out after 10 seconds. Please check queue status.', 'error');
      } else {
        showToast(err?.message || 'Failed', 'error');
      }
    } finally {
      clearTimeout(timeout);
      const elapsed = Date.now() - startedAt;
      if (elapsed < 500) {
        await new Promise(resolve => setTimeout(resolve, 500 - elapsed));
      }
      setActionLoading('');
    }
  }

  async function retryFailed() {
    if (!token) return;
    try {
      setActionLoading('retry');
      const res = await fetch(`${BASE}/api/enrichments/retry-failed`, { method: 'POST', headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed');
      showToast(`Retried ${data.retried} items`, 'success');
      setIsPolling(true);
      await loadStatus();
      await loadQueueItems();
    } catch (err: any) {
      showToast(err?.message || 'Failed', 'error');
    } finally {
      setActionLoading('');
    }
  }

  async function togglePause() {
    if (!token) return;
    const action = status?.paused ? 'resume' : 'pause';
    try {
      setActionLoading('pause');
      const res = await fetch(`${BASE}/api/enrichments/${action}`, { method: 'POST', headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed');
      showToast(data.message, 'info');
      await loadStatus();
      await loadQueueItems();
    } catch (err: any) {
      showToast(err?.message || 'Failed', 'error');
    } finally {
      setActionLoading('');
    }
  }

  async function cancelPending() {
    if (!token) return;
    try {
      setActionLoading('cancel');
      const res = await fetch(`${BASE}/api/enrichments/cancel-pending`, { method: 'POST', headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed');
      showToast(`Cancelled ${data.cancelled} pending items`, 'info');
      await loadStatus();
      await loadQueueItems();
    } catch (err: any) {
      showToast(err?.message || 'Failed', 'error');
    } finally {
      setActionLoading('');
    }
  }

  function saveToken() {
    const next = tokenInput.trim();
    localStorage.setItem('admin_token', next);
    setToken(next);
  }

  const totalProcessing = status ? status.processing.zai : 0;
  const totalActive = (status?.pending || 0) + totalProcessing;

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 1000, margin: '2rem auto', padding: '0 1rem' }}>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <h1>⚡ Enrichments</h1>
      <div style={{ marginBottom: 12 }}>
        <a href={`${BASE}/admin`}>← Back to Admin</a>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Admin token" type="password" value={tokenInput}
          onChange={e => setTokenInput(e.target.value)} style={{ width: 320 }} />
        <button onClick={saveToken}>Connect</button>
        <button onClick={() => { loadStatus(); loadUnsummarizedCount(); loadQueueItems(); }} disabled={loading}>Refresh</button>
      </div>

      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}

      {/* Unsummarized Count */}
      {unsummarizedCount !== null && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16, background: unsummarizedCount > 0 ? '#1a1a0a' : '#0a1a0a' }}>
          <h2 style={{ marginTop: 0 }}>📋 Attachments Missing Summaries</h2>
          <p style={{ margin: 0, fontSize: 28, fontWeight: 'bold', color: unsummarizedCount > 0 ? '#ffab00' : '#4caf50' }}>
            {unsummarizedCount.toLocaleString()}
          </p>
        </div>
      )}

      {/* Queue Status */}
      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>
          📊 Queue Status
          {status?.paused && <span style={{ color: '#ff9800', fontSize: 14, marginLeft: 8 }}>⏸ PAUSED</span>}
        </h2>
        {loading && !status ? (
          <p>Loading…</p>
        ) : status ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#888' }}>PENDING</p>
              <p style={{ margin: 0, fontSize: 24, fontWeight: 'bold' }}>{status.pending}</p>
            </div>
            <div>
              <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#888' }}>PROCESSING</p>
              <p style={{ margin: 0, fontSize: 24, fontWeight: 'bold' }}>
                {totalProcessing} <span style={{ fontSize: 14, color: '#888' }}>(Z.AI: {status.processing.zai})</span>
              </p>
            </div>
            <div>
              <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#888' }}>DEAD LETTERS</p>
              <p style={{ margin: 0, fontSize: 24, fontWeight: 'bold', color: status.deadLetterCount > 0 ? '#ff6b6b' : 'inherit' }}>
                {status.deadLetterCount}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {/* Rate Limits */}
      {status && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>⏱️ Rate Limits (per minute)</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {(['zai'] as const).map(api => (
              <div key={api}>
                <p style={{ margin: '0 0 8px 0' }}>
                  <strong>Z.AI:</strong> {status.rateLimits[api].used} / {status.rateLimits[api].limit}
                </p>
                <div style={{ width: '100%', background: '#f1f1f1', borderRadius: 4, overflow: 'hidden', height: 12 }}>
                  <div style={{
                    width: `${Math.min(100, (status.rateLimits[api].used / status.rateLimits[api].limit) * 100)}%`,
                    background: '#4caf50', height: '100%',
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Adaptive Concurrency */}
      {status?.adaptiveConcurrency && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>🎚️ Adaptive Concurrency</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#888' }}>CURRENT</p>
              <p style={{ margin: 0, fontSize: 24, fontWeight: 'bold', color: '#4caf50' }}>{status.adaptiveConcurrency.current}</p>
            </div>
            <div>
              <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#888' }}>MAX REACHED</p>
              <p style={{ margin: 0, fontSize: 24, fontWeight: 'bold', color: '#2196f3' }}>{status.adaptiveConcurrency.maxReached}</p>
            </div>
            <div>
              <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#888' }}>SUCCESSES</p>
              <p style={{ margin: 0, fontSize: 24, fontWeight: 'bold' }}>{status.adaptiveConcurrency.totalSuccesses}</p>
            </div>
            <div>
              <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#888' }}>RATE LIMIT HITS</p>
              <p style={{ margin: 0, fontSize: 24, fontWeight: 'bold', color: status.adaptiveConcurrency.totalRateLimitHits > 0 ? '#ff6b6b' : 'inherit' }}>
                {status.adaptiveConcurrency.totalRateLimitHits}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Concurrency</label>
              <input type="number" min="1" max="100" value={concurrencyInput}
                onChange={e => setConcurrencyInput(e.target.value)}
                style={{ width: 60 }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Increment</label>
              <input type="number" min="1" max="20" value={incrementInput}
                onChange={e => setIncrementInput(e.target.value)}
                style={{ width: 60 }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Floor</label>
              <input type="number" min="1" max="100" value={minInput}
                onChange={e => setMinInput(e.target.value)}
                style={{ width: 60 }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Ceiling</label>
              <input type="number" min="1" max="100" value={maxInput}
                onChange={e => setMaxInput(e.target.value)}
                style={{ width: 60 }} />
            </div>
            <button onClick={async () => {
              try {
                const res = await fetch(`${BASE}/api/enrichments/adaptive-settings`, {
                  method: 'POST', headers,
                  body: JSON.stringify({
                    current: Number(concurrencyInput),
                    increment: Number(incrementInput),
                    min: Number(minInput),
                    max: Number(maxInput),
                  }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error || 'Failed');
                showToast(`Concurrency updated to ${data.current} (floor: ${data.min}, ceiling: ${data.max}, increment: ${data.increment})`, 'success');
                await loadStatus();
              } catch (err: any) {
                showToast(err?.message || 'Failed', 'error');
              }
            }} style={{ background: '#2196f3', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}>
              Apply
            </button>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: '#888' }}>
            Streak: {status.adaptiveConcurrency.consecutiveSuccesses} / 10 successes until next increase
          </p>
          {status.adaptiveConcurrency.recentHistory.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 12, color: '#888', cursor: 'pointer' }}>Recent adjustments</summary>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                {status.adaptiveConcurrency.recentHistory.map((h, i) => (
                  <div key={i} style={{ color: '#aaa', marginBottom: 2 }}>
                    {new Date(h.time).toLocaleTimeString()} → {h.concurrency} ({h.reason})
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Dead Letter Queue */}
      {status && status.deadLetterCount > 0 && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>💀 Dead Letter Queue ({status.deadLetterCount})</h2>
          {status.deadLetterQueue.length > 0 && (
            <div style={{ overflowX: 'auto', marginBottom: 12 }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 6 }}>Filename</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 6 }}>Retries</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 6 }}>Last Error</th>
                  </tr>
                </thead>
                <tbody>
                  {status.deadLetterQueue.map((item, i) => (
                    <tr key={i}>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.fileName}</td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{item.retries}</td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6, color: '#ff6b6b', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.lastError || 'Unknown'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Queue */}
      {status && status.pending > 0 && queueItems.length > 0 && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>📋 Queue ({status.pending})</h2>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 6 }}>Filename</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 6 }}>Type</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 6 }}>Retries</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 6 }}>Queued At</th>
                </tr>
              </thead>
              <tbody>
                {queueItems.map((item, i) => (
                  <tr key={`${item.recordId}-${i}`}>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.fileName}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{item.fileType}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{item.retries}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6, color: '#888' }}>{formatRelativeTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>🎮 Controls</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <input type="number" min="1" max="1000" value={backfillLimit}
            onChange={e => setBackfillLimit(e.target.value)}
            style={{ width: 80 }} placeholder="Limit" title="Max attachments to enqueue" />
          <button onClick={startBackfill} disabled={actionLoading === 'backfill'}
            style={{ background: '#4caf50', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', opacity: actionLoading === 'backfill' ? 0.6 : 1 }}>
            {actionLoading === 'backfill' ? '⏳ Starting…' : '▶️ Start Backfill'}
          </button>
          <button onClick={togglePause}
            style={{ background: status?.paused ? '#2196f3' : '#ff9800', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', opacity: 1 }}>
            {actionLoading === 'pause' ? '⏳…' : status?.paused ? '▶️ Resume' : '⏸ Pause'}
          </button>
          <button onClick={cancelPending} disabled={status?.pending === 0}
            style={{ background: '#f44336', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', opacity: status?.pending === 0 ? 0.6 : 1 }}>
            {actionLoading === 'cancel' ? '⏳…' : '🛑 Cancel Pending'}
          </button>
          <button onClick={retryFailed} disabled={!!(status && status.deadLetterCount === 0)}
            style={{ background: '#ff9800', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', opacity: (status && status.deadLetterCount === 0) ? 0.6 : 1 }}>
            {actionLoading === 'retry' ? '⏳…' : '🔄 Retry Failed'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={forceReenrich} onChange={e => setForceReenrich(e.target.checked)} />
            🔄 Force re-enrich (overwrites existing summaries)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={isPolling} onChange={e => setIsPolling(e.target.checked)} />
            Auto-refresh every 4 seconds
          </label>
        </div>
      </div>

      {/* Recent Summaries */}
      {recentSummaries.length > 0 && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>📝 Recent Summaries (last {recentSummaries.length})</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {recentSummaries.map((s, i) => (
              <div
                key={i}
                onClick={() => loadHistory(s.record_id)}
                style={{ border: '1px solid #333', borderRadius: 6, padding: 10, background: '#1a1a1a', cursor: 'pointer', display: 'flex', gap: 12 }}
                title="Click to view version history"
              >
                {/* Thumbnail preview */}
                {(s.file_type === 'image' || s.mime_type?.startsWith('image/')) ? (
                  <img
                    src={`${BASE}/api/attachments/${s.record_id}/file?token=${token}`}
                    alt={s.original_file_name}
                    style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 4, flexShrink: 0, background: '#333' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : s.file_type === 'video' ? (
                  <div style={{ width: 80, height: 80, borderRadius: 4, flexShrink: 0, background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🎬</div>
                ) : s.file_type === 'audio' ? (
                  <div style={{ width: 80, height: 80, borderRadius: 4, flexShrink: 0, background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🎵</div>
                ) : (
                  <div style={{ width: 80, height: 80, borderRadius: 4, flexShrink: 0, background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>📄</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontWeight: 'bold', fontSize: 13 }}>
                      {s.original_file_name}
                    </span>
                    <span style={{ fontSize: 11, color: '#888', flexShrink: 0, marginLeft: 8 }}>
                      {new Date(s.summary_updated_at).toLocaleString()} · {s.summary_model}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: 13, color: '#ccc', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
                    {s.summary_text}
                  </p>
                  {s.metadata?.enrichment_metadata?.file_metadata && Object.keys(s.metadata.enrichment_metadata.file_metadata).length > 0 && (
                    <details style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                      <summary style={{ fontSize: 11, color: '#888', cursor: 'pointer' }}>📋 File Metadata</summary>
                      <pre style={{ fontSize: 11, color: '#aaa', background: '#111', padding: 6, borderRadius: 4, marginTop: 4, overflow: 'auto', maxHeight: 150 }}>
                        {JSON.stringify(s.metadata.enrichment_metadata.file_metadata, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {historyRecordId && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 10000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{
            width: 'min(920px, 95vw)', maxHeight: '90vh', overflow: 'auto',
            background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>🕘 Version History</h2>
              <button onClick={() => { setHistoryRecordId(null); setHistoryVersions([]); }}
                style={{ background: '#333', color: '#fff', border: '1px solid #444', borderRadius: 4, padding: '6px 10px', cursor: 'pointer' }}>
                Close
              </button>
            </div>

            <p style={{ fontSize: 12, color: '#888', marginTop: 0, wordBreak: 'break-all' }}>
              record_id: {historyRecordId}
            </p>

            {historyLoading ? (
              <p>Loading history…</p>
            ) : historyVersions.length === 0 ? (
              <p style={{ color: '#aaa' }}>No versions found.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {historyVersions.map(v => {
                  const expanded = expandedHistoryVersions.includes(v.id);
                  const summary = v.summary_text || '(no summary)';
                  const preview = summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
                  return (
                    <div key={v.id} style={{
                      border: `1px solid ${v.is_active ? '#2e7d32' : '#333'}`,
                      borderRadius: 8,
                      padding: 10,
                      background: v.is_active ? '#102010' : '#141414',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>
                            {new Date(v.effective_from || v.created_at).toLocaleString()} · {v.summary_model || 'unknown model'}
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <strong>Version #{v.id}</strong>
                            {v.is_active && (
                              <span style={{ fontSize: 11, background: '#2e7d32', color: 'white', borderRadius: 999, padding: '2px 8px' }}>
                                ACTIVE
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {!v.is_active && (
                            <button
                              onClick={() => revertVersion(v.record_id, v.id)}
                              disabled={!!actionLoading}
                              style={{ background: '#2196f3', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', opacity: actionLoading ? 0.7 : 1 }}>
                              {actionLoading === `revert-${v.id}` ? 'Reverting…' : 'Revert'}
                            </button>
                          )}
                          {(!v.is_active || historyVersions.length >= 2) && (
                            <button
                              onClick={() => deleteVersion(v.id, v.record_id)}
                              disabled={!!actionLoading}
                              style={{ background: '#c62828', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', opacity: actionLoading ? 0.7 : 1 }}>
                              {actionLoading === `delete-${v.id}` ? 'Deleting…' : v.is_active ? 'Delete & Revert' : 'Delete'}
                            </button>
                          )}
                        </div>
                      </div>

                      <div
                        onClick={() => toggleHistoryExpand(v.id)}
                        style={{ marginTop: 8, fontSize: 13, color: '#ccc', whiteSpace: 'pre-wrap', cursor: 'pointer' }}>
                        {expanded ? summary : preview}
                        {summary.length > 200 && (
                          <span style={{ color: '#66b3ff', marginLeft: 6 }}>
                            {expanded ? 'Show less' : 'Show more'}
                          </span>
                        )}
                      </div>

                      {/* File Metadata */}
                      {v.metadata?.enrichment_metadata?.file_metadata && Object.keys(v.metadata.enrichment_metadata.file_metadata).length > 0 && (
                        <details style={{ marginTop: 8 }}>
                          <summary style={{ fontSize: 12, color: '#888', cursor: 'pointer' }}>📋 File Metadata</summary>
                          <pre style={{ fontSize: 11, color: '#aaa', background: '#111', padding: 8, borderRadius: 4, marginTop: 4, overflow: 'auto', maxHeight: 200 }}>
                            {JSON.stringify(v.metadata.enrichment_metadata.file_metadata, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
