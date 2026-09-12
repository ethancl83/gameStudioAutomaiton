import { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../../../../packages/domain';
import { api } from '../api';
import { Field, Notice, Spinner } from './ui';

export function MediaPicker({projectId, assets, value, onChange, refresh}: {
  projectId: string; assets: MediaAsset[]; value: string; onChange: (id: string) => void; refresh: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [imported, setImported] = useState<MediaAsset[]>([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const options = [...assets.filter(asset => asset.projectId === projectId), ...imported.filter(asset => !assets.some(item => item.id === asset.id))];
  async function upload(file: File) {
    setPending(true); setError('');
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('15 MiB 이하의 이미지를 선택해 주세요.');
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(file);
      });
      if (!alive.current) return;
      const result = await api.addMedia({projectId, name: file.name, base64});
      if (!alive.current) return;
      if (!result.ok) throw new Error(result.error.message);
      setImported(items => [...items, result.data]); onChange(result.data.id); await refresh();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '이미지 등록에 실패했습니다.'); }
    finally { if (alive.current) setPending(false); }
  }
  return <div className="stack" style={{gap: 10}}>
    <Field label="스토어 이미지" required htmlFor="listing-media" hint="PNG·JPEG·WebP, 15 MiB 이하. 선택한 프로젝트에 저장됩니다.">
      <select id="listing-media" className="select" value={value} disabled={pending} onChange={event => onChange(event.target.value)}>
        <option value="">등록한 이미지 선택</option>
        {options.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {(asset.size / 1024).toFixed(0)} KB</option>)}
      </select>
    </Field>
    <Field label="새 이미지 등록" htmlFor="listing-media-file">
      <input id="listing-media-file" type="file" accept="image/png,image/jpeg,image/webp" disabled={pending} onChange={event => {const file = event.target.files?.[0]; if (file) void upload(file);}} />
    </Field>
    {pending && <span className="small muted"><Spinner /> 이미지 등록 중</span>}
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}
