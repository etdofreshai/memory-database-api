import React, { useEffect, useState, useMemo } from 'react';

interface QueueStatus {
  pending: number;
  processing: {
    gemini: number;
    claude: number;
  };
  rateLimits: {
    gemini: { used: number; limit: number };
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

export default function Enrichments() {
  const [token, setToken] = useState(localStorage.getItem('admin_token') || '');
  const [tokenInput, setTokenInput] = useState(localStorage.getItem('admin_token') || '');
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');

  const headers = useMemo(() => token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {}, [token]);

  async function loadStatus() {
    if (!token) return;
    try {
      setLoading(true);
      const res = await fetch(`${BASE}/api/enrichments/queue-status`, { headers });
      if (!res.ok) {
        throw new Error(res.status === 401 ? 'Invalid token' : 'Failed to load status');
      }
      const data = await res.json();
      setStatus(data);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, [token]);

  useEffect(() => {
    if (!isPolling || !token) return;
    const timer = setInterval(() => {
      loadStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, [isPolling, token]);

  async function startBackfill() {
    if (!token) {
      setError('Token not set');
      return;
    }
    try {
      setActionLoading('backfill');
      const res = await fetch(`${BASE}/api/enrichments/enrich-all?limit=100`, {
        method: 'POST',
        headers,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to start backfill');
      }
      setError('');
      setIsPolling(true);
      await loadStatus();
    } catch (err: any) {
      setError(err?.message || 'Failed to start backfill');
    } finally {
      setActionLoading('');
    }
  }

  async function retryFailed() {
    if (!token) {
      setError('Token not set');
      return;
    }
    try {
      setActionLoading('retry');
      const res = await fetch(`${BASE}/api/enrichments/retry-failed`, {
        method: 'POST',
        headers,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to retry failed');
      }
      setError('');
      setIsPolling(true);
      await loadStatus();
    } catch (err: any) {
      setError(err?.message || 'Failed to retry failed');
    } finally {
      setActionLoading('');
    }
  }

  function saveToken() {
    const next = tokenInput.trim();
    localStorage.setItem('admin_token', next);
    setToken(next);
  }

  const totalProcessing = status ? (status.processing.gemini + status.processing.claude) : 0;
  const totalPending = status ? status.pending : 0;

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 1000, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>⚡ Enrichments</h1>
      <div style={{ marginBottom: 12 }}>
        <a href={`${BASE}/admin`}>← Back to Admin</a>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Admin token"
          type="password"
          value={tokenInput}
          onChange={e => setTokenInput(e.target.value)}
          style={{ width: 320 }}
        />
        <button onClick={saveToken}>Connect</button>
        <button onClick={loadStatus} disabled={loading}>Refresh</button>
      </div>

      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}

      {/* Queue Status Section */}
      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>📊 Queue Status</h2>
        {loading ? (
          <p>Loading…</p>
        ) : status ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#888' }}>PENDING</p>
              <p style={{ margin: 0, fontSize: 24, fontWeight: 'bold' }}>{totalPending}</p>
            </div>
            <div>
              <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#888' }}>PROCESSING</p>
              <p style={{ margin: 0, fontSize: 24, fontWeight: 'bold' }}>
                {totalProcessing} <span style={{ fontSize: 14, color: '#888' }}>({status.processing.gemini} Gemini, {status.processing.claude} Claude)</span>
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {/* Rate Limits Section */}
      {status && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>⏱️ Rate Limits (per minute)</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <p style={{ margin: '0 0 8px 0' }}>
                <strong>Gemini:</strong> {status.rateLimits.gemini.used} / {status.rateLimits.gemini.limit}
              </p>
              <div style={{ width: '100%', background: '#f1f1f1', borderRadius: 4, overflow: 'hidden', height: 12 }}>
                <div
                  style={{
                    width: `${Math.min(100, (status.rateLimits.gemini.used / status.rateLimits.gemini.limit) * 100)}%`,
                    background: '#4caf50',
                    height: '100%',
                  }}
                />
              </div>
            </div>
            <div>
              <p style={{ margin: '0 0 8px 0' }}>
                <strong>Claude:</strong> {status.rateLimits.claude.used} / {status.rateLimits.claude.limit}
              </p>
              <div style={{ width: '100%', background: '#f1f1f1', borderRadius: 4, overflow: 'hidden', height: 12 }}>
                <div
                  style={{
                    width: `${Math.min(100, (status.rateLimits.claude.used / status.rateLimits.claude.limit) * 100)}%`,
                    background: '#4caf50',
                    height: '100%',
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Dead Letter Queue Section */}
      {status && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>💀 Dead Letter Queue</h2>
          <p style={{ margin: '0 0 12px 0' }}>
            <strong>{status.deadLetterCount}</strong> item{status.deadLetterCount !== 1 ? 's' : ''} failed to enrich
          </p>
          {status.deadLetterCount > 0 && status.deadLetterQueue.length > 0 && (
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
                      <td style={{ borderBottom: '1px solid #eee', padding: 6, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.fileName}
                      </td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{item.retries}</td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6, color: '#ff6b6b', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.lastError || 'Unknown error'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Controls Section */}
      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>🎮 Controls</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={startBackfill}
            disabled={actionLoading === 'backfill'}
            style={{
              background: '#4caf50',
              color: 'white',
              border: 'none',
              padding: '8px 16px',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            {actionLoading === 'backfill' ? '⏳ Starting…' : '▶️ Start Backfill'}
          </button>
          <button
            onClick={retryFailed}
            disabled={actionLoading === 'retry' || (status && status.deadLetterCount === 0)}
            style={{
              background: '#ff9800',
              color: 'white',
              border: 'none',
              padding: '8px 16px',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 'bold',
              opacity: actionLoading === 'retry' || (status && status.deadLetterCount === 0) ? 0.6 : 1,
            }}
          >
            {actionLoading === 'retry' ? '⏳ Retrying…' : '🔄 Retry Failed'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={isPolling}
              onChange={e => setIsPolling(e.target.checked)}
            />
            Auto-refresh every 5 seconds
          </label>
        </div>
      </div>
    </div>
  );
}
