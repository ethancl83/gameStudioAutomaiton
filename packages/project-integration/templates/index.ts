import { catalogFor } from '../catalog.js';
import type { TemplateContext, TemplatePlan } from '../types.js';
import { planAndroid } from './android.js';
import { planIos } from './ios.js';
import { planUnity } from './unity.js';
import { planGodot } from './godot.js';
import { planUnreal } from './unreal.js';

export function buildTemplate(ctx: TemplateContext, existing: Map<string, string | null>): TemplatePlan {
  if (ctx.engine === 'android') return planAndroid(ctx, existing);
  if (ctx.engine === 'ios') return planIos(ctx, existing);
  if (ctx.engine === 'unity') return planUnity(ctx, existing);
  if (ctx.engine === 'godot') return planGodot(ctx, existing);
  if (ctx.engine === 'unreal') return planUnreal(ctx, existing);
  return {
    supported: false,
    catalog: catalogFor(ctx.engine, ctx.platform, ctx.provider, ctx.products.length > 0),
    changes: [],
    findings: [{
      code: 'scope.engine_unsupported',
      severity: 'error',
      message: `엔진 '${ctx.engine}' 임의 배선은 지원하지 않습니다.`,
      fixHint: 'android, ios, unity, godot, unreal 구체 템플릿만 구현되어 있습니다.',
    }],
  };
}

export { planAndroid, planIos, planUnity, planGodot, planUnreal };
