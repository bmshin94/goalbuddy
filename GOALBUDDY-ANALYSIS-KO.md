# GoalBuddy 분석 및 활용 정리 (한국어)

> 작성일: 2026-09-18
> 대상 버전: GoalBuddy `0.4.3` (MIT)

## 관련 링크

- 원본 저장소: https://github.com/tolimarchuk/goalbuddy
- 현재 작업 저장소(포크): https://github.com/bmshin94/goalbuddy
- npm 패키지: https://www.npmjs.com/package/goalbuddy
- 공식 사이트: https://goalbuddy.dev
- 릴리스 노트: https://github.com/tolimarchuk/goalbuddy/releases/tag/v0.4.3
- 영수증 규격: [docs/spec/receipt-v1.md](docs/spec/receipt-v1.md)
- 릴리스 프로세스: [docs/releases/README.md](docs/releases/README.md)

---

## 1. GoalBuddy는 무엇인가

GoalBuddy는 **AI 코딩 에이전트(OpenAI Codex / Claude Code)가 길고 광범위한 작업에서 방향을 잃지 않도록 잡아주는 목표 운영 루프**다.
npm 패키지로 배포되며, 설치하면 각 하네스(harness)에 스킬 + 서브에이전트 + 슬래시 커맨드를 얹는다.

### 해결하는 문제

| 기존 문제 | GoalBuddy의 대응 |
| --- | --- |
| 세션이 끊기면 진행 상황이 사라짐 | 계획과 상태를 레포 안 `state.yaml` 파일로 영속화 |
| 절반만 하고 "완료" 선언 | Judge 감사 + `full_outcome_complete: true` 없이는 완료 불가 |
| 지시 안 한 파일까지 수정 | Worker는 `allowed_files` 밖을 못 건드리고 git으로 기계 검증 |
| 검증 없이 끝냄 | 각 태스크의 `verify` 명령 실행 + 영수증(receipt) 필수 |
| 하네스를 바꾸면 처음부터 | 보드가 레포에 있으므로 Codex ↔ Claude Code 이어가기 가능 |

### 핵심 불변식

```text
Intent -> Oracle -> Surface -> Loop -> Proof
의도   -> 판정기준 -> 작업판  -> 루프 -> 증거
```

- **Oracle(오라클)**: 원래의 결과가 실제로 참이 되었는지 알려주는 관측 가능한 신호.
  테스트 스위트, 브라우저 워크스루, 데모 기록, 산출물, 벤치마크, 근거 기반 답변, 릴리스 체크, 최종 사람 결정 등.
- 저장소 문구: **"No oracle, no serious goal."** (오라클 없으면 진지한 목표가 아니다)
- **"Safe does not mean small. Safe means bounded, explicit, verified, and reversible."**
  → 작게 쪼개는 게 아니라 **가장 크고 안전한 슬라이스(largest safe useful slice)** 를 고르는 것이 목표.

---

## 2. 저장소 구조 분석

| 경로 | 역할 |
| --- | --- |
| `goalbuddy/SKILL.md` (24KB) | `goal-prep` 스킬 본문. 인테이크 컴파일러, 보드 규약, 금지사항 |
| `goalbuddy/references/goal-execution.md` (24KB) | 실행(`/goalbuddy`, `/goal`) 계약서 |
| `goalbuddy/agents/goal_*.toml` | Codex용 에이전트 정의 (scout / worker / judge) |
| `plugins/goalbuddy/agents/goal-*.md` | Claude Code용 서브에이전트 정의 |
| `plugins/goalbuddy/commands/goalbuddy.md` | Claude Code `/goalbuddy` 슬래시 커맨드 |
| `goalbuddy/templates/` | `state.yaml`, `goal.md`, `note.md`, `agents.md` 원본 템플릿 |
| `goalbuddy/scripts/` | 실행 엔진 스크립트 모음 (아래 표) |
| `goalbuddy/surfaces/local-goal-board/` | 의존성 0 로컬 웹 보드 서버 + 뷰어 (약 3,100줄) |
| `internal/cli/goal-maker.mjs` (59KB) | `npx goalbuddy` 설치/진단/보드/디스패치 CLI |
| `internal/test/`, `.github/workflows/` | 테스트 및 CI (Node 18 / 24), npm trusted publishing |
| `.claude-plugin/`, `.agents/plugins/` | Claude / Codex 플러그인 마켓플레이스 등록 파일 |
| `docs/spec/receipt-v1.md` | 하네스 중립 영수증·태스크 카드 규격 (v1, stable) |

