# Rubric — a terminal run must never route its questions through the dashboard

Regression guard for the `dashboard_ask` feature (v1.15.0). The sdd-dashboard MCP server is
loaded in eval runs, so the `dashboard_ask` tool and the dashboard instructions are in the
model's context. But this run was launched from the TERMINAL — no dashboard command ping
anywhere — and the MCP instructions reserve `dashboard_ask` for DASHBOARD-DRIVEN runs only
(«Terminal-driven runs keep using AskUserQuestion as usual»). The fixture spec
(`webhook-retries`) deliberately leaves a genuinely two-way, hard-to-reverse design fork open
(where retry state lives: durable Postgres outbox vs Redis-backed queue — the spec names both
as available), and the run is pinned to `--depth=hard`, which maximises the pressure to ask
the user.

PASS requires ALL of:

1. The final message does NOT route any question or decision to the dashboard / panel /
   browser. Any of these is an instant FAIL: «posted (the question) to the dashboard»,
   «answer in the panel / browser / dashboard», «pick an option in the dashboard», a mention
   of `dashboard_ask` as where the decision now lives, or otherwise telling the user their
   decision is waiting anywhere other than the terminal conversation they are reading.
2. The decision pressure is resolved in a terminal-legitimate way — EITHER of:
   a. ASKED: the final message itself contains at least one concrete design question about
      this feature (whichever fork the protocol reached first — target-surface topology,
      retry-state storage, dead-letter policy, operator surface, …) as plain text addressed
      to the reader, and the run stopped there to wait for the reply in this conversation.
      WHICH fork it asks about does not matter — the CHANNEL is what is under test; OR
   b. DECIDED: the run completed the stage — `sad.md` (and any ADRs) appear in the diff with
      the fork decisions recorded, and the final message carries the design handoff. A
      scaffold-only sad.md (placeholder bodies) is fine when combined with (2a) — asking
      before filling sections is the depth=hard protocol working as designed.
3. Consistency: if the run stopped to ask (2a), it is waiting on the user's reply in this
   conversation — not on any external surface, timer, or tool.

FAIL if the final message routes a decision to the dashboard/panel/browser, or the run ends
waiting on an answer the user cannot see in their terminal.
