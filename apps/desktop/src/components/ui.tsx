// 공용 UI 요소. 상태·오류·대기·빈 상태를 일관되게 표현한다.
import { useEffect, useRef, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  X,
  type LucideIcon,
} from 'lucide-react';

type Tone = 'ok' | 'warn' | 'error' | 'info' | 'neutral' | 'progress';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge--${tone}`}>
      <span className="badge__dot" aria-hidden />
      {children}
    </span>
  );
}

export function Spinner({ large }: { large?: boolean }) {
  return <span className={`spinner${large ? ' spinner--lg' : ''}`} role="status" aria-label="로딩 중" />;
}

export function LoadingBlock({ label = '불러오는 중…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <Spinner large />
      <span>{label}</span>
    </div>
  );
}

export function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: 'error' | 'warn' | 'info';
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = tone === 'error' ? AlertTriangle : tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={17} style={{ flex: 'none', marginTop: 1 }} aria-hidden />
      <div className="notice__body">
        {title && <div className="notice__title">{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon size={40} strokeWidth={1.4} aria-hidden />
      </div>
      <p className="empty__title">{title}</p>
      {description && <p className="empty__desc">{description}</p>}
      {action}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  flush,
  icon: Icon,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <section className="card">
      {title && (
        <div className="card__head">
          {Icon && <Icon size={17} aria-hidden />}
          <h2 className="card__title">{title}</h2>
          {actions && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>{actions}</div>}
        </div>
      )}
      <div className={`card__body${flush ? ' card__body--flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="stat">
      <div className="stat__label">
        {Icon && <Icon size={13} aria-hidden />}
        {label}
      </div>
      <div className="stat__value">{value}</div>
      {sub && <div className="stat__sub">{sub}</div>}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // 첫 포커스 가능한 요소로 이동(모달 포커스 진입).
    const focusable = el?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      // 포커스 트랩.
      const nodes = Array.from(
        el.querySelectorAll<HTMLElement>(
          'button, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previouslyFocused.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal${wide ? ' modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        ref={ref}
      >
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <button
            className="btn btn--ghost btn--sm"
            style={{ marginLeft: 'auto' }}
            onClick={onClose}
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({
  label,
  required,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="field__req" aria-hidden>
            *
          </span>
        )}
      </label>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}

export function ConfirmIcon({ tone }: { tone: 'ok' | 'error' }) {
  return tone === 'ok' ? (
    <CheckCircle2 size={16} color="var(--ok)" aria-hidden />
  ) : (
    <AlertTriangle size={16} color="var(--error)" aria-hidden />
  );
}

export { Loader2 };
