import React, { useEffect, useState } from 'react';

interface MessageRow {
  id: number;
  source_name: string | null;
  sender: string | null;
  recipient: string | null;
  content: string | null;
  timestamp: string;
}

interface SourceRow {
  id: number;
  name: string;
}

const BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '');
const PAGE_SIZE = 50;

type SortKey = 'id' | 'timestamp' | 'sender' | 'recipient' | 'source' | 'content';
type SortOrder = 'asc' | 'desc';

export default function Viewer() {
  const [token, setToken] = useState(localStorage.getItem('admin_token') || '');
  const [tokenInput, setTokenInput] = useState(localStorage.getItem('admin_token') || '');
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<SortKey>('timestamp');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/sources`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        setSources(data.sources || []);
      } catch {
        // no-op
      }
    })();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError('');

    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      sort,
      order
    });
    if (q) params.set('q', q);
    if (source) params.set('source', source);

    fetch(`${BASE}/api/messages?${params.toString()}`, { headers })
      .then(async res => {
        if (!res.ok) {
          throw new Error(res.status === 401 ? 'Invalid token' : 'Failed to load messages');
        }
        return res.json();
      })
      .then(data => {
        setMessages(data.messages || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      })
      .catch(err => setError(err.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [token, page, sort, order, q, source]);

  function toggleSort(key: SortKey) {
    if (sort === key) {
      setOrder(order === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(key);
      setOrder('asc');
    }
    setPage(1);
  }

  function applySearch() {
    setQ(searchInput.trim());
    setPage(1);
  }

  function saveToken() {
    localStorage.setItem('admin_token', tokenInput.trim());
    setToken(tokenInput.trim());
    setPage(1);
  }

  function sortIndicator(key: SortKey) {
    if (sort !== key) return '↕';
    return order === 'asc' ? '↑' : '↓';
  }

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 1200, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>🗂️ Memory DB Viewer</h1>

      <div style={{ marginBottom: 12 }}>
        <a href={`${BASE}/admin`} style={{ marginRight: 12 }}>← Back to Admin</a>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Admin/read token"
          type="password"
          value={tokenInput}
          onChange={e => setTokenInput(e.target.value)}
          style={{ width: 320 }}
        />
        <button onClick={saveToken}>Connect</button>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Search content, sender, recipient"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') applySearch(); }}
          style={{ minWidth: 280 }}
        />
        <button onClick={applySearch}>Search</button>
        <button onClick={() => { setSearchInput(''); setQ(''); setPage(1); }}>Clear</button>

        <label style={{ marginLeft: 8 }}>Source:</label>
        <select value={source} onChange={e => { setSource(e.target.value); setPage(1); }}>
          <option value="">All</option>
          {sources.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
      </div>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      <p style={{ color: '#555' }}>Total messages: {total.toLocaleString()}</p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              {[
                ['id', 'ID'],
                ['source', 'Source'],
                ['sender', 'Sender'],
                ['recipient', 'Recipient'],
                ['content', 'Content'],
                ['timestamp', 'Timestamp']
              ].map(([key, label]) => (
                <th
                  key={key}
                  onClick={() => toggleSort(key as SortKey)}
                  style={{
                    textAlign: 'left',
                    borderBottom: '2px solid #ccc',
                    padding: '6px 4px',
                    cursor: 'pointer',
                    userSelect: 'none'
                  }}
                  title="Click to sort"
                >
                  {label} {sortIndicator(key as SortKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ padding: 12 }}>Loading...</td></tr>
            ) : messages.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 12 }}>No messages found.</td></tr>
            ) : messages.map(m => (
              <tr key={m.id}>
                <td style={{ padding: '6px 4px', borderBottom: '1px solid #eee' }}>{m.id}</td>
                <td style={{ padding: '6px 4px', borderBottom: '1px solid #eee' }}>{m.source_name || '—'}</td>
                <td style={{ padding: '6px 4px', borderBottom: '1px solid #eee' }}>{m.sender || '—'}</td>
                <td style={{ padding: '6px 4px', borderBottom: '1px solid #eee' }}>{m.recipient || '—'}</td>
                <td
                  style={{ padding: '6px 4px', borderBottom: '1px solid #eee', maxWidth: 420, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={m.content || ''}
                >
                  {m.content && m.content.length > 100 ? `${m.content.slice(0, 100)}…` : (m.content || '—')}
                </td>
                <td style={{ padding: '6px 4px', borderBottom: '1px solid #eee' }}>
                  {m.timestamp ? new Date(m.timestamp).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>Prev</button>
        <span>Page {page} of {Math.max(1, totalPages)}</span>
        <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</button>
      </div>
    </div>
  );
}
