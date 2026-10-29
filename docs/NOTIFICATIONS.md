# Invitations and integrated notifications

GATE includes invite-only onboarding, a private notification inbox and a durable delivery queue. No external cron job is needed. PostgreSQL is the intended team deployment; SQLite supports the same flow for local evaluation.

## Team onboarding

1. Configure `PUBLIC_BASE_URL` to the exact origin recipients will visit. Example local setting: `http://localhost:4310`; shared installations require HTTPS, such as `https://gateway.example.com` or `https://YOUR_IP:8443` with a trusted IP certificate.
2. Sign in as Owner or Admin and open **Team → Invite person**. Enter name/email, choose Member or Viewer, and optionally assign model aliases and a required guardrail policy. Owners can also choose Admin, granting full operational management on acceptance.
3. Copy the private link once, or select **Send invitation by email** if SES is configured.
4. The recipient opens the link, sets and confirms their own password, then signs in normally.
5. Members request an allowance; Owners or Admins approve it in Team. Members receive no budget, deployment permissions or API key automatically.

The former `POST /api/admin/users` password-creation route now returns HTTP 410 (`invitation_required`). Existing accounts and sessions are preserved. Invitations cannot grant owner status or replace an existing account. This is an intentional API behavior change for clients that previously provisioned accounts with an initial password.

Links expire after 24 hours and are single-use. Regenerating invalidates the old link; revocation and acceptance cancel pending delivery jobs. A request already handed to an email service cannot be recalled, but revoked links remain unusable. Deleted/suspended issuers, issuers without the required role, expired links, missing grants, and existing accounts prevent acceptance. Inspection and email link previews do not consume invitations.

Tokens have 256 random bits; only their hash is stored in the invitation record. For automatic email delivery, the pending message temporarily contains an **encrypted** link using the gateway encryption key. That encrypted payload is deleted after acceptance by the provider, terminal failure, or cancellation. Backups may retain historical encrypted payloads; protect backups and encryption keys together. A failed invitation should be regenerated to retry delivery.

The token travels in the URL fragment, is removed from browser history on load, and is sent to the backend only in JSON POST bodies. Invitation pages set no-referrer, no-store and a restrictive CSP. Request logs omit bodies, raw URLs and error details. Tokens are never included in SNS notifications. Manually forwarding a link transfers the ability to claim that account: it proves link possession, **not independent ownership of the email address**.

## Delivery configuration

```dotenv
PUBLIC_BASE_URL=https://gateway.example.com
COOKIE_SECURE=true
# Trust only your own reverse-proxy address/network; never use a broad internet range.
TRUSTED_PROXY_CIDRS=172.30.0.2/32
NOTIFICATION_EMAIL_FROM=gate@example.com
NOTIFICATION_AWS_REGION=eu-west-2
# Optional shared administrator budget notifications, not individual invitations.
NOTIFICATION_SNS_TOPIC_ARN=arn:aws:sns:eu-west-2:123456789012:gate-budget-alerts
```

These settings are passed through both Compose configurations. Change `PUBLIC_BASE_URL` when changing the external port or domain. The origin must not contain a path, query, credentials or fragment. GATE does not construct invitation links from request Host headers. When moving to a new origin, regenerate pending invitations if recipients can no longer use the old address.

AWS credentials come from the standard server identity chain (prefer the EC2 IAM role). No notification API credentials are exposed in the dashboard. SES requires a verified sender identity and appropriate `ses:SendEmail` permissions; SES sandbox accounts also restrict recipients. SNS requires `sns:Publish` permission for the configured standard topic in the selected region. Consult [SES SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html) and [SNS Publish](https://docs.aws.amazon.com/sns/latest/api/API_Publish.html). SES API delivery is implemented; SMTP is not included in this increment.

Leave email and SNS configuration empty for in-app-only operation. Configure server channels first, then enable budget email/SNS in **Settings → Notifications**. Configuring SES alone does not automatically send invitation email; Owners or Admins choose that action for each invitation.

Reverse proxies must strip untrusted forwarded headers and set their own. Set `COOKIE_SECURE=true` for HTTPS; cookie hosts are not isolated by port, so use a distinct hostname for production services and avoid hosting untrusted apps on the same host. Keep first-owner bootstrap private; existing Compose remote-setup behavior is not a substitute for a deployment bootstrap policy.

## Budget and allowance alerts

- Default thresholds: 70%, 90%, 100%; owners can configure up to five percentages.
- Monitor currency budgets and combined input/output token caps for individual keys and shared member allowances.
- Notify workspace Owners and Admins, optionally the affected member / assigned key owner, and optionally the administrator SNS topic.
- Allowance requests notify Owners and Admins; approval/rejection notifies the requesting member. These inbox updates work even when budget threshold notifications are disabled.
- Mark individual messages or the whole personal inbox as read. Members cannot access another user's notifications or delivery history.
- Delivery history is owner-only. **Accepted** means the transport acknowledged the message, not that the recipient received/read it. Bounce/complaint webhooks and inbox-delivery confirmation are not implemented.

Deduplication includes subject, metric, configured limit, threshold and UTC budget period. A new daily/monthly period can alert again. Changing the numeric limit creates a new threshold series. A leap across multiple thresholds creates each crossed alert. Usage is not erased. Free models still trigger token alerts when a token cap exists.

Usage settlement inserts a small pending marker in the same transaction as billing. A background worker reads durable usage totals, records inbox events and delivery jobs transactionally, and clears that marker. External sending never happens inside a model request or a database transaction. Budget changes are evaluated against current limits when the worker processes a pending marker; changing limits alone does not send an immediate alert. Enabling alerts starts with subsequent usage; it does not replay all historical usage automatically.

## Reliability and operational limits

The worker runs asynchronously **inside the single gateway process**, every five seconds. It is not an independent process and is not a multi-replica worker architecture. One GATE instance per database remains required by the existing storage lock. Each tick processes up to 25 usage subjects in separate short transactions and up to 10 deliveries. Account for this bounded throughput before enabling email for a large population.

Jobs have a durable lease, bounded send timeout, five attempts and exponential retry delays. Restart recovers pending jobs and expired leases. The worker is stopped and drained before database close. A provider accepting a message just before a crash can cause a duplicate on retry: delivery is at-least-once, not exactly-once. Inbox/queue event creation itself is deduplicated.

Delivery failures cannot prevent budget enforcement or roll back settled usage. A database failure during usage settlement continues to follow the existing fail-closed accounting behavior. Delivery errors use a fixed safe code, avoiding provider secrets/message contents in logs or dashboard errors. Monitor `notification_worker_failed` operational events and terminal `failed` rows in delivery history.

History currently has no automated retention deletion. Inbox and history endpoints return the latest 100 rows; unread counts include all retained notifications. Plan database retention before prolonged high-volume operation. Back up PostgreSQL and the encryption key. SQLite-to-PostgreSQL import retains notification history, cancels pending invitation deliveries and revokes pending links so they can be regenerated at the destination.

## Testing

`npm test` covers activation races, ownership boundaries, reset-period deduplication, retry/failure state and secret redaction with synthetic delivery transports. `npm run test:postgres` uses a disposable local database for migrations, restart recovery, atomic invitation acceptance and durable delivery state. `GATE_TEST_POSTGRES_MAJOR=16 npm run test:postgres` runs the same suite against PostgreSQL 16 for compatibility with existing installations. No tests intentionally send real email or SNS messages. A deployment smoke test with explicitly selected recipients is still required after SES/IAM/network configuration.
