import { AppError, object } from "../domain/errors.js";
import type { AgentChoice, AgentSettings, AgentPurpose } from "./types.js";
export const AGENT_PURPOSES: AgentPurpose[] = [
  "analysis",
  "coding",
  "review",
  "operations",
];
function choice(value: unknown): AgentChoice {
  const input = object(value);
  if (!["auto", "codex", "opencode"].includes(String(input.provider)))
    throw new AppError("INVALID_INPUT", "Codex 또는 OpenCode를 선택해 주세요.");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(model))
    throw new AppError("INVALID_MODEL", "모델 이름 형식을 확인해 주세요.");
  return {
    provider: input.provider as AgentChoice["provider"],
    ...(model ? { model } : {}),
  };
}
export function agentSettings(
  input: unknown,
  previous: AgentSettings,
): AgentSettings {
  const data = object(input);
  const base = choice({ ...previous, ...data });
  if (data.purposes === undefined)
    return { ...previous, ...base, model: base.model };
  const purposes = object(data.purposes);
  const result: AgentSettings = { ...base, purposes: {} };
  for (const purpose of AGENT_PURPOSES)
    if (purposes[purpose] !== undefined)
      result.purposes![purpose] = choice(purposes[purpose]);
  return result;
}
export function agentChoice(
  settings: AgentSettings,
  purpose: AgentPurpose,
): AgentChoice {
  return (
    settings.purposes?.[purpose] ?? {
      provider: settings.provider,
      model: settings.model,
    }
  );
}
