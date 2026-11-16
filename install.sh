#!/usr/bin/env bash
# Install DB-GPT, DeepSeek Harness (dsh), and this plugin on one machine and
# wire them together. Safe to run again: finished steps are kept or redone
# without side effects.
#
# Usage: bash install.sh [options]
#   --dbgpt-dir DIR      DB-GPT checkout; cloned when missing
#                        (default: <directory above this plugin>/DB-GPT)
#   --dsh-dir DIR        deepseek-harness checkout; cloned when missing
#                        (default: <directory above this plugin>/deepseek-harness)
#   --profile NAME       dsh profile to install into (default: web)
#   --port PORT          port of the DB-GPT web page and API (default: 5670)
#   --embedding-url URL  OpenAI-compatible embeddings endpoint
#                        (default: https://modelservice.jdcloud.com/v1; "none" uses the model's endpoint)
#   --skip-build         skip `uv sync`, `pnpm install`, and `pnpm run build`
#   --no-keys            do not ask for API keys
#   -h, --help           show this help
#
# API keys: the script asks for the DeepSeek key (DEEPSEEK_API_KEY) and the
# embeddings key (DBGPT_EMBEDDING_API_KEY), or takes them from environment
# variables of the same names, and stores them in $DSH_HOME/.env (mode 600).
# A key saved later in the dsh web UI takes precedence over that file.
set -euo pipefail

PLUGIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BASE_DIR=$(dirname "$PLUGIN_DIR")
DBGPT_DIR="$BASE_DIR/DB-GPT"
DSH_DIR="$BASE_DIR/deepseek-harness"
PROFILE=web
PORT=5670
EMBEDDING_URL=https://modelservice.jdcloud.com/v1
SKIP_BUILD=0
ASK_KEYS=1

DBGPT_REPO=https://github.com/eosphoros-ai/DB-GPT.git
# DB-GPT commit this plugin was tested with; used only for a fresh clone.
DBGPT_COMMIT=8733ce907
DSH_REPO=https://github.com/deepseek-ai/deepseek-harness.git
DBGPT_EXTRAS=(--extra base --extra proxy_openai --extra rag --extra storage_chromadb --extra dbgpts)

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }
step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required: $2"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dbgpt-dir) DBGPT_DIR=${2:?--dbgpt-dir needs a value}; shift 2 ;;
    --dsh-dir) DSH_DIR=${2:?--dsh-dir needs a value}; shift 2 ;;
    --profile) PROFILE=${2:?--profile needs a value}; shift 2 ;;
    --port) PORT=${2:?--port needs a value}; shift 2 ;;
    --embedding-url) EMBEDDING_URL=${2:?--embedding-url needs a value}; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-keys) ASK_KEYS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac
DBGPT_DIR=$(realpath -m "$DBGPT_DIR")
DSH_DIR=$(realpath -m "$DSH_DIR")
DSH_HOME=${DSH_HOME:-$HOME/.dsh}

step "[1/6] Check tools"
need git "install git"
need node "install Node.js 24.9 or newer"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 24 || (a === 24 && b >= 9) ? 0 : 1)' \
  || die "Node.js $(node -v) is too old; dsh needs 24.9 or newer"
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then corepack enable pnpm; else npm install -g pnpm; fi
fi
need pnpm "install pnpm (npm install -g pnpm)"
if ! command -v uv >/dev/null 2>&1; then
  need python3 "install Python 3 so uv can be installed"
  python3 -m pip install -U uv
fi
need uv "install uv (pip install uv)"
info "node $(node -v), pnpm $(pnpm -v), $(uv --version)"

step "[2/6] DB-GPT: $DBGPT_DIR"
if [ ! -d "$DBGPT_DIR" ]; then
  git clone "$DBGPT_REPO" "$DBGPT_DIR"
  git -C "$DBGPT_DIR" checkout -q "$DBGPT_COMMIT"
fi
grep -q thinking_enabled "$DBGPT_DIR/packages/dbgpt-core/src/dbgpt/model/proxy/llms/deepseek.py" 2>/dev/null \
  || warn "this DB-GPT has no DeepSeek thinking switch; deepseek-v4-pro may not return SQL. Update DB-GPT to $DBGPT_COMMIT or newer."
if [ "$SKIP_BUILD" = 0 ]; then
  (cd "$DBGPT_DIR" && { uv python find 3.11 >/dev/null 2>&1 || uv python install 3.11; } \
    && uv sync --frozen --python 3.11 --all-packages "${DBGPT_EXTRAS[@]}")
fi
[ -x "$DBGPT_DIR/.venv/bin/dbgpt" ] || die "$DBGPT_DIR/.venv/bin/dbgpt is missing; run without --skip-build"
# Datasources record absolute file paths. After DB-GPT moved to another
# directory, point SQLite files that now live under this checkout's pilot/ there.
"$DBGPT_DIR/.venv/bin/python" - "$DBGPT_DIR" <<'PY'
import os, sqlite3, sys
home = sys.argv[1]
db = os.path.join(home, "pilot", "meta_data", "dbgpt.db")
if not os.path.exists(db):
    print("    no datasources yet (DB-GPT creates its database on first start)")
    sys.exit(0)
