#!/usr/bin/env bash
# Tears down only what rr-verify-agent started. Evidence is never touched.
# Usage: rr-verify-agent cleanup
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scrub_keys() { sed -E -e 's/sk-ant-[A-Za-z0-9_-]{8,}/[redacted]/g' -e 's/sk-(proj-)?[A-Za-z0-9_-]{16,}/[redacted]/g'; }

for name in shell rocket-ui; do
	if pg="$(dev_group "$name")"; then
		kill -TERM -- "-$pg" 2>/dev/null || true
		left=1
		for _ in $(seq 1 10); do kill -0 -- "-$pg" 2>/dev/null || { left=0; break; }; sleep 1; done
		((left)) && { kill -KILL -- "-$pg" 2>/dev/null || true; }
		log "stopped $name dev server (process group $pg)"
	elif [[ -f "$STATE_DIR/$name.pgid" ]]; then
		log "the $name dev server launch recorded is gone (or its pid now belongs to another process); nothing signaled"
	fi
	rm -f "$STATE_DIR/$name.pgid"
done

case "$(engine_mode)" in
	image)
		# A container id is never reused, so the recorded one is the container launch started, running or not.
		id="$(cat "$STATE_DIR/engine.container" 2>/dev/null)"
		if [[ -n "$id" ]] && docker inspect "$id" >/dev/null 2>&1; then
			docker logs "$id" 2>&1 | scrub_keys >"$STATE_DIR/engine-last.log" || true
			docker rm -f "$id" >/dev/null 2>&1 && log "removed engine container ${id:0:12}"
		elif docker inspect "$ENGINE_NAME" >/dev/null 2>&1; then
			log "container $ENGINE_NAME is not the one launch started; left alone"
		fi
		;;
	source)
		run_id="$(cat "$STATE_DIR/engine.run")"
		# The launcher stops the pid in its run record; forward that only while it is the process launch started.
		if pid="$(owned_pid "$STATE_DIR/engine.pid")" && [[ "$pid" == "$(source_pid)" ]]; then
			if [[ -x "$LAUNCHER" ]]; then
				"$LAUNCHER" stop --id "$run_id" >&2 || log "the launcher could not stop run $run_id"
			else
				# The launcher made the engine a process-group leader; end only that group.
				kill -TERM -- "-$pid" 2>/dev/null || true
				sleep 5
				kill -0 -- "-$pid" 2>/dev/null && { kill -KILL -- "-$pid" 2>/dev/null || true; }
				log "stopped engine process group $pid"
			fi
		else
			log "the engine of run $run_id is gone (or its pid now belongs to another process); nothing signaled"
		fi
		engine_log="$ROOT/.verify/$run_id/engine.log"
		if [[ -f "$engine_log" ]]; then
			scrub_keys <"$engine_log" >"$STATE_DIR/engine-last.log"
			cp "$STATE_DIR/engine-last.log" "$engine_log"
		fi
		;;
esac
rm -f "$STATE_DIR/engine.mode" "$STATE_DIR/engine.run" "$STATE_DIR/engine.container" "$STATE_DIR/engine.pid" "$STATE_DIR/engine.json" "$STATE_DIR/run.json" "$STATE_DIR/fallback.txt"
rm -f "$SHELL_WRAPPER" "$UI_WRAPPER"
rmdir --ignore-fail-on-non-empty "$(dirname "$SHELL_WRAPPER")" "$(dirname "$UI_WRAPPER")" 2>/dev/null || true
log "clean. Evidence kept under $EVIDENCE_ROOT"
