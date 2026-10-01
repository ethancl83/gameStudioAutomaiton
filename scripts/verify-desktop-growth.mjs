// npm run build 후 실행. 격리한 제어 서비스와 실제 Electron 창에서 성장 운영 화면을 검증한다.
// 계정은 저장소에 공개 메타데이터만 넣은 픽스처이며 작업 큐를 멈춰 외부 서비스 요청을 보내지 않는다.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shots = join(root, 'tmp', 'growth-ui', 'screenshots');

async function until(read, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`${description}: ${timeout / 1000}초 안에 완료되지 않았습니다.`);
}

// 렌더러 도우미. 라벨 텍스트로 입력을 찾고 React 입력은 네이티브 setter + 이벤트로 바꾼다.
const HELPERS = `window.__t = {
  find: (sel, text) => [...document.querySelectorAll(sel)].find(e => e.textContent.replace(/\\s+/g, ' ').trim().includes(text)),
  click(sel, text) {
    const e = text === undefined ? document.querySelector(sel) : this.find(sel, text);
    if (!e) throw new Error('없음: ' + sel + ' ' + (text ?? ''));
    if (e.disabled) throw new Error('비활성: ' + sel + ' ' + (text ?? ''));
    e.click(); return true;
  },
  field(label) {
    const l = [...document.querySelectorAll('label')].find(e => e.htmlFor && e.textContent.replace(/\\s+/g, ' ').trim().startsWith(label));
    if (!l) throw new Error('라벨 없음: ' + label);
    return document.getElementById(l.htmlFor);
  },
  set(label, value) {
    const e = this.field(label);
    const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
    e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return true;
  },
  text: () => document.querySelector('.content')?.innerText ?? '',
  growth: (input) => window.appOps.request(input ? 'POST' : 'GET', '/growth', input),
}; true`;

