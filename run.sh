#!/usr/bin/env bash
# Run the game locally in dev mode (DEV=1: the Skip room button) in the background.
# See ./run.sh --help.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$DIR/.run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
PORT="${PORT:-3000}"

usage() {
  cat <<EOF
Usage: ./run.sh [option]

  (no option)   Start the dev server in the background on http://localhost:$PORT
  --stop        Stop it
  --restart     Stop it, then start it again (picks up server code changes)
  --status      Say whether it's running
  --help, -h    Show this help

The server runs with DEV=1 (enables the Skip room button). It reads .env if there is
one (SUPABASE_URL, SUPABASE_SECRET_KEY); without it the database is off.
Set PORT to use another port, e.g. PORT=4000 ./run.sh
Log: .run/server.log
EOF
}

# The pid of this project's server: from the pid file, or any 'node server.js' running
# in this directory (e.g. one started by hand).
server_pid() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then echo "$pid"; return; fi
    rm -f "$PID_FILE"
  fi
  for p in /proc/[0-9]*; do
    [[ "$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)" == "node server.js "* ]] || continue
    [[ "$(readlink "$p/cwd" 2>/dev/null)" == "$DIR" ]] || continue
    basename "$p"; return
  done
}

start() {
  local pid
  pid="$(server_pid)"
  if [[ -n "$pid" ]]; then
    echo "Already running (pid $pid). Use ./run.sh --restart to restart it."
    return
  fi
  mkdir -p "$RUN_DIR"
  (
    cd "$DIR"
    if [[ -f .env ]]; then set -a; . ./.env; set +a; fi
    DEV=1 PORT="$PORT" nohup node server.js > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
  )
  for _ in $(seq 1 50); do
    if curl -sf "http://localhost:$PORT/healthz" > /dev/null 2>&1; then
      echo "Running on http://localhost:$PORT (pid $(cat "$PID_FILE"), log: .run/server.log)"
      return
    fi
    if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "The server exited while starting. Last lines of .run/server.log:" >&2
      tail -n 20 "$LOG_FILE" >&2
      exit 1
    fi
    sleep 0.2
  done
  echo "Started (pid $(cat "$PID_FILE")) but http://localhost:$PORT/healthz isn't answering yet. See .run/server.log" >&2
}

stop() {
  local pid
  pid="$(server_pid)"
  if [[ -z "$pid" ]]; then echo "Not running."; return; fi
  kill "$pid"
  for _ in $(seq 1 25); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid"; fi
  rm -f "$PID_FILE"
  echo "Stopped (pid $pid)."
}

status() {
  local pid
  pid="$(server_pid)"
  if [[ -n "$pid" ]]; then echo "Running (pid $pid) on http://localhost:$PORT"; else echo "Not running."; fi
}

case "${1:-}" in
  "") start ;;
  --stop) stop ;;
  --restart) stop; start ;;
  --status) status ;;
  -h|--help) usage ;;
  *) echo "Unknown option: $1" >&2; echo >&2; usage >&2; exit 1 ;;
esac
