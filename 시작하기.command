#!/bin/bash
# review_bot 시작하기
#
# 더블클릭하면 필요한 프로그램을 확인해 없는 것만 설치하고, 로그인을 안내한 뒤 대시보드를 연다.
# 두 번째부터는 확인만 하고 바로 켠다. 관리자 비밀번호를 묻지 않는다 — 모든 도구는 ~/.review_bot/tools 에 깔린다.
# macOS 에서는 더블클릭, Linux 에서는 터미널에서 `bash 시작하기.command`.

set -euo pipefail
cd "$(dirname "$0")"

BOT_HOME="${REVIEW_BOT_HOME:-$HOME/.review_bot}"
TOOLS="$BOT_HOME/tools"
export PATH="$TOOLS/bin:$TOOLS/node/bin:$PATH"
mkdir -p "$TOOLS/bin"

bold=$'\033[1m'; dim=$'\033[2m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
step() { printf '\n%s%s%s\n' "$bold" "$1" "$reset"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
say() { printf '  %s\n' "$1"; }
fail() {
  printf '\n  %s멈췄어요.%s %s\n' "$red" "$reset" "$1"
  printf '  이 창을 닫고 %s시작하기.command%s 를 다시 열면 멈춘 곳부터 이어서 해요.\n\n' "$bold" "$reset"
  read -r -p "  창을 닫으려면 Enter 를 눌러 주세요. " _ || true
  exit 1
}
wait_enter() { read -r -p "  $1 (준비되면 Enter) " _ || true; }

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "이 컴퓨터의 운영체제는 아직 지원하지 않아요. macOS 나 Linux 에서 열어 주세요." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) fail "이 컴퓨터의 CPU 종류($(uname -m))는 아직 지원하지 않아요." ;;
esac

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

# 받은 파일이 공식 배포본과 같은지 체크섬으로 확인한 뒤에만 푼다.
download_verified() { # url, 기대 체크섬, 저장 경로
  curl -fsSL "$1" -o "$3" || fail "인터넷에서 파일을 받지 못했어요. 연결을 확인해 주세요."
  [ "$(sha256_of "$3")" = "$2" ] || { rm -f "$3"; fail "받은 파일이 공식 배포본과 달라요. 잠시 뒤 다시 해 주세요."; }
}

printf '\n%sreview_bot 을 준비할게요.%s\n' "$bold" "$reset"
printf '%s없는 것만 설치하고, 로그인이 필요하면 하나씩 안내해요. 처음에는 5~10분쯤 걸려요.%s\n' "$dim" "$reset"

# ── 1. Node.js ─────────────────────────────────────────────
step "1/5  실행 도구(Node.js) 확인"
node_major() { node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }
if [ "$(node_major)" -ge 22 ]; then
  ok "Node.js 가 있어요. ($(node -v))"
else
  say "Node.js 를 내려받아 설치할게요. 관리자 비밀번호는 필요 없어요."
  base="https://nodejs.org/dist/latest-v22.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")" || fail "Node.js 정보를 받지 못했어요. 인터넷 연결을 확인해 주세요."
  line="$(printf '%s\n' "$sums" | grep " node-v[0-9.]*-$OS-$ARCH.tar.gz$" | head -1)"
  [ -n "$line" ] || fail "이 컴퓨터에 맞는 Node.js 파일을 찾지 못했어요."
  file="${line##* }"; expected="${line%% *}"
  tmp="$(mktemp -d)"
  download_verified "$base/$file" "$expected" "$tmp/node.tar.gz"
  rm -rf "$TOOLS/node" && mkdir -p "$TOOLS/node"
  tar -xzf "$tmp/node.tar.gz" -C "$TOOLS/node" --strip-components 1
  rm -rf "$tmp"
  ok "Node.js 를 설치했어요. ($(node -v))"
fi

# ── 2. GitHub CLI ──────────────────────────────────────────
step "2/5  GitHub 연결 도구(gh) 확인"
if command -v gh >/dev/null 2>&1; then
  ok "gh 가 있어요."
else
  say "gh 를 내려받아 설치할게요."
  tag="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$tag" ] || fail "gh 정보를 받지 못했어요. 인터넷 연결을 확인해 주세요."
  gharch=$([ "$ARCH" = x64 ] && echo amd64 || echo arm64)
  if [ "$OS" = darwin ]; then asset="gh_${tag}_macOS_${gharch}.zip"; else asset="gh_${tag}_linux_${gharch}.tar.gz"; fi
  url="https://github.com/cli/cli/releases/download/v${tag}"
  expected="$(curl -fsSL "$url/gh_${tag}_checksums.txt" | grep " $asset$" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "gh 확인용 정보를 찾지 못했어요."
  tmp="$(mktemp -d)"
  download_verified "$url/$asset" "$expected" "$tmp/$asset"
  if [ "$OS" = darwin ]; then unzip -q "$tmp/$asset" -d "$tmp"; else tar -xzf "$tmp/$asset" -C "$tmp"; fi
  cp "$tmp"/gh_*/bin/gh "$TOOLS/bin/gh" && chmod +x "$TOOLS/bin/gh"
  rm -rf "$tmp"
  ok "gh 를 설치했어요. ($tag)"