if (process.versions.electron) {
  const { app, BrowserWindow } = await import('electron');
  app.setPath('userData', join(process.env.APPOPS_DATA_DIR, 'electron'));
  // A held main-process fetch makes the project-switch race deterministic while still
  // exercising the actual Electron bridge and controller HTTP response.
  const slowProjectId = process.env.APPOPS_GROWTH_SLOW_PROJECT_ID;
  const fastProjectId = process.env.APPOPS_GROWTH_FAST_PROJECT_ID;
  const historyExperimentId = process.env.APPOPS_GROWTH_HISTORY_EXPERIMENT_ID;
  const growthPollDelayMs = Number(process.env.APPOPS_GROWTH_POLL_DELAY_MS ?? 0);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  let holdNextSlowProjectRead = false;
  let releaseSlowProjectRead;
  let slowProjectReadFinished = false;
  let growthPollRequests = 0;
  let growthPollResponses = 0;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (holdNextSlowProjectRead && url.includes(`/growth/projects/${slowProjectId}`)) {
      holdNextSlowProjectRead = false;
      return new Promise((resolve, reject) => {
        releaseSlowProjectRead = () => {
          void nativeFetch(input, init).then(response => {
            slowProjectReadFinished = true;
            resolve(response);
          }, reject);
        };
      });
    }
    if (growthPollDelayMs > 0 && url.includes('/growth/projects/')) {
      growthPollRequests++;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          void nativeFetch(input, init).then(response => {
            growthPollResponses++;
            resolve(response);
          }, reject);
        }, growthPollDelayMs);
      });
    }
    return nativeFetch(input, init);
  };
  async function verify() {
    try {
      await import('../dist/apps/desktop/electron/main.js');
      const win = await until(() => BrowserWindow.getAllWindows()[0], '창 생성');
      win.setSize(1440, 1000);
      const wc = win.webContents;
      const read = (expression) => wc.executeJavaScript(expression);
      const js = (body) => read(`(async () => { ${body} })()`);
      const wait = (expression, description, timeout) => until(() => read(expression).catch(() => false), description, timeout);
      const pass = (name) => console.log(`PASS ${name}`);
      const shot = async (name) => { await delay(400); await writeFile(join(shots, `${name}.png`), (await win.capturePage()).toPNG()); };
      const growth = async () => (await js(`return (await __t.growth()).data`));
      await wait(`!!document.querySelector('.mode-switch--live')`, '실제 모드 화면');
      await read(HELPERS);
      const tasksBefore = (await read(`window.appOps.request('GET', '/agent')`)).data.tasks.length;
      const pollCheck = process.env.APPOPS_GROWTH_POLL_CHECK;
      if (pollCheck) {
        if (growthPollDelayMs !== 6000) throw new Error('poll 재현은 모든 project growth 응답을 정확히 6초 지연해야 합니다.');
        await js(`__t.click('.nav-item', '성장 운영'); return true`);
        await wait(`document.querySelector('.topbar__title')?.textContent === '성장 운영'`, '느린 poll 성장 화면');
        if (pollCheck === 'before-fix') {
          await delay(12500);
          assert.ok(growthPollRequests >= 3, `${growthPollRequests}건의 지연 poll 요청이 시작되어야 함`);
          assert.ok(growthPollResponses >= 2, `${growthPollResponses}건의 지연 poll 응답이 도착해야 함`);
          assert.equal(await read(`!document.querySelector('[role=tablist]')`), true, '현재 dist는 반복 지연 응답 뒤에도 성장 탭을 로드하지 못함');
          assert.equal(await read(`__t.text().includes('성장 운영 상태를 불러오는 중')`), true, '현재 dist의 화면이 계속 로딩 상태');
          await shot('15-slow-poll-loading-before-fix');
          pass(`현재 dist에서 6초 poll ${growthPollResponses}/${growthPollRequests} 응답 후 permanent loading 재현`);
        } else if (pollCheck === 'after-fix') {
          await wait(`!!document.querySelector('[role=tablist]')`, '6초 지연 poll 성장 상태 반영', 20000);
          await js(`__t.click('[role=tab]', '지식·환율'); return true`);
          await wait(`__t.text().includes('SLOW_PROJECT_SCOPE_MARKER')`, '느린 poll 뒤 현재 프로젝트 데이터');
          await until(() => growthPollResponses >= 2, '두 번째 6초 지연 poll 응답', 22000);
          assert.ok(growthPollRequests >= 2, '초기 응답 후 두 번째 poll 요청 시작');
          assert.equal(await read(`!__t.text().includes('불러오는 중')`), true, '지연 응답 뒤 로딩 종료');
          await shot('15-slow-poll-loaded-after-fix');
          pass(`수정 dist에서 6초 지연 poll ${growthPollResponses}/${growthPollRequests} 응답으로 첫 로드 및 다음 갱신 확인`);
        } else {
          throw new Error(`알 수 없는 APPOPS_GROWTH_POLL_CHECK=${pollCheck}`);
        }
        const runs = (await read(`window.appOps.request('GET', '/state')`)).data.runs;
        assert.equal(runs.filter(run => run.writeEffect).length, 0, 'poll 재현 중 외부 쓰기 작업 없음');
        app.exit(0);
        return;
      }
      holdNextSlowProjectRead = true;
      await js(`__t.click('.nav-item', '성장 운영'); return true`);
      await wait(`document.querySelector('.topbar__title')?.textContent === '성장 운영'`, '성장 운영 화면');
      await until(() => Boolean(releaseSlowProjectRead), '이전 프로젝트 응답 지연 시작');
      await js(`__t.set('프로젝트', ${JSON.stringify(fastProjectId)}); return true`);
      await wait(`!!document.querySelector('[role=tablist]')`, '새 프로젝트 성장 상태');
      await js(`__t.click('[role=tab]', '지식·환율'); return true`);
      await wait(`__t.text().includes('FAST_PROJECT_SCOPE_MARKER')`, '새 프로젝트 범위 데이터');
      await shot('10-project-switch-fast');
      releaseSlowProjectRead();
      await until(() => slowProjectReadFinished, '늦은 이전 프로젝트 응답 완료');
      await delay(350);
      assert.equal(await read(`document.getElementById('growth-project').value === ${JSON.stringify(fastProjectId)}`), true, '프로젝트 선택 유지');
      assert.equal(await read(`__t.text().includes('FAST_PROJECT_SCOPE_MARKER') && !__t.text().includes('불러오는 중')`), true, '늦은 이전 응답이 현재 화면을 덮지 않음');
      pass('프로젝트 전환: 늦은 이전 응답이 현재 범위 화면을 덮지 않음');

      await js(`__t.click('[role=tab]', '실험·결정'); return true`);
      const historySelector = `#growth-experiment-${historyExperimentId}`;
      await wait(`!!document.querySelector(${JSON.stringify(historySelector)})`, '결정 이력 픽스처 실험');
      await js(`__t.click('summary', '결정 이력 300건'); return true`);
      const markerList = `([...document.querySelectorAll(${JSON.stringify(historySelector + ' .action-group')})].map(row => row.innerText.match(/CURSOR_BOUNDARY_(\\d{3})/)?.[1] ?? ''))`;
      await wait(`${markerList}.length === 300`, '최근 결정 300건 표시');
      const firstPageMarkers = await read(markerList);
      assert.deepEqual(firstPageMarkers, Array.from({ length: 300 }, (_, i) => String(350 - i).padStart(3, '0')), '같은 시각 결정의 첫 커서 경계 순서');
      assert.equal(await read(`!!__t.find('button', '이전 결정 더 보기')`), true, '이전 이력 더 보기 표시');
      await shot('11-decision-history-initial-300');
      await js(`__t.click('button', '이전 결정 더 보기'); return true`);
      await wait(`${markerList}.length === 350`, '이전 결정 첫 페이지 추가');
      const secondPageMarkers = await read(markerList);
      assert.deepEqual(secondPageMarkers, Array.from({ length: 350 }, (_, i) => String(350 - i).padStart(3, '0')), '첫 추가 페이지 중복·누락 없음');
      await shot('12-decision-history-page-50');
      await js(`__t.click('button', '이전 결정 더 보기'); return true`);
      await wait(`${markerList}.length === 351`, '마지막 결정 추가');
      const allPageMarkers = await read(markerList);
      assert.deepEqual(allPageMarkers, Array.from({ length: 351 }, (_, i) => String(350 - i).padStart(3, '0')), '모든 결정의 커서 경계 중복·누락 없음');
      assert.equal(new Set(allPageMarkers).size, 351, '결정 이력 ID별 렌더링 유일성');
      assert.equal(await read(`!!__t.find('button', '이전 결정 더 보기')`), false, '마지막 커서 이후 더 보기 버튼 제거');
      await shot('13-decision-history-complete');
      pass('결정 이력: 300건 상한, 50건 cursor page, 동일 시각 경계와 마지막 항목 연결');

      await js(`__t.set('프로젝트', ${JSON.stringify(slowProjectId)}); return true`);
      await wait(`!!document.querySelector('[role=tablist]')`, '원래 프로젝트 재선택');
      await js(`__t.click('[role=tab]', '지식·환율'); return true`);
      await wait(`__t.text().includes('SLOW_PROJECT_SCOPE_MARKER')`, '원래 프로젝트 범위 데이터');
      await js(`__t.click('[role=tab]', '개요·위임'); return true`);
      await shot('14-project-switch-back');
      pass('프로젝트 전환: 원래 프로젝트로 복귀');

      await wait(`__t.text().includes('아직 정책이 없습니다')`, '정책 없음 안내');
      assert.equal(await read(`__t.find('button', '정책 저장').disabled`), true, '필수 정책값 없이 저장 불가');
      assert.equal(await read(`__t.find('button', '새 위임').disabled`), true, '정책 없이 위임 불가');
      await shot('01-no-policy');
      pass('정책 없는 초기 화면: 저장·위임 비활성');

      for (const [label, value] of [['유의수준 α', '0.05'], ['다중 비교 보정', 'holm'], ['기본 중지 규칙', 'fixed_horizon'], ['가격 실험 허용', 'no'], ['환율 허용 기간(시간)', '48'], ['가변비용 비율(%)', '0'], ['Google Ads', '48'], ['X', '48']])
        await js(`__t.set(${JSON.stringify(label)}, ${JSON.stringify(value)}); return true`);
      await wait(`!__t.find('button', '정책 저장').disabled`, '정책 저장 활성');
      await js(`__t.click('button', '정책 저장'); return true`);
      await until(async () => (await growth()).policies.length === 1, '정책 저장');
      const policy = (await growth()).policies[0];
      assert.equal(policy.alpha, 0.05); assert.equal(policy.multiplicity, 'holm'); assert.equal(policy.freshnessHours['google-ads'], 48);
      pass('화면 양식으로 통계·신선도 정책 저장');

      // AI가 채팅에서 만든 위임안은 제안 상태이며 화면에서 확인 체크 후에만 확정된다.
      const projectId = await read(`document.getElementById('growth-project').value`);
      const proposed = (await js(`return (await __t.growth({ action: 'propose-mandate', projectId: ${JSON.stringify(projectId)}, source: 'chat', requestText: '다음 달 광고 실험과 커뮤니티 초안 운영', connectionIds: ['ads', 'x'], actions: ['ads-experiment', 'community-draft', 'feedback-triage'], endsAt: new Date(Date.now() + 40 * 86400000).toISOString(), limits: { maxTotalSpendMicros: '300000000', maxLossMicros: '100000000' }, confirm: true })).data`));
      assert.equal(proposed.status, 'proposed');
      await wait(`__t.text().includes('확정 전 위임안입니다')`, '위임안 표시', 8000);
      assert.equal(await read(`__t.find('button', '확정').disabled`), true, '확인 체크 전 확정 불가');
      await shot('02-proposed-mandate');
      await js(`__t.find('label.checkbox-row', '위 범위·기간·한도를 확인했고').querySelector('input').click(); return true`);
      await wait(`!__t.find('button', '확정').disabled`, '확정 버튼 활성');
      await js(`__t.click('button', '확정'); return true`);
      await until(async () => (await growth()).mandates[0]?.status === 'active', '위임 확정');
      pass('AI 위임안 → 확인 체크 → 확정');

      await js(`await __t.growth({ action: 'create-experiment', mandateId: ${JSON.stringify(proposed.id)}, kind: 'ads', connectionId: 'ads', design: 'observational_comparison', hypothesis: { change: '새 소재 비교', cohort: '신규 설치', primaryMetric: 'conversion_rate', guardrails: [], minimumEffect: 0.05, attributionWindowDays: 0, minDurationDays: 7, maxDurationDays: 14, minSamplePerArm: 100 }, arms: [{ role: 'control', label: '기존 소재', campaignId: '111' }, { role: 'treatment', label: '새 소재', campaignId: '222' }] }); return true`);
      await js(`__t.click('[role=tab]', '실험·결정'); return true`);
      await wait(`__t.text().includes('관찰 비교 — A/B 아님, 자동 확대 없음')`, '관찰 비교 표시', 8000);
      await js(`__t.click('button', '사전 등록'); return true`);
      await wait(`__t.text().includes('사전 등록하면 되돌릴 수 없습니다')`, '사전 등록 경고');
      await js(`__t.find('.notice button, button', '등록') && [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '등록').click(); return true`);
      await until(async () => (await growth()).experiments[0]?.status === 'scheduled', '실험 사전 등록');
      await wait(`!!__t.find('button', '시작')`, '시작 버튼');
      await js(`__t.click('button', '시작'); return true`);
      await until(async () => (await growth()).experiments[0]?.status === 'observing', '관찰 시작');
      await shot('03-experiment-observing');
      pass('관찰 비교 실험 준비 → 사전 등록 경고 → 등록 → 시작');

      await js(`__t.click('[role=tab]', '개요·위임'); return true`);
      await wait(`__t.text().includes('ROAS')`, '성과 카드');
      assert.equal(await read(`__t.text().includes('contribution')`) || await read(`__t.text().includes('기여')`), true, 'contribution과 다른 값이라는 안내');
      await shot('04-overview-performance');
      pass('성과 카드: ROAS·순이익 ROI 분리 표시와 정의');

      for (const [tab, name] of [['수익화·가격', '05-pricing'], ['고객응대', '06-community'], ['피드백 이슈', '07-feedback'], ['지식·환율', '08-knowledge']]) {
        await js(`__t.click('[role=tab]', ${JSON.stringify(tab)}); return true`);
        await wait(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes(${JSON.stringify(tab)})`, tab + ' 탭');
        await delay(300);
        assert.ok((await read(`__t.text().length`)) > 200, tab + ' 탭 내용 렌더링');
        await shot(name);
      }
      pass('여섯 탭 전환·렌더링');

      // 행의 AI 요청 버튼은 선택 스냅샷과 함께 대화 창만 열고 작업을 만들지 않는다.
      await js(`__t.click('[role=tab]', '실험·결정'); return true`);
      await wait(`!!document.querySelector('button[aria-label^="AI 요청: "]')`, '행 AI 요청 버튼');
      await js(`document.querySelector('button[aria-label^="AI 요청: "]').click(); return true`);
      await wait(`!!document.querySelector('.modal .agent-chat')`, 'AI 대화 창');
      await delay(1200);
      assert.equal((await read(`window.appOps.request('GET', '/agent')`)).data.tasks.length, tasksBefore, 'AI 요청 버튼은 작업을 만들지 않음');
      await shot('09-ai-request-selection');
      await js(`document.querySelector('.modal button[aria-label="닫기"]').click(); return true`);
      pass('행 AI 요청: 선택 맥락으로 대화 창만 열고 자동 실행 없음');

      const runs = (await read(`window.appOps.request('GET', '/state')`)).data.runs;
      assert.equal(runs.filter(run => run.writeEffect).length, 0, '외부 쓰기 작업 없음');
      pass('검증 중 외부 쓰기 작업 0건');
      app.exit(0);
    } catch (error) {
      console.error(error);
      try {
        const image = await BrowserWindow.getAllWindows()[0]?.capturePage();
        if (image) await writeFile(join(shots, 'failure.png'), image.toPNG());
      } catch { /* 실패 화면 저장은 최선 노력 */ }
      app.exit(1);
    }
  }
  void verify();
} else {
  const { spawn } = await import('node:child_process');
  const { default: electron } = await import('electron');
  const { startController } = await import('../dist/apps/controller/server.js');
  const directory = await mkdtemp(join(tmpdir(), 'appops-growth-ui-'));
  const fixture = await mkdtemp(join(tmpdir(), 'appops-growth-project-'));
  const secondFixture = await mkdtemp(join(tmpdir(), 'appops-growth-project-'));
  await mkdir(shots, { recursive: true });
  await writeFile(join(fixture, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="Growth Fixture"\n');
  await writeFile(join(secondFixture, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="Growth Fixture B"\n');
  await writeFile(join(directory, 'desktop-mode.json'), JSON.stringify({ mode: 'live' }));
  let controller;
  try {
    controller = await startController({ directory, port: 0, scanToolchains: async () => [] });
    const service = controller.service;
    // 픽스처 계정으로 외부 요청이 나가지 않도록 큐와 스케줄러를 멈춘다.
    service.queue.pause(); await service.scheduler.stop();
    await service.addProject({ path: fixture });
    await service.addProject({ path: secondFixture });
    const projectOrder = (await service.state()).projects.map(item => item.id);
    const slowProjectId = projectOrder[0];
    const fastProjectId = projectOrder.find(id => id !== slowProjectId);
    if (!slowProjectId || !fastProjectId) throw new Error('성장 UI 프로젝트 픽스처 두 개를 만들지 못했습니다.');
    const now = new Date().toISOString();
    for (const [id, provider, label, accountId] of [['ads', 'google-ads', 'Ads 픽스처', '1234567890'], ['x', 'x', 'X 픽스처', '42']])
      service.store.put('connection', id, { id, provider, label, accountId, status: 'connected', createdAt: now, updatedAt: now, lastCheckedAt: null, lastError: null, authKind: 'fixture', credentialFields: [] });
    const stored = service.store.get('project', slowProjectId);
    service.store.put('project', slowProjectId, { ...stored, policy: { ...stored.policy, allowedConnectionIds: ['ads'], allowCampaignWrites: true, maxDailyBudgetMicros: '50000000', currency: 'USD' },
      socialPolicy: { enabled: true, connectionIds: ['x'], dailyPostLimit: 5, autoReleaseAnnouncements: false, releaseTemplate: '', autoReply: false, replyRules: [] } });
    for (const [projectId, title] of [[slowProjectId, 'SLOW_PROJECT_SCOPE_MARKER'], [fastProjectId, 'FAST_PROJECT_SCOPE_MARKER']])
      service.store.put('knowledge-revision', `growth-scope-${projectId}`, { id: `growth-scope-${projectId}`, projectId, documentKey: title, version: 1,
        sourceKind: 'analysis', title, body: `Native fixture marker for ${title}`, sha256: '0'.repeat(64), status: 'draft', createdAt: now });
    const historyExperimentId = 'growth-ui-history-fixture';
    service.store.put('growth-experiment', historyExperimentId, {
      id: historyExperimentId, projectId: fastProjectId, mandateId: 'fixture-mandate', version: 1, kind: 'ads', provider: 'google-ads', connectionId: 'ads',
      design: 'observational_comparison', hypothesis: { change: 'Cursor boundary fixture', cohort: 'Native fixture', primaryMetric: 'conversion_rate', guardrails: [],
        minimumEffect: 0.05, attributionWindowDays: 0, minDurationDays: 7, maxDurationDays: 14, minSamplePerArm: 100 },
      stopping: { kind: 'fixed_horizon' }, alpha: 0.05, multiplicity: 'holm',
      arms: [{ id: 'control', role: 'control', label: '대조군', campaignId: '111' }, { id: 'treatment', role: 'treatment', label: '실험군', campaignId: '222' }],
      status: 'completed', looksUsed: 1, runIds: [], policyVersion: 1, createdAt: now, updatedAt: now,
    });
    const historyAt = '2025-01-01T00:00:00.000Z';
    for (let i = 0; i < 351; i++) {
      const id = `cursor-${String(i).padStart(3, '0')}`;
      service.store.put('growth-decision', id, { id, experimentId: historyExperimentId, experimentVersion: 1, projectId: fastProjectId, at: historyAt,
        look: 1, kind: 'efficacy', outcome: 'continue', arms: [], comparisons: [], quality: { fresh: true, sampleSufficient: true, windowComplete: true,
          assignmentProven: true, currencyConsistent: true, reasons: [] }, guardrailViolations: [], factIds: [], policyVersion: 1,
        algorithmVersion: 'fixture', mandateId: 'fixture-mandate', reasons: [`CURSOR_BOUNDARY_${String(i).padStart(3, '0')}`] });
    }
    for (let day = 3; day <= 9; day++) {
      const date = new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10);
      const base = { projectId: slowProjectId, provider: 'google-ads', connectionId: 'ads', campaignId: '111', acquisitionDate: date, eventDate: date, currency: 'USD', observedAt: now, collectedAt: now, sourceWatermark: date, revision: 1, finality: 'estimated', attributionWindowDays: 0 };
      service.store.put('attribution-fact', 's' + day, { ...base, id: 's' + day, kind: 'spend', amountMicros: '10000000', sourceId: 'spend:' + date });
      service.store.put('attribution-fact', 'r' + day, { ...base, id: 'r' + day, kind: 'revenue', amountMicros: '15000000', revenueBasis: 'gross_conversion_value', sourceId: 'rev:' + date });
    }
    const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: root, stdio: 'inherit', env: { ...process.env, APPOPS_DATA_DIR: directory, APPOPS_DEV_SERVER_URL: '', APPOPS_API_URL: '',
      APPOPS_GROWTH_SLOW_PROJECT_ID: slowProjectId, APPOPS_GROWTH_FAST_PROJECT_ID: fastProjectId, APPOPS_GROWTH_HISTORY_EXPERIMENT_ID: historyExperimentId } });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    try {
      process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
    } finally { clearTimeout(timer); }
  } finally {
    await controller?.close();
    await rm(directory, { recursive: true, force: true });
    await rm(directory + '.demo', { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
    await rm(secondFixture, { recursive: true, force: true });
  }
}
