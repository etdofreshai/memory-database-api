import React, { useState, useEffect } from 'react';
import Viewer from './Viewer.js';

interface Token {
  id: number; label: string; permissions: string; write_sources: string[] | null;
  created_at: string; last_used_at: string | null; is_active: boolean; token?: string;
}

const BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '');

function AdminPanel() {
  const [adminToken, setAdminToken] = useState(localStorage.getItem('admin_token') || '');
  const [tokens, setTokens] = useState<Token[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [newPerm, setNewPerm] = useState('read');
  const [newSources, setNewSources] = useState('');
  const [createdToken, setCreatedToken] = useState('');
  const [error, setError] = useState('');

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

  useEffect(() => { loadTokens(); }, [adminToken]);

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

  const saveToken = () => { localStorage.setItem('admin_token', adminToken); loadTokens(); };

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
            <td>{t.label}</td>
            <td>{t.permissions}</td>
            <td>{t.write_sources?.join(', ') || '—'}</td>
            <td>{new Date(t.created_at).toLocaleDateString()}</td>
            <td>{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : '—'}</td>
            <td>{t.is_active ? '✅' : '❌'}</td>
            <td>{t.is_active && <button onClick={() => deactivate(t.id)} style={{ fontSize: 12 }}>Deactivate</button>}</td>
          </tr>
        ))}</tbody>
      </table>
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
