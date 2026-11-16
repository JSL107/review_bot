# review_bot

GitHub PR 을 로컬 `codex` / `claude` CLI(구독 인증)로 리뷰하는 개인용 CLI.
이대리(personal_agents)의 코드 리뷰 워커에서 리뷰 프롬프트·응답 파서·diff 정제·게시 좌표 보정만 떼어 냈다. DB·Slack·NestJS 없이 `gh` 로그인만 있으면 돈다.

## 준비

- Node 22.13+, pnpm
- `gh auth login` 완료
- 쓸 모델 쪽 CLI 로그인: `codex login` 또는 `claude` (구독)

```bash
pnpm install
pnpm build
pnpm link --global   # 어디서나 `pr-review` 로 실행
```

## 사용

```bash
pr-review                                   # 선택 화면: PR → 모델 → 출력 방식
pr-review owner/repo#123 -m claude          # 터미널 출력
pr-review https://github.com/o/r/pull/1 -m codex --comment   # 게시 전 확인 후 PR 리뷰로 게시
pr-review o/r#1 -m codex --json > review.json                # JSON
```

| 옵션 | 설명 |
|---|---|
| `-m, --model codex\|claude` | 리뷰 모델. 생략하면 선택 화면(비대화형이면 codex) |
| `--model-name <이름>` | 세부 모델. 기본 codex=`gpt-6-sol`, claude=`opus` |
| `-c, --comment` / `--no-comment` | PR 리뷰 코멘트로 게시 / 터미널만 |
| `-y, --yes` | 게시 확인 생략. 비대화형에서 게시하려면 필수 |
| `--inline-max <n>` | 게시할 지적 상한(기본 4, 심각도 순) |
| `-i, --instruction <문장>` | 이번 리뷰에 덧붙일 지시 |
| `--timeout <초>` | 모델 호출 제한(기본 600) |

## 동작

1. `gh` 로 PR 상세 → diff → 상세 재조회. 그 사이 push 가 들어오면 한 번 다시 받는다.
2. lockfile·스냅샷·dist 는 빼고, `.env`·`*.pem` 같은 비밀 파일은 내용을 모델에 보내지 않는다. 120KB 를 넘으면 테스트 파일을 뒤로 보내고 자른다.
3. PR 본문·diff 는 `<untrusted-input>` 경계로 감싸 지시가 아닌 데이터로 읽힌다. 추가된 줄의 숨은 유니코드(Trojan Source)는 따로 경고한다.
4. 모델 호출은 stdin 으로만 넘긴다. codex 는 빈 임시 폴더만 읽을 수 있게 권한 프로필로 잠그고, claude 는 도구·MCP·사용자 설정을 전부 끈다. 주입된 PR 이 로컬 파일을 읽혀 코멘트로 내보내지 못하게 하기 위해서다.
5. 응답 JSON 을 검증하고, 판단 보류와 등급이 어긋나면 코드가 보정한다.
6. 게시는 GitHub 리뷰 하나(`COMMENT`)로 한다. 지적 줄이 diff 밖이면 20줄 안의 hunk 경계로 당기고, 그래도 못 붙이면 본문 목록으로 내린다. 인라인이 거부되면 전부 본문으로 다시 게시한다.

이대리에서 가져오지 않은 것: 기각에서 학습한 규약, diff 밖 관련 코드·기존 테스트 첨부, 레포 사본 읽기, codex→claude 자동 폴백, 위험 지도 코멘트.

## 개발

```bash
pnpm typecheck && pnpm test && pnpm build
pnpm dev -- o/r#1 -m claude     # 빌드 없이 실행
```