con = sqlite3.connect(db)
try:
    rows = con.execute("SELECT id, db_name, db_path FROM connect_config WHERE db_path IS NOT NULL AND db_path != ''").fetchall()
except sqlite3.Error as error:
    print(f"    cannot read datasources: {error}")
    sys.exit(0)
for row_id, name, path in rows:
    if os.path.exists(path):
        continue
    candidate = os.path.join(home, "pilot", path.split("/pilot/", 1)[1]) if "/pilot/" in path else None
    if candidate and os.path.exists(candidate):
        con.execute("UPDATE connect_config SET db_path = ? WHERE id = ?", (candidate, row_id))
        print(f"    datasource {name}: {path} -> {candidate}")
    else:
        print(f"    warning: datasource {name} points to a missing file {path}; fix it on the DB-GPT web page")
con.commit()
print(f"    {len(rows)} file datasource(s) checked")
PY

step "[3/6] dsh: $DSH_DIR"
[ -d "$DSH_DIR" ] || git clone "$DSH_REPO" "$DSH_DIR"
if [ "$SKIP_BUILD" = 0 ]; then
  (cd "$DSH_DIR" && pnpm install --frozen-lockfile && pnpm run build)
fi
DSH_VERSION=$(cd "$DSH_DIR" && pnpm --silent dsh -V 2>/dev/null | tail -1) || die "dsh does not start; run without --skip-build"
info "dsh $DSH_VERSION"

step "[4/6] Plugin defaults for this machine"
EMBEDDING_LINE=
if [ "$EMBEDDING_URL" != none ]; then
  EMBEDDING_LINE="        embeddingBaseURL: $(node -p 'JSON.stringify(process.argv[1])' "$EMBEDDING_URL")"
fi
cat > "$PLUGIN_DIR/cordis.patch.yml" <<EOF
# Layer this bundle adds to a dsh profile. Edit values here for every profile
# that installs the bundle, or save them from the plugin's settings page, which
# writes them into the profile's own cordis.patch.yml. install.sh rewrites it.
- insert:
    - id: dbgpt
      name: dsh-plugin-dbgpt
      config:
        dbgptHome: $(node -p 'JSON.stringify(process.argv[1])' "$DBGPT_DIR")
        port: $PORT
        llmSource: dsh
${EMBEDDING_LINE}
EOF
info "wrote $PLUGIN_DIR/cordis.patch.yml"

step "[5/6] Install the plugin into dsh profile '$PROFILE' ($DSH_HOME/profiles/$PROFILE)"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
# A shipped profile name (web, headless, ...) is created from its template on first use.
[ -d "$PROFILE_DIR" ] || (cd "$DSH_DIR" && pnpm --silent dsh --profile "$PROFILE" --dump-config >/dev/null 2>&1) || true
if grep -q '"dsh-plugin-dbgpt"' "$PROFILE_DIR/package.json" 2>/dev/null \
  && grep -q "link:$PLUGIN_DIR\"" "$PROFILE_DIR/package.json"; then
  info "already installed"
else
  (cd "$DSH_DIR" && pnpm dsh plugin --profile "$PROFILE" add "$PLUGIN_DIR")
fi
if grep -q '^- id: dbgpt$' "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null; then
  warn "$PROFILE_DIR/cordis.patch.yml has its own 'dbgpt' entry (saved from the settings page); it replaces the defaults above."
  grep -A8 '^- id: dbgpt$' "$PROFILE_DIR/cordis.patch.yml" | sed 's/^/      /' >&2
fi

step "[6/6] API keys ($DSH_HOME/.env)"
ENV_FILE="$DSH_HOME/.env"
store_key() {
  local name=$1 value=$2
  mkdir -p "$DSH_HOME"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  grep -v "^$name=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "saved $name"
}
ask_key() {
  local name=$1 label=$2 value=${!1:-}
  if [ -z "$value" ] && [ "$ASK_KEYS" = 1 ] && [ -t 0 ]; then
    if grep -q "^$name=" "$ENV_FILE" 2>/dev/null; then label="$label (Enter keeps the saved one)"; else label="$label (Enter skips)"; fi
    read -rsp "    $label: " value
    echo
  fi
  if [ -n "$value" ]; then store_key "$name" "$value"
  elif grep -q "^$name=" "$ENV_FILE" 2>/dev/null; then info "$name already saved"
  else info "$name not set; enter it later in the dsh web UI"
  fi
}
ask_key DEEPSEEK_API_KEY "DeepSeek API key for dsh and DB-GPT"
if [ "$EMBEDDING_URL" != none ]; then
  ask_key DBGPT_EMBEDDING_API_KEY "API key for embeddings at $EMBEDDING_URL"
fi

if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  warn "port $PORT is in use; stop that program or rerun with --port before starting dsh"
fi

cat <<EOF

Done. Start dsh (it starts DB-GPT on port $PORT by itself):

  cd $DSH_DIR
  pnpm dsh --profile $PROFILE

Then ask a data question in dsh, or type /dbgpt to see DB-GPT's state.
Manage datasources on the DB-GPT page: http://127.0.0.1:$PORT
Change settings under Plugins -> dsh-plugin-dbgpt -> dbgpt -> Configure.
EOF
