# 수익·광고비 지표

Last Updated: 2026-09-11

[작업 목록](../dev/active/app-operations-platform/app-operations-platform-tasks.md) · [연동 기능표](integration-capabilities.md)

금액은 문자열 정수 마이크로 단위(1 통화 단위=1,000,000)로 저장하고 BigInt로 합산한다. 날짜·통화·앱·원천을 보존한다. 통화를 섞거나 임의 환산하지 않고 미수집은 미수집으로 표시한다.

| 원천 | 기준 |
|---|---|
| Play earnings | Merchant Currency의 부호 있는 수수료·환불·조정 포함 proceeds |
| Apple Sales Reports | 개발자 proceeds, 통화·환불 부호 보존 |
| Steam Financial | net_sales_usd 기반 proceeds, 총매출·반환액은 보고 요약에서 구분 |
| MAX / AdMob | estimated revenue, 확정 입금과 구분 |
| Google Ads / AppLovin Ads | 원천 통화 spend |

contribution은 수집된 수익−광고비이고 회사 전체 순이익이나 캠페인 ROAS가 아니다. 원천 기간이 다를 수 있다. 코호트·귀속 기간을 맞춘 ROAS는 후속 구현이다.

앱 식별자가 등록 프로젝트와 유일하게 일치할 때만 매핑한다. 계정 전체 보고를 화면에서 선택한 프로젝트에 일괄 귀속하지 않는다. 식별자 없는 보고는 전체 합계에만 사용한다.

Google Ads의 여러 캠페인 행은 같은 앱·날짜별 광고비로 먼저 BigInt 합산한 뒤 저장한다. AdMob의 SDK 앱 ID는 앱 목록의 `linkedAppInfo.appStoreId`로 Android 패키지에 연결한다. iOS 숫자 스토어 ID·미연결 앱은 bundle ID로 추측하지 않으며 원래 SDK ID를 원천 메타데이터에 보존한다.

원천·연결·날짜·통화·종류로 upsert한다. Play는 최근 완료된 3개월을 재수집하고 성공한 월을 원자적으로 교체해 삭제·정정 행을 반영한다. ZIP/CSV 한도를 검사하며 주문 ID·구매자 자료는 저장하지 않는다. 다른 공급자의 조회 기간 밖 정정·삭제 행 완전 반영은 미검증이다.

같은 앱/일자의 MAX와 AdMob 수익이 겹치면 AdMob을 합계에서 제외하고 주의를 표시한다. 앱 식별자가 없으면 같은 일자·통화의 중복 가능성도 보수적으로 제외한다. MAX 밖 AdMob 수익이 빠질 수 있으므로 전체 확정값이 아니다. 앱/광고 단위별 원천 선택·정산 대조는 후속 작업이다.

Play 보고서의 경로·필드·권한은 [Google 공식 안내](https://support.google.com/googleplay/android-developer/answer/6135870?hl=en)를 따른다. 비공개 버킷과 재무 권한, devstorage.read_only 범위가 필요하다. 상품 가격을 매출로 계산하지 않는다.
