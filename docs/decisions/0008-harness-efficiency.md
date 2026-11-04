# ADR-0008 — Harness efficiency mechanisms (from SoL-Pi), measured and switchable

- **Status:** accepted (4 Nov 2026, KK approval; Architect under D10). Applies to M1.1, M1.5, M3.1, M3.2, M3.3, M4.4, M6.4.
- **Context:** SoL-Pi (arXiv 2609.20519; NVIDIA, NTU, MIT) kept model and benchmark fixed and changed only the harness: 50–54% lower list-price API cost than native Codex/Claude Code on EdgeBench, and versus Pi 45–49% fewer tokens and about a third lower cost while keeping about 94% of Pi's score. Per mechanism (GPT-5.6 Sol, versus Pi): action fusion −11.9% tokens, +4.1% score; online compaction −40.2% tokens, −6.3% score; evidence-preserving reducer −10.0% tokens, −0.5% score; ObservationPack −6.1% tokens, +5.3% score. Only the method is adopted; no SoL-Pi code is lifted.
- **Decision:**
  1. **Token-waste telemetry (M1.5):** per run and turn, record input/output/cache tokens, context size, tokens per tool result, output bytes per command, and repeated identical calls.
  2. **Action fusion (M3.2):** a DevOS-owned Builder tool `edit_and_check` applies an edit and runs the module contract's declared test command in one call, returning one combined result. Opt-in per call; plain Edit stays for intermediate edits.
  3. **Output archive (M3.1):** command output over 10 KiB is stored in the run's artifact store. It is shown in full for the next two model requests, then replaced by a handle, its size, and head/tail excerpts. `artifact_page` and `artifact_grep` tools fetch exact pages.
  4. **Evidence-preserving log reader (M3.3, M4.4):** for build/test/runtime logs of 4 KiB or more from declared commands, Haiku writes a receipt (verdict, exit code, failing test names, exact quoted lines). A deterministic verifier checks schema, source hash, exit code and that every quote appears verbatim in the source. On any failure, suspected secret, or no size saving, the full log is used instead.
  5. **No online compaction.** One-session sub-issues plus handoffs (D10) are the compaction strategy.
  6. **Frozen eval set and tuning loop (M6.4):** see guards.
- **Guards:**
  - **Baseline first:** the quality guard metrics are recorded over the first 20 real P3 tasks with every mechanism off, before any is switched on.
  - **Quality guard metrics:** first-round Codex PASS rate, CI green on the first attempt, Opus escalation rate, deadlocks, rollbacks. Tolerance (Architect default, editable setting): no metric worse than baseline by more than 5 percentage points over a rolling 20 tasks. A breach switches the mechanism off for that role and raises a card.
  - **Per-role flags:** each mechanism has an on/off setting per role (DV-FR-006 settings page).
  - **Gates never read a model-written receipt.** The merge gate, Release, the Tester's pass/fail and dashboard status read raw exit codes and stored evidence (DV-NFR-07).
  - **One mechanism at a time:** enable in order telemetry → archive → fusion → log reader, each measured against the baseline before the next.
  - **Tuning changes are ordinary changes:** M6.4 proposes, but every harness change goes through PR, CI, Codex PASS and KK approval. The optimiser can never promote itself.
- **Consequences:** expected −15% to −30% tokens and −10% to −25% cost per Builder/Tester task (inference, to be measured; savings do not simply add up, and the paper saw lower trigger rates on Opus). Work folds into existing modules plus M6.4.
