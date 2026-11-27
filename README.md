# 🕹️ Jolt Physics UFO Catcher 3D (C++ → WebAssembly)

**Jolt Physics (`jolt-physics` v1.1.2, C++ → WebAssembly)** + **Three.js** + **React / Vite**로 구현한 **13종 3D 아케이드 UFO 크레인 물리 시뮬레이터**입니다.  
피규어 박스 8종의 **하시와타시(4-Bar 브릿지)** 방식과 3D 입체 인형 5종의 **클래식 산더미 인형뽑기(WIN 구멍 운반)** 방식을 120Hz `EMotionQuality_LinearCast` (CCD) 강체 물리로 구현했으며, [Rapier3D 버전](https://github.com/SilverRuler/Rapier3D)과 1:1 비교가 가능합니다.

---

## ✨ 핵심 물리 & 게임플레이 아키텍처

- **가짜 잡기(`Constraint`) 제거 → 100% 실제 관절 물리**:
  - `Kinematic Gantry` ↔ **`SixDOFConstraint`** (케이블 스웨이 + 하강 최대 힘 제한 + 승강 윈치) ↔ `Dynamic UFO Head`
  - `Dynamic UFO Head` ↔ **2× `HingeConstraint`** (토크 제한 모터 + 유연한 하강 힌지) ↔ `2× Dynamic 3-세그먼트 연장 <> 곡면 집게 암`
  - `OffsetCenterOfMassShapeSettings`를 이용한 내부 편심 무게중심 + 상단 안정화 후 완전 개방 수직 낙하
- **듀얼 아케이드 모드 (총 13개 독립 뽑기판)**:
  - **📦 피규어 박스 8종 (하시와타시 4-Bar)**: 크롬 Bar(`0.28μ`)와 돌출된 빨간 실리콘 링(`1.19μ`) 별도 콜라이더 + 기계별 맞춤 4-Bar 간격·높이
  - **🧸 3D 입체 인형 5종 (클래식 산더미 인형뽑기)**: `#2 마린`, `#5 타야마`, `#8 미쿠`, `#11 산드로네`, `#13 마키마` — 같은 3D 인형 **36개**를 바닥부터 높은 ㄱ자 외벽(`1.55m`)까지 5단 산더미로 꽉 채우고, **4방향 집게(10 N·m)**로 인형을 집어 올린 채 **`carrying` 단계**에서 좌측 하단(초기 위치) 아크릴 가드 너머 **WIN 구멍** 위로 운반해 떨어뜨리면 당첨
- **13종 뽑기판별 고유 물리 프로필 (`MACHINE_PROFILES`)**:
  - `#1 페른`을 기준 기본값으로 두고 나머지 12개 뽑기판의 **4-Bar 간격, 크레인 헤드 크기, 집게 길이/두께, 닫힘·유지 토크, 팁 마찰**을 난이도에 맞춰 개별 설정
- **편의성 · 관전 · 샌드박스**:
  - **실시간 관전(LIVE)**, **뽑기판별 독립 최근 상황 로그**, **`[선택]` / `[랜덤]`** 빠른 이동, **`[뽑기정보]`** 13종 제원 모달
  - PC 뽑기 시작 시 스크롤 간섭을 막는 **확대 집중 모드** + 모든 팝업 **`Enter`/`Esc`** 단축키
  - `VITE_APP_MODE=sandbox` 빌드 시 토크/누르기 힘/마찰/무게/슬로우모션(`0.5x`)/콜라이더 와이어프레임 실시간 튜닝 지원

---

## 🚀 로컬 실행 및 빌드

```bash
npm install
npm run dev                        # 프로덕션 UI 개발 서버 (http://localhost:4000)
npm run build                      # TypeScript 체크 + 프로덕션 dist/ 빌드
VITE_APP_MODE=sandbox npm run build # 물리 테스트 샌드박스 dist/ 빌드
```
