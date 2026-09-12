// 빌드/출시용 러너 선택기. GET /operations 의 준비된 러너만 노출한다. 비우면 로컬(현재 OS) 빌드다.
import { useReadyRunners } from '../useOperations';
import { Field } from './ui';

const PLATFORM_LABELS: Record<'linux' | 'darwin' | 'win32', string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
};

export function RunnerSelect({
  value,
  onChange,
  id = 'runner-select',
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
}) {
  const { runners, loading } = useReadyRunners();
  return (
    <Field
      label="빌드 러너"
      htmlFor={id}
      hint={
        loading
          ? '준비된 러너를 불러오는 중…'
          : runners.length === 0
            ? '준비된 원격 러너가 없습니다. 비우면 현재 OS에서 로컬로 빌드합니다.'
            : '다른 OS 타깃(macOS·Windows 등)은 준비된 러너를 선택하세요. 비우면 로컬(현재 OS) 빌드입니다.'
      }
    >
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)} disabled={loading}>
        <option value="">로컬(현재 OS)</option>
        {runners.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label} · {PLATFORM_LABELS[r.platform]}
          </option>
        ))}
      </select>
    </Field>
  );
}
