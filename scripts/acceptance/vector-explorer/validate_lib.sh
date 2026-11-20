# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
# The step runner of validate_all.sh (sourced; selftest/test_validate_all.py
# runs it on its own). Expects LOGS, SUMMARY and CONSTANTS to be set and
# STEPS/FAILED to be counters.

# Run one step: log to $LOGS/<name>.log, record its exit status in $SUMMARY.
# The builder rewrites $CONSTANTS during builds: a step that changed it gets it
# back exactly as it was before the step (an uncommitted edit included, never
# the committed version), and SUMMARY says so. Nothing else is touched.
step() {
	local name=$1; shift
	local before="$LOGS/.constants-before-step"
	local had=0
	if [ -f "$CONSTANTS" ]; then cp -p "$CONSTANTS" "$before" && had=1; fi
	"$@" > "$LOGS/$name.log" 2>&1
	local rc=$?
	printf '%-28s exit=%s\n' "$name" "$rc" | tee -a "$SUMMARY"
	if [ "$had" = 1 ] && ! cmp -s "$CONSTANTS" "$before"; then
		cp -p "$before" "$CONSTANTS"
		printf '%-28s restored %s to its content before this step\n' '' "$CONSTANTS" | tee -a "$SUMMARY"
	fi
	rm -f "$before"
	STEPS=$((STEPS + 1))
	if [ "$rc" -ne 0 ]; then FAILED=$((FAILED + 1)); fi
}