### 주요 스크립트

| 스크립트 | 하는 일 |
| --- | --- |
| `check-goal-state.mjs` | `state.yaml` 규약 위반을 기계적으로 검증하는 레퍼런스 검증기 |
| `render-task-prompt.mjs` | 활성 태스크만 골라 컴팩트 프롬프트로 렌더링 (컨텍스트 절약) |
| `dispatch-task.mjs` | 외부 하네스 CLI를 headless 실행 + git 기반 쓰기 범위 검사 |
| `apply-receipt.mjs` | 영수증을 보드에 반영하고 다음 태스크를 활성화 |
| `check-can-stop.mjs` | "지금 멈춰도 되는가"를 fail-closed로 판정 |
| `parallel-plan.mjs` | 쓰기 범위가 겹치지 않는 병렬 가능 작업을 추천 (상태 변경 없음) |
| `install-agents.mjs`, `check-update.mjs` | 에이전트 설치, 신규 버전 확인 |

### 생성되는 작업 공간

```text
docs/goals/<slug>/
  goal.md            # 사람이 읽고 고치는 헌장(charter)
  state.yaml         # 보드의 유일한 진실(board truth)
  notes/             # 긴 발견 내용 (메인 스레드 오염 방지)
  .goalbuddy-board/  # 생성된 시각 보드 아티팩트
  subgoals/          # 선택적 depth-1 자식 보드
```

### 역할(Role) 모델

| 역할 | 권한 | 책임 |
| --- | --- | --- |
| **PM** (메인 세션) | `state.yaml`의 유일한 소유자 | 보드 관리, 태스크 배정, 영수증 기록. 직접 구현하지 않음 |
| **Scout** | 읽기 전용 | 레포 지도, 검증 명령 파악, 개선 후보 랭킹 |
| **Judge** | 읽기 전용 | 가장 크고 안전한 슬라이스 선택, 최종 감사(audit) |
| **Worker** | `allowed_files` 내부만 쓰기 | 배정된 슬라이스 전체 완수, `verify` 실행, 영수증 제출 |

Worker 계약의 핵심: 수정 시도는 최대 2회, 유효한 종료 상태는 **done 영수증 또는 blocked 영수증** 뿐이며,
영수증 없이 조용히 멈추는 것은 금지된다.

---

## 3. 설치 및 사용법

### 설치

```bash
npx goalbuddy                 # Codex + Claude Code 동시 설치 (기본)
npx goalbuddy --target claude # Claude Code만
npx goalbuddy --target codex  # Codex만
```

- 요구 사항: **Node.js >= 18**, 런타임 의존성 **0개**
- 설치 후 Codex / Claude Code **재시작** 필요

설치 위치:

```text
Claude Code : ~/.claude/ (스킬 + goal-* 서브에이전트 + /goalbuddy 커맨드)
Codex       : ~/.codex/plugins/cache/goalbuddy/goalbuddy/<version>/
              ~/.codex/agents/goal_{scout,worker,judge}.toml
```

### 기본 흐름

```text
1) 보드 준비   : /goal-prep      (Claude Code)  |  $goal-prep  (Codex)
2) 실행 시작   : /goalbuddy Follow docs/goals/<slug>/goal.md.   (Claude Code)
                /goal Follow docs/goals/<slug>/goal.md.        (Codex)
```

