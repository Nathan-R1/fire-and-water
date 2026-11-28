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

  (no option)   Show the status; start the dev server in the background on
                http://localhost:$PORT if it isn't running
  --stop        Stop it
  --restart     Stop it, then start it again (picks up server code changes)
  --status      Say whether it's running, for how long, and whether server code
                changed since it started (then it needs --restart)
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

# Seconds a process has been running, from ps's elapsed time ([[dd-]hh:]mm:ss). (The
# timestamps under /proc aren't reliable on every system, e.g. Termux/PRoot.)
uptime_secs() {
  local e d=0 h=0 m=0 s=0
  e="$(ps -o etime= -p "$1" 2>/dev/null | tr -d ' \n')"
  [[ -n "$e" ]] || return 1
  if [[ "$e" == *-* ]]; then d="${e%%-*}"; e="${e#*-}"; fi
  IFS=: read -r -a parts <<< "$e"
  case ${#parts[@]} in
    3) h=${parts[0]}; m=${parts[1]}; s=${parts[2]} ;;
    2) m=${parts[0]}; s=${parts[1]} ;;
    *) return 1 ;;
  esac
  echo $(( 10#$d * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s ))
}

# 75 -> "1m 15s", 7300 -> "2h 1m", 90000 -> "1d 1h"
human() {
  local t=$1
  if (( t < 60 )); then echo "${t}s"
  elif (( t < 3600 )); then echo "$(( t / 60 ))m $(( t % 60 ))s"
  elif (( t < 86400 )); then echo "$(( t / 3600 ))h $(( t % 3600 / 60 ))m"
  else echo "$(( t / 86400 ))d $(( t % 86400 / 3600 ))h"; fi
}

# Server-side files changed after epoch second $1. Files in public/ are served fresh on
# every load, but these only take effect after a restart.
changed_since() {
  # (a pipe, not < <(…): there's no /dev/fd under Termux/PRoot)
  # (|| true: a missing .env makes find fail, which pipefail would turn into an exit)
  { find "$DIR/server.js" "$DIR/src" "$DIR/shared" "$DIR/levels" "$DIR/.env" -type f -print0 2>/dev/null || true; } |
    while IFS= read -r -d '' f; do
      if (( $(stat -c %Y "$f") > $1 + 1 )); then echo "${f#"$DIR"/}"; fi
    done
}

# Prints the status; returns 1 if the server isn't running.
status() {
  local pid up changed
  pid="$(server_pid)"
  if [[ -z "$pid" ]]; then echo "Not running."; return 1; fi
  if ! up="$(uptime_secs "$pid")"; then echo "Running (pid $pid) on http://localhost:$PORT"; return 0; fi
  echo "Running (pid $pid) on http://localhost:$PORT, up $(human "$up")"
  changed="$(changed_since $(( $(date +%s) - up )))"
  if [[ -n "$changed" ]]; then
    echo "Server code changed since it started; ./run.sh --restart to load it:"
    echo "$changed" | head -n 8 | sed 's/^/  /'
    local n; n="$(echo "$changed" | wc -l)"
    (( n > 8 )) && echo "  …and $(( n - 8 )) more"
  fi
  return 0
}

case "${1:-}" in
  "") if status; then echo "Use ./run.sh --restart to restart it, or --stop to stop it."; else start; fi ;;
  --stop) stop ;;
  --restart) stop; start ;;
  --status) status ;;
  -h|--help) usage ;;
  *) echo "Unknown option: $1" >&2; echo >&2; usage >&2; exit 1 ;;
esac
