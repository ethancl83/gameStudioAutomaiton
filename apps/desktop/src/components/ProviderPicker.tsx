import { AtSign, ChartNoAxesCombined, Gamepad2, Layers, Megaphone, Play, ShoppingBag, Smartphone, type LucideIcon } from 'lucide-react';
import type { Provider } from '../../../../packages/domain';
import { providerLabel } from '../format';

const icons: Record<Provider, LucideIcon> = {
  'google-play': Play, 'app-store': ShoppingBag, steam: Gamepad2,
  'google-ads': ChartNoAxesCombined, 'applovin-ads': Megaphone,
  'applovin-max': Layers, admob: Smartphone, x: AtSign, threads: AtSign,
};

export function ProviderPicker<T extends string>({ label, value, options, onChange }: {
  label: string; value: T | ''; onChange: (value: T) => void;
  options: { id: T; provider: Provider; label?: string; description?: string }[];
}) {
  return <div className="provider-picker" role="group" aria-label={label}>
    {options.map(option => {
      const Icon = icons[option.provider];
      return <button key={option.id} type="button" className="provider-choice" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>
        <span className={`provider-choice__icon provider-choice__icon--${option.provider}`}><Icon size={21} aria-hidden /></span>
        <span><strong>{option.label ?? providerLabel(option.provider)}</strong>{option.description && <small>{option.description}</small>}</span>
      </button>;
    })}
  </div>;
}
