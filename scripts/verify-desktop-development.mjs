// npm run build 후 실행. 격리한 제어 서비스와 실제 Electron 창에서 개발 작업·웹 배포·AI 설정 화면을 검증한다.
// GitHub·배포 서비스·CLI 로그인 같은 외부 작업은 제어 서비스의 개발 action 경계에서 픽스처로 대체한다.
// 로컬 Git·tmux 터미널·정책 저장·상태 조회는 제품 코드를 그대로 통과한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shots = join(root, 'tmp', 'development-workflow', 'screenshots');

async function until(read, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`${description}: ${timeout / 1000}초 안에 완료되지 않았습니다.`);
}

// 렌더러에 주입하는 조회·조작 도우미. React 입력은 네이티브 setter + 이벤트로 바꾼다.
const HELPERS = `window.__t = {
  all: (sel) => [...document.querySelectorAll(sel)],
  find: (sel, text) => [...document.querySelectorAll(sel)].find(e => e.textContent.replace(/\\s+/g, ' ').trim().includes(text)),
  click(sel, text) {
    const e = text === undefined ? document.querySelector(sel) : this.find(sel, text);
    if (!e) throw new Error('없음: ' + sel + ' ' + (text ?? ''));
    if (e.disabled) throw new Error('비활성: ' + sel + ' ' + (text ?? ''));
    e.click(); return true;
  },
  enabled(sel, text) { const e = this.find(sel, text); return !!e && !e.disabled; },
  set(sel, value) {
    const e = document.querySelector(sel);
    if (!e) throw new Error('없음: ' + sel);
    const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
    e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return true;
  },
  text: () => document.querySelector('.content')?.innerText ?? '',
  terminal: () => document.querySelector('.studio-terminal .xterm-rows')?.textContent ?? '',
  dev: (input) => window.appOps.request('POST', '/development', input),
}; true`;

