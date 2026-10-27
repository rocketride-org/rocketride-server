#!/usr/bin/env bash
# Tears down only what rr-verify-agent started. Evidence is never touched.
# Usage: rr-verify-agent cleanup
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scrub_keys() { sed -E -e 's/sk-ant-[A-Za-z0-9_-]{8,}/[redacted]/g' -e 's/sk-(proj-)?[A-Za-z0-9_-]{16,}/[redacted]/g'; }

for name in shell rocket-ui; do
	if pgid_alive "$name"; then
		pg="$(cat "$STATE_DIR/$name.pgid")"
		kill -TERM -- "-$pg" 2>/dev/null || true
		for _ in $(seq 1 10); do kill -0 -- "-$pg" 2>/dev/null || break; sleep 1; done
		kill -KILL -- "-$pg" 2>/dev/null || true
		log "stopped $name dev server (process group $pg)"
	fi
	rm -f "$STATE_DIR/$name.pgid"
done

case "$(engine_mode)" in
	image)
		if engine_is_ours; then
			docker logs "$ENGINE_NAME" 2>&1 | scrub_keys >"$STATE_DIR/engine-last.log" || true
			docker rm -f "$ENGINE_NAME" >/dev/null 2>&1 && log "removed engine container $ENGINE_NAME"
		elif docker inspect "$ENGINE_NAME" >/dev/null 2>&1; then
			log "container $ENGINE_NAME exists but is not marked as ours; left alone"
		fi
		;;
	source)
		run_id="$(cat "$STATE_DIR/engine.run")"
		pid="$(source_pid)"
		if [[ -x "$LAUNCHER" ]]; then
			"$LAUNCHER" stop --id "$run_id" >&2 || log "the launcher could not stop run $run_id"
		elif [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
			# The launcher made the engine a process-group leader; end only that group.
			kill -TERM -- "-$pid" 2>/dev/null || true
			sleep 5
			kill -KILL -- "-$pid" 2>/dev/null || true
			log "stopped engine process group $pid"
		fi
		engine_log="$ROOT/.verify/$run_id/engine.log"
		if [[ -f "$engine_log" ]]; then
			scrub_keys <"$engine_log" >"$STATE_DIR/engine-last.log"
			cp "$STATE_DIR/engine-last.log" "$engine_log"
		fi
		;;
esac
rm -f "$STATE_DIR/engine.mode" "$STATE_DIR/engine.run" "$STATE_DIR/engine.container" "$STATE_DIR/engine.json" "$STATE_DIR/run.json"
rm -f "$SHELL_WRAPPER" "$UI_WRAPPER"
rmdir --ignore-fail-on-non-empty "$(dirname "$SHELL_WRAPPER")" "$(dirname "$UI_WRAPPER")" 2>/dev/null || true
log "clean. Evidence kept under $EVIDENCE_ROOT"
