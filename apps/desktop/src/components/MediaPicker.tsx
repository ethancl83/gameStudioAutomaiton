import { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../../../../packages/domain';
import { api } from '../api';
import { Field, Notice, Spinner } from './ui';

const ACCEPT = { image: 'image/png,image/jpeg,image/webp', video: 'video/mp4,video/quicktime', any: 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime' } as const;
const HINT = { image: 'PNG·JPEG·WebP', video: 'MP4·MOV', any: 'PNG·JPEG·WebP·GIF·MP4·MOV' } as const;
export function MediaPicker({projectId, assets, value, onChange, refresh, kind = 'image', required = true}: {
  projectId: string; assets: MediaAsset[]; value: string; onChange: (id: string) => void; refresh: () => Promise<void>;
  kind?: 'image' | 'video' | 'any'; required?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [imported, setImported] = useState<MediaAsset[]>([]);
  const [path, setPath] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fits = (asset: MediaAsset) => kind === 'any' || (kind === 'video' ? asset.mimeType.startsWith('video/') : ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType));
  const options = [...assets.filter(asset => asset.projectId === projectId && fits(asset)), ...imported.filter(asset => !assets.some(item => item.id === asset.id))];
  async function upload(file: File) {
    setPending(true); setError('');
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('15 MiB 이하의 파일을 선택해 주세요.');
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
  async function registerPath() {
    setPending(true); setError('');
    try {
      const result = await api.addMediaPath({projectId, path: path.trim()});
      if (!alive.current) return;
      if (!result.ok) throw new Error(result.error.message);
      setImported(items => [...items, result.data]); onChange(result.data.id); setPath(''); await refresh();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '동영상 등록에 실패했습니다.'); }
    finally { if (alive.current) setPending(false); }
  }
  return <div className="stack" style={{gap: 10}}>
    <Field label={kind === 'video' ? '동영상' : kind === 'any' ? '첨부 미디어' : '스토어 이미지'} required={required} htmlFor="listing-media" hint={`${HINT[kind]}, 15 MiB 이하. 선택한 프로젝트에 저장됩니다.${required ? '' : ' 비워 두면 첨부하지 않습니다.'}`}>
      <select id="listing-media" className="select" value={value} disabled={pending} onChange={event => onChange(event.target.value)}>
        <option value="">{required ? '등록한 미디어 선택' : '첨부 안 함'}</option>
        {options.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {(asset.size / 1024).toFixed(0)} KB</option>)}
      </select>
    </Field>
    <Field label="새 미디어 등록" htmlFor="listing-media-file">
      <input id="listing-media-file" type="file" accept={ACCEPT[kind]} disabled={pending} onChange={event => {const file = event.target.files?.[0]; if (file) void upload(file);}} />
    </Field>
    {kind !== 'image' && <Field label="큰 동영상 경로로 등록" htmlFor="listing-media-path" hint="15 MiB를 넘는 MP4·MOV(최대 500 MiB)는 이 컴퓨터의 전체 파일 경로로 등록합니다. 원본은 보존하고 앱 보관 폴더에 복사합니다.">
      <div className="row" style={{gap: 8}}>
        <input id="listing-media-path" className="input" value={path} disabled={pending} onChange={event => setPath(event.target.value)} placeholder="/path/to/preview.mp4" />
        <button type="button" className="btn" disabled={pending || !path.trim()} onClick={() => void registerPath()}>등록</button>
      </div>
    </Field>}
    {pending && <span className="small muted"><Spinner /> 미디어 등록 중</span>}
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}
