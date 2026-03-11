import React, { useState, useEffect, useCallback } from 'react';

const BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '');

interface Stats {
  total_messages: number;
  total_attachments: number;
  sources: { source_id: number; source_name: string; count: number; attachment_count: number }[];
  channels: { source_name: string; source_id: number; channel: string; count: number; attachment_count: number; display_name?: string; discord_channel_name?: string; discord_guild_name?: string }[];
  senders: { sender: string; count: number; attachment_count: number }[];
  date_buckets: { month: string; count: number }[];
}

interface Preview {
  messages: number;
  links: number;
  orphaned_attachments: number;
  total_linked_attachments: number;
}

export default function Cleanup() {
  const [token] = useState(localStorage.getItem('admin_token') || '');
  const [stats, setStats] = useState<Stats | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  // Filters
  const [sourceId, setSourceId] = useState('');
  const [channel, setChannel] = useState('');
  const [sender, setSender] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Sorting
  type SortKey = { key: string; direction: 'asc' | 'desc' };
  const [channelSort, setChannelSort] = useState<SortKey[]>([]);
  const [senderSort, setSenderSort] = useState<SortKey[]>([]);

  const toggleSort = (sorts: SortKey[], setSorts: React.Dispatch<React.SetStateAction<SortKey[]>>, key: string) => {
    const idx = sorts.findIndex(s => s.key === key);
    if (idx === -1) {
      setSorts([...sorts, { key, direction: 'asc' }]);
    } else if (sorts[idx].direction === 'asc') {
      setSorts(sorts.map((s, i) => i === idx ? { ...s, direction: 'desc' as const } : s));
    } else {
      setSorts(sorts.filter((_, i) => i !== idx));
    }
  };

  const applySorts = <T extends Record<string, any>>(data: T[], sorts: SortKey[]): T[] => {
    if (!sorts.length) return data;
    return [...data].sort((a, b) => {
      for (const { key, direction } of sorts) {
        const av = a[key], bv = b[key];
        let cmp = 0;
        if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av || '').localeCompare(String(bv || ''));
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
      }
      return 0;
    });
  };

  // Breadcrumb
  const [breadcrumb, setBreadcrumb] = useState<{ label: string; sourceId?: string; channel?: string; sender?: string }[]>([]);

  const headers = useCallback(() => ({
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }), [token]);

  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    if (sourceId) p.set('source_id', sourceId);
    if (channel) p.set('channel', channel);
    if (sender) p.set('sender', sender);
    if (dateFrom) p.set('date_from', dateFrom);
    if (dateTo) p.set('date_to', dateTo);
    return p.toString();
  }, [sourceId, channel, sender, dateFrom, dateTo]);

  const loadStats = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const qs = buildParams();
      const res = await fetch(`${BASE}/api/cleanup/stats?${qs}`, { headers: headers() });
      if (!res.ok) throw new Error(await res.text());
      setStats(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, buildParams, headers]);

  useEffect(() => { loadStats(); }, []);

  const loadPreview = async () => {
    setPreviewLoading(true);
    setError('');
    try {
      const qs = buildParams();
      const res = await fetch(`${BASE}/api/cleanup/preview?${qs}`, { headers: headers() });
      if (!res.ok) throw new Error(await res.text());
      setPreview(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const doDelete = async () => {
    if (confirmText !== 'DELETE') return;
    setDeleting(true);
    setError('');
    try {
      const res = await fetch(`${BASE}/api/cleanup/delete`, {
        method: 'DELETE',
        headers: headers(),
        body: JSON.stringify({
          source_id: sourceId || undefined,
          channel: channel || undefined,
          sender: sender || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setToast(`✅ Deleted: ${data.deleted.messages} messages, ${data.deleted.links} links, ${data.deleted.attachments} attachments`);
      setShowConfirm(false);
      setConfirmText('');
      setPreview(null);
      loadStats();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  const drillDown = (type: string, value: string, label: string, sid?: string) => {
    const crumb = { label, sourceId: sourceId, channel, sender };
    setBreadcrumb(prev => [...prev, crumb]);
    if (type === 'source') { setSourceId(sid || ''); setChannel(''); setSender(''); }
    else if (type === 'channel') { setChannel(value); }
    else if (type === 'sender') { setSender(value); }
  };

  const resetFilters = () => {
    setSourceId(''); setChannel(''); setSender(''); setDateFrom(''); setDateTo('');
    setBreadcrumb([]);
  };

  const goBack = (idx: number) => {
    const crumb = breadcrumb[idx];
    setSourceId(crumb.sourceId || '');
    setChannel(crumb.channel || '');
    setSender(crumb.sender || '');
    setBreadcrumb(breadcrumb.slice(0, idx));
  };

  const hasFilters = !!(sourceId || channel || sender || dateFrom || dateTo);

  const s: React.CSSProperties = { fontFamily: 'system-ui', maxWidth: 1000, margin: '0 auto', padding: '1rem' };

  return (
    <div style={s}>
      <div style={{ marginBottom: 12 }}>
        <a href={`${BASE}/admin`}>← Admin Home</a>
      </div>
      <h1>🧹 Database Cleanup</h1>

      {toast && <div style={{ background: '#1b3a2a', border: '1px solid #2e7d32', padding: 12, borderRadius: 6, marginBottom: 12 }}
        onClick={() => setToast('')}>{toast}</div>}
      {error && <div style={{ background: '#3a1b1b', border: '1px solid #7d2e2e', padding: 12, borderRadius: 6, marginBottom: 12 }}>{error}</div>}

      {/* Filter sidebar */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={{ flex: '1 1 280px', background: '#16213e', padding: 16, borderRadius: 8, minWidth: 260 }}>
          <h3 style={{ marginTop: 0 }}>Filters</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label>
              <small style={{ color: '#aaa' }}>Source</small>
              <select value={sourceId} onChange={e => setSourceId(e.target.value)} style={{ width: '100%', display: 'block' }}>
                <option value="">All sources</option>
                {stats?.sources.map(s => <option key={s.source_id} value={s.source_id}>{s.source_name} ({s.count})</option>)}
              </select>
            </label>
            <label>
              <small style={{ color: '#aaa' }}>Channel / Recipient</small>
              <input value={channel} onChange={e => setChannel(e.target.value)} placeholder="Filter by channel..." style={{ width: '100%', display: 'block', boxSizing: 'border-box' }} />
            </label>
            <label>
              <small style={{ color: '#aaa' }}>Sender</small>
              <input value={sender} onChange={e => setSender(e.target.value)} placeholder="Filter by sender..." style={{ width: '100%', display: 'block', boxSizing: 'border-box' }} />
            </label>
            <label>
              <small style={{ color: '#aaa' }}>Date From</small>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ width: '100%', display: 'block', boxSizing: 'border-box' }} />
            </label>
            <label>
              <small style={{ color: '#aaa' }}>Date To</small>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ width: '100%', display: 'block', boxSizing: 'border-box' }} />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={loadStats} disabled={loading} style={{ flex: 1 }}>
                {loading ? '⏳ Loading...' : '🔍 Apply Filters'}
              </button>
              {hasFilters && <button onClick={resetFilters} style={{ flex: 0 }}>Reset</button>}
            </div>
          </div>
        </div>

        {/* Main content */}
        <div style={{ flex: '2 1 500px' }}>
          {/* Breadcrumb */}
          {breadcrumb.length > 0 && (
            <div style={{ marginBottom: 12, display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 13, color: '#aaa' }}>
              <span style={{ cursor: 'pointer', color: '#64b5f6' }} onClick={resetFilters}>All</span>
              {breadcrumb.map((b, i) => (
                <span key={i}>
                  {' › '}
                  <span style={{ cursor: 'pointer', color: '#64b5f6' }} onClick={() => goBack(i)}>{b.label}</span>
                </span>
              ))}
            </div>
          )}

          {/* Stats cards */}
          {stats && (
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <Card label="Messages" value={stats.total_messages.toLocaleString()} />
              <Card label="Linked Attachments" value={stats.total_attachments.toLocaleString()} />
              <Card label="Sources" value={stats.sources.length.toString()} />
            </div>
          )}

          {/* Breakdown table */}
          {stats && !loading && (
            <div style={{ background: '#16213e', borderRadius: 8, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr>
                    <SortableHeader label="Source" sortKey="source_name" sorts={channelSort} onToggle={k => toggleSort(channelSort, setChannelSort, k)} />
                    <SortableHeader label="Channel" sortKey="display_name" sorts={channelSort} onToggle={k => toggleSort(channelSort, setChannelSort, k)} />
                    <SortableHeader label="Messages" sortKey="count" sorts={channelSort} onToggle={k => toggleSort(channelSort, setChannelSort, k)} align="right" />
                    <SortableHeader label="Attachments" sortKey="attachment_count" sorts={channelSort} onToggle={k => toggleSort(channelSort, setChannelSort, k)} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {applySorts(stats.channels, channelSort).slice(0, 50).map((ch, i) => (
                    <tr key={i} style={{ cursor: 'pointer' }}
                      onClick={() => {
                        if (!sourceId) drillDown('source', '', ch.source_name, String(ch.source_id));
                        else if (!channel) drillDown('channel', ch.channel || '', ch.channel || '(no channel)');
                      }}
                    >
                      <td style={{ padding: '6px 12px', borderBottom: '1px solid #2a2a3e' }}>{ch.source_name}</td>
                      <td style={{ padding: '6px 12px', borderBottom: '1px solid #2a2a3e' }} title={ch.channel}>
                        {ch.display_name || ch.channel || '—'}
                        {ch.discord_guild_name && !ch.display_name && (
                          <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>{ch.discord_guild_name}</span>
                        )}
                      </td>
                      <td style={{ padding: '6px 12px', borderBottom: '1px solid #2a2a3e', textAlign: 'right' }}>{ch.count.toLocaleString()}</td>
                      <td style={{ padding: '6px 12px', borderBottom: '1px solid #2a2a3e', textAlign: 'right', color: '#aaa' }}>{ch.attachment_count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Senders breakdown when filtered */}
          {stats && hasFilters && stats.senders.length > 0 && (
            <div style={{ marginTop: 16, background: '#16213e', borderRadius: 8, overflow: 'auto' }}>
              <h4 style={{ padding: '8px 12px', margin: 0, color: '#aaa' }}>Top Senders</h4>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr>
                    <SortableHeader label="Sender" sortKey="sender" sorts={senderSort} onToggle={k => toggleSort(senderSort, setSenderSort, k)} />
                    <SortableHeader label="Messages" sortKey="count" sorts={senderSort} onToggle={k => toggleSort(senderSort, setSenderSort, k)} align="right" />
                    <SortableHeader label="Attachments" sortKey="attachment_count" sorts={senderSort} onToggle={k => toggleSort(senderSort, setSenderSort, k)} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {applySorts(stats.senders, senderSort).slice(0, 30).map((s, i) => (
                    <tr key={i} style={{ cursor: 'pointer' }}
                      onClick={() => drillDown('sender', s.sender || '', s.sender || '(unknown)')}>
                      <td style={{ padding: '6px 12px', borderBottom: '1px solid #2a2a3e' }}>{s.sender || '(unknown)'}</td>
                      <td style={{ padding: '6px 12px', borderBottom: '1px solid #2a2a3e', textAlign: 'right' }}>{s.count.toLocaleString()}</td>
                      <td style={{ padding: '6px 12px', borderBottom: '1px solid #2a2a3e', textAlign: 'right', color: '#aaa' }}>{s.attachment_count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {loading && <div style={{ textAlign: 'center', padding: 40, color: '#aaa' }}>⏳ Loading stats...</div>}
        </div>
      </div>

      {/* Action bar */}
      <div style={{ position: 'sticky', bottom: 0, background: '#1a1a2e', borderTop: '1px solid #333', padding: '12px 0', display: 'flex', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {!hasFilters && <span style={{ color: '#aaa', fontSize: 13, alignSelf: 'center', flex: 1 }}>Apply filters before previewing/deleting</span>}
        <button onClick={loadPreview} disabled={!hasFilters || previewLoading}
          style={{ background: '#1b3a2a', borderColor: '#2e7d32' }}>
          {previewLoading ? '⏳ Previewing...' : '👁 Preview Delete'}
        </button>
        <button onClick={() => { if (preview && preview.messages > 0) setShowConfirm(true); }}
          disabled={!preview || preview.messages === 0}
          style={{ background: '#3a1b1b', borderColor: '#7d2e2e' }}>
          🗑 Delete Selected
        </button>
      </div>

      {/* Preview result */}
      {preview && (
        <div style={{ background: '#16213e', padding: 16, borderRadius: 8, marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Delete Preview</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Card label="Messages to delete" value={preview.messages.toLocaleString()} color="#ff6b6b" />
            <Card label="Links to remove" value={preview.links.toLocaleString()} color="#ffa726" />
            <Card label="Orphaned attachments" value={preview.orphaned_attachments.toLocaleString()} color="#ffa726" />
          </div>
          <p style={{ fontSize: 13, color: '#aaa', marginBottom: 0 }}>
            {preview.total_linked_attachments - preview.orphaned_attachments} attachment(s) are shared with other messages and will be kept.
          </p>
        </div>
      )}

      {/* Confirmation modal */}
      {showConfirm && preview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => { setShowConfirm(false); setConfirmText(''); }}>
          <div style={{ background: '#1a1a2e', border: '1px solid #7d2e2e', borderRadius: 8, padding: 24, maxWidth: 420, width: '90%' }}
            onClick={e => e.stopPropagation()}>
            <h2 style={{ marginTop: 0, color: '#ff6b6b' }}>⚠️ Confirm Deletion</h2>
            <p>This will permanently delete:</p>
            <ul style={{ lineHeight: 1.8 }}>
              <li><strong>{preview.messages.toLocaleString()}</strong> messages</li>
              <li><strong>{preview.links.toLocaleString()}</strong> attachment links</li>
              <li><strong>{preview.orphaned_attachments.toLocaleString()}</strong> orphaned attachments</li>
            </ul>
            <p style={{ fontSize: 13, color: '#aaa' }}>This action cannot be undone. Type <strong>DELETE</strong> to confirm.</p>
            <input value={confirmText} onChange={e => setConfirmText(e.target.value)}
              placeholder="Type DELETE" autoFocus
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12, fontSize: 16, textAlign: 'center' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setShowConfirm(false); setConfirmText(''); }}
                style={{ flex: 1 }}>Cancel</button>
              <button onClick={doDelete} disabled={confirmText !== 'DELETE' || deleting}
                style={{ flex: 1, background: '#5a1a1a', borderColor: '#ff6b6b', color: confirmText === 'DELETE' ? '#ff6b6b' : '#666' }}>
                {deleting ? '⏳ Deleting...' : '🗑 Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SortableHeader({ label, sortKey, sorts, onToggle, align }: {
  label: string; sortKey: string; sorts: { key: string; direction: 'asc' | 'desc' }[];
  onToggle: (key: string) => void; align?: 'left' | 'right';
}) {
  const idx = sorts.findIndex(s => s.key === sortKey);
  const active = idx !== -1;
  const dir = active ? sorts[idx].direction : null;
  return (
    <th
      onClick={() => onToggle(sortKey)}
      style={{
        textAlign: align || 'left', padding: '8px 12px', borderBottom: '2px solid #333',
        cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
        color: active ? '#64b5f6' : '#aaa',
        background: active ? 'rgba(100,181,246,0.07)' : 'transparent',
      }}
    >
      {label}{' '}
      {active ? (
        <span style={{ fontSize: 11 }}>
          <span style={{ background: '#2a3f5f', borderRadius: 4, padding: '1px 4px', marginRight: 2, fontSize: 10 }}>{idx + 1}</span>
          {dir === 'asc' ? '↑' : '↓'}
        </span>
      ) : (
        <span style={{ fontSize: 11, opacity: 0.4 }}>↕</span>
      )}
    </th>
  );
}

function Card({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: 8, padding: '12px 16px', flex: '1 1 120px', minWidth: 100 }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || '#64b5f6' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>{label}</div>
    </div>
  );
}
