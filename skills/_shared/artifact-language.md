# Artifact language — the `artifact_language` switch (prose ↔ structure)

> **Reference-only.** Not a skill. Every artifact-writing skill reads this for the one rule of
> the `artifact_language` key in `.claude/sdd.local.md` (defined in
> [`../implement/references/settings.md`](../implement/references/settings.md), default `en`):
> **prose switches language, structure stays English.** Conversation language (questions +
> option text) is a separate concern → [`ask-style.md`](./ask-style.md).

## The rule

Write the **prose** of every pipeline document in the configured language; keep the **structure**
English, verbatim from the template. Concretely:

- **Prose (switches):** paragraphs, list items, table cells, Mermaid node/edge/participant *labels*,
  ADR context/rationale/consequences, review + fix findings, changelog and PR body text, the prose
  fields of `tasks.json` (`title`, `dod`) and of `openapi.yaml` (`summary`, `description`).
- **Structure (stays English):** section headings (verbatim from the template), frontmatter keys
  **and** values, file names, and every machine token listed below.
- **The setting never leaks into artifacts:** `artifact_language` lives in `.claude/sdd.local.md`
  only. Never write it (or any other settings key) into a document — an artifact's frontmatter
  keys come **verbatim from its template**, no improvised keys in any language.

## Never translate

These are parsed by the dashboard's state derivation, the implement engine, or downstream skills —
translating one silently breaks the pipeline:

- Headings the state derivation reads: `## Shipped` (roadmap), `## Test plan` (spec), `## Glossary`
  (CONTEXT.md) — and every other template heading, as a class.
- Review verdict literals: `PASS`, `CHANGES REQUESTED`, `REVIEW_CLEAN`.
- Tracker states `todo / in_progress / review / done` and task ids `T<n>`.
- Frontmatter keys + values (`status: approved`, `test_cmd`, `reflects_commit`, `target_surfaces`, …)
  and the `.size` / `.route` token files.
- Mermaid keywords (`sequenceDiagram`, `participant`, `alt/else/end`, …) and diagram identifiers that
  name real modules / files / endpoints — labels translate, names don't.
- `tasks.json` machine fields (`id`, `layer`, `deps`, `acs`, `files_hint`, `slug`) and OpenAPI
  paths / `operationId` / status codes / schema names.
- ADR `Status:` values (`Proposed`, `Accepted`, `Deprecated`, `Superseded`).

Code, tests, test names, commit messages and branch names are **always English** — outside this
key's scope entirely.

## Precedence (editing vs creating)

1. **An existing file's language wins over the setting** — a skill that edits a document
   (`clarify`, `sequences`, `fix`, …) matches what's already on the page.
2. **A new file matches its feature-folder neighbours** — don't start a second language mid-feature.
3. Only a genuinely fresh start reads the setting. **Never retro-translate** an existing artifact.

## Agent reports

A skill dispatching a report-writing subagent carries the language in the **dispatch prompt** — e.g.
«Write your report's prose in Ukrainian; keep identifiers, file paths and verdict literals as-is.»
The skill's own pass is the backstop; `agents/*.md` stay language-neutral.

## Template comments

`<!-- … -->` comments in `skills/*/templates/*.md` are the generation contract, not content — they
are **never copied into the output in any language**.
