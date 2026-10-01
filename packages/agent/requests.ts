import type { AgentScreen } from './types.js';

// 화면은 대화 맥락이다. 화면 이름으로 사용자 요청이나 실행 지시를 만들지 않는다.
export const SCREEN_REQUESTS: Record<AgentScreen, { label: string }> = {
  agent: { label: 'AI 운영' },
  dashboard: { label: '대시보드' },
  projects: { label: '프로젝트' },
  setup: { label: '운영 준비' },
  connections: { label: '계정 연결' },
  releases: { label: '스토어 배포' },
  marketing: { label: '마케팅' },
  monetization: { label: '수익화' },
  community: { label: '커뮤니티' },
  operations: { label: '운영·복구' },
  history: { label: '이력' },
  settings: { label: '설정' },
  development: { label: '개발 작업' },
  'web-deployments': { label: '웹 배포' },
  growth: { label: '성장 운영' },
};
