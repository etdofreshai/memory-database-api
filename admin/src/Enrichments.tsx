import React, { useEffect, useState, useMemo, useCallback } from 'react';

interface QueueStatus {
  paused: boolean;
  pending: number;
  processing: {
    zai: number;
    claude: number;
  };
  rateLimits: {
    zai: { used: number; limit: number };
    claude: { used: number; limit: number };
  };
  deadLetterCount: number;
  deadLetterQueue: Array<{
    recordId: string;
    fileName: string;
    lastError?: string;
    retries: number;
  }>;
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
  const [isPolling, setIsPolling] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [unsummarizedCount, setUnsummarizedCount] = useState<number | null>(null);
  const [backfillLimit, setBackfillLimit] = useState('100');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

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
    } catch (err: any) {
      setError(err?.message || 'Failed to load status');
    } finally {
      setLoading(false);
    }
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

  useEffect(() => {
    loadStatus();
    loadUnsummarizedCount();
  }, [token]);

  useEffect(() => {
    if (!isPolling || !token) return;
    const timer = setInterval(() => {
      loadStatus();
      loadUnsummarizedCount();
    }, 4000);
    return () => clearInterval(timer);
  }, [isPolling, token]);

  async function startBackfill() {
    if (!token) return;
    try {
      setActionLoading('backfill');
      const limit = Math.max(1, Math.min(Number(backfillLimit) || 100, 1000));
      const res = await fetch(`${BASE}/api/enrichments/enrich-all?limit=${limit}`, { method: 'POST', headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed');
      showToast(`Queued ${data.queued} attachments (${data.failed} failed)`, data.failed > 0 ? 'error' : 'success');
      setIsPolling(true);
      await loadStatus();
      await loadUnsummarizedCount();
    } catch (err: any) {
      showToast(err?.message || 'Failed', 'error');
    } finally {
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

  const totalProcessing = status ? (status.processing.zai + status.processing.claude) : 0;
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
        <button onClick={() => { loadStatus(); loadUnsummarizedCount(); }} disabled={loading}>Refresh</button>
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
                {totalProcessing} <span style={{ fontSize: 14, color: '#888' }}>({status.processing.zai} Z.AI, {status.processing.claude} Claude)</span>
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
            {(['zai', 'claude'] as const).map(api => (
              <div key={api}>
                <p style={{ margin: '0 0 8px 0' }}>
                  <strong>{api === 'zai' ? 'Z.AI' : 'Claude'}:</strong> {status.rateLimits[api].used} / {status.rateLimits[api].limit}
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

      {/* Controls */}
      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>🎮 Controls</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <input type="number" min="1" max="1000" value={backfillLimit}
            onChange={e => setBackfillLimit(e.target.value)}
            style={{ width: 80 }} placeholder="Limit" title="Max attachments to enqueue" />
          <button onClick={startBackfill} disabled={!!actionLoading}
            style={{ background: '#4caf50', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', opacity: actionLoading ? 0.6 : 1 }}>
            {actionLoading === 'backfill' ? '⏳ Starting…' : '▶️ Start Backfill'}
          </button>
          <button onClick={togglePause} disabled={!!actionLoading}
            style={{ background: status?.paused ? '#2196f3' : '#ff9800', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', opacity: actionLoading ? 0.6 : 1 }}>
            {actionLoading === 'pause' ? '⏳…' : status?.paused ? '▶️ Resume' : '⏸ Pause'}
          </button>
          <button onClick={cancelPending} disabled={!!actionLoading || (status?.pending === 0)}
            style={{ background: '#f44336', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', opacity: (actionLoading || status?.pending === 0) ? 0.6 : 1 }}>
            {actionLoading === 'cancel' ? '⏳…' : '🛑 Cancel Pending'}
          </button>
          <button onClick={retryFailed} disabled={!!actionLoading || (status && status.deadLetterCount === 0)}
            style={{ background: '#ff9800', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', opacity: (actionLoading || (status && status.deadLetterCount === 0)) ? 0.6 : 1 }}>
            {actionLoading === 'retry' ? '⏳…' : '🔄 Retry Failed'}
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={isPolling} onChange={e => setIsPolling(e.target.checked)} />
          Auto-refresh every 4 seconds
        </label>
      </div>
    </div>
  );
}
