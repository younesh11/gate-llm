# Members, model permissions and allowances

Member access was introduced in SQLite schema 5. Admin roles add SQLite schema 8 / PostgreSQL application migration 4 (unreleased). Back up before upgrading; older binaries cannot open the current schema. Existing providers, keys, owners and per-key limits are preserved. Viewers now see only personal activity, rather than workspace-wide configuration. No existing viewer is automatically granted member privileges.

## Roles and manager access

| Capability | Owner | Admin | Member / Viewer |
| --- | --- | --- | --- |
| Providers, deployments, guardrails and all workspace keys | Yes | Yes | No; members can submit deployments when granted access |
| Workspace usage and activity | Yes | Yes | Personal records only |
| Invite and manage members/viewers; approve allowances | Yes | Yes | No |
| Invite admins; change roles; suspend/remove admins | Yes | No | No |
| Workspace name, notification settings and delivery history | Yes | No | No |

**Invite a manager:** as Owner, open **Team → Invite person → Admin**. Send or copy the one-time invitation. The manager sets their password and sees the operational dashboard. There are no public signups.

**Promote an existing person:** open **Team → Change role → Admin → Save role**. Use the same flow to demote to Member or Viewer. Owner accounts cannot be promoted, demoted, suspended or deleted through these routes. No existing account is automatically promoted. Viewer accounts cannot use model APIs, including through keys assigned to them.

Role changes sign the person out, revoke personal/assigned keys and their pending invitations, cancel pending personal notifications and invitation delivery and close pending allowance/deployment requests. Existing assignments, approved allowances and usage are retained. Workspace application keys are independent of their creator and remain active; rotate those keys separately if the person should no longer possess them. Already-admitted inference requests may finish. Changes are audited.

Admin is a trusted workspace-wide role: admins can create application keys, change budgets and guardrails, and operate every deployment. It is not a restricted departmental manager role. Only Owners can grant or remove that authority. Suspended admins cannot sign in, use assigned keys or issue valid invitations.

## Owner and Admin flow

1. Open **Team → Invite person**, enter their name and email, and choose **Member**. Optionally assign model access and a guardrail policy. Copy the invitation link or send it through configured email delivery. The link expires after 24 hours; the recipient sets their own password, then signs in normally. Self-service password recovery remains future work; the local recovery CLI remains available.
2. Choose **Manage access** next to the person and select model aliases. Optionally require a guardrail policy for all their keys.
3. Review their allowance request in **Team → Requests to review**. Approve the requested limits, adjust them, or reject with a note. An approval replaces their total dollar/token limit and period; it never clears usage or reservations. An optional expiry stops new inference and key creation after that date.
4. To delegate deployment creation, select approved providers under **Allow deployment creation**. Members submit a new alias and upstream model ID. Owners or Admins set separate input/output prices and approve activation. Model access and allowances remain separate decisions.

Owners retain workspace-wide administration. Members cannot access provider credentials, other people's keys, workspace audit records, policy editing or approval endpoints. A copied API key is a bearer credential; keep it private.

## Member flow

**My access** shows three steps: model access, approved allowance, personal key. Request a budget in USD, combined input/output tokens, or both, choosing a daily, monthly or lifetime period and a reason. One pending request per person keeps review simple.

After approval, create a named key scoped to assigned models. The full secret is returned only on creation or rotation and can be used directly in the playground. **My keys** contains only keys created by that member; owner-created keys assigned to the member still consume their allowance but are administered by the owner. Members can rename personal keys, narrow model access, lower per-request token limits, rotate or revoke. New personal keys default to 60 requests per minute; owner-set key limits remain additional restrictions.

**My usage** and recent activity contain only the member's personal keys. **My deployments** appears only when the owner has approved providers for delegation. Deployment submissions cannot add routes to an existing alias and do not become active until reviewed.

## Enforcement and accounting

Every member call must pass both current model assignment and key model restrictions. The owner-required member guardrail runs in addition to any key policy. Missing/expired allowances and suspension block new calls. Model permission, policy and allowance changes are rechecked after asynchronous token counting, before reservation.

Money and combined input/output tokens are reserved atomically against the member's shared allowance and key limits. Multiple keys cannot multiply the member allowance. Actual reported usage reconciles reservations; ambiguous upstream failures retain the existing conservative charge. Estimates and provider-reported usage have the same limitations as ordinary gateway accounting.

The durable member ledger retains usage when keys rotate, are revoked or are reassigned. Reservation ownership is captured at admission and survives process crashes. Daily/monthly periods reset at UTC boundaries. Removing an account revokes its assigned keys and invalidates sessions, retains usage/audit records, and rejects pending requests. Suspension blocks new requests; already-admitted requests may finish and are charged to their original member.

This increment does not introduce multiple teams, SMTP, SSO, user-to-user delegation, self-service provider credentials, or workspace-wide shared budgets.
