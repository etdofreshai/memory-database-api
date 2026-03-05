import React, { useEffect, useMemo, useRef, useState } from 'react';

interface EmbeddingSample {
  id: number;
  content_preview: string;
  embedding_preview: number[];
}

interface EmbeddingStatus {
  total: number;
  embedded: number;
  remaining: number;
  percentage: number;
  isRunning: boolean;
  currentBatch: number;
  totalBatches: number;
  processed: number;
  errors: string[];
  logs: string[];
  recentSamples: EmbeddingSample[];
}

const BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '');

export default function Embeddings() {
  const [token, setToken] = useState(localStorage.getItem('admin_token') || '');
  const [tokenInput, setTokenInput] = useState(localStorage.getItem('admin_token') || '');
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [batchSize, setBatchSize] = useState(50);
  const [limit, setLimit] = useState(1000000);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState('');

  const logRef = useRef<HTMLDivElement | null>(null);
  const headers = useMemo(() => token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {}, [token]);

  async function loadStatus() {
    if (!token) return;
    try {
      const res = await fetch(`${BASE}/api/admin/embeddings/status`, { headers });
      if (!res.ok) {
        throw new Error(res.status === 401 ? 'Invalid token' : 'Failed to load embedding status');
      }
      const data = await res.json();
      setStatus(data);
      if (!data.isRunning) {
        setIsPolling(false);
      }
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Failed to load embedding status');
    }
  }

  useEffect(() => {
    loadStatus();
  }, [token]);

  useEffect(() => {
    if (!isPolling || !token) return;
    const timer = setInterval(() => {
      loadStatus();
    }, 2000);
    return () => clearInterval(timer);
  }, [isPolling, token]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [status?.logs?.length]);

  async function startBackfill() {
    if (!token) return;
    try {
      const res = await fetch(`${BASE}/api/admin/embeddings/backfill`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ batchSize, limit })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to start backfill');
      }
      setIsPolling(true);
      await loadStatus();
    } catch (err: any) {
      setError(err?.message || 'Failed to start backfill');
    }
  }

  function stopPolling() {
    setIsPolling(false);
  }

  function saveToken() {
    const next = tokenInput.trim();
    localStorage.setItem('admin_token', next);
    setToken(next);
  }

  const percentage = Math.max(0, Math.min(100, status?.percentage || 0));

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 1000, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>🧬 Embeddings</h1>
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
        <button onClick={loadStatus}>Refresh</button>
      </div>

      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Status</h2>
        <p>
          Total: <strong>{status?.total ?? 0}</strong> · Embedded: <strong>{status?.embedded ?? 0}</strong> · Remaining: <strong>{status?.remaining ?? 0}</strong>
        </p>
        <div style={{ width: '100%', background: '#f1f1f1', borderRadius: 8, overflow: 'hidden', height: 16 }}>
          <div style={{ width: `${percentage}%`, background: '#4caf50', height: '100%' }} />
        </div>
        <p style={{ marginBottom: 0 }}>
          {percentage.toFixed(2)}% · {status?.isRunning ? `Running batch ${status.currentBatch}/${status.totalBatches || 0}` : 'Idle'}
        </p>
      </div>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Controls</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label>Batch size</label>
          <input type="number" min={1} value={batchSize} onChange={e => setBatchSize(Number(e.target.value) || 50)} style={{ width: 100 }} />
          <label>Limit</label>
          <input type="number" min={1} value={limit} onChange={e => setLimit(Number(e.target.value) || 1000)} style={{ width: 120 }} />
          <button onClick={startBackfill} disabled={!!status?.isRunning}>Start Backfill</button>
          <button onClick={stopPolling} disabled={!isPolling}>Stop</button>
        </div>
      </div>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Live Progress Log</h2>
        <div
          ref={logRef}
          style={{
            height: 180,
            overflowY: 'auto',
            background: '#0b0f14',
            color: '#d1e7ff',
            borderRadius: 6,
            padding: 10,
            fontFamily: 'monospace',
            fontSize: 12,
            whiteSpace: 'pre-wrap'
          }}
        >
          {(status?.logs?.length ? status.logs : ['No logs yet.']).map((line, i) => (
            <div key={`${i}-${line}`}>{line}</div>
          ))}
        </div>
      </div>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14 }}>
        <h2 style={{ marginTop: 0 }}>Recent Embedding Samples</h2>
        {!status?.recentSamples?.length ? (
          <p style={{ color: '#999' }}>No new samples yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '2px solid #ccc', padding: 6 }}>ID</th>
                <th style={{ textAlign: 'left', borderBottom: '2px solid #ccc', padding: 6 }}>Content</th>
                <th style={{ textAlign: 'left', borderBottom: '2px solid #ccc', padding: 6 }}>Vector (first 5)</th>
              </tr>
            </thead>
            <tbody>
              {status.recentSamples.map(s => (
                <tr key={s.id}>
                  <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{s.id}</td>
                  <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{s.content_preview || '—'}</td>
                  <td style={{ borderBottom: '1px solid #eee', padding: 6, fontFamily: 'monospace', fontSize: 12 }}>
                    [{(s.embedding_preview || []).map(v => Number(v).toFixed(4)).join(', ')}]
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