> 0.4.3부터 Claude Code에서는 `/goal`이 아니라 **`/goalbuddy`** 를 사용한다.
> Claude 기본 `/goal` 커맨드와의 이름 충돌을 제거한 변경이다.

### 주요 CLI 명령

```bash
npx goalbuddy update                              # 양쪽 하네스 업데이트
npx goalbuddy doctor --target codex --goal-ready  # 설치 진단
npx goalbuddy reset --target codex                # GoalBuddy 소유 파일 제거
npx goalbuddy init <slug> [--title "..."]         # 보드 수동 생성
npx goalbuddy resume                              # 살아있는 보드 + 이어가기 명령 목록
npx goalbuddy board docs/goals/<slug>             # 로컬 보드 서버 실행
npx goalbuddy prompt docs/goals/<slug>            # 활성 태스크 프롬프트 렌더
npx goalbuddy dispatch docs/goals/<slug> --to codex|claude-code
npx goalbuddy receipt docs/goals/<slug> --task T003 --receipt receipt.json
npx goalbuddy can-stop docs/goals/<slug>          # 종료 가능 여부 판정
npx goalbuddy parallel-plan docs/goals/<slug>     # 병렬 가능 작업 추천
```

로컬 보드는 기본적으로 `http://goalbuddy.localhost:41737/<slug>/` 에서 열리고,
여러 보드는 동일 포트의 허브에서 스위처로 전환된다.

---

## 4. 형태 구분: 플러그인 / 스킬 / MCP

| 형태 | 해당 여부 | 근거 |
| --- | --- | --- |
| 스킬(Skill) | **예** | `goalbuddy/SKILL.md` (frontmatter `name: goal-prep`) |
| 플러그인(Plugin) | **예** | `plugins/goalbuddy/.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` |
| CLI 도구 | **예** | `package.json`의 `bin.goalbuddy` → `internal/cli/goal-maker.mjs` |
| 서브에이전트 팩 | **예** | `plugins/goalbuddy/agents/goal-*.md` |
| 슬래시 커맨드 | **예** | `plugins/goalbuddy/commands/goalbuddy.md` |
| **MCP 서버** | **아니오** | MCP 서버 구현, 매니페스트, stdio 핸들러가 저장소에 없음 |

MCP는 에이전트에게 **새 도구(tool)** 를 공급하는 프로토콜이다.
GoalBuddy가 제공하는 것은 새 도구가 아니라 **규율(discipline)** — 순서, 역할, 권한 범위, 증거 요건 — 이므로
프롬프트 + 파일 규약 방식이 더 적합하고, 그 덕분에 Codex와 Claude Code 양쪽에 **하네스 중립**으로 붙을 수 있다.

---

## 5. API 토큰 필요 여부

**별도의 API 토큰은 필요 없다.**

- 저장소 전체에서 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 사용처가 없다.
- GoalBuddy는 모델을 직접 호출하지 않고, 이미 로그인된 Codex / Claude Code **안에서** 동작한다.
- `dispatch` 명령만 외부 CLI를 부르는데, `spawnSync`로 로컬 `codex` / `claude-code` 바이너리를 headless 실행한다.
  인증은 해당 CLI의 기존 로그인을 그대로 사용한다. CLI가 미설치·미인증이면 PM 폴백으로 처리된다.
- 저장소에 등장하는 토큰 이야기는 `docs/releases/README.md`의 **npm 배포(OIDC trusted publishing)** 맥락으로,
  패키지 유지관리자에게만 해당한다.

비용은 GoalBuddy 자체가 아니라 사용 중인 Claude / Codex 구독·API 요금에서 발생한다.
자율 실행 특성상 일반 대화보다 토큰 사용량이 크다는 점은 감안해야 한다.

---

## 6. GitHub에서 주목받는 이유

