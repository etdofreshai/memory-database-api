import React, { useEffect, useState } from 'react';

interface MessageRow {
  id: number;
  source_name: string | null;
  sender: string | null;
  recipient: string | null;
  content: string | null;
  timestamp: string;
  embedding_preview: string | null;
  record_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  is_active: boolean;
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
  const [includeHistory, setIncludeHistory] = useState(false);

  // History modal state
  const [historyRecordId, setHistoryRecordId] = useState<string | null>(null);
  const [historyVersions, setHistoryVersions] = useState<MessageRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

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
    if (includeHistory) params.set('include_history', 'true');

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
  }, [token, page, sort, order, q, source, includeHistory]);

  async function loadHistory(recordId: string) {
    setHistoryRecordId(recordId);
    setHistoryLoading(true);
    setHistoryVersions([]);
    try {
      const res = await fetch(`${BASE}/api/messages/${recordId}/history`, { headers });
      if (!res.ok) throw new Error('Failed to load history');
      const data = await res.json();
      setHistoryVersions(data.versions || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  }

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

        <label style={{ marginLeft: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={includeHistory}
            onChange={e => { setIncludeHistory(e.target.checked); setPage(1); }}
          />
          Show history
        </label>
      </div>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      <p style={{ color: '#555' }}>Total messages: {total.toLocaleString()}{includeHistory ? ' (including old versions)' : ''}</p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              {[
                ['id', 'ID'],
                ['record_id', 'Record'],
                ['source', 'Source'],
                ['sender', 'Sender'],
                ['recipient', 'Recipient'],
                ['content', 'Content'],
                ['timestamp', 'Timestamp'],
                ['embedding', 'Vector']
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
              <tr><td colSpan={9} style={{ padding: 12 }}>Loading...</td></tr>
            ) : messages.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 12 }}>No messages found.</td></tr>
            ) : messages.map(m => (
              <tr key={m.id} style={{
                opacity: m.effective_to ? 0.5 : 1,
                background: m.effective_to ? '#fafafa' : 'transparent'
              }}>
                <td style={{ padding: '6px 4px', borderBottom: '1px solid #eee' }}>{m.id}</td>
                <td style={{ padding: '6px 4px', borderBottom: '1px solid #eee', fontSize: 11, fontFamily: 'monospace' }}>
                  {m.record_id ? (
                    <span
                      onClick={() => loadHistory(m.record_id!)}
                      style={{ cursor: 'pointer', color: '#2196f3', textDecoration: 'underline' }}
                      title={`View history — ${m.record_id}`}
                    >
                      {m.record_id.slice(0, 8)}… 📜
                    </span>
                  ) : '—'}
                </td>
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
                <td style={{ padding: '6px 4px', borderBottom: '1px solid #eee', fontSize: 11, fontFamily: 'monospace', color: '#888', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.embedding_preview || ''}>
                  {m.embedding_preview || '—'}
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

      {/* History Modal */}
      {historyRecordId && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
          onClick={() => setHistoryRecordId(null)}
        >
          <div
            style={{
              background: 'white', borderRadius: 8, padding: 24, maxWidth: 900,
              width: '90%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>📜 Version History</h2>
              <button
                onClick={() => setHistoryRecordId(null)}
                style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <p style={{ color: '#666', fontSize: 12, fontFamily: 'monospace', margin: '0 0 16px' }}>
              record_id: {historyRecordId}
            </p>

            {historyLoading ? (
              <p>Loading...</p>
            ) : historyVersions.length === 0 ? (
              <p>No versions found.</p>
            ) : (
              <div>
                <p style={{ color: '#555', marginBottom: 8 }}>{historyVersions.length} version{historyVersions.length !== 1 ? 's' : ''}</p>
                {historyVersions.map((v, idx) => (
                  <div
                    key={v.id}
                    style={{
                      border: '1px solid #ddd',
                      borderRadius: 6,
                      padding: 12,
                      marginBottom: 8,
                      background: !v.effective_to ? '#f0f8ff' : '#fafafa',
                      opacity: v.effective_to ? 0.7 : 1
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <strong>
                        Version {idx + 1}
                        {!v.effective_to && <span style={{ color: '#2196f3', marginLeft: 8 }}>● Current</span>}
                        {v.effective_to && <span style={{ color: '#999', marginLeft: 8 }}>Superseded</span>}
                      </strong>
                      <span style={{ fontSize: 11, color: '#999' }}>id: {v.id}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                      <span>From: {v.effective_from ? new Date(v.effective_from).toLocaleString() : '—'}</span>
                      {v.effective_to && <span style={{ marginLeft: 12 }}>To: {new Date(v.effective_to).toLocaleString()}</span>}
                    </div>
                    <div style={{ fontSize: 12 }}>
                      <strong>Sender:</strong> {v.sender || '—'} → <strong>Recipient:</strong> {v.recipient || '—'}
                    </div>
                    <div style={{
                      marginTop: 8, padding: 8, background: '#f5f5f5', borderRadius: 4,
                      fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto'
                    }}>
                      {v.content || '(empty)'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
