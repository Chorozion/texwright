---
title: "Runbook: payments-api Incident Response"
subtitle: "Elevated error rates, latency and dependency failures"
author: "Payments Platform Team · Owner: Priyanka Desai"
date: "Last reviewed 2026-10-01 · Next review 2027-01-01"
numbersections: true
toc: true
geometry: margin=2cm
fontsize: 10pt
colorlinks: true
monofont: "DejaVu Sans Mono"
---

# Overview

This runbook covers incidents affecting **payments-api**, the service that
authorises, captures and refunds card payments for all storefronts. It is
written for the on-call engineer. Follow it in order; skip steps only if you
are certain they do not apply.

> **Golden rule:** mitigate first, investigate second. If a recent deploy
> might be the cause, roll it back *before* you understand why it broke.

**Service at a glance**

| Item | Value |
|:-----|:------|
| Runtime | Kubernetes, namespace `payments`, deployment `payments-api` (12–40 pods, HPA) |
| Datastores | PostgreSQL 16 (primary + 2 replicas) via PgBouncer; Redis 7 for idempotency keys |
| Upstream dependencies | Primary payment service provider (PSP-A), secondary (PSP-B), fraud scoring service |
| Traffic | ~350 req/s typical, ~1,400 req/s at seasonal peak |
| SLO | 99.95% successful authorisations (30-day), p99 latency < 800 ms |
| Dashboards | Grafana → *Payments / API Overview*, *Payments / Dependencies* |
| Logs | Kibana index `payments-api-*` |
| Deploys | Argo CD application `payments-api-prod` |

# Severity levels

Assign a severity as soon as you understand the customer impact. You can
change it later; under-classifying is worse than over-classifying.

Table: Severity definitions for payments incidents.

| Severity | Customer impact | Examples | Response |
|:---------|:----------------|:---------|:---------|
| **SEV1** | Payments failing for a large share of customers, or data integrity at risk | Auth success < 90% for 5 min; duplicate captures; card data exposure | Page IC immediately; all hands; status page in 15 min |
| **SEV2** | Significant degradation, workaround exists | Auth success 90–99%; p99 > 3 s; one PSP down with failover working | Page IC; status page in 30 min |
| **SEV3** | Minor or internal impact | Refunds delayed; one region slow; elevated retries | Fix in business hours |
| **SEV4** | No customer impact | Alert noise; non-prod failure | Ticket |

# Alerts

| Alert | Condition | Most likely causes | First action |
|:------|:----------|:-------------------|:-------------|
| `PaymentsAuthSuccessLow` | Auth success < 99% for 5 min | Bad deploy; PSP outage; DB issue | Check deploy history, then PSP dashboard |
| `PaymentsLatencyHigh` | p99 > 1.5 s for 10 min | DB connection pressure; slow PSP; GC pauses | Check DB pool and PSP latency panels |
| `PaymentsPSPErrorRate` | PSP-A 5xx > 2% for 3 min | Provider incident | Check provider status page; consider failover (§5.3) |
| `PgBouncerPoolSaturated` | Waiting clients > 50 for 2 min | Long transactions; traffic spike | §5.2 |
| `PaymentsPodRestarts` | > 5 restarts in 10 min | OOM; failing health checks | `kubectl describe pod`, check memory |

# First response

## The first ten minutes

- [ ] **Acknowledge** the page within 5 minutes. If you can't, it will
      escalate automatically (Figure 1).
- [ ] Open the *Payments / API Overview* dashboard. Note the start time of
      the problem and which metrics moved first.
- [ ] Check **recent changes**: Argo CD history, feature-flag audit log, and
      `#payments-deploys`. Anything in the last 2 hours is a suspect.
- [ ] Check **dependency health**: PSP-A and PSP-B status pages, fraud
      service dashboard, PostgreSQL and Redis panels.
- [ ] **Assign a severity** (Table 1). For SEV1/SEV2, declare an incident
      in Slack with `/incident declare` and page the Incident Commander.
- [ ] Post a first update in the incident channel, even if it only says
      what you're looking at.

![Acknowledgement and escalation flow for payments-api
alerts.](19-escalation-flow.svg){width=75%}

## Quick triage commands

Confirm your context first; the production cluster is `prod-eu-1`:

```bash
kubectl config current-context        # must print prod-eu-1
kubectl -n payments get pods -l app=payments-api -o wide
kubectl -n payments top pods -l app=payments-api --sort-by=memory | head -20
```

Recent deploys and the running image:

```bash
argocd app history payments-api-prod | tail -5
kubectl -n payments get deploy payments-api \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

Error breakdown from the logs in the last 15 minutes (Kibana query):

```text
service:payments-api AND level:error AND @timestamp >= now-15m
| stats count by error.code, upstream
```

# Mitigation playbooks

## Bad deploy: roll back

If the problem started within about 30 minutes of a deploy, roll back
without waiting for root cause.

```bash
# Roll back to the previous synced revision in Argo CD
argocd app history payments-api-prod
argocd app rollback payments-api-prod <PREVIOUS_ID>

# Watch the rollout
kubectl -n payments rollout status deploy/payments-api --timeout=10m
```

Then **pause auto-sync** so the bad version is not redeployed:

```bash
argocd app set payments-api-prod --sync-policy none
```

Post in `#payments-deploys` that auto-sync is paused and why. Re-enable it
only after the fix is merged.

## Database connection exhaustion

Symptoms: `PgBouncerPoolSaturated`, rising latency across all endpoints,
errors like `timeout acquiring connection`.