1. **정확한 통증 타격** — "에이전트가 긴 작업을 못 버틴다"는 현재 AI 코딩의 1순위 불만.
2. **Codex + Claude Code 양쪽 지원** — "Harnesses churn; repos persist." 한 보드에서 하네스 혼용(예: Claude Judge + Codex Worker)도 가능.
3. **의존성 0 + `npx` 한 줄 설치** — 진입 장벽이 사실상 없음.
4. **로컬 라이브 보드** — 눈에 보이는 산출물이 있어 공유·스크린샷에 유리.
5. **"Receipt(영수증)" 네이밍** — 증거 기반 작업이라는 개념을 한 단어로 설명.
6. **선명한 철학 문장** — "No oracle, no serious goal." 등 인용하기 좋은 카피.
7. **실제 구현이 뒷받침됨** — 기계 검증기, git 기반 범위 검사, Node 18/24 CI, 촘촘한 릴리스 노트.

---

## 7. 로컬 에이전트 구축에 주는 시사점

바로 차용할 만한 설계 패턴:

1. **상태를 파일에 둔다** — 대화 컨텍스트는 휘발되고 `state.yaml`은 남는다. 세션 재시작만으로 복구 가능한 구조.
2. **권한 스코프 + 기계 검증** — 작업 전후 `git` 변경 파일을 비교해 범위 위반을 잡는다. 읽기 전용 역할은 변경이 0이어야 통과.
3. **구조화된 출력 강제** — "`goalbuddy_receipt_v1` JSON 객체 하나로 답을 끝내라". 파싱 가능한 출력이 자동화의 전제.
4. **컨텍스트 다이어트** — 전체 상태 대신 활성 태스크만 렌더링해 프롬프트로 전달.
5. **fail-closed 종료 판정** — 에이전트의 "그만하고 싶다"가 아니라 `can-stop`이 허용해야 종료.

부가적으로 `local-goal-board` 스크립트는 **의존성 없는 Node HTTP 서버 + 실시간 보드** 구현 예제로 쓸 수 있고,
`goal-*.md` / `goal_*.toml`은 역할 프롬프트 작성의 좋은 참고 자료다.

---

## 8. React / PHP로 만들 수 있는가

| 구성 요소 | React | PHP | 비고 |
| --- | --- | --- | --- |
| 보드 뷰어 UI | 적합 | 가능 | 현재는 바닐라 JS. React 교체가 가장 쉬운 개선 |
| `state.yaml` 파서·검증기 | 가능 | 가능 | PHP는 `symfony/yaml` 사용 |
| 보드 서버 / API | Node 유지 권장 | Laravel 적합 | 팀 대시보드 성격이면 PHP가 유리 |
| CLI 스폰(dispatch) | 브라우저 불가 | `proc_open`으로 가능 | 실행 주체는 결국 로컬 개발 환경 |
| 설치기(`npx`) | 부적합 | 부적합 | 하네스와 같은 Node 생태계가 자연스러움 |
| 스킬·프롬프트 문서 | 언어 무관 | 언어 무관 | 마크다운이므로 이식 자유 |

권장 조합:

```text
핵심 엔진    : Node CLI        (하네스와 동일 생태계)
개인 보드    : React + SSE     (기존 API 위에 프론트만 교체)
팀 대시보드  : PHP / Laravel   (다중 레포 집계, 영수증 아카이브, 알림 연동)
```

주의: GoalBuddy의 실질적 가치는 코드보다 `SKILL.md` / `goal-execution.md`에 적힌 **규약 설계**에 있다.
언어 이식은 껍데기 교체에 가깝고, 규약 자체의 설계가 훨씬 어려운 부분이다.

---

## 9. 수익화 아이디어

### 티어 1 — 즉시 실행 가능 (추가 개발 거의 없음)

1. **증거 기반 프리랜싱 / 에이전시 차별화**
   납품물에 영수증·검증 로그·보드 히스토리를 첨부해 작업 투명성을 세일즈 포인트로 삼는다. 단가 인상 명분 확보.
