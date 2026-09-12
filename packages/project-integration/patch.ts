import { MARKER_BEGIN, MARKER_END } from './catalog.js';
import type { IntegrationFinding } from './types.js';

export function hasManagedRegion(source: string, id: string): boolean {
  return source.includes(`${MARKER_BEGIN} ${id}`);
}

export function extractManagedRegion(source: string, id: string): string | null {
  const begin = source.indexOf(`${MARKER_BEGIN} ${id}`);
  const end = source.indexOf(`${MARKER_END} ${id}`);
  if (begin < 0 || end < 0 || end < begin) return null;
  return source.slice(begin, end);
}

export function replaceManagedRegion(source: string, beginLine: string, endLine: string, body: string): string {
  const beginIdx = source.indexOf(beginLine);
  const endIdx = source.indexOf(endLine);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    return `${source.replace(/\s*$/, '\n')}\n${beginLine}\n${body}\n${endLine}\n`;
  }
  const from = source.lastIndexOf('\n', beginIdx) >= 0 && source[source.lastIndexOf('\n', beginIdx) + 1] !== undefined
    ? source.lastIndexOf('\n', beginIdx) + 1
    : beginIdx;
  const to = endIdx + endLine.length;
  return source.slice(0, from) + `${beginLine}\n${body}\n${endLine}` + source.slice(to);
}

export function insertIntoBlock(
  source: string,
  blockPattern: RegExp,
  beginLine: string,
  endLine: string,
  body: string,
  findings: IntegrationFinding[],
  path: string,
): string | null {
  if (hasManagedRegion(source, beginLine.replace(/^[^A]+APPOPS-INTEGRATION-BEGIN /, '').replace(/\s*$/, ''))) {
    return replaceManagedRegion(source, beginLine, endLine, body);
  }
  const match = source.match(blockPattern);
  if (!match || match.index === undefined) {
    findings.push({
      code: 'format.unknown_block',
      severity: 'error',
      message: '기존 파일에서 삽입할 블록을 찾지 못했습니다. 임의 형식을 덮어쓰지 않습니다.',
      path,
      fixHint: '공식 Gradle/Podfile/manifest 형식을 유지하거나 빈 파일을 사용하세요.',
    });
    return null;
  }
  const blockStart = match.index;
  const openBrace = source.indexOf('{', blockStart);
  if (openBrace < 0) {
    findings.push({
      code: 'format.unknown_block',
      severity: 'error',
      message: '블록 본문을 파싱할 수 없습니다.',
      path,
      fixHint: 'Groovy/Kotlin DSL dependencies { } 형식을 확인하세요.',
    });
    return null;
  }
  const close = findMatchingBrace(source, openBrace);
  if (close < 0) {
    findings.push({
      code: 'format.unbalanced',
      severity: 'error',
      message: '중괄호가 맞지 않아 기존 파일을 수정하지 않습니다.',
      path,
    });
    return null;
  }
  const indent = '    ';
  const insertion = `\n${indent}${beginLine}\n${body.split('\n').map((line) => (line ? indent + line : line)).join('\n')}\n${indent}${endLine}\n`;
  return source.slice(0, close) + insertion + source.slice(close);
}

function findMatchingBrace(source: string, open: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const prev = source[i - 1];
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function ensureXmlMeta(source: string, name: string, value: string, beginLine: string, endLine: string, findings: IntegrationFinding[], path: string): string | null {
  if (source.includes('\0') || /[\x00-\x08]/.test(source.slice(0, 64))) {
    findings.push({ code: 'format.binary_xml', severity: 'error', message: '바이너리 XML은 수정하지 않습니다.', path });
    return null;
  }
  if (source.includes(beginLine)) return replaceManagedRegion(source, beginLine, endLine, `        <meta-data android:name="${name}" android:value="${value}" />`);
  const appClose = source.lastIndexOf('</application>');
  if (appClose < 0) {
    findings.push({
      code: 'format.manifest_application',
      severity: 'error',
      message: 'AndroidManifest에서 </application>을 찾지 못했습니다.',
      path,
      fixHint: '표준 매니페스트 형식을 사용하세요.',
    });
    return null;
  }
  const block = `    ${beginLine}\n        <meta-data android:name="${name}" android:value="${value}" />\n    ${endLine}\n`;
  return source.slice(0, appClose) + block + source.slice(appClose);
}

export function ensurePlistKey(source: string, key: string, value: string, beginLine: string, endLine: string, findings: IntegrationFinding[], path: string): string | null {
  if (source.includes('bplist') || source.startsWith('bplist00')) {
    findings.push({ code: 'format.binary_plist', severity: 'error', message: '바이너리 Info.plist는 수정하지 않습니다.', path, fixHint: 'XML Info.plist를 사용하세요.' });
    return null;
  }
  if (source.includes(beginLine)) {
    return replaceManagedRegion(source, beginLine, endLine, `    <key>${key}</key>\n    <string>${value}</string>`);
  }
  const dictClose = source.lastIndexOf('</dict>');
  if (dictClose < 0) {
    findings.push({ code: 'format.plist_dict', severity: 'error', message: 'Info.plist에서 </dict>를 찾지 못했습니다.', path });
    return null;
  }
  const block = `    ${beginLine}\n    <key>${key}</key>\n    <string>${value}</string>\n    ${endLine}\n`;
  return source.slice(0, dictClose) + block + source.slice(dictClose);
}
