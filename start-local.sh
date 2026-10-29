#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -d "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin" ]]; then
 export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
fi
node -e 'if(Number(process.versions.node.split(".")[0])<22)throw new Error("Please install Node.js 22.12 or newer")'
if [[ ! -d frontend/node_modules ]]; then (cd frontend && npm ci); fi
if [[ -n "${MAVEN_BIN:-}" ]]; then
 maven="$MAVEN_BIN"
elif [[ -x /tmp/apache-maven-3.9.9/bin/mvn ]]; then
 maven=/tmp/apache-maven-3.9.9/bin/mvn
else
 maven=./mvnw
fi
if [[ ! -f backend/target/workflow-os-0.1.0.jar ]]; then (cd backend && "$maven" package); fi
(cd backend && exec java -jar target/workflow-os-0.1.0.jar --spring.profiles.active=local) &
backend_pid=$!
(cd frontend && exec node node_modules/vite/bin/vite.js --host 127.0.0.1) &
frontend_pid=$!
trap 'kill "$backend_pid" "$frontend_pid" 2>/dev/null || true' EXIT INT TERM
printf '\nWorkFlow OS: http://127.0.0.1:5173\nAPI docs: http://127.0.0.1:18080/swagger-ui/index.html\nCtrl+C stops both processes.\n'
wait