2. **한국어 콘텐츠 및 교육**
   AI 에이전트 장기 작업 관리 강의, 한국어 가이드와 템플릿 팩. 국내 경쟁 콘텐츠가 희소.
3. **도입 컨설팅**
   스타트업·SI 대상 워크플로우 셋업 프로젝트. 커스텀 역할팩과 오라클 설계가 실제 상품.

### 티어 2 — 개발 필요 (1~3개월)

4. **GitHub App "AI 작업 감사관"**
   PR에서 `state.yaml`을 읽어 영수증 수, `verify` 결과, `allowed_files` 위반, 오라클 달성률을 자동 코멘트.
   레포당 구독 과금. 기존 `check-goal-state.mjs`를 재활용할 수 있어 개발량 대비 효과가 큼.
5. **팀 클라우드 보드 SaaS**
   다중 레포 통합 뷰, 실시간 공유, Slack / Linear / Jira 연동, 영수증 아카이브, 주간 리포트. 시트당 과금.
   원본 저장소가 외부 연동을 의도적으로 다루지 않으므로 시장 공백이 있다.
6. **AI 비용·성과 애널리틱스**
   영수증 기반으로 목표당 비용, 역할별 성공률, 하네스/모델 비교, 추천 엔진 제공.
7. **도메인 특화 역할팩 판매**
   커머스(PG·재고·주문 상태머신), 핀테크·의료(규제 체크리스트 내장 Judge), 한국 SI(전자정부 프레임워크 등).

### 티어 3 — 장기 (6개월+)

8. **규제 산업용 AI 감사 리포트**
   영수증을 변조 불가 감사 로그(해시 체인·서명)로 확장하고 리포트를 자동 생성. B2B 고단가 영역.
9. **매니지드 오케스트레이션**
   `dispatch`를 클라우드에서 실행해 야간 자율 작업 후 PR을 전달. 목표당 또는 실행시간 과금.
10. **오라클 / verify 레시피 마켓플레이스**
    프레임워크별 검증 레시피 거래소. 플랫폼 수수료 모델.

### 권장 순서

```text
0~1개월 : (1) 프리랜싱 차별화 + (2) 한국어 콘텐츠 → 현금흐름과 인지도 확보
1~3개월 : (4) GitHub App MVP → 개발량 적고 CI 락인 효과 큼
3~6개월 : (6) 애널리틱스를 애드온으로 결합 → ARPU 상승
6개월+  : (5) 팀 SaaS 확장, 필요 시 (8) 규제 대응 엔터프라이즈
```

### 라이선스 및 리스크 체크

- MIT이므로 상업적 이용은 자유. 단 **저작권 고지와 LICENSE 유지** 필수.
- **'GoalBuddy' 이름·로고는 그대로 쓰지 말고** 자체 브랜드를 사용하는 편이 안전하다.
- 업스트림이 활발히 개발 중(0.4.x)이므로 포크 유지보수 비용을 고려해야 한다.
- 차별화 지점은 코어가 아니라 **코어가 의도적으로 다루지 않는 영역**(클라우드, 팀 협업, 외부 연동, 분석)에 있다.

---

## 10. 요약

- GoalBuddy는 **AI 에이전트의 장기 작업을 파일 기반 상태머신으로 규율화**하는 도구다.
- 플러그인이자 스킬이자 CLI이며, **MCP는 아니다**.
- **별도 API 토큰이 필요 없고**, 기존 Codex / Claude Code 인증을 그대로 사용한다.
- 인기 요인은 문제의 보편성, 하네스 중립성, 무의존성 설치, 시각 보드, 선명한 철학, 그리고 실제 동작하는 구현이다.
- 로컬 에이전트를 만든다면 **상태 영속화 / 권한 스코프 검증 / 구조화 출력 / 컨텍스트 다이어트 / fail-closed 종료** 패턴이 바로 재사용할 가치가 있다.
- 수익화는 코어 복제가 아니라 **감사·팀 협업·분석 레이어**에서 찾는 것이 현실적이다.
