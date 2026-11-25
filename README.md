# 🕹️ Jolt Physics UFO Catcher 3D

**Jolt Physics (`jolt-physics` v1.1.2, C++ → WebAssembly)** + **Three.js** + **React / Vite**로 구현한 실제 아케이드 방식의 3D UFO 브릿지 크레인(2-Bar 하시와타시) 물리 시뮬레이터입니다.

## ✨ 핵심 물리 아키텍처
- **가짜 잡기(`Constraint`) 제거 → 100% 실제 관절 물리**:
  - Kinematic Gantry ↔ **`SixDOFConstraint`** (케이블 스웨이 + 하강 최대 힘 제한 + 승강 윈치) ↔ Dynamic UFO Head
  - Dynamic UFO Head ↔ **2× `HingeConstraint`** (토크 제한 모터 + 유연한 하강 힌지) ↔ 2× Dynamic 3-세그먼트 곡면 집게 암
- **실제 오락실 마찰·무게중심 분리**:
  - 크롬 금속 Bar(`0.28μ`)와 돌출된 빨간 실리콘 링(`0.76μ`)을 별도 물리 콜라이더로 분리
  - `OffsetCenterOfMassShapeSettings`를 이용한 피규어 박스 내부 편심 무게중심 구현
  - `EMotionQuality_LinearCast` (CCD) + 120Hz 서브스텝으로 관통·튀어오름 방지
- **6종 개별 뽑기판**: 프리렌 #1 · 네즈코 #2 · 노엘 실바 #3 · 레제 #4 · 바니카 #5(정사각) · 산드로네 #6(3D 입체 다이컷 쿠션 인형 + 4파츠 복합 콜라이더)
- **특수 연출 & 실시간 물리 튜닝**:
  - 초기 원위치 정중앙 리프트 시 **`⚖️ Balance Catch!`** + 효과음 / 이후 중앙 빨간 Bar 근처 리프트 시 **`⚡ 극한 드르륵! ⚡`** + 효과음
  - 집게 닫힘/리프트 토크, 하강 누르기 힘, 실리콘 링 마찰, 무게 배율, 슬로우모션(`0.5x`), 콜라이더 와이어프레임 디버그 실시간 조절 지원

## 🚀 로컬 실행 및 빌드

```bash
npm install
npm run dev      # http://localhost:4000
npm run build    # TypeScript 체크 + dist/ 정적 빌드
```