if (process.versions.electron) {
  const { app, BrowserWindow, dialog } = await import('electron');
  app.setPath('userData', join(process.env.APPOPS_DATA_DIR, 'electron'));
  // 모드 전환 확인창은 승인 결과만 주입한다.
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
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
      const shot = async (name) => {
        await delay(350);
        const image = await win.capturePage();
        await writeFile(join(shots, `${name}.png`), image.toPNG());
      };
      const calls = async (action) => (await js(`return (await __t.dev({ action: 'fixture-calls' })).data`)).filter((c) => c.action === action);
      const nav = async (label) => {
        await js(`__t.click('.nav-item', ${JSON.stringify(label)}); return true`);
        await wait(`document.querySelector('.topbar__title')?.textContent === ${JSON.stringify(label)}`, `${label} 화면`);
      };

      await wait(`!!document.querySelector('.mode-switch--live') && !!document.querySelector('.agent-chat')`, '실제 모드 화면');
      await read(HELPERS);

      // 기존 AI 버튼은 대화 패널만 열고 요청을 실행하지 않는다.
      const agentBefore = (await read(`window.appOps.request('GET', '/agent')`)).data.tasks.length;
      await nav('개발 작업');
      await js(`__t.click('.topbar button', 'AI 요청'); return true`);
      await wait(`!!document.querySelector('.modal .agent-chat')`, 'AI 대화 패널');
      await delay(1600);
      assert.equal((await read(`window.appOps.request('GET', '/agent')`)).data.tasks.length, agentBefore, 'AI 패널을 열어도 작업이 생기지 않음');
      assert.equal(await read(`document.querySelector('.modal textarea').value`), '', '요청 초안 자동 입력 없음');
      await js(`document.querySelector('.modal button[aria-label="닫기"]').click(); return true`);
      pass('AI 요청 버튼은 패널만 열고 자동 실행하지 않음');

      const ids = await js(`return (await __t.dev({ action: 'fixture-projects' })).data`);
      const pick = (label, id) => js(`__t.set('select[aria-label="${label}"]', ${JSON.stringify(id)}); return true`);
      await pick('개발 프로젝트', ids.a);

      // GitHub CLI 연결 검사와 로그인 터미널 종료 후 재검사
      await wait(`__t.text().includes('main') && __t.text().includes('example/fixture')`, 'Git 요약');
      await js(`__t.click('.cli-row button', '연결 검사'); return true`);
      await wait(`!!__t.find('.cli-row .badge', '로그인됨')`, 'GitHub 연결 검사 결과');
      const checksBefore = (await calls('connection-check')).length;
      await js(`__t.click('.cli-row button', '브라우저 로그인'); return true`);
      await wait(`__t.terminal().includes('fixture-login')`, '로그인 터미널 출력');
      await until(async () => (await calls('connection-check')).length > checksBefore, '로그인 종료 후 재검사');
      await js(`__t.click('.studio-terminal button', '패널 닫기'); return true`);
      pass('GitHub CLI 연결 검사·로그인 터미널·종료 후 재검사');
      // 패널을 바로 닫아도 세션 종료를 상태 폴링으로 감지해 한 번만 다시 검사한다.
      const closedBefore = (await calls('connection-check')).length;
      await js(`__t.click('.cli-row button', '브라우저 로그인'); return true`);
      await wait(`!!document.querySelector('.studio-terminal')`, '로그인 터미널 열림');
      await js(`__t.click('.studio-terminal button', '패널 닫기'); return true`);
      await until(async () => (await calls('connection-check')).length > closedBefore, '패널을 닫은 로그인 종료 후 재검사', 12000);
      await delay(4000);
      assert.equal((await calls('connection-check')).length, closedBefore + 1, '종료 후 재검사는 한 번만');
      pass('패널을 닫은 로그인 세션 종료 감지·중복 없는 재검사');
      await shot('01-development-header');

      // 이슈 목록 요청 중 PR 탭으로 바꾸면 늦게 온 이슈 응답이 PR 목록으로 쓰이지 않는다.
      await js(`__t.click('.tab', '이슈'); return true`);
      await js(`__t.click('.card button', '이슈 불러오기'); return true`);
      await js(`__t.click('.tab', 'PR'); return true`);
      await delay(1800);
      assert.equal(await read(`__t.text().includes('Issue fixture three')`), false, '이전 탭의 이슈 응답 무시');
      await wait(`__t.enabled('.card button', 'PR 불러오기')`, 'PR 불러오기 활성');
      await js(`__t.click('.card button', 'PR 불러오기'); return true`);
      await wait(`__t.text().includes('PR fixture seven')`, 'PR 목록');
      await js(`__t.click('.tab', '이슈'); return true`);
      assert.equal(await read(`__t.text().includes('PR fixture seven')`), false, 'PR 목록이 이슈 탭에 남지 않음');
      await js(`__t.click('.tab', 'PR'); return true`);
      await wait(`__t.text().includes('PR fixture seven')`, '같은 종류 탭으로 돌아오면 PR 목록 유지');
      await shot('02-pr-list');
      await js(`__t.click('.item-row button', '가져와서 분석'); return true`);
      await wait(`__t.find('.tab', '가져온 작업')?.getAttribute('aria-selected') === 'true'`, '작업 탭 이동');
      const imports = await calls('import');
      assert.equal(imports.length, 1);
      assert.equal(imports[0].kind, 'pr', 'PR 목록에서 가져오면 kind=pr');
      assert.equal(imports[0].number, 7);
      pass('이슈/PR 탭 전환 중 stale 목록 차단과 올바른 kind 가져오기');

      // terminalId가 늦게 생겨도 상태 폴링으로 패널이 열리고, 닫았다가 다시 열 수 있다.
      assert.equal(await read(`!!document.querySelector('.studio-terminal')`), false, '가져온 직후에는 터미널 없음');
      await wait(`__t.terminal().includes('analysis-log')`, '늦게 생긴 분석 터미널 자동 열기', 15000);
      await js(`__t.click('.studio-terminal button', '패널 닫기'); return true`);
      await delay(2600);
      assert.equal(await read(`!!document.querySelector('.studio-terminal')`), false, '닫은 패널은 다시 자동으로 열리지 않음');
      const running = (await js(`return (await __t.dev({ action: 'state' })).data.terminals`)).filter((t) => t.status === 'running');
      assert.ok(running.some((t) => t.title === '분석 · #7'), '패널을 닫아도 세션 유지');
      await wait(`!!__t.find('.session-chips button', '분석 · #7')`, '실행 중인 세션 칩');
      await js(`__t.click('button', '실행 터미널 열기'); return true`);
      await wait(`__t.terminal().includes('analysis-log')`, '세션 다시 열기');
      await delay(800);
      assert.equal(await read(`__t.terminal().includes('^[[')`), false, '재생한 출력의 장치 질의 응답이 프로그램 입력으로 들어가지 않음');
      pass('비동기 terminalId 자동 열기·패널 닫기(detach)·다시 열기(resume)');
      await shot('03-task-running-terminal');
      await js(`__t.click('.studio-terminal button', '패널 닫기'); return true`);

      // 작업 문서: 원본 요약, 리뷰 구조화, diff 강조
      assert.equal(await read(`__t.enabled('button', '승인하고 커밋')`), false, '분석 중에는 커밋 승인 불가');
      assert.equal(await read(`__t.enabled('button', '중지')`), true, '분석 중에는 중지 가능');
      await js(`__t.click('.tab', '원본'); return true`);
      await wait(`__t.text().includes('댓글 1개')`, '원본 요약');
      assert.equal(await read(`__t.text().includes('"comments"')`), false, '원본 API JSON을 그대로 노출하지 않음');
      await js(`__t.click('.tab', '리뷰'); return true`);
      await wait(`__t.text().includes('보완 필요') && __t.text().includes('오류 처리 누락')`, '리뷰 결과');
      assert.equal(await read(`__t.text().includes('"findings"')`), false, '리뷰 JSON을 그대로 노출하지 않음');
      await js(`__t.click('.tab', '변경사항'); return true`);
      await wait(`!!document.querySelector('.diff-add')`, 'diff 강조');
      await js(`__t.click('.tab', '계획'); return true`);
      await wait(`__t.text().includes('픽스처 계획')`, '계획 문서');
      pass('source/plan/review/diff 문서 표시');

      // 반영 승인: 상태에 따라 활성화되고 승인 플래그를 보낸다.
      await js(`const t = (await __t.dev({ action: 'state' })).data.tasks[0]; await __t.dev({ action: 'fixture-task', id: t.id, status: 'ready' }); return true`);
      await wait(`__t.enabled('button', '승인하고 커밋')`, '검증 통과 뒤 커밋 승인 활성');
      assert.equal(await read(`__t.enabled('button', '승인하고 푸시')`), false);
      await shot('04-task-ready-approval');
      await js(`__t.click('button', '승인하고 커밋'); return true`);
      await wait(`__t.enabled('button', '승인하고 푸시')`, '커밋 뒤 푸시 승인 활성');
      const commits = await calls('commit');
      assert.equal(commits.length, 1);
      assert.equal(commits[0].approved, true);
      assert.equal(await read(`__t.enabled('button', '다시 분석')`), false, '커밋한 작업은 AI 재실행 불가');
      await js(`__t.click('button', '원격 반영 확인'); return true`);
      await wait(`__t.enabled('button', 'Preview 확인') && __t.enabled('button', '승인하고 PR 등록')`, '원격 반영 확인 뒤 푸시 상태');
      await js(`__t.click('button', 'Preview 확인'); return true`);
      await wait(`!!__t.find('.session-chips button', 'Preview · success')`, 'Git 연동 Preview 링크');
      pass('상태별 반영 승인·원격 반영 확인·Preview 확인');
      await js(`__t.click('button', '작업 정리'); return true`);
      await js(`__t.click('button', '정리 확정'); return true`);
      await wait(`__t.text().includes('작업을 정리했습니다') && __t.text().includes('가져온 작업이 없습니다')`, '작업 정리');
      pass('작업 정리 2단계 확인');

      // 백업에서 복원된 작업: 문서는 열람 가능, 실행·반영·diff는 불가
      await js(`await __t.dev({ action: 'fixture-restored' }); return true`);
      await wait(`!!__t.find('.task-pick', 'Restored fixture nine')`, '복원 작업 표시');
      await js(`__t.click('.task-pick', 'Restored fixture nine'); return true`);
      await wait(`__t.text().includes('백업에서 복원된 작업 기록입니다')`, '복원 작업 안내');
      for (const label of ['다시 분석', '다시 구현', '검증만 실행', '승인하고 커밋', '승인하고 푸시', '원격 반영 확인'])
        assert.equal(await read(`__t.enabled('button', ${JSON.stringify(label)})`), false, `복원 작업 ${label} 불가`);
      assert.equal(await read(`__t.find('.tab', '변경사항').disabled`), true, '복원 작업 diff 불가');
      await js(`__t.click('.tab', '계획'); return true`);
      await wait(`__t.text().includes('픽스처 계획')`, '복원 작업 문서 열람');
      await js(`__t.click('.tab', '원본'); return true`);
      await wait(`__t.text().includes('댓글 1개')`, '복원 작업 원본 열람');
      assert.equal(await read(`__t.enabled('button', '작업 정리')`), true, '복원 기록 정리 가능');
      pass('복원 작업 문서 열람 허용·실행/반영/diff 차단');

      // 자동화 설정: autoPreview(Git 연동 Preview 조회)를 표시하고 검증 명령을 보존한다.
      await js(`document.querySelector('details.card summary').click(); return true`);
      assert.equal(await read(`__t.find('label.checkbox-row', 'Git 연동 Preview 결과 조회').querySelector('input').checked`), true, 'autoPreview 표시');
      assert.equal(await read(`__t.text().includes('이 앱이 따로 배포하지는 않습니다')`), true, 'autoPreview 조회 전용 설명');
      await js(`__t.find('label.checkbox-row', '분석 후 자동 구현').querySelector('input').click(); return true`);
      await wait(`__t.text().includes('저장하지 않은 변경')`, '정책 변경 표시');
      assert.equal(await read(`__t.find('label.checkbox-row', '자동 커밋 후 자동 푸시').querySelector('input').disabled`), true, '자동 커밋 없이 자동 푸시 불가');
      await js(`__t.click('button', '자동화 설정 저장'); return true`);
      await wait(`__t.text().includes('자동화 설정을 저장했습니다')`, '정책 저장');
      const policy = await js(`return (await __t.dev({ action: 'policy', projectId: document.querySelector('select[aria-label="개발 프로젝트"]').value })).data`);
      assert.equal(policy.autoImplement, true);
      assert.equal(policy.autoPreview, true, 'autoPreview 보존');
      assert.equal(policy.testCommand, 'npm test', '검증 명령 보존');
      pass('자동화 설정 저장·autoPreview 표시·검증 명령 보존');

      // 프로젝트 전환 경합: A의 늦은 정책·Git 응답이 B 화면에 쓰이거나 B로 저장되지 않는다.
      await js(`await __t.dev({ action: 'fixture-delay', projectId: ${JSON.stringify(ids.a)}, ms: 1500 }); return true`);
      await pick('개발 프로젝트', ids.b);
      await wait(`__t.text().includes('example/second')`, 'B 프로젝트 표시');
      await pick('개발 프로젝트', ids.a);
      await delay(150);
      await pick('개발 프로젝트', ids.b);
      await delay(2500);
      assert.equal(await read(`__t.text().includes('example/second') && !__t.text().includes('example/fixture')`), true, 'A의 늦은 Git 응답 무시');
      await wait(`document.querySelector('details.card input.input')?.value === 'npm run check'`, 'B 정책 표시');
      assert.equal(await read(`__t.find('label.checkbox-row', 'Git 연동 Preview 결과 조회').querySelector('input').checked`), false, 'A의 늦은 정책 응답 무시');
      await js(`__t.find('label.checkbox-row', '검증 통과 시 자동 커밋').querySelector('input').click(); return true`);
      await js(`__t.click('button', '자동화 설정 저장'); return true`);
      await wait(`__t.text().includes('자동화 설정을 저장했습니다')`, 'B 정책 저장');
      const policyA = await js(`return (await __t.dev({ action: 'policy', projectId: ${JSON.stringify(ids.a)} })).data`);
      const policyB = await js(`return (await __t.dev({ action: 'policy', projectId: ${JSON.stringify(ids.b)} })).data`);
      assert.deepEqual([policyB.testCommand, policyB.autoPreview, policyB.autoCommit, policyB.autoImplement], ['npm run check', false, true, false], 'B에는 B 정책만 저장');
      assert.deepEqual([policyA.testCommand, policyA.autoPreview, policyA.autoCommit, policyA.autoImplement], ['npm test', true, false, true], 'A 정책 변경 없음');
      await js(`await __t.dev({ action: 'fixture-delay', projectId: ${JSON.stringify(ids.a)}, ms: 0 }); return true`);
      await pick('개발 프로젝트', ids.a);
      await wait(`__t.text().includes('example/fixture')`, 'A 프로젝트 복귀');
      pass('프로젝트 전환 중 늦은 정책·Git 응답 무효화와 정책 교차 저장 차단');

      // Git 탭: 실제 로컬 Git으로 변경 확인·Stage·커밋, 저장소 선택
      await js(`await __t.dev({ action: 'fixture-touch' }); return true`);
      await js(`__t.click('.tab', 'Git'); return true`);
      await wait(`__t.text().includes('변경 파일 1개')`, 'Git 변경 표시');
      assert.equal(await read(`document.querySelector('select[aria-label="브랜치 전환"]').disabled`), true, '변경이 있으면 브랜치 전환 불가');
      assert.equal(await read(`__t.enabled('button', '스테이징 0개 커밋')`), false, '스테이징 없이 커밋 불가');
      await js(`__t.click('.git-file button', 'Stage'); return true`);
      await wait(`__t.text().includes('스테이징 1개')`, 'Stage');
      await js(`__t.set('input[aria-label="커밋 메시지"]', 'docs: 검증 픽스처 변경'); return true`);
      await js(`__t.click('button', '스테이징 1개 커밋'); return true`);
      await wait(`__t.text().includes('작업 트리가 깨끗합니다')`, '로컬 커밋');
      await js(`__t.click('button', '내 저장소 불러오기'); return true`);
      await wait(`!!document.querySelector('select[aria-label="GitHub 저장소"]')`, '저장소 목록');
      await js(`__t.set('select[aria-label="GitHub 저장소"]', 'example/fixture'); return true`);
      await wait(`!!__t.find('button', 'origin으로 연결')`, '저장소 연결 버튼');
      await shot('05-git-tab');
      pass('Git 상태·Stage·커밋·저장소 선택 UI');

      // 웹 배포: 준비 점검, 승인 배포, 늦게 생기는 배포 터미널, 결과 확인
      await nav('웹 배포');
      await pick('웹 프로젝트', ids.a);
      await wait(`__t.text().includes('연결됨 · 프로젝트 prj_fixture') && __t.text().includes('스냅샷을 배포합니다')`, 'Vercel 준비 점검');

      // 조회가 끝나기 전에는 배포할 수 없고, 프로젝트를 바꾸면 A의 늦은 조회 결과가 B에 쓰이지 않는다.
      await js(`await __t.dev({ action: 'fixture-delay', projectId: ${JSON.stringify(ids.a)}, ms: 1500 }); return true`);
      await pick('웹 프로젝트', ids.b);
      await wait(`__t.text().includes('배포 프로젝트를 먼저 연결하세요')`, 'B 준비 점검');
      await pick('웹 프로젝트', ids.a);
      await delay(300);
      assert.equal(await read(`__t.enabled('button', '승인하고 Preview 배포')`), false, '조회 전 배포 차단');
      assert.equal(await read(`__t.text().includes('배포 준비 상태를 확인하는 중입니다')`), true, '조회 중 안내');
      await pick('웹 프로젝트', ids.b);
      await delay(2500);
      assert.equal(await read(`__t.text().includes('배포 프로젝트를 먼저 연결하세요') && !__t.text().includes('prj_fixture')`), true, 'A의 늦은 inspect 무시');
      assert.equal(await read(`__t.enabled('button', '승인하고 Preview 배포')`), false, 'B는 미연결로 배포 차단');
      await js(`await __t.dev({ action: 'fixture-delay', projectId: ${JSON.stringify(ids.a)}, ms: 0 }); return true`);
      await pick('웹 프로젝트', ids.a);
      await wait(`__t.text().includes('연결됨 · 프로젝트 prj_fixture') && __t.enabled('button', '승인하고 Preview 배포')`, 'A 준비 완료');
      pass('웹 배포 조회 전 차단·프로젝트 전환 중 늦은 inspect/Git 무효화');
      await shot('06-web-deploy-ready');

      const head = (await js(`return (await __t.dev({ action: 'git-state', projectId: ${JSON.stringify(ids.a)} })).data.head`));
      await js(`__t.click('button', '승인하고 Preview 배포'); return true`);
      const deploys = await calls('deploy');
      assert.equal(deploys.length, 1);
      assert.deepEqual([deploys[0].provider, deploys[0].production, deploys[0].approved, deploys[0].expectedHead], ['vercel', false, true, head], 'expectedHead 전달');
      await wait(`__t.terminal().includes('deploy-log')`, '늦게 생긴 배포 터미널 자동 열기', 15000);
      await wait(`__t.enabled('button', '결과 확인')`, '배포 종료 뒤 결과 확인 활성', 15000);
      assert.equal(await read(`__t.enabled('button', '승인하고 Preview 배포')`), false, '미확인 배포가 있으면 새 배포 차단');
      await js(`__t.click('button', '잠금 해제 승인'); return true`);
      await wait(`__t.enabled('button', '승인하고 Preview 배포') && __t.text().includes('사용자 확인 완료')`, '잠금 해제 뒤 배포 가능');
      assert.equal((await calls('web-resolve'))[0].approved, true);
      await js(`__t.click('button', '결과 확인'); return true`);
      await wait(`__t.text().includes('https://fixture-preview.vercel.app') && !!__t.find('button', '사이트 열기')`, '결과 URL 표시');
      pass('웹 배포 준비·승인(expectedHead)·터미널·잠금 해제·결과 확인');

      // 화면 밖에서 HEAD가 바뀌면 서비스가 거부하고, 화면은 새 HEAD로 다시 확인한다.
      const deployRecords = async () => (await js(`return (await __t.dev({ action: 'state' })).data.deployments`)).length;
      const recordsBefore = await deployRecords();
      const newHead = await js(`return (await __t.dev({ action: 'fixture-commit' })).data`);
      await js(`__t.click('button', '승인하고 Preview 배포'); return true`);
      await wait(`__t.text().includes('현재 HEAD가 다릅니다')`, 'HEAD 변경 거부 표시');
      assert.equal((await calls('deploy')).at(-1).expectedHead, head, '이전 화면의 HEAD 전달');
      assert.equal(await deployRecords(), recordsBefore, '거부된 배포는 기록 없음');
      await wait(`__t.text().includes(${JSON.stringify(newHead.slice(0, 8))}) && __t.enabled('button', '승인하고 Preview 배포')`, '새 HEAD로 다시 확인');
      pass('HEAD 변경 시 배포 거부와 재확인');

      // 연결 CLI 패널을 닫아도 종료를 감지해 설정을 한 번만 다시 확인한다.
      await js(`document.querySelector('.studio-terminal') && __t.click('.studio-terminal button', '패널 닫기'); return true`);
      await wait(`!document.querySelector('.studio-terminal')`, '이전 배포 패널 닫기');
      const inspectsBefore = (await calls('web-inspect')).length;
      await js(`__t.click('button', '다시 연결'); return true`);
      await wait(`!!document.querySelector('.studio-terminal')`, '연결 터미널 열림');
      await js(`__t.click('.studio-terminal button', '패널 닫기'); return true`);
      await until(async () => (await calls('web-inspect')).length > inspectsBefore, '패널을 닫은 연결 종료 후 재확인', 12000);
      await delay(4000);
      assert.equal((await calls('web-inspect')).length, inspectsBefore + 1, '종료 후 재확인은 한 번만');
      pass('패널을 닫은 연결 세션 종료 감지·중복 없는 재확인');

      await js(`__t.click('.pill-group button', 'Production'); return true`);
      await wait(`!!__t.find('button', '승인하고 Production 배포')`, 'Production 승인 문구');
      await shot('07-web-deploy-history');

      // Netlify 공개 범위: 공개 폴더를 정할 수 없으면(publicationError) 배포 차단
      await js(`__t.click('.pill-group button', 'Netlify'); return true`);
      await wait(`__t.text().includes('사이트 site_fixture') && __t.enabled('button', '승인하고 Production 배포')`, 'Netlify 연결·배포 가능');
      await js(`await __t.dev({ action: 'fixture-publication', projectId: ${JSON.stringify(ids.a)}, on: true }); __t.click('button', '다시 확인'); return true`);
      await wait(`__t.text().includes('server.js와 문서가 함께 있어') && __t.text().includes('공개할 폴더를 정할 수 없습니다')`, 'Netlify 공개 범위 안내');
      assert.equal(await read(`__t.enabled('button', '승인하고 Production 배포')`), false, '공개 범위 오류 시 Netlify 배포 차단');
      await shot('10-netlify-publication-blocked');
      await js(`__t.click('.pill-group button', 'Vercel'); return true`);
      await wait(`__t.enabled('button', '승인하고 Production 배포')`, 'Vercel은 공개 범위 오류와 무관');
      await js(`await __t.dev({ action: 'fixture-publication', projectId: ${JSON.stringify(ids.a)}, on: false }); return true`);
      pass('Netlify 공개 범위 오류 차단·서비스별 안내');

      // AI 설정: datalist 중복 없음, 용도별 선택·해제, 모델 목록, 모델 비우기
      await nav('설정');
      await wait(`!!document.querySelector('select[aria-label="기본 AI CLI"]')`, 'AI 설정');
      // 용도 순서: 분석·문서, 코딩, 리뷰, 운영 대화
      const coding = `document.querySelectorAll('.purpose-grid input[type=checkbox]')[1]`;
      await js(`${coding}.click(); return true`);
      await wait(`!!document.querySelector('select[aria-label="코딩 AI CLI"]')`, '용도별 선택 열기');
      await js(`__t.set('select[aria-label="기본 AI CLI"]', 'codex'); return true`);
      await js(`__t.set('select[aria-label="코딩 AI CLI"]', 'codex'); return true`);
      await wait(`document.querySelectorAll('.choice-picker button').length >= 2`, '모델 목록 버튼');
      await js(`document.querySelectorAll('.choice-picker button')[1].click(); return true`);
      await wait(`__t.text().includes('모델 2개를 불러왔습니다')`, '모델 목록 메시지');
      const lists = await read(`(() => { const ids = [...document.querySelectorAll('datalist')].map(d => d.id); const input = document.querySelector('input[aria-label="코딩 모델"]'); return { ids, options: input.list?.options.length ?? 0, base: document.querySelector('input[aria-label="기본 모델"]').list?.id, coding: input.list?.id }; })()`);
      assert.equal(new Set(lists.ids).size, lists.ids.length, 'datalist id 중복 없음');
      assert.equal(lists.options, 2, '코딩 모델 후보');
      assert.equal(lists.base, lists.coding, '같은 CLI는 같은 목록 공유');
      await js(`__t.set('input[aria-label="코딩 모델"]', 'gpt-fixture-a'); return true`);
      await js(`__t.set('input[aria-label="기본 모델"]', 'gpt-fixture-b'); return true`);
      await js(`__t.click('button', 'AI 설정 저장'); return true`);
      await wait(`__t.text().includes('AI 설정을 저장했습니다')`, 'AI 설정 저장');
      await read(`document.querySelector('select[aria-label="기본 AI CLI"]').scrollIntoView({ block: 'center' }); true`);
      await shot('08-ai-settings');
      let settings = (await read(`window.appOps.request('GET', '/agent')`)).data.settings;
      assert.deepEqual(settings.purposes.coding, { provider: 'codex', model: 'gpt-fixture-a' });
      assert.equal(settings.model, 'gpt-fixture-b');
      await js(`${coding}.click(); return true`);
      await js(`__t.set('input[aria-label="기본 모델"]', ''); return true`);
      await wait(`!document.querySelector('select[aria-label="코딩 AI CLI"]')`, '용도별 선택 해제');
      await js(`__t.click('button', 'AI 설정 저장'); return true`);
      settings = await until(async () => {
        const value = (await read(`window.appOps.request('GET', '/agent')`)).data.settings;
        return value.purposes?.coding === undefined ? value : null;
      }, '용도별 선택 해제 저장');
      assert.equal(settings.model, undefined, '비운 모델 제거');
      pass('AI 설정 datalist·용도별 선택/해제·모델 목록·모델 비우기');

      // 데모: 외부 작업 없이 화면만 표시
      const liveCalls = (await js(`return (await __t.dev({ action: 'fixture-calls' })).data`)).length;
      await writeFile(join(process.env.APPOPS_DATA_DIR, 'live-calls.json'), JSON.stringify(liveCalls));
      await read(`document.querySelector('.mode-switch__toggle button:nth-child(1)').click(); true`);
      await wait(`!!document.querySelector('.mode-switch--demo')`, '데모 전환', 15000);
      await read(HELPERS);
      await nav('개발 작업');
      await wait(`__t.text().includes('데모에서는 화면만 둘러볼 수 있습니다')`, '데모 안내');
      const demoDisabled = await read(`[...document.querySelectorAll('.content button')].filter(b => /불러오기|로그인|연결 검사|가져와서/.test(b.textContent)).every(b => b.disabled)`);
      assert.equal(demoDisabled, true, '데모에서 외부 작업 버튼 비활성');
      await shot('09-demo-development');
      await nav('웹 배포');
      await wait(`!!__t.find('button', '승인하고 Preview 배포')`, '데모 웹 배포');
      assert.equal(await read(`__t.enabled('button', '승인하고 Preview 배포')`), false);
      // 데모 화면의 요청은 전용 데모 서비스가 처리한다. 실제 서비스 호출이 늘지 않았는지는 부모가 확인한다.
      pass('데모 모드 외부 작업 버튼 비활성');
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
  const { AppError } = await import('../dist/packages/domain/errors.js');
  const directory = await mkdtemp(join(tmpdir(), 'appops-dev-ui-'));
  const fixture = await mkdtemp(join(tmpdir(), 'appops-dev-fixture-'));
  // 프로젝트 전환 경합을 검사할 두 번째 프로젝트(배포 연결 없음, 다른 원격·정책).
  const second = await mkdtemp(join(tmpdir(), 'appops-dev-second-'));
  await mkdir(shots, { recursive: true });
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
  const git = (...args) => gitIn(fixture, ...args);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'fixture-web', private: true, scripts: { build: 'vite build', test: 'node -e 0' }, devDependencies: { vite: '8.0.0' } }, null, 2));
  await writeFile(join(fixture, 'index.html'), '<!doctype html><title>fixture</title>\n');
  await writeFile(join(fixture, '.gitignore'), '.vercel\n.netlify\n');
  await mkdir(join(fixture, '.vercel'));
  await writeFile(join(fixture, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_fixture', orgId: 'team_fixture', projectName: 'fixture-web' }));
  await mkdir(join(fixture, '.netlify'));
  await writeFile(join(fixture, '.netlify', 'state.json'), JSON.stringify({ siteId: 'site_fixture' }));
  await writeFile(join(second, 'index.html'), '<!doctype html><title>second</title>\n');
  for (const [cwd, remote] of [[fixture, 'example/fixture'], [second, 'example/second']]) {
    gitIn(cwd, 'init', '-b', 'main');
    gitIn(cwd, 'config', 'user.name', 'Fixture');
    gitIn(cwd, 'config', 'user.email', 'fixture@example.invalid');
    gitIn(cwd, 'add', '-A');
    gitIn(cwd, 'commit', '-m', 'init');
    gitIn(cwd, 'remote', 'add', 'origin', `https://github.com/${remote}.git`);
  }
  await writeFile(join(directory, 'desktop-mode.json'), JSON.stringify({ mode: 'live' }));

  let controller;
  let demoCallsAfter = 0;
  try {
    controller = await startController({ directory, port: 0, scanToolchains: async () => [] });
    const service = controller.service;
    const dev = service.development;
    const project = await service.addProject({ path: fixture });
    const secondProject = await service.addProject({ path: second });
    dev.tasks.savePolicy(project.id, { autoImplement: false, autoCommit: false, autoPush: false, autoPr: false, autoPreview: true, testCommand: 'npm test' });
    dev.tasks.savePolicy(secondProject.id, { autoImplement: false, autoCommit: false, autoPush: false, autoPr: false, autoPreview: false, testCommand: 'npm run check' });
    // 늦은 응답 주입(프로젝트별 지연)과 Netlify 공개 범위 오류 주입. root의 web-inspect 계약(publicationError)을 흉내 낸다.
    const delays = new Map();
    const publication = new Set();

    const calls = [];
    const now = () => new Date().toISOString();
    const blocked = () => { throw new AppError('VERIFY_EXTERNAL_BLOCKED', '검증에서는 외부 원격 작업을 실행하지 않습니다.'); };
    const local = (title, script) => dev.terminals.open(title, fixture, '/bin/sh', ['-c', script]);
    const item = (number, title, kind) => ({ number, title, body: `${title} 본문`, url: `https://github.com/example/fixture/${kind === 'pr' ? 'pull' : 'issues'}/${number}`, state: 'open', updated_at: now(), user: { login: 'alice' } });
    const putTask = (task) => { service.store.put('development-task', task.id, { ...task, updatedAt: now() }); return service.store.get('development-task', task.id); };
    const putDeploy = (value) => { service.store.put('web-deployment', value.id, value); return value; };
    const source = '# PR fixture seven\n\n원본: https://github.com/example/fixture/pull/7\n\n본문\n\n## 댓글·리뷰·변경 파일\n\n```json\n' +
      JSON.stringify({ comments: [[{ user: { login: 'bob' }, body: '확인 부탁드립니다.' }]], reviews: [], files: [[{ filename: 'src/app.ts', additions: 3, deletions: 1 }]] }, null, 2) + '\n```\n';
    const passthrough = new Set(['state', 'connections', 'terminal-read', 'terminal-input', 'terminal-resize', 'terminal-stop', 'git-state', 'git-diff', 'git-stage', 'git-unstage', 'git-commit', 'git-branch', 'git-init', 'git-remote', 'policy', 'policy-save', 'web-inspect']);
    const original = dev.action.bind(dev);
    dev.action = async (input) => {
      const action = input?.action;
      if (action !== 'fixture-calls' && !action?.startsWith('terminal-') && action !== 'state') calls.push({ ...input });
      if (action === 'fixture-calls') return calls;
      if (action === 'fixture-projects') return { a: project.id, b: secondProject.id };
      if (action === 'fixture-delay') { delays.set(input.projectId, input.ms); return true; }
      if (action === 'fixture-publication') { if (input.on) publication.add(input.projectId); else publication.delete(input.projectId); return true; }
      if (action === 'fixture-commit') { await writeFile(join(fixture, 'CHANGELOG.md'), `변경 ${Date.now()}\n`); git('add', '-A'); git('commit', '-m', 'chore: 화면 밖 커밋'); return git('rev-parse', 'HEAD').trim(); }
      if (action === 'fixture-restored') return putTask({ id: 'task-restored', projectId: project.id, repository: 'example/fixture', number: 9, kind: 'issue', title: 'Restored fixture nine', url: 'https://github.com/example/fixture/issues/9', worktree: join(fixture, 'missing-worktree'), branch: 'appops/issue-9-restored', base: 'abc1234567890', sourceSha: 'abc1234567890', documentPath: 'dev/active/fixture', status: 'failed', provider: 'codex', restored: true, message: '복원한 기록입니다.', createdAt: now() });
      if (['policy', 'git-state', 'web-inspect'].includes(action) && delays.get(input.projectId)) await delay(delays.get(input.projectId));
      if (action === 'web-inspect' && publication.has(input.projectId)) return { ...(await original(input)), output: '.', publicationError: '프로젝트 루트에 server.js와 문서가 함께 있어 공개할 파일을 정할 수 없습니다.' };
      if (action === 'fixture-touch') { await writeFile(join(fixture, 'NOTES.md'), `변경 ${Date.now()}\n`); return true; }
      if (action === 'fixture-task') return putTask({ ...service.store.get('development-task', input.id), status: input.status, verifiedFingerprint: 'fixture', verifiedCommand: 'npm test' });
      if (action === 'state') {
        const state = await original(input);
        state.connections = state.connections.map((c) => ['github', 'netlify', 'vercel'].includes(c.tool) && !c.executable ? { ...c, executable: `/fixture/bin/${c.tool}`, status: 'unchecked', message: '설치됨 · 연결 검사를 실행하세요.' } : c);
        return state;
      }
      if (action === 'git-diff' && input.id) return { diff: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n' };
      if (passthrough.has(action)) return original(input);
      switch (action) {
        case 'connection-check': return { tool: input.tool, executable: `/fixture/bin/${input.tool}`, status: 'connected', message: 'CLI 인증 검사를 통과했습니다. (검증 픽스처)' };
        // 패널을 닫은 뒤 끝나도록 잠시 실행한다.
        case 'login': case 'install': case 'logout': return local(`${input.tool} 로그인`, 'echo fixture-login; sleep 1.5');
        case 'web-link': return local(`${input.provider} 프로젝트 연결`, 'echo fixture-link; sleep 1.5');
        case 'models': return ['gpt-fixture-a', 'gpt-fixture-b'];
        case 'repositories': return [{ full_name: 'example/fixture', private: false }, { full_name: 'example/other', private: true }];
        case 'items':
          if (input.kind === 'issue') { await delay(1200); return { items: [item(3, 'Issue fixture three', 'issue')], hasMore: false, page: 1 }; }
          return { items: [item(7, 'PR fixture seven', 'pr')], hasMore: false, page: 1 };
        case 'import': {
          const task = putTask({ id: `task-${input.number}`, projectId: input.projectId, repository: 'example/fixture', number: input.number, kind: input.kind, forkPr: false, title: input.kind === 'pr' ? 'PR fixture seven' : 'Issue fixture three', url: `https://github.com/example/fixture/pull/${input.number}`, worktree: fixture, branch: `appops/${input.kind}-${input.number}-fixture`, base: 'abc1234567890', sourceSha: 'abc1234567890', documentPath: 'dev/active/fixture', status: 'analyzing', provider: 'codex', message: '격리된 CLI에서 작업 중입니다.', createdAt: now() });
          // 실제 백엔드처럼 터미널 id를 응답 뒤에 기록한다.
          setTimeout(async () => { const session = await local('분석 · #7', 'echo analysis-log; sleep 120'); putTask({ ...service.store.get('development-task', task.id), terminalId: session.id }); }, 1500);
          return task;
        }
        case 'document':
          if (input.name === 'source') return { text: source };
          if (input.name === 'review.json') return { text: JSON.stringify({ passed: false, findings: ['src/app.ts: 오류 처리 누락'] }) };
          return { text: `# ${input.name}\n\n픽스처 계획 문서입니다.` };
        case 'commit': return putTask({ ...service.store.get('development-task', input.id), status: 'committed', commitSha: 'def4567890abcdef', message: '검증한 변경을 커밋했습니다.' });
        case 'cancel': return putTask({ ...service.store.get('development-task', input.id), status: 'cancelled' });
        case 'reconcile-push': return putTask({ ...service.store.get('development-task', input.id), status: 'pushed', message: '원격 커밋을 확인했습니다.' });
        case 'preview-check': {
          const previews = [{ environment: 'Preview', state: 'success', url: 'https://fixture-git.vercel.app' }];
          putTask({ ...service.store.get('development-task', input.id), previews, message: 'Git 연동 Preview 결과를 확인했습니다.' });
          return { previews };
        }
        case 'cleanup': {
          const task = service.store.get('development-task', input.id);
          service.store.remove('development-task', input.id);
          return { cleaned: true, branch: task.branch };
        }
        case 'web-resolve': return putDeploy({ ...service.store.get('web-deployment', input.id), resolved: true });
        case 'analyze': case 'implement': case 'verify': case 'push': case 'pr':
          return service.store.get('development-task', input.id);
        case 'deploy': {
          const head = git('rev-parse', 'HEAD').trim();
          // root 백엔드 계약: 화면에서 확인한 HEAD(expectedHead)가 현재 HEAD와 다르면 거부한다.
          if (!input.expectedHead) throw new AppError('EXPECTED_HEAD_REQUIRED', '배포할 커밋을 확인하세요.');
          if (input.expectedHead !== head) throw new AppError('DEPLOY_HEAD_CHANGED', '화면에서 확인한 커밋과 현재 HEAD가 다릅니다. 다시 확인한 뒤 배포하세요.');
          const record = putDeploy({ id: `deploy-${calls.length}`, projectId: input.projectId, provider: input.provider, production: input.production === true, sourceSha: head, status: 'running', terminalId: '', message: '커밋한 소스로 배포를 준비합니다.', createdAt: now() });
          setTimeout(async () => {
            const session = await local(`${input.provider} Preview 배포`, 'echo deploy-log; sleep 1.5');
            putDeploy({ ...record, terminalId: session.id, dispatched: true, message: '배포 서비스에서 처리 중입니다.' });
            await dev.terminals.wait(session.id);
            putDeploy({ ...record, terminalId: session.id, dispatched: true, status: 'action_required', message: '배포 URL 확인이 필요합니다.' });
          }, 1200);
          return record;
        }
        case 'web-check': {
          const value = service.store.get('web-deployment', input.id);
          return putDeploy({ ...value, url: 'https://fixture-preview.vercel.app', status: 'succeeded', message: '공급자 완료 상태와 사이트 응답을 확인했습니다.' });
        }
        default: return blocked();
      }
    };

    const child = spawn(electron, [fileURLToPath(import.meta.url)], {
      cwd: root, stdio: 'inherit',
      env: { ...process.env, APPOPS_DATA_DIR: directory, APPOPS_DEV_SERVER_URL: '', APPOPS_API_URL: '' },
    });
    const callsBeforeExit = () => calls.length;
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? 1));
      });
    } finally { clearTimeout(timer); }
    if (process.exitCode === 0) {
      demoCallsAfter = callsBeforeExit();
      const liveCalls = JSON.parse(await readFile(join(directory, 'live-calls.json'), 'utf8'));
      assert.equal(demoCallsAfter, liveCalls, '데모 전환 뒤 실제 서비스 개발 action 호출 없음');
      const external = calls.filter((c) => ['git-fetch', 'git-pull', 'git-push', 'git-clone'].includes(c.action));
      assert.equal(external.length, 0, '원격 Git 작업 호출 없음');
      console.log(`PASS 데모 전환 뒤 실제 서비스 호출 0건 (실제 모드 기록 ${liveCalls}건, 외부 작업은 모두 픽스처)`);
    }
  } finally {
    await controller?.close();
    await rm(directory, { recursive: true, force: true });
    await rm(directory + '.demo', { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
}
