# Security model

**Threat model headline: the agent is untrusted.** It executes model-chosen commands on model-chosen inputs, and repository/task content is untrusted input *to* the agent. Protection is capability limitation, not trusting the model to behave (design doc §12).

## Boundaries

- **Process privileges.** The frontend (nginx) and api have no Docker socket; only the worker holds it. api, worker, postgres and redis publish no host ports — the single public origin is the nginx proxy on `:3000`. Compromise of the public frontend ≠ database access; compromise of the api ≠ host code execution.
- **Sandboxes.** Each agent step runs in its own sandbox (Docker container per step, or child process in dev), bind-mounted only to its flow's git worktree. Network policy per project: `full`, `llm-only`, or `none`. Resource limits (memory/cpu/pids) and a wall-clock timeout apply.
- **Credentials.**
  - Project secrets are AES-256-GCM encrypted at rest (`AGENTFORGE_SECRET_KEY`), write-only over the API, decrypted only in worker memory at provisioning time, and scrubbed from event payloads before they are persisted.
  - **Agents never hold push credentials** — branch pushes and PR creation happen in the Scm context, worker-side.
  - PATs are stored SHA-256-hashed and shown exactly once. Sessions are opaque tokens (SHA-256 at rest), HttpOnly, SameSite=Lax.
- **Audit.** `run_events` and `outbox_events` are append-only twice over: the app DB role has no UPDATE/DELETE grants (outbox: a column-grant for `dispatched_at` only), and triggers reject mutations even for the admin role. App-level SQL compromise cannot rewrite history.
- **Auth surface.** Login/registration are rate-limited (10/min/IP). The single-origin proxy leaves no CORS surface.

## Recommended practice

- Put a `gate.human` node before `action.open_pr` in any workflow triggered by external task sources (the "gated" template ships for this) — a prompt-injected agent then cannot open a PR without a human look at the diff.
- Use `allowedCommands` in project settings to allow-list what runs without a permission gate; everything else pauses the run for approval.
- For fully offline operation use the `api-loop` adapter against a local model with `SANDBOX_NETWORK_DEFAULT=none`.

## Reporting

This is a self-hosted tool; there is no bug-bounty program. Please open a private security advisory or issue on the repository.
