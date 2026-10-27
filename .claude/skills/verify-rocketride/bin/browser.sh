# shellcheck shell=bash
# Browser commands for rr-verify: browse, docs, and the browser part of stop.
# bin/rr-verify sources this file. It uses rr-verify's SKILL_DIR, REPO, RUN_DIR, RUN_ID, LABEL,
# ARGS, die, and load_run.

# Run a browser script (bin/browse.mjs) against the run's engine or docs server.
cmd_browse() {
	case " ${ARGS[*]-} " in
		*" --help "* | *" -h "*) exec node "$SKILL_DIR/bin/browse.mjs" --help ;;
	esac
	load_run
	if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
		die "engine pid $ENGINE_PID is not running; launch a new run"
	fi
	if [ -f "$RUN_DIR/docs.env" ]; then
		set -a
		# shellcheck disable=SC1091
		. "$RUN_DIR/docs.env"
		set +a
	fi
	local label_args=()
	[ -n "$LABEL" ] && label_args=(--label "$LABEL")
	RR_VERIFY_REPO="$REPO" exec node "$SKILL_DIR/bin/browse.mjs" ${label_args[@]+"${label_args[@]}"} ${ARGS[@]+"${ARGS[@]}"}
}

# Serve the built docs site (dist/docs) the way GitHub Pages serves it, on a free port.
cmd_docs() {
	load_run
	local site="$REPO/dist/docs"
	[ -f "$site/index.html" ] || die "no built docs site at dist/docs. Build it first: ./builder docs:build"
	if [ -f "$RUN_DIR/docs.env" ]; then
		local old_pid
		old_pid=$(grep '^DOCS_PID=' "$RUN_DIR/docs.env" | cut -d= -f2)
		if kill -0 "$old_pid" 2>/dev/null; then
			grep '^DOCS_URI=' "$RUN_DIR/docs.env" | sed 's/^DOCS_URI=/docs:     /'
			return 0
		fi
	fi
	local port log="$RUN_DIR/docs.log"
	port=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
	# setsid makes the server a process-group leader, so `stop` ends it and its children.
	(
		cd "$REPO/docs/docusaurus" || exit 1
		exec setsid pnpm exec docusaurus serve --dir "$site" --port "$port" --host 127.0.0.1 --no-open
	) >"$log" 2>&1 </dev/null &
	local pid=$! waited=0
	until curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$port/"; do
		if ! kill -0 "$pid" 2>/dev/null; then
			tail -n 20 "$log" >&2
			die "the docs server exited during startup; see $log"
		fi
		if [ "$waited" -ge 60 ]; then
			kill -TERM -- "-$pid" 2>/dev/null || true
			die "the docs server did not answer after 60s; see $log"
		fi
		sleep 1
		waited=$((waited + 1))
	done
	printf 'DOCS_PID=%s\nDOCS_PORT=%s\nDOCS_URI=http://127.0.0.1:%s\n' "$pid" "$port" "$port" >"$RUN_DIR/docs.env"
	echo "docs:     http://127.0.0.1:$port (pid $pid, serving dist/docs)"
}

# True when /proc says PID is still the process we started (guards against PID reuse).
_rr_is() {
	local pid="$1" pattern="$2"
	[ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q -- "$pattern"
}

# End every browser and docs server this run started. Called by cmd_stop.
browser_stop() {
	local f pid bpid stopped=0
	for f in "$RUN_DIR"/browsers/*.env; do
		[ -f "$f" ] || continue
		pid=$(grep '^BROWSE_PID=' "$f" | cut -d= -f2)
		bpid=$(grep '^BROWSER_PID=' "$f" | cut -d= -f2)
		if ! _rr_is "$pid" browse.mjs && ! _rr_is "$bpid" chrom; then
			rm -f "$f"
			continue
		fi
		_rr_is "$pid" browse.mjs && kill -TERM "$pid" 2>/dev/null
		for _ in $(seq 1 10); do
			_rr_is "$pid" browse.mjs || _rr_is "$bpid" chrom || break
			sleep 1
		done
		_rr_is "$pid" browse.mjs && kill -KILL "$pid" 2>/dev/null
		_rr_is "$bpid" chrom && kill -KILL -- "-$bpid" 2>/dev/null
		rm -f "$f"
		stopped=$((stopped + 1))
	done
	[ "$stopped" -gt 0 ] && echo "stopped $stopped browser session(s)"
	if [ -f "$RUN_DIR/docs.env" ]; then
		pid=$(grep '^DOCS_PID=' "$RUN_DIR/docs.env" | cut -d= -f2)
		if kill -0 "$pid" 2>/dev/null; then
			kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
			for _ in $(seq 1 10); do
				pgrep -g "$pid" >/dev/null || break
				sleep 1
			done
			pgrep -g "$pid" >/dev/null && kill -KILL -- "-$pid" 2>/dev/null
			echo "stopped docs server pid $pid"
		fi
		rm -f "$RUN_DIR/docs.env"
	fi
	return 0
}
