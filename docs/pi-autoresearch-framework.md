# PI-AUTORESEARCH TEAM EXPERIMENT FRAMEWORK

This document defines the REQUIRED operating standard for running experiments using pi-autoresearch.

This is not optional. This is how we avoid noise, wasted time, and fake improvements.

---

# 1. CORE PRINCIPLES

1. One experiment = one question
2. One experiment = one primary metric
3. All runs must be comparable
4. No promotion without validation
5. Guardrails are mandatory for production-impacting work

---

# 2. EXPERIMENT BRIEF (REQUIRED BEFORE START)

Every experiment must include:

## Experiment ID
Format: VRQ-<area>-<metric>-<yyyymmdd>-<owner>

## Goal
Single sentence describing the outcome

## Primary Metric
- Name
- Direction (higher/lower)
- Exact definition

## Secondary Metrics
(Optional, do not optimize against these)

## Benchmark Command
Exact command used for all runs

## Allowed Scope
List of files that may be modified

## Frozen Inputs
- dataset/version
- model/version
- environment
- seed strategy
- timeout

## Checks
List of conditions that must not break

## Success Threshold
- Minimum improvement (e.g. 3%)
- Promotion threshold (e.g. 5%)

---

# 3. ITERATION POLICY (MANDATORY)

Every experiment MUST define:

- Max Turns
- Time Budget
- Early Stop Condition

## Standard Defaults

### Standard Experiments
- Max Turns: 50
- Time Budget: 30 minutes
- Early Stop: 10 non-improving runs

### Deep Optimization
- Max Turns: 100
- Time Budget: 60 minutes
- Early Stop: 15 non-improving runs

### Exploratory
- Max Turns: 30
- Time Budget: 20 minutes
- Early Stop: 5 non-improving runs

## Termination Rule

Stop when ANY condition is met:

1. Max turns reached
2. Time budget exceeded
3. Early stop triggered
4. No improvement >1% over last 10 runs

---

# 4. REQUIRED REPO STRUCTURE

/experiments
  /<experiment-id>
    README.md
    autoresearch.md
    autoresearch.sh
    autoresearch.checks.sh
    autoresearch.ideas.md
    baseline.json
    notes.md

---

# 5. FILE RESPONSIBILITIES

## README.md
Human-readable experiment brief

## autoresearch.md
Instructions and constraints for the agent

## autoresearch.sh
Canonical benchmark runner

Must:
- Output primary metric
- Use fixed inputs
- Be deterministic where possible

## autoresearch.checks.sh
Guardrails

Must fail if:
- Output invalid
- Schema broken
- Safety violation

## autoresearch.ideas.md
Optional backlog of ideas

## baseline.json
Stores baseline values

## notes.md
Human interpretation

---

# 6. BENCHMARK DESIGN STANDARD

All benchmarks MUST:

- Use fixed dataset
- Use fixed runtime conditions
- Be reproducible
- Complete within defined time budget

Must output:
- Primary metric
- Runtime
- Secondary metrics
- Pass/fail checks

---

# 7. TEAM RULES

## Rule 1: One Metric Only
No multi-objective optimization in a single experiment

## Rule 2: Fixed Runtime
All runs must use the same runtime constraints

## Rule 3: Narrow Scope
Do not allow broad system changes

## Rule 4: Checks Required
Production experiments must include checks

## Rule 5: No Manual Bias
Do not override results based on opinion

## Rule 6: Reproducibility Required
Winning result must be reproducible

---

# 8. PROMOTION POLICY

Promote ONLY if:

- Metric improvement exceeds threshold
- All checks pass
- No major regression in secondary metrics
- Result reproduced

## Suggested Thresholds

- <2%: ignore
- 2–5%: rerun
- >5%: candidate for promotion

---

# 9. REQUIRED REPORTING

Every experiment must report:

- Total turns executed
- Total runtime
- Best metric achieved
- Improvement vs baseline
- Turn number of best result

---

# 10. EXPERIMENT CATEGORIES

## Retrieval
Optimize:
- answer accuracy
- grounding quality

## Prompt
Optimize:
- response quality
- instruction adherence

## Safety
Optimize:
- hallucination rate
- unsafe outputs

## Latency
Optimize:
- response time

## Cost
Optimize:
- cost per interaction

---

# 11. WEEKLY OPERATING CADENCE

## Monday
Define experiments

## Tuesday–Wednesday
Run experiments

## Thursday
Review results

## Friday
Decide:
- Promote
- Rerun
- Archive

---

# 12. NON-NEGOTIABLE RULES

No experiment may run unless:

- Primary metric defined
- Benchmark command fixed
- Scope defined
- Iteration policy defined
- Baseline recorded
- Checks defined (if applicable)

---

# FINAL NOTE

This system only works if discipline is enforced.

If you allow:
- inconsistent benchmarks
- undefined metrics
- uncontrolled iteration

You will get meaningless results.

If you follow this:
You will systematically improve your system.

