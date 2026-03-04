import React, { useState, useEffect } from 'react';
import Viewer from './Viewer.js';

interface Token {
  id: number; label: string; permissions: string; write_sources: string[] | null;
  created_at: string; last_used_at: string | null; is_active: boolean; token?: string;
}

interface Source {
  id: number; name: string;
}

interface EmbeddingStatus {
  total: number;
  embedded: number;
  remaining: number;
  percentage: number;
}

const BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '');

function AdminPanel() {
  const [adminToken, setAdminToken] = useState(localStorage.getItem('admin_token') || '');
  const [tokens, setTokens] = useState<Token[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [editingSource, setEditingSource] = useState<number | null>(null);
  const [editSourceName, setEditSourceName] = useState('');
  const [editingToken, setEditingToken] = useState<number | null>(null);
  const [editTokenLabel, setEditTokenLabel] = useState('');
  const [editTokenPerm, setEditTokenPerm] = useState('read');
  const [editTokenSources, setEditTokenSources] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newPerm, setNewPerm] = useState('read');
  const [newSources, setNewSources] = useState('');
  const [createdToken, setCreatedToken] = useState('');
  const [error, setError] = useState('');

  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [batchSize, setBatchSize] = useState(50);
  const [limit, setLimit] = useState(1000);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [pollStatus, setPollStatus] = useState(false);

  const headers = () => ({ 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' });

  async function loadTokens() {
    if (!adminToken) return;
    try {
      const res = await fetch(`${BASE}/api/admin/tokens`, { headers: headers() });
      if (!res.ok) { setError('Failed to load tokens'); return; }
      const data = await res.json();
      setTokens(data.tokens);
      setError('');
    } catch { setError('Connection error'); }
  }

  async function loadEmbeddingStatus() {
    if (!adminToken) return;
    try {
      const res = await fetch(`${BASE}/api/admin/embeddings/status`, { headers: headers() });
      if (!res.ok) return;
      const data = await res.json();
      setEmbeddingStatus(data);
    } catch {
      // no-op
    }
  }

  async function loadSources() {
    if (!adminToken) return;
    try {
      const res = await fetch(`${BASE}/api/sources`, { headers: headers() });
      if (res.ok) { const data = await res.json(); setSources(data.sources); }
    } catch {}
  }

  function startEditSource(s: Source) {
    setEditingSource(s.id);
    setEditSourceName(s.name);
  }

  async function saveSource(id: number) {
    const res = await fetch(`${BASE}/api/sources/${id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ name: editSourceName }) });
    if (res.ok) { setEditingSource(null); loadSources(); } else { setError('Failed to update source'); }
  }

  function startEditToken(t: Token) {
    setEditingToken(t.id);
    setEditTokenLabel(t.label);
    setEditTokenPerm(t.permissions);
    setEditTokenSources(t.write_sources?.join(', ') || '');
  }

  async function saveToken2(id: number) {
    const body: any = { label: editTokenLabel, permissions: editTokenPerm };
    body.write_sources = editTokenPerm === 'write' && editTokenSources ? editTokenSources.split(',').map(s => s.trim()) : null;
    const res = await fetch(`${BASE}/api/admin/tokens/${id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(body) });
    if (res.ok) { setEditingToken(null); loadTokens(); } else { setError('Failed to update token'); }
  }

  useEffect(() => { loadTokens(); loadSources(); loadEmbeddingStatus(); }, [adminToken]);

  useEffect(() => {
    if (!pollStatus || !adminToken) return;
    const timer = setInterval(() => {
      loadEmbeddingStatus();
    }, 2000);
    return () => clearInterval(timer);
  }, [pollStatus, adminToken]);

  async function createToken() {
    const body: any = { label: newLabel, permissions: newPerm };
    if (newPerm === 'write' && newSources) body.write_sources = newSources.split(',').map(s => s.trim());
    const res = await fetch(`${BASE}/api/admin/tokens`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!res.ok) { setError('Failed to create'); return; }
    const data = await res.json();
    setCreatedToken(data.token);
    setNewLabel(''); setNewSources('');
    loadTokens();
  }

  async function deactivate(id: number) {
    await fetch(`${BASE}/api/admin/tokens/${id}`, { method: 'DELETE', headers: headers() });
    loadTokens();
  }

  async function runBackfill() {
    if (isBackfilling) return;
    setIsBackfilling(true);
    setPollStatus(true);
    setError('');

    try {
      const res = await fetch(`${BASE}/api/admin/embeddings/backfill`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ batchSize, limit })
      });
      if (!res.ok) {
        throw new Error('Backfill failed');
      }
      await loadEmbeddingStatus();
    } catch (err: any) {
      setError(err?.message || 'Backfill failed');
    } finally {
      setIsBackfilling(false);
      setPollStatus(false);
    }
  }

  function stopPolling() {
    setPollStatus(false);
    setIsBackfilling(false);
  }

  const saveToken = () => { localStorage.setItem('admin_token', adminToken); loadTokens(); loadEmbeddingStatus(); };

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 800, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>🧠 Memory API Admin</h1>
      <div style={{ marginBottom: 12 }}>
        <a href={`${BASE}/admin/viewer`}>Open Viewer →</a>
      </div>
      <div style={{ marginBottom: '1rem' }}>
        <input placeholder="Admin token" type="password" value={adminToken} onChange={e => setAdminToken(e.target.value)} style={{ width: 400, marginRight: 8 }} />
        <button onClick={saveToken}>Connect</button>
      </div>
      {error && <p style={{ color: 'red' }}>{error}</p>}

      <h2>Create Token</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: '1rem', flexWrap: 'wrap' }}>
        <input placeholder="Label" value={newLabel} onChange={e => setNewLabel(e.target.value)} />
        <select value={newPerm} onChange={e => setNewPerm(e.target.value)}>
          <option value="read">read</option><option value="write">write</option><option value="admin">admin</option>
        </select>
        {newPerm === 'write' && <input placeholder="Sources (comma-sep)" value={newSources} onChange={e => setNewSources(e.target.value)} />}
        <button onClick={createToken} disabled={!newLabel}>Create</button>
      </div>
      {createdToken && <div style={{ background: '#e8f5e9', padding: 12, borderRadius: 4, marginBottom: 16, wordBreak: 'break-all' }}>
        <strong>New token:</strong> <code>{createdToken}</code><br /><small>Copy now — won't be shown again</small>
      </div>}

      <h2>Tokens</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['ID','Label','Perms','Sources','Created','Last Used','Active',''].map(h => <th key={h} style={{ textAlign: 'left', borderBottom: '2px solid #ccc', padding: 4 }}>{h}</th>)}</tr></thead>
        <tbody>{tokens.map(t => (
          <tr key={t.id} style={{ opacity: t.is_active ? 1 : 0.4 }}>
            <td style={{ padding: 4 }}>{t.id}</td>
            <td style={{ padding: 4 }}>{editingToken === t.id
              ? <input value={editTokenLabel} onChange={e => setEditTokenLabel(e.target.value)} style={{ width: 140 }} />
              : t.label}</td>
            <td style={{ padding: 4 }}>{editingToken === t.id
              ? <select value={editTokenPerm} onChange={e => setEditTokenPerm(e.target.value)}>
                  <option value="read">read</option><option value="write">write</option><option value="admin">admin</option>
                </select>
              : t.permissions}</td>
            <td style={{ padding: 4 }}>{editingToken === t.id
              ? <input placeholder="Sources (comma-sep)" value={editTokenSources} onChange={e => setEditTokenSources(e.target.value)} style={{ width: 140 }} />
              : (t.write_sources?.join(', ') || '—')}</td>
            <td style={{ padding: 4 }}>{new Date(t.created_at).toLocaleDateString()}</td>
            <td style={{ padding: 4 }}>{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : '—'}</td>
            <td style={{ padding: 4 }}>{t.is_active ? '✅' : '❌'}</td>
            <td style={{ padding: 4 }}>
              {editingToken === t.id
                ? <span style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => saveToken2(t.id)} style={{ fontSize: 12 }}>Save</button>
                    <button onClick={() => setEditingToken(null)} style={{ fontSize: 12 }}>Cancel</button>
                  </span>
                : <>
                    {t.is_active && <button onClick={() => startEditToken(t)} style={{ fontSize: 12, cursor: 'pointer', background: 'none', border: 'none' }} title="Edit">✏️</button>}
                    {t.is_active && <button onClick={() => deactivate(t.id)} style={{ fontSize: 12 }}>Deactivate</button>}
                  </>
              }
            </td>
          </tr>
        ))}</tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>Embeddings</h2>
      <div style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 24 }}>
        <p style={{ margin: '0 0 8px' }}>
          Total: <strong>{embeddingStatus?.total ?? 0}</strong> · Embedded: <strong>{embeddingStatus?.embedded ?? 0}</strong> · Remaining: <strong>{embeddingStatus?.remaining ?? 0}</strong>
        </p>
        <div style={{ width: '100%', background: '#f1f1f1', borderRadius: 6, overflow: 'hidden', height: 14, marginBottom: 8 }}>
          <div style={{ width: `${Math.max(0, Math.min(100, embeddingStatus?.percentage ?? 0))}%`, height: '100%', background: '#4caf50' }} />
        </div>
        <p style={{ marginTop: 0 }}>{embeddingStatus?.percentage?.toFixed(2) ?? '0.00'}%</p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>Batch size</label>
          <input type="number" min={1} value={batchSize} onChange={e => setBatchSize(Number(e.target.value) || 50)} style={{ width: 90 }} />
          <label>Limit</label>
          <input type="number" min={1} value={limit} onChange={e => setLimit(Number(e.target.value) || 1000)} style={{ width: 110 }} />
          <button onClick={runBackfill} disabled={isBackfilling}>{isBackfilling ? 'Backfilling…' : 'Backfill'}</button>
          <button onClick={stopPolling} disabled={!isBackfilling && !pollStatus}>Stop</button>
          <button onClick={loadEmbeddingStatus}>Refresh</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const path = window.location.pathname;
  if (path.startsWith('/admin/viewer')) {
    return <Viewer />;
  }
  return <AdminPanel />;
}
