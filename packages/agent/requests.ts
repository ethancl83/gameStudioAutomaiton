import type { AgentScreen } from './types.js';

/** A button is an explicit, bounded request. Merely viewing the screen never submits it. */
export const SCREEN_REQUESTS: Record<AgentScreen, { label: string; message: string }> = {
  agent: { label: '현재 상태 분석', message: '현재 상태와 이전 작업을 확인하고 필요한 다음 작업을 정리해 줘.' },
  dashboard: { label: '운영 현황 분석', message: '현재 운영 현황과 조치가 필요한 항목을 분석하고 우선순위를 정리해 줘.' },
  projects: { label: '프로젝트 분석·등록 준비', message: '선택한 프로젝트를 분석해서 스토어 소개 문구와 이미지를 준비하고, 기존 계정을 활용해 스토어 등록을 진행해 줘. 로그인 등 꼭 필요한 때만 요청해 줘. 프로젝트가 선택되지 않았다면 목록을 분석하고 대상부터 확인해 줘.' },
  setup: { label: '운영 준비 점검', message: '선택한 프로젝트의 운영 준비 상태를 점검하고, 기존 설정과 연결로 해결 가능한 스토어 설정을 진행해 줘. 엔진 설치나 프로젝트 수정은 별도 요청이 필요해.' },
  connections: { label: '계정 연결 점검', message: '현재 화면의 계정 연결 상태를 확인하고 기존 인증과 설정으로 해결해 줘. 로그인 등 직접 해야 하는 단계만 요청해 줘.' },
  releases: { label: '스토어 등록 준비', message: '선택한 프로젝트의 스토어 등록 상태를 확인하고 부족한 소개 문구와 이미지를 준비해 등록을 진행해 줘. 심사 제출과 공개는 포함하지 않아.' },
  marketing: { label: '광고 성과 분석', message: '현재 광고 데이터로 성과와 A/B 실험 후보를 분석해 줘. 비용이나 표본이 부족하면 근거를 밝혀 줘. 광고 집행과 주기적 실험은 2차 기획 범위이므로 실행하지 마.' },
  monetization: { label: '수익률 분석', message: '현재 수익화 데이터와 광고비를 함께 분석해서 수익률 개선안을 작성해 줘. 실제 가격·예산 변경과 반복 실험은 2차 기획 범위야.' },
  community: { label: '피드백·이슈 분석', message: '현재 수집된 커뮤니티 피드백을 분석하고 고객응대 초안과 이슈 목록을 정리해 줘. 게시·답글 전송과 계정 자동관리는 2차 기획 범위이므로 실행하지 마.' },
  operations: { label: '운영 문제 점검', message: '현재 작업·러너·오류 상태를 분석하고 원인과 복구 방법을 정리해 줘. 백업 복원이나 데이터 삭제는 실행하지 마.' },
  history: { label: '작업 이력 분석', message: '현재 화면 범위의 작업 이력을 분석해 실패·미확정 변경과 다음 조치를 정리해 줘. 외부 작업을 임의로 재실행하지 마.' },
  settings: { label: '환경·정책 점검', message: '현재 환경과 프로젝트 정책을 점검하고 설정 충돌이나 누락을 정리해 줘. 정책 변경은 실행하지 마.' },
};