1. Look for long-running or idle-in-transaction sessions:

    ```sql
    SELECT pid, usename, state, now() - xact_start AS xact_age,
           left(query, 80) AS query
    FROM   pg_stat_activity
    WHERE  datname = 'payments'
      AND  state <> 'idle'
    ORDER  BY xact_age DESC NULLS LAST
    LIMIT  20;
    ```

2. Terminate sessions that have been *idle in transaction* for more than 5
   minutes. **Do not** terminate active `INSERT`/`UPDATE` statements on the
   `captures` or `refunds` tables without the IC's agreement.

    ```sql
    SELECT pg_terminate_backend(pid)
    FROM   pg_stat_activity
    WHERE  datname = 'payments'
      AND  state = 'idle in transaction'
      AND  now() - state_change > interval '5 minutes';
    ```

3. If the cause is a traffic spike rather than stuck sessions, see §5.4.
   Do **not** raise PgBouncer's `default_pool_size` above 80 without the
   database on-call; the primary allows at most 400 connections.

## Payment provider (PSP-A) degradation

Symptoms: `PaymentsPSPErrorRate`, errors with `upstream=psp_a`, provider
status page showing an incident.

1. Confirm the problem is upstream: errors are concentrated on PSP-A calls,
   and PSP-B's error rate is normal.
2. Fail over a share of traffic to PSP-B using the feature flag
   `payments.psp_routing`. Start at 50%, watch for 5 minutes, then go to
   100% if PSP-B is healthy:

    ```bash
    flagctl set payments.psp_routing '{"psp_a": 50, "psp_b": 50}' \
      --env prod --reason "INC-<number>: PSP-A degradation"
    ```

3. Note that **3-D Secure challenges in progress on PSP-A cannot move to
   PSP-B.** Customers mid-challenge will need to retry. This is expected.
4. Open a ticket with PSP-A support (priority P1) and post the ticket number
   in the incident channel.
5. When PSP-A recovers, move traffic back in steps (100/0 → 50/50 → 0/100
   for PSP-B) with 10 minutes between steps.

## Traffic spike

If the HPA is already at its maximum (40 pods) and CPU is above 80%:

```bash
kubectl -n payments patch hpa payments-api \
  -p '{"spec":{"maxReplicas":60}}'
```

The database, not the pods, is usually the next bottleneck. Watch the
PgBouncer panels after scaling and be ready to apply §5.2. Revert the HPA
change after the incident and record it in the PIR.

## Redis unavailable

payments-api uses Redis only for idempotency keys. If Redis is down, the
service **fails closed** by default: it rejects payment requests rather
than risk duplicate charges. This is deliberate.

- If Redis will be back within 15 minutes, wait.
- If not, the IC may approve switching idempotency storage to PostgreSQL
  with the flag `payments.idempotency_backend=postgres`. This roughly
  doubles database write load; check §5.2 first.

# Communication

Update the incident channel at least every **15 minutes** during a SEV1 and
every **30 minutes** during a SEV2, even if nothing has changed.

**Status page: initial message**

```text
We are investigating elevated errors affecting card payments on some
storefronts. Customers may see failed or delayed payments. We will post
an update within 30 minutes.
```

**Status page: mitigated**

```text
We have applied a fix and payment success rates have returned to normal.
We are monitoring closely. Any customers who saw a failed payment between
HH:MM and HH:MM UTC can safely retry; no duplicate charges were made.
```

Only state that no duplicate charges were made after checking with the
`duplicate_capture_check` query in the Appendix.

# Escalation contacts

| Role | Primary | Escalate after | Contact |
|:-----|:--------|:---------------|:--------|
| Payments on-call (primary) | Rotation | 5 min no ack | PagerDuty: *payments-primary* |
| Payments on-call (secondary) | Rotation | 10 min no ack | PagerDuty: *payments-secondary* |
| Engineering manager | Priyanka Desai | 15 min, or any SEV1 | PagerDuty: *payments-em* |
| Incident Commander | Rotation | Immediately for SEV1/SEV2 | `/incident page ic` |
| Database on-call | Rotation | §5.2 changes to pool size | PagerDuty: *dba-primary* |
| PSP-A support | Vendor | Any PSP-A incident | Support portal, priority P1 |
| Security | Rotation | Any suspected card data exposure | PagerDuty: *security-urgent* |

# After the incident

1. Keep monitoring for at least 30 minutes after mitigation before closing.
2. Revert temporary changes (HPA limits, feature flags, paused auto-sync) or
   record why they stay.
3. The IC schedules a post-incident review (PIR) within **5 business days**
   for every SEV1 and SEV2. Reviews are blameless.
4. Update this runbook if any step was wrong, missing or confusing. The
   person who was on call owns that update.

# Appendix: useful queries {-}

**Authorisation success rate (PromQL):**

```promql
sum(rate(payments_auth_requests_total{result="success"}[5m]))
  /
sum(rate(payments_auth_requests_total[5m]))
```

**p99 latency by endpoint:**

```promql
histogram_quantile(0.99,
  sum by (le, endpoint) (
    rate(payments_http_request_duration_seconds_bucket[5m])
  )
)
```

**Duplicate capture check (SQL, read replica):**

```sql
SELECT order_id, count(*) AS captures, sum(amount_minor) AS total_minor
FROM   captures
WHERE  created_at >= now() - interval '6 hours'
GROUP  BY order_id
HAVING count(*) > 1;
```

An empty result means no order was captured more than once in the window.
