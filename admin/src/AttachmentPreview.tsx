import React, { useState } from 'react';

const BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '');

type PreviewType = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'unknown';

function detectPreviewType(mimeType?: string, fileName?: string): PreviewType {
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'text';
  // fallback: check extension
  const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', '3gpp'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'amr', 'caf', 'flac'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  return 'unknown';
}

interface AttachmentPreviewModalProps {
  recordId: string;
  mimeType?: string;
  fileName?: string;
  token: string;
  onClose: () => void;
}

export function AttachmentPreviewModal({ recordId, mimeType, fileName, token, onClose }: AttachmentPreviewModalProps) {
  const [error, setError] = useState(false);
  const type = detectPreviewType(mimeType, fileName);
  const fileUrl = `${BASE}/api/attachments/${recordId}/file?token=${encodeURIComponent(token)}`;

  const overlayStyle: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.75)', zIndex: 2000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  const modalStyle: React.CSSProperties = {
    background: '#1a1a2e', borderRadius: 8, padding: 20,
    maxWidth: '90vw', maxHeight: '90vh', width: 'auto',
    border: '1px solid #444', boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', marginBottom: 4,
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={{ fontSize: 14, color: '#aaa', maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {fileName || recordId} <span style={{ color: '#666' }}>({mimeType || 'unknown'})</span>
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <a href={fileUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: '#64b5f6', fontSize: 13, textDecoration: 'none' }}>
              Open in new tab ↗
            </a>
            <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#aaa' }}>✕</button>
          </div>
        </div>

        {error ? (
          <div style={{ padding: 32, color: '#ff6b6b', textAlign: 'center' }}>
            <p>⚠️ Unable to load file</p>
            <a href={fileUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: '#64b5f6', fontSize: 14 }}>
              Try opening in new tab ↗
            </a>
          </div>
        ) : type === 'image' ? (
          <img src={fileUrl} alt={fileName || 'preview'}
            style={{ maxWidth: '85vw', maxHeight: '75vh', objectFit: 'contain', borderRadius: 4 }}
            onError={() => setError(true)} />
        ) : type === 'video' ? (
          <video controls src={fileUrl}
            style={{ maxWidth: '85vw', maxHeight: '75vh', borderRadius: 4 }}
            onError={() => setError(true)} />
        ) : type === 'audio' ? (
          <audio controls src={fileUrl}
            style={{ width: 400, maxWidth: '85vw' }}
            onError={() => setError(true)} />
        ) : type === 'pdf' ? (
          <iframe src={fileUrl} title="PDF preview"
            style={{ width: '80vw', height: '75vh', border: 'none', borderRadius: 4, background: '#fff' }}
            onError={() => setError(true)} />
        ) : (
          <div style={{ padding: 32, textAlign: 'center', color: '#aaa' }}>
            <p>No preview available for this file type</p>
            <a href={fileUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: '#64b5f6', fontSize: 14 }}>
              Download / Open in new tab ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// Clickable attachment name that opens preview
interface AttachmentLinkProps {
  recordId: string;
  mimeType?: string;
  fileName?: string;
  token: string;
  children?: React.ReactNode;
}

export function AttachmentLink({ recordId, mimeType, fileName, token, children }: AttachmentLinkProps) {
  const [showPreview, setShowPreview] = useState(false);
  return (
    <>
      <span onClick={(e) => { e.stopPropagation(); setShowPreview(true); }}
        style={{ color: '#64b5f6', cursor: 'pointer', textDecoration: 'underline' }}
        title="Click to preview">
        {children || fileName || recordId}
      </span>
      {showPreview && (
        <AttachmentPreviewModal
          recordId={recordId}
          mimeType={mimeType}
          fileName={fileName}
          token={token}
          onClose={() => setShowPreview(false)}
        />
      )}
    </>
  );
}
