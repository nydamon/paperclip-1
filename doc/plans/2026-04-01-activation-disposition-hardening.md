# Activation & Disposition Hardening Plan

## Problem

Paperclip currently allows a critical issue to show a technically successful run without guaranteeing that the assignee answered the supervisory instruction, refreshed the blocker, or advanced the issue to the correct next state.

This creates a misleading pattern:
- board/Hermes posts a direct instruction
- the assignee wakes and produces one or more runs
- one run may succeed
- the issue remains `blocked` or otherwise semantically unresolved
- the board still does not know whether the lane is blocked, review-ready, or silently abandoned

This is an activation/disposition defect, not just a prompt-quality problem.

## Live failure pattern to harden against

Example class:
1. Issue comment asks the assignee to choose between explicit branches such as:
   - `(a)` post evidence and request `in_review`
   - `(b)` name the specific deployment dependency
2. The assignee later records a successful run.
3. No clear branch-answering disposition comment appears.
4. The issue remains `blocked` with stale board truth.

A green run should not be treated as successful coordination in this case.

## Root causes

### 1. Missing supervisory response contract
The current system allows an agent to execute work without explicitly answering the latest board/Hermes instruction.

### 2. Missing adoption/disposition receipt
Assignment/comment wakeups do not require a short board-visible statement that the task was adopted and what branch/status now applies.

### 3. Run success is overloaded
The UI exposes run success/failure, but not whether the run actually resolved the issue-level ask.

### 4. `blocked` state can drift stale
An issue can remain `blocked` without a fresh blocker explanation tied to the latest run.

## Hardening goals

1. Detect activation failures quickly.
2. Require a board-visible adoption/disposition signal for critical issue work.
3. Distinguish technical run success from semantic issue disposition success.
4. Prevent `blocked` from acting as a silent holding pen.
5. Surface the wake source and any unresolved directive mismatch.

## Proposed implementation

### A. Adoption receipt SLA
For critical non-terminal issues, require a first visible adoption/disposition signal within a short SLA after:
- assignment
- re-open
- same-owner retrigger
- issue comment wake

Valid signals:
- explicit assignee comment
- system-generated adoption receipt tied to run start

If no signal appears, classify as activation failure.

### B. Directive-resolution tracking
When the latest supervisory comment contains a direct ask or explicit branch structure, create a lightweight pending-directive record for the issue.

A directive is considered resolved only when a subsequent assignee/system comment states:
- chosen branch or direct answer
- current status recommendation
- exact blocker or evidence
- next owner or next step

If the assignee run finishes without resolving the directive, record a directive-mismatch signal.

### C. Separate run status from disposition status
Keep current run outcome, but add an issue-level disposition signal such as:
- `directive_answered`
- `blocked_with_current_reason`
- `advanced_to_next_state`
- `semantic_incomplete`

This makes “run succeeded” distinct from “lane truth updated”.

### D. Blocked-state hygiene
Require `blocked` issues to carry fresh blocker metadata:
- blocker reason class
- blocker text
- blocker confirmed at timestamp
- blocking owner/dependency if known

A successful assignee run that leaves the issue `blocked` must refresh this information.

### E. Wake-source observability
Expose whether the latest activation came from:
- assignment
- comment on assigned issue
- mention
- watchdog retry
- manual board retrigger
- routine/timer

This lets the board distinguish organic pickup from rescue paths.

### F. Watchdog rule for semantic incompleteness
Add an observe-only watchdog rule that flags:
- latest assignee run succeeded
- issue remained in the same non-terminal state
- no disposition comment or blocker refresh followed

This should produce an activity event and UI-visible warning before later automated remediation is considered.

## Minimum viable implementation order

### Phase 1 — policy + observe-only detection
1. Harden `AGENTS.md` with explicit disposition rules.
2. Add server-side detection for “successful run with no disposition refresh”.
3. Surface an observe-only warning/event in issue activity.

### Phase 2 — stronger control-plane enforcement
4. Add adoption-receipt SLA watchdog.
5. Add structured blocked metadata.
6. Add directive-resolution tracking and mismatch classification.

### Phase 3 — optional auto-recovery
7. Allow one bounded same-owner re-wake when activation/disposition SLA fails.
8. Escalate visibly if the second attempt still produces no valid disposition.

## Acceptance criteria

The hardening is successful when all are true:
- A direct supervisory instruction on a critical issue is answered explicitly in the thread or flagged as unresolved.
- A successful run no longer silently leaves a lane semantically unresolved.
- `blocked` issues carry current blocker truth.
- The board can distinguish assignment, wake, execution, and disposition as separate stages.
- Manual same-owner retriggers become a recovery exception rather than the normal control path.
