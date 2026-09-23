import { redact } from '../domain/errors.js';

export function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).filter(([key, value]) => value && /token|secret|password|api_?key|credential/i.test(key)).map(([, value]) => value!);
}

/** Keep partial secret prefixes private across PTY chunks, including echoed input. */
export function terminalRedactor(secrets: string[], lineBuffered: boolean, append: (safe: string) => void) {
  const known = [...new Set(secrets.filter(value => value.length >= 4))];
  let pending = '';
  const sanitize = (value: string) => {
    // tmux can redraw an unfinished line with cursor controls/newlines before the
    // next source chunk. Hide recognizable credential prefixes in those frames.
    let safe=value;
    for(const secret of known) {
      safe=safe.split(secret).join('[REDACTED]').split(secret.slice(0,4)).join('[REDACTED]');
    }
    return redact(safe.replace(/("(?:access_token|refresh_token|id_token|api_key|password|client_secret)"\s*:\s*")[^"]+/gi, '$1[REDACTED]'), known);
  };
  return (data: string, final = false) => {
    pending += data;
    let end = pending.length;
    if (!final && lineBuffered) end = pending.lastIndexOf('\n') + 1;
    if (!final) for (const secret of known) {
      for (let length = Math.min(secret.length - 1, pending.length); length > 0; length--) {
        if (pending.endsWith(secret.slice(0, length))) { end = Math.min(end, pending.length - length); break; }
      }
    }
    if (end) { append(sanitize(pending.slice(0, end))); pending = pending.slice(end); }
    if (pending.length > 64 * 1024) { pending = ''; append('[긴 터미널 출력 생략]\r\n'); }
  };
}