fi

# ── 3. GitHub 로그인 ───────────────────────────────────────
step "3/5  GitHub 로그인"
if gh auth status >/dev/null 2>&1; then
  ok "GitHub 에 로그인되어 있어요. ($(gh api user --jq .login 2>/dev/null || echo 계정 확인 안 됨))"
else
  say "브라우저에서 GitHub 에 로그인할게요. 순서는 이래요."
  say "  ① 아래에 8자리 코드가 나오고, 자동으로 복사돼요."
  say "  ② Enter 를 누르면 브라우저가 열려요. 코드 칸에 붙여 넣고(⌘V) 승인해 주세요."
  say "  ③ 브라우저에 완료 화면이 나오면 이 창으로 돌아와 주세요."
  gh auth login --web --git-protocol https --hostname github.com || fail "GitHub 로그인을 끝내지 못했어요."
  ok "GitHub 에 로그인했어요."
fi

# ── 4. 리뷰를 쓸 AI ────────────────────────────────────────
step "4/5  리뷰를 쓸 AI 확인"
codex_ready() { command -v codex >/dev/null 2>&1 && codex login status >/dev/null 2>&1; }
claude_ready() { command -v claude >/dev/null 2>&1 && claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; }
if codex_ready; then
  ok "ChatGPT 로 리뷰할 수 있어요."
elif claude_ready; then
  ok "Claude 로 리뷰할 수 있어요."
else
  say "리뷰는 이미 쓰고 있는 AI 구독으로 해요. 어느 쪽을 쓰세요?"
  say "  1) ChatGPT (Plus 이상 구독)"
  say "  2) Claude (Pro 이상 구독)"
  choice=""
  while [ "$choice" != 1 ] && [ "$choice" != 2 ]; do read -r -p "  번호를 입력해 주세요: " choice || true; done
  if [ "$choice" = 1 ]; then
    say "ChatGPT 연결 도구를 설치할게요."
    npm install -g --prefix "$TOOLS" --no-audit --no-fund @openai/codex >/dev/null || fail "ChatGPT 연결 도구를 설치하지 못했어요."
    say "브라우저가 열리면 ChatGPT 계정으로 로그인해 주세요."
    codex login || fail "ChatGPT 로그인을 끝내지 못했어요."
    codex_ready || fail "ChatGPT 로그인을 확인하지 못했어요."
  else
    say "Claude 연결 도구를 설치할게요."
    npm install -g --prefix "$TOOLS" --no-audit --no-fund @anthropic-ai/claude-code >/dev/null || fail "Claude 연결 도구를 설치하지 못했어요."
    say "브라우저가 열리면 Claude 계정으로 로그인해 주세요."
    claude auth login || fail "Claude 로그인을 끝내지 못했어요."
    claude_ready || fail "Claude 로그인을 확인하지 못했어요."
  fi
  ok "AI 를 연결했어요."
fi

# ── 5. review_bot 켜기 ─────────────────────────────────────
step "5/5  review_bot 켜기"
# 실행에 필요한 tsx 가 없거나 package.json 이 그보다 새로우면 설치한다.
if [ ! -x node_modules/.bin/tsx ] || [ package.json -nt node_modules/.bin/tsx ]; then
  say "필요한 부품을 설치할게요. 1분쯤 걸려요."
  log="$BOT_HOME/install.log"
  # pnpm 으로 만든 node_modules 위에 npm 을 돌리면 npm 이 깨진다 — 만든 도구로 다시 설치한다.
  if [ -d node_modules/.pnpm ] && command -v pnpm >/dev/null 2>&1; then
    installer=(pnpm install)
  else
    installer=(npm install --no-audit --no-fund)
  fi
  if ! "${installer[@]}" >"$log" 2>&1; then
    tail -n 5 "$log" | sed 's/^/    /'
    fail "부품을 설치하지 못했어요. 자세한 기록: $log"
  fi
  touch node_modules/.bin/tsx
fi
ok "준비를 마쳤어요. 잠시 뒤 브라우저에 review_bot 이 열려요."
printf '\n  %s이 창을 닫으면 review_bot 도 꺼져요. 쓰는 동안에는 열어 두세요.%s\n\n' "$bold" "$reset"
exec npm run --silent dev
