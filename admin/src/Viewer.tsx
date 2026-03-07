import React, { useEffect, useState, useCallback } from 'react';
import { AttachmentLink, AttachmentPreviewModal } from './AttachmentPreview.js';

const BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '');
const PAGE_SIZE = 50;

// ─── Shared types ───
interface SourceRow { id: number; name: string; }
type Tab = 'messages' | 'attachments' | 'links';

// ─── Token / auth helper ───
function useToken() {
  const [token, setToken] = useState(localStorage.getItem('admin_token') || '');
  const [input, setInput] = useState(localStorage.getItem('admin_token') || '');
  const save = () => { localStorage.setItem('admin_token', input.trim()); setToken(input.trim()); };
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return { token, input, setInput, save, headers };
}

// ─── Pagination controls ───
function Pager({ page, totalPages, setPage }: { page: number; totalPages: number; setPage: (p: number | ((p: number) => number)) => void }) {
  return (
    <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
      <button onClick={() => setPage(1)} disabled={page <= 1}>⏮</button>
      <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>◀ Prev</button>
      <span>Page {page} / {Math.max(1, totalPages)}</span>
      <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next ▶</button>
      <button onClick={() => setPage(totalPages)} disabled={page >= totalPages}>⏭</button>
    </div>
  );
}

// ─── Detail Modal ───
function DetailModal({ title, data, onClose, children }: { title: string; data?: any; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: '#1a1a2e', borderRadius: 8, padding: 24, maxWidth: 960, width: '92%', maxHeight: '85vh', overflowY: 'auto', border: '1px solid #333', boxShadow: '0 4px 24px rgba(0,0,0,0.4)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#aaa' }}>✕</button>
        </div>
        {children}
        {data && (
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: 'pointer', color: '#64b5f6' }}>Raw JSON</summary>
            <pre style={{ background: '#16213e', padding: 12, borderRadius: 4, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto' }}>
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
//  MESSAGES TAB
// ═══════════════════════════════════════════════
function MessagesTab({ headers, sources, token }: { headers: Record<string, string>; sources: SourceRow[]; token: string }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // filters
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [sender, setSender] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [hasAttachments, setHasAttachments] = useState(false);
  const [includeHistory, setIncludeHistory] = useState(false);
  // detail
  const [selected, setSelected] = useState<any>(null);
  const [linkedAtts, setLinkedAtts] = useState<any[]>([]);
  const [loadingAtts, setLoadingAtts] = useState(false);

  useEffect(() => {
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort: 'timestamp', order: 'desc' });
    if (q) params.set('q', q);
    if (source) params.set('source', source);
    if (sender) params.set('sender', sender);
    if (dateFrom) params.set('after', dateFrom);
    if (dateTo) params.set('before', dateTo);
    if (includeHistory) params.set('include_history', 'true');
    if (hasAttachments) params.set('has_attachments', 'true');

    fetch(`${BASE}/api/messages?${params}`, { headers })
      .then(r => { if (!r.ok) throw new Error(r.status === 401 ? 'Invalid token' : 'Failed'); return r.json(); })
      .then(d => { setMessages(d.messages || []); setTotal(d.total || 0); setTotalPages(d.totalPages || 1); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [page, q, source, sender, dateFrom, dateTo, includeHistory, hasAttachments]);

  function openDetail(m: any) {
    setSelected(m);
    if (m.record_id) {
      setLoadingAtts(true);
      fetch(`${BASE}/api/messages/${m.record_id}/attachments`, { headers })
        .then(r => r.json())
        .then(d => setLinkedAtts(d.attachments || []))
        .catch(() => setLinkedAtts([]))
        .finally(() => setLoadingAtts(false));
    } else {
      setLinkedAtts([]);
    }
  }

  return (
    <>
      {/* Filters */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Search content/sender/recipient" value={searchInput} onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setQ(searchInput.trim()); setPage(1); } }} style={{ minWidth: 260 }} />
        <button onClick={() => { setQ(searchInput.trim()); setPage(1); }}>Search</button>
        <button onClick={() => { setSearchInput(''); setQ(''); setPage(1); }}>Clear</button>
        <select value={source} onChange={e => { setSource(e.target.value); setPage(1); }}>
          <option value="">All sources</option>
          {sources.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
        <input placeholder="Sender" value={sender} onChange={e => setSender(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') setPage(1); }} style={{ width: 120 }} />
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} title="From date" />
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} title="To date" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={hasAttachments} onChange={e => { setHasAttachments(e.target.checked); setPage(1); }} />
          Has attachments
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={includeHistory} onChange={e => { setIncludeHistory(e.target.checked); setPage(1); }} />
          History
        </label>
      </div>

      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
      <p style={{ color: '#888', margin: '4px 0 8px' }}>Total: {total.toLocaleString()}</p>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr>
            {['ID', 'Source', 'Sender', 'Recipient', 'Content', 'Timestamp', '📎'].map(h =>
              <th key={h} style={{ padding: '6px 4px', textAlign: 'left' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={7} style={{ padding: 12 }}>Loading…</td></tr>
              : messages.length === 0 ? <tr><td colSpan={7} style={{ padding: 12 }}>No messages.</td></tr>
              : messages.map(m => (
                <tr key={m.id} onClick={() => openDetail(m)} style={{ cursor: 'pointer', opacity: m.effective_to ? 0.5 : 1 }}>
                  <td style={{ padding: '6px 4px' }}>{m.id}</td>
                  <td style={{ padding: '6px 4px' }}>{m.source_name || '—'}</td>
                  <td style={{ padding: '6px 4px' }}>{m.sender || '—'}</td>
                  <td style={{ padding: '6px 4px' }}>{m.recipient || '—'}</td>
                  <td style={{ padding: '6px 4px', maxWidth: 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.content || ''}>
                    {m.content?.slice(0, 120) || '—'}
                  </td>
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{m.timestamp ? new Date(m.timestamp).toLocaleString() : '—'}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'center' }}>{(m.version_count > 1) ? `📜${m.version_count}` : ''}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} totalPages={totalPages} setPage={setPage} />

      {/* Detail modal */}
      {selected && (
        <DetailModal title={`Message #${selected.id}`} data={selected} onClose={() => setSelected(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '6px 12px', fontSize: 14, marginBottom: 12 }}>
            <strong>Record ID:</strong><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{selected.record_id || '—'}</span>
            <strong>Source:</strong><span>{selected.source_name || '—'}</span>
            <strong>Sender:</strong><span>{selected.sender || '—'}</span>
            <strong>Recipient:</strong><span>{selected.recipient || '—'}</span>
            <strong>Timestamp:</strong><span>{selected.timestamp ? new Date(selected.timestamp).toLocaleString() : '—'}</span>
            <strong>External ID:</strong><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{selected.external_id || '—'}</span>
          </div>
          <div style={{ background: '#16213e', padding: 12, borderRadius: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto', marginBottom: 12 }}>
            {selected.content || '(empty)'}
          </div>

          <h3>📎 Linked Attachments ({linkedAtts.length})</h3>
          {loadingAtts ? <p>Loading…</p> : linkedAtts.length === 0 ? <p style={{ color: '#888' }}>None</p> : (
            <table style={{ fontSize: 13 }}>
              <thead><tr>
                {['Filename', 'MIME', 'Size', 'Role', 'Privacy'].map(h => <th key={h} style={{ padding: '4px 6px', textAlign: 'left' }}>{h}</th>)}
              </tr></thead>
              <tbody>{linkedAtts.map((a: any, i: number) => (
                <tr key={i}>
                  <td style={{ padding: '4px 6px' }}>
                    {a.attachment_record_id ? (
                      <AttachmentLink recordId={a.attachment_record_id} mimeType={a.mime_type} fileName={a.original_file_name} token={token}>
                        {a.original_file_name || '📎 Preview'}
                      </AttachmentLink>
                    ) : (a.original_file_name || '—')}
                  </td>
                  <td style={{ padding: '4px 6px' }}>{a.mime_type || '—'}</td>
                  <td style={{ padding: '4px 6px' }}>{a.size_bytes ? `${(a.size_bytes / 1024).toFixed(1)} KB` : '—'}</td>
                  <td style={{ padding: '4px 6px' }}>{a.role || '—'}</td>
                  <td style={{ padding: '4px 6px' }}>{a.privacy_level || '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </DetailModal>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════
//  ATTACHMENTS TAB
// ═══════════════════════════════════════════════
function AttachmentsTab({ headers, token }: { headers: Record<string, string>; token: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // filters
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [mimeType, setMimeType] = useState('');
  const [fileType, setFileType] = useState('');
  const [privacy, setPrivacy] = useState('');
  const [sha256, setSha256] = useState('');
  const [recordId, setRecordId] = useState('');
  // detail
  const [selected, setSelected] = useState<any>(null);
  const [linkedMsgs, setLinkedMsgs] = useState<any[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  // per-row summarize status
  const [summarizing, setSummarizing] = useState<Record<string, 'loading' | 'success' | 'error'>>({});

  useEffect(() => {
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort: 'imported_at', order: 'desc' });
    if (q) params.set('q', q);
    if (mimeType) params.set('mime_type', mimeType);
    if (fileType) params.set('file_type', fileType);
    if (privacy) params.set('privacy_level', privacy);
    if (sha256) params.set('sha256', sha256);
    if (recordId) params.set('record_id', recordId);

    fetch(`${BASE}/api/attachments?${params}`, { headers })
      .then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); })
      .then(d => { setRows(d.attachments || []); setTotal(d.total || 0); setTotalPages(d.totalPages || 1); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [page, q, mimeType, fileType, privacy, sha256, recordId]);

  const reloadPage = useCallback(() => {
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort: 'imported_at', order: 'desc' });
    if (q) params.set('q', q);
    if (mimeType) params.set('mime_type', mimeType);
    if (fileType) params.set('file_type', fileType);
    if (privacy) params.set('privacy_level', privacy);
    if (sha256) params.set('sha256', sha256);
    if (recordId) params.set('record_id', recordId);
    fetch(`${BASE}/api/attachments?${params}`, { headers })
      .then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); })
      .then(d => { setRows(d.attachments || []); setTotal(d.total || 0); setTotalPages(d.totalPages || 1); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [page, q, mimeType, fileType, privacy, sha256, recordId]);

  async function summarizeAttachment(e: React.MouseEvent, recordId: string) {
    e.stopPropagation();
    setSummarizing(prev => ({ ...prev, [recordId]: 'loading' }));
    try {
      const res = await fetch(`${BASE}/api/enrichments/enrich-attachment/${recordId}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Failed');
      }
      setSummarizing(prev => ({ ...prev, [recordId]: 'success' }));
      // Refresh row after a delay to let enrichment process
      setTimeout(() => reloadPage(), 3000);
    } catch {
      setSummarizing(prev => ({ ...prev, [recordId]: 'error' }));
    }
    // Clear status after 5s
    setTimeout(() => setSummarizing(prev => { const n = { ...prev }; delete n[recordId]; return n; }), 5000);
  }

  function openDetail(a: any) {
    setSelected(a);
    setLoadingMsgs(true);
    fetch(`${BASE}/api/attachments/${a.record_id}`, { headers })
      .then(r => r.json())
      .then(d => setLinkedMsgs(d.linked_messages || []))
      .catch(() => setLinkedMsgs([]))
      .finally(() => setLoadingMsgs(false));
  }

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Search filename/summary/OCR" value={searchInput} onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setQ(searchInput.trim()); setPage(1); } }} style={{ minWidth: 220 }} />
        <button onClick={() => { setQ(searchInput.trim()); setPage(1); }}>Search</button>
        <input placeholder="MIME type" value={mimeType} onChange={e => setMimeType(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') setPage(1); }} style={{ width: 120 }} />
        <input placeholder="File type" value={fileType} onChange={e => setFileType(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') setPage(1); }} style={{ width: 100 }} />
        <select value={privacy} onChange={e => { setPrivacy(e.target.value); setPage(1); }}>
          <option value="">All privacy</option>
          <option value="public">public</option>
          <option value="private_consent">private_consent</option>
          <option value="private_double_consent">private_double_consent</option>
        </select>
        <input placeholder="SHA256" value={sha256} onChange={e => setSha256(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') setPage(1); }} style={{ width: 160, fontFamily: 'monospace', fontSize: 11 }} />
        <input placeholder="Record ID" value={recordId} onChange={e => setRecordId(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') setPage(1); }} style={{ width: 160, fontFamily: 'monospace', fontSize: 11 }} />
      </div>

      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
      <p style={{ color: '#888', margin: '4px 0 8px' }}>Total: {total.toLocaleString()}</p>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr>
            {['ID', 'Filename', 'MIME', 'Type', 'Size', 'Summary', 'Imported', ''].map(h =>
              <th key={h} style={{ padding: '6px 4px', textAlign: 'left' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={8} style={{ padding: 12 }}>Loading…</td></tr>
              : rows.length === 0 ? <tr><td colSpan={8} style={{ padding: 12 }}>No attachments.</td></tr>
              : rows.map(a => (
                <tr key={a.id} onClick={() => openDetail(a)} style={{ cursor: 'pointer' }}>
                  <td style={{ padding: '6px 4px' }}>{a.id}</td>
                  <td style={{ padding: '6px 4px', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <AttachmentLink recordId={a.record_id} mimeType={a.mime_type} fileName={a.original_file_name} token={token}>
                      {a.original_file_name || '📎 Preview'}
                    </AttachmentLink>
                  </td>
                  <td style={{ padding: '6px 4px' }}>{a.mime_type || '—'}</td>
                  <td style={{ padding: '6px 4px' }}>{a.file_type || '—'}</td>
                  <td style={{ padding: '6px 4px' }}>{a.size_bytes ? `${(a.size_bytes / 1024).toFixed(1)} KB` : '—'}</td>
                  <td style={{ padding: '6px 4px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: a.summary_text ? '#aaa' : '#555' }}
                    title={a.summary_text || ''}>
                    {a.summary_text ? a.summary_text.slice(0, 80) + (a.summary_text.length > 80 ? '…' : '') : '—'}
                  </td>
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{a.imported_at ? new Date(a.imported_at).toLocaleString() : '—'}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                    {summarizing[a.record_id] === 'loading' ? (
                      <span style={{ fontSize: 12, color: '#888' }}>⏳</span>
                    ) : summarizing[a.record_id] === 'success' ? (
                      <span style={{ fontSize: 12, color: '#4caf50' }}>✓</span>
                    ) : summarizing[a.record_id] === 'error' ? (
                      <span style={{ fontSize: 12, color: '#ff6b6b' }}>✗</span>
                    ) : (
                      <button onClick={(e) => summarizeAttachment(e, a.record_id)}
                        style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer', background: '#1e3a5f', color: '#64b5f6', border: '1px solid #64b5f6', borderRadius: 3 }}
                        title="Trigger enrichment for this attachment">
                        Summarize
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} totalPages={totalPages} setPage={setPage} />

      {selected && (
        <DetailModal title={`Attachment #${selected.id}`} data={selected} onClose={() => setSelected(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '6px 12px', fontSize: 14, marginBottom: 12 }}>
            <strong>Record ID:</strong><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{selected.record_id}</span>
            <strong>Filename:</strong><span>{selected.original_file_name || '—'}</span>
            <strong>MIME:</strong><span>{selected.mime_type || '—'}</span>
            <strong>File Type:</strong><span>{selected.file_type || '—'}</span>
            <strong>Size:</strong><span>{selected.size_bytes ? `${(selected.size_bytes / 1024).toFixed(1)} KB` : '—'}</span>
            <strong>SHA256:</strong><span style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>{selected.sha256}</span>
            <strong>Privacy:</strong><span>{selected.privacy_level}</span>
            <strong>Storage:</strong><span>{selected.storage_provider} — {selected.storage_path || selected.url_local || '—'}</span>
            <strong>Imported:</strong><span>{selected.imported_at ? new Date(selected.imported_at).toLocaleString() : '—'}</span>
          </div>
          <div style={{ marginBottom: 12 }}>
            <AttachmentLink recordId={selected.record_id} mimeType={selected.mime_type} fileName={selected.original_file_name} token={token}>
              👁️ Preview File
            </AttachmentLink>
          </div>
          {selected.summary_text && (
            <div style={{ marginBottom: 12, background: '#0f1419', borderLeft: '3px solid #64b5f6', padding: 10, borderRadius: 4 }}>
              <p style={{ margin: '0 0 6px 0', fontSize: 12, color: '#64b5f6', fontWeight: 'bold' }}>📝 Summary</p>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{selected.summary_text}</p>
              {selected.summary_model && (
                <p style={{ margin: '4px 0 0 0', fontSize: 11, color: '#888' }}>
                  Generated by <code>{selected.summary_model}</code>
                  {selected.summary_updated_at && ` on ${new Date(selected.summary_updated_at).toLocaleString()}`}
                </p>
              )}
            </div>
          )}
          {selected.labels && selected.labels.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ margin: '0 0 6px 0', fontSize: 12, color: '#888', fontWeight: 'bold' }}>🏷️ Labels</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {selected.labels.map((label: string, i: number) => (
                  <span key={i} style={{
                    background: '#1e3a5f',
                    color: '#64b5f6',
                    padding: '3px 10px',
                    borderRadius: 4,
                    fontSize: 12,
                    border: '1px solid #64b5f6',
                  }}>
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}
          {selected.ocr_text && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ margin: '0 0 6px 0', fontSize: 12, color: '#888', fontWeight: 'bold' }}>📄 OCR Text</p>
              <pre style={{
                margin: 0,
                fontSize: 11,
                color: '#aaa',
                background: '#0a0e14',
                padding: 8,
                borderRadius: 4,
                maxHeight: 150,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {selected.ocr_text.slice(0, 500)}
                {selected.ocr_text.length > 500 && '\n…'}
              </pre>
            </div>
          )}

          <h3>✉️ Linked Messages ({linkedMsgs.length})</h3>
          {loadingMsgs ? <p>Loading…</p> : linkedMsgs.length === 0 ? <p style={{ color: '#888' }}>None</p> : (
            <table style={{ fontSize: 13 }}>
              <thead><tr>
                {['Source', 'Sender', 'Content Preview', 'Timestamp', 'Role'].map(h => <th key={h} style={{ padding: '4px 6px', textAlign: 'left' }}>{h}</th>)}
              </tr></thead>
              <tbody>{linkedMsgs.map((l: any, i: number) => (
                <tr key={i}>
                  <td style={{ padding: '4px 6px' }}>{l.source_name || '—'}</td>
                  <td style={{ padding: '4px 6px' }}>{l.sender || '—'}</td>
                  <td style={{ padding: '4px 6px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.content?.slice(0, 100) || '—'}</td>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{l.timestamp ? new Date(l.timestamp).toLocaleString() : '—'}</td>
                  <td style={{ padding: '4px 6px' }}>{l.role || '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </DetailModal>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════
//  LINKS TAB
// ═══════════════════════════════════════════════
function LinksTab({ headers }: { headers: Record<string, string> }) {
  const [rows, setRows] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // filters
  const [msgRecordId, setMsgRecordId] = useState('');
  const [attRecordId, setAttRecordId] = useState('');
  const [provider, setProvider] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  // detail
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort: 'created_at', order: 'desc' });
    if (q) params.set('q', q);
    if (msgRecordId) params.set('message_record_id', msgRecordId);
    if (attRecordId) params.set('attachment_record_id', attRecordId);
    if (provider) params.set('provider', provider);

    fetch(`${BASE}/api/links?${params}`, { headers })
      .then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); })
      .then(d => { setRows(d.links || []); setTotal(d.total || 0); setTotalPages(d.totalPages || 1); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [page, q, msgRecordId, attRecordId, provider]);

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Search provider/IDs/role" value={searchInput} onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setQ(searchInput.trim()); setPage(1); } }} style={{ minWidth: 200 }} />
        <button onClick={() => { setQ(searchInput.trim()); setPage(1); }}>Search</button>
        <input placeholder="Message Record ID" value={msgRecordId} onChange={e => setMsgRecordId(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') setPage(1); }} style={{ width: 200, fontFamily: 'monospace', fontSize: 11 }} />
        <input placeholder="Attachment Record ID" value={attRecordId} onChange={e => setAttRecordId(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') setPage(1); }} style={{ width: 200, fontFamily: 'monospace', fontSize: 11 }} />
        <input placeholder="Provider" value={provider} onChange={e => setProvider(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') setPage(1); }} style={{ width: 120 }} />
      </div>

      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
      <p style={{ color: '#888', margin: '4px 0 8px' }}>Total: {total.toLocaleString()}</p>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr>
            {['ID', 'Message', 'Attachment', 'Provider', 'Role', 'Ordinal', 'Created'].map(h =>
              <th key={h} style={{ padding: '6px 4px', textAlign: 'left' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={7} style={{ padding: 12 }}>Loading…</td></tr>
              : rows.length === 0 ? <tr><td colSpan={7} style={{ padding: 12 }}>No links.</td></tr>
              : rows.map(l => (
                <tr key={l.id} onClick={() => setSelected(l)} style={{ cursor: 'pointer' }}>
                  <td style={{ padding: '6px 4px' }}>{l.id}</td>
                  <td style={{ padding: '6px 4px', fontSize: 11, fontFamily: 'monospace' }}>
                    {l.msg_sender || '?'}: {l.msg_preview?.slice(0, 50) || '—'}
                  </td>
                  <td style={{ padding: '6px 4px', fontSize: 11 }}>
                    {l.att_filename || l.att_mime || '—'}
                  </td>
                  <td style={{ padding: '6px 4px' }}>{l.provider || '—'}</td>
                  <td style={{ padding: '6px 4px' }}>{l.role || '—'}</td>
                  <td style={{ padding: '6px 4px' }}>{l.ordinal ?? '—'}</td>
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{l.created_at ? new Date(l.created_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} totalPages={totalPages} setPage={setPage} />

      {selected && (
        <DetailModal title={`Link #${selected.id}`} data={selected} onClose={() => setSelected(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '6px 12px', fontSize: 14, marginBottom: 12 }}>
            <strong>Record ID:</strong><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{selected.record_id}</span>
            <strong>Message Record ID:</strong><span style={{ fontFamily: 'monospace', fontSize: 12, color: '#64b5f6' }}>{selected.message_record_id}</span>
            <strong>Attachment Record ID:</strong><span style={{ fontFamily: 'monospace', fontSize: 12, color: '#64b5f6' }}>{selected.attachment_record_id}</span>
            <strong>Provider:</strong><span>{selected.provider || '—'}</span>
            <strong>Provider Msg ID:</strong><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{selected.provider_message_id || '—'}</span>
            <strong>Provider Att ID:</strong><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{selected.provider_attachment_id || '—'}</span>
            <strong>Role:</strong><span>{selected.role || '—'}</span>
            <strong>Ordinal:</strong><span>{selected.ordinal ?? '—'}</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <strong>Message:</strong> {selected.msg_sender || '?'} → {selected.msg_preview || '—'}
          </div>
          <div style={{ marginTop: 4 }}>
            <strong>Attachment:</strong> {selected.att_filename || '—'} ({selected.att_mime || '—'})
          </div>
        </DetailModal>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════
//  MAIN VIEWER
// ═══════════════════════════════════════════════
export default function Viewer() {
  const { token, input, setInput, save, headers } = useToken();
  const [tab, setTab] = useState<Tab>('messages');
  const [sources, setSources] = useState<SourceRow[]>([]);

  useEffect(() => {
    if (!token) return;
    fetch(`${BASE}/api/sources`, { headers })
      .then(r => r.ok ? r.json() : { sources: [] })
      .then(d => setSources(d.sources || []))
      .catch(() => {});
  }, [token]);

  const tabStyle = (t: Tab) => ({
    padding: '8px 20px',
    cursor: 'pointer' as const,
    borderBottom: tab === t ? '2px solid #64b5f6' : '2px solid transparent',
    color: tab === t ? '#64b5f6' : '#aaa',
    fontWeight: tab === t ? 600 : 400,
    background: 'none',
    border: 'none',
    borderBottomWidth: 2,
    borderBottomStyle: 'solid' as const,
    borderBottomColor: tab === t ? '#64b5f6' : 'transparent',
    fontSize: 15,
  });

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 1300, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>🗂️ Memory DB Viewer</h1>
      <div style={{ marginBottom: 12 }}>
        <a href={`${BASE}/admin`}>← Back to Admin</a>
      </div>

      {/* Auth */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input placeholder="Admin/read token" type="password" value={input} onChange={e => setInput(e.target.value)} style={{ width: 320 }} />
        <button onClick={save}>Connect</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #333', marginBottom: 16 }}>
        <button style={tabStyle('messages')} onClick={() => setTab('messages')}>✉️ Messages</button>
        <button style={tabStyle('attachments')} onClick={() => setTab('attachments')}>📎 Attachments</button>
        <button style={tabStyle('links')} onClick={() => setTab('links')}>🔗 Links</button>
      </div>

      {/* Tab content */}
      {tab === 'messages' && <MessagesTab headers={headers} sources={sources} token={token} />}
      {tab === 'attachments' && <AttachmentsTab headers={headers} token={token} />}
      {tab === 'links' && <LinksTab headers={headers} />}
    </div>
  );
}
