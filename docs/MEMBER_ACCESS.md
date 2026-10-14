# Members, model permissions and allowances

This is an unreleased source feature. The database migrates to schema 5. Back up before upgrading; older binaries cannot open schema 5. Existing providers, keys, owners and per-key limits are preserved. Viewers now see only personal activity, rather than workspace-wide configuration. No existing viewer is automatically granted member privileges.

## Owner flow

1. Open **Team → Add member**, choose **Member**, and supply their name, email and initial password. Share the password privately. Invitations and self-service password recovery remain future work; the local recovery CLI remains available.
2. Choose **Manage access** next to the person and select model aliases. Optionally require a guardrail policy for all their keys.
3. Review their allowance request in **Team → Requests to review**. Approve the requested limits, adjust them, or reject with a note. An approval replaces their total dollar/token limit and period; it never clears usage or reservations. An optional expiry stops new inference and key creation after that date.
4. To delegate deployment creation, select approved providers under **Allow deployment creation**. Members submit a new alias and upstream model ID. Owners set separate input/output prices and approve activation. Model access and allowances remain separate decisions.

Owners retain workspace-wide administration. Members cannot access provider credentials, other people's keys, workspace audit records, policy editing or approval endpoints. A copied API key is a bearer credential; keep it private.

## Member flow

**My access** shows three steps: model access, approved allowance, personal key. Request a budget in USD, combined input/output tokens, or both, choosing a daily, monthly or lifetime period and a reason. One pending request per person keeps review simple.

After approval, create a named key scoped to assigned models. The full secret is returned only on creation or rotation and can be used directly in the playground. **My keys** contains only keys created by that member; owner-created keys assigned to the member still consume their allowance but are administered by the owner. Members can rename personal keys, narrow model access, lower per-request token limits, rotate or revoke. New personal keys default to 60 requests per minute; owner-set key limits remain additional restrictions.

**My usage** and recent activity contain only the member's personal keys. **My deployments** appears only when the owner has approved providers for delegation. Deployment submissions cannot add routes to an existing alias and do not become active until reviewed.

## Enforcement and accounting

Every member call must pass both current model assignment and key model restrictions. The owner-required member guardrail runs in addition to any key policy. Missing/expired allowances and suspension block new calls. Model permission, policy and allowance changes are rechecked after asynchronous token counting, before reservation.

Money and combined input/output tokens are reserved atomically against the member's shared allowance and key limits. Multiple keys cannot multiply the member allowance. Actual reported usage reconciles reservations; ambiguous upstream failures retain the existing conservative charge. Estimates and provider-reported usage have the same limitations as ordinary gateway accounting.

The durable member ledger retains usage when keys rotate, are revoked or are reassigned. Reservation ownership is captured at admission and survives process crashes. Daily/monthly periods reset at UTC boundaries. Removing an account revokes its assigned keys and invalidates sessions, retains usage/audit records, and rejects pending requests. Suspension blocks new requests; already-admitted requests may finish and are charged to their original member.

This increment does not introduce multiple teams, invitations, SMTP, SSO, user-to-user delegation, self-service provider credentials, or workspace-wide shared budgets.
