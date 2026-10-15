import { useState, useRef } from 'react';
import { Check, CircleAlert, Eye, EyeOff, LoaderCircle, Plus, Trash2, Zap, ShieldCheck } from 'lucide-react';

export type KeyTestStatus = 'idle' | 'testing' | 'valid' | 'invalid';

export type MultiApiKeyManagerProps = {
  title: string;
  description?: string;
  apiKeys: string[];
  onChange: (keys: string[]) => void;
  onTestKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
  placeholder?: string;
};

export function MultiApiKeyManager({
  title,
  description,
  apiKeys,
  onChange,
  onTestKey,
  placeholder = 'Dán danh sách API key vào đây (mỗi key trên một dòng)...'
}: MultiApiKeyManagerProps) {
  const [showAddBox, setShowAddBox] = useState(false);
  const [pasteContent, setPasteContent] = useState('');
  const [revealedIndices, setRevealedIndices] = useState<Set<number>>(new Set());
  const [keyStatuses, setKeyStatuses] = useState<Record<number, { status: KeyTestStatus; message?: string }>>({});
  const [testingAll, setTestingAll] = useState(false);
  const activeRef = useRef(true);

  // Toggle eye visibility
  const toggleReveal = (index: number) => {
    setRevealedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // Add bulk keys
  const handleAddBulk = () => {
    if (!pasteContent.trim()) {
      setShowAddBox(false);
      return;
    }
    const lines = pasteContent
      .split(/[\r\n,]+/)
      .map(k => k.trim())
      .filter(k => k.length > 0);

    const merged = Array.from(new Set([...apiKeys, ...lines]));
    onChange(merged);
    setPasteContent('');
    setShowAddBox(false);
  };

  // Delete single key
  const handleDeleteKey = (index: number) => {
    const updated = apiKeys.filter((_, i) => i !== index);
    onChange(updated);
    // Clear status for deleted index and shift others
    setKeyStatuses(prev => {
      const next: Record<number, { status: KeyTestStatus; message?: string }> = {};
      let nextIdx = 0;
      for (let i = 0; i < apiKeys.length; i++) {
        const item = prev[i];
        if (i !== index && item !== undefined) {
          next[nextIdx] = item;
          nextIdx++;
        }
      }
      return next;
    });
  };

  // Clear all keys
  const handleClearAll = () => {
    if (apiKeys.length === 0) return;
    if (window.confirm('Bạn có chắc chắn muốn xóa toàn bộ danh sách API Key không?')) {
      onChange([]);
      setKeyStatuses({});
    }
  };

  // Test single key
  const handleTestKey = async (index: number) => {
    const key = apiKeys[index];
    if (!key) return;

    setKeyStatuses(prev => ({
      ...prev,
      [index]: { status: 'testing', message: 'Đang kiểm tra...' }
    }));

    try {
      const res = await onTestKey(key);
      if (!activeRef.current) return;
      if (res.valid) {
        setKeyStatuses(prev => ({
          ...prev,
          [index]: { status: 'valid', message: 'Hợp lệ & Sẵn sàng' }
        }));
      } else {
        setKeyStatuses(prev => ({
          ...prev,
          [index]: { status: 'invalid', message: res.error || 'Lỗi / Hết quota' }
        }));
      }
    } catch (err) {
      if (!activeRef.current) return;
      setKeyStatuses(prev => ({
        ...prev,
        [index]: { status: 'invalid', message: err instanceof Error ? err.message : 'Lỗi kết nối' }
      }));
    }
  };

  // Test all keys
  const handleTestAll = async () => {
    if (apiKeys.length === 0 || testingAll) return;
    setTestingAll(true);

    for (let i = 0; i < apiKeys.length; i++) {
      if (!activeRef.current) break;
      await handleTestKey(i);
    }
    setTestingAll(false);
  };

  // Mask string helper
  const maskKey = (key: string, isRevealed: boolean) => {
    if (isRevealed) return key;
    if (key.length <= 10) return '••••••••••';
    return `${key.slice(0, 6)}••••••••${key.slice(-4)}`;
  };

  const validCount = Object.values(keyStatuses).filter(s => s.status === 'valid').length;
  const invalidCount = Object.values(keyStatuses).filter(s => s.status === 'invalid').length;

  return (
    <div className="multi-key-manager" style={{ marginTop: '1rem', marginBottom: '1.5rem', background: 'rgba(255, 255, 255, 0.02)', padding: '1.25rem', borderRadius: '10px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Zap size={16} style={{ color: '#f59e0b' }} />
            {title}
          </h4>
          {description ? <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.8rem', color: '#888' }}>{description}</p> : null}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            className="creator-btn-primary"
            onClick={() => setShowAddBox(prev => !prev)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.75rem', fontSize: '0.85rem', cursor: 'pointer', borderRadius: '6px', background: '#2563eb', color: '#fff', border: 'none' }}
          >
            <Plus size={15} />
            {showAddBox ? 'Đóng hộp nhập' : 'Thêm API Key'}
          </button>
          {apiKeys.length > 0 ? (
            <>
              <button
                type="button"
                disabled={testingAll}
                onClick={() => void handleTestAll()}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.75rem', fontSize: '0.85rem', cursor: 'pointer', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.08)', color: '#fff', border: '1px solid rgba(255, 255, 255, 0.15)' }}
              >
                {testingAll ? <LoaderCircle size={14} className="is-spinning" /> : <ShieldCheck size={14} />}
                Kiểm tra tất cả
              </button>
              <button
                type="button"
                onClick={handleClearAll}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.75rem', fontSize: '0.85rem', cursor: 'pointer', borderRadius: '6px', background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' }}
              >
                <Trash2 size={14} />
                Xóa tất cả
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* Bulk paste box */}
      {showAddBox ? (
        <div style={{ background: 'rgba(0, 0, 0, 0.3)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.5rem', color: '#ccc' }}>
            Dán toàn bộ các API key của bạn vào khung bên dưới (mỗi dòng một key):
          </label>
          <textarea
            rows={5}
            value={pasteContent}
            onChange={e => setPasteContent(e.target.value)}
            placeholder={placeholder}
            style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', background: 'rgba(0, 0, 0, 0.5)', border: '1px solid rgba(255, 255, 255, 0.2)', color: '#fff', fontFamily: 'monospace', fontSize: '0.85rem', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              onClick={() => { setPasteContent(''); setShowAddBox(false); }}
              style={{ padding: '0.35rem 0.75rem', fontSize: '0.85rem', borderRadius: '6px', background: 'transparent', color: '#aaa', border: '1px solid rgba(255, 255, 255, 0.15)', cursor: 'pointer' }}
            >
              Hủy
            </button>
            <button
              type="button"
              onClick={handleAddBulk}
              style={{ padding: '0.35rem 0.85rem', fontSize: '0.85rem', borderRadius: '6px', background: '#10b981', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 500 }}
            >
              Tách dòng & Lưu tự động
            </button>
          </div>
        </div>
      ) : null}

      {/* Key stats */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem', fontSize: '0.825rem', color: '#aaa' }}>
        <span>Tổng số: <strong style={{ color: '#fff' }}>{apiKeys.length}</strong> keys</span>
        {validCount > 0 ? <span style={{ color: '#10b981' }}>● {validCount} hợp lệ</span> : null}
        {invalidCount > 0 ? <span style={{ color: '#ef4444' }}>● {invalidCount} lỗi / hết quota</span> : null}
      </div>

      {/* Key list table */}
      {apiKeys.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '1.5rem', color: '#666', fontSize: '0.875rem', border: '1px dashed rgba(255, 255, 255, 0.1)', borderRadius: '8px' }}>
          Chưa có API key nào. Nhấn <strong>"Thêm API Key"</strong> để dán danh sách key vào hệ thống.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '360px', overflowY: 'auto' }}>
          {apiKeys.map((key, idx) => {
            const isRevealed = revealedIndices.has(idx);
            const status = keyStatuses[idx];
            return (
              <div
                key={`${idx}:${key.slice(0, 10)}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.45rem 0.75rem',
                  borderRadius: '6px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  fontSize: '0.85rem'
                }}
              >
                {/* Index & key text */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1, minWidth: 0 }}>
                  <span style={{ color: '#666', width: '24px', fontSize: '0.75rem', fontWeight: 600 }}>#{idx + 1}</span>
                  <code style={{ color: '#e2e8f0', fontFamily: 'monospace', fontSize: '0.825rem' }}>
                    {maskKey(key, isRevealed)}
                  </code>
                  <button
                    type="button"
                    onClick={() => toggleReveal(idx)}
                    title={isRevealed ? 'Ẩn key' : 'Hiện key'}
                    style={{ background: 'transparent', border: 'none', color: '#777', cursor: 'pointer', padding: 0 }}
                  >
                    {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>

                {/* Status Badge */}
                <div style={{ minWidth: '140px', textAlign: 'right', marginRight: '0.75rem' }}>
                  {status?.status === 'testing' ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: '#60a5fa', fontSize: '0.75rem' }}>
                      <LoaderCircle size={12} className="is-spinning" /> {status.message}
                    </span>
                  ) : status?.status === 'valid' ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: '#34d399', fontSize: '0.75rem' }}>
                      <Check size={12} /> {status.message}
                    </span>
                  ) : status?.status === 'invalid' ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: '#f87171', fontSize: '0.75rem' }} title={status.message}>
                      <CircleAlert size={12} /> {status.message}
                    </span>
                  ) : (
                    <span style={{ color: '#666', fontSize: '0.75rem' }}>Chưa kiểm tra</span>
                  )}
                </div>

                {/* Actions per row */}
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => void handleTestKey(idx)}
                    disabled={status?.status === 'testing'}
                    title="Kiểm tra key này"
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', borderRadius: '4px', background: 'rgba(255, 255, 255, 0.08)', color: '#cbd5e1', border: '1px solid rgba(255, 255, 255, 0.1)', cursor: 'pointer' }}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteKey(idx)}
                    title="Xóa key này"
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', borderRadius: '4px', background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)', cursor: 'pointer' }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
