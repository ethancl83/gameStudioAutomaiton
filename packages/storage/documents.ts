import type { Connection, ExternalResource, MetricFact, Project, ReleasePipeline } from '../domain/index.js';
import type { WebDeployment } from '../development/types.js';
import { AppError } from '../domain/errors.js';

export interface GrowthRunSource {
  runId: string; mandateId: string; safety: boolean; responseId?: string;
  source?: 'mandate' | 'operator'; at: string;
}
export interface DocumentPayloads {
  project: Project; connection: Connection; resource: ExternalResource; metric: MetricFact;
  pipeline: ReleasePipeline; 'web-deployment': WebDeployment; 'growth-run': GrowthRunSource;
}
export type CoreDocumentKind = keyof DocumentPayloads;

/** Validate the persisted identity and kind discriminators at typed boundaries.
 * Feature controllers still own business validation (policy, prices, paths).
 * Legacy generic settings and document readers retain their existing contract.
 */
export function validateDocument<K extends CoreDocumentKind>(kind: K, id: string, value: unknown): asserts value is DocumentPayloads[K] {
  const fail = () => { throw new AppError('INVALID_DOCUMENT', `저장 문서 형식이 올바르지 않습니다: ${kind}/${id}`, 422); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const doc = value as Record<string, unknown>;
  if (doc[kind === 'growth-run' ? 'runId' : 'id'] !== id) return fail();
  const required: Record<CoreDocumentKind, string[]> = {
    project: ['name','rootPath','engine'], connection: ['provider','accountId','status'],
    resource: ['provider','connectionId','kind','externalId'], metric: ['provider','connectionId','kind','date','amountMicros'],
    pipeline: ['projectId','status'], 'web-deployment': ['projectId','provider','status','terminalId'],
    'growth-run': ['mandateId','at'],
  };
  if (required[kind].some(field => typeof doc[field] !== 'string')) return fail();
  if (kind === 'growth-run' && (typeof doc.safety !== 'boolean' || doc.source !== undefined && !['operator','mandate'].includes(String(doc.source)))) return fail();
  if (kind === 'web-deployment' && (!['netlify','vercel'].includes(String(doc.provider)) || !['running','succeeded','failed','action_required','uncertain'].includes(String(doc.status)) || typeof doc.production !== 'boolean')) return fail();
}
