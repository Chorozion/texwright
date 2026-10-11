# Postmortem: Primary Database Outage, 2026-09-22

| | |
|---|---|
| **Incident ID** | INC-2026-0917 |
| **Severity** | SEV-1 |
| **Status** | Resolved; action items in progress |
| **Duration** | 1 h 47 min of full outage, 3 h 12 min total customer impact |
| **Authors** | Priya Natarajan (Database Reliability), Tom Okafor (Platform) |
| **Incident commander** | Lena Vasquez |
| **Review date** | 2026-09-25 |

> This is a blameless postmortem. The goal is to understand how our systems and processes allowed this to happen, not to assign fault to individuals.

## Summary

On Tuesday, September 22, the primary PostgreSQL cluster serving the orders and accounts services stopped accepting writes at 14:06 UTC after its data volume filled up. The disk filled because a logical replication slot created for a data-warehouse migration had been abandoned and was retaining write-ahead log (WAL) segments. Automated failover did not help, because the replica had been promoted to the same volume class and was itself within 4% of capacity from the same retained WAL. We restored write availability at 15:53 UTC by dropping the stale slot and expanding the volume, and fully recovered read-replica capacity by 17:18 UTC.

## Impact

- **Checkout:** customers could browse but could not place orders for 1 h 47 min. Roughly 18,400 checkout attempts failed with an error page.
- **Accounts:** sign-ups, password resets, and profile updates failed during the same window. Logins using existing sessions continued to work.
- **Degraded period:** from 15:53 to 17:18 UTC, read traffic was served by one replica instead of three, and p99 API latency rose from 220 ms to 1.9 s.
- **Revenue:** estimated $412,000 in delayed orders, of which we estimate 70 to 80% were recovered when customers retried. Finance will confirm the final figure.
- **Data loss:** none. No committed transactions were lost.
- **Support:** 1,260 tickets opened during the incident window, against a typical 90.

## Timeline

All times UTC, September 22 unless noted.

| Time | Event |
|---|---|
| Aug 28 | Analytics team creates logical replication slot `dw_migration_v2` on the primary to test a CDC pipeline into the new warehouse. |
| Sep 4 | CDC pipeline test ends; consumer is shut down. Slot is not dropped. WAL retention begins growing at about 38 GB/day. |
| Sep 19, 03:10 | Disk usage alert at 80% fires on the primary. On-call acknowledges, sees steady growth, and opens a ticket to expand the volume "this week" (DBRE-2231). |
| Sep 22, 13:41 | Disk usage crosses 95%. The 95% alert routes to the same low-urgency channel as the 80% alert and is not paged. |
| 14:06 | Data volume reaches 100%. PostgreSQL cannot write new WAL and begins rejecting writes with `PANIC: could not write to file "pg_wal/..."`. Primary process restarts in a loop. |
| 14:07 | Checkout error rate alarm pages the commerce on-call. |
| 14:11 | SEV-1 declared. Lena Vasquez takes incident command; DBRE on-call (Priya) joins. |
| 14:15 | Patroni attempts failover to replica `pg-orders-2`. Promotion succeeds, but the replica's disk is at 96% and fills within 9 minutes of taking writes. |
| 14:24 | New primary stops accepting writes. Team decides to stop automated failover to avoid flapping (`patronictl pause`). |
| 14:31 | Root cause of disk growth identified: `pg_wal` is 697 GB (normally under 20 GB), and `pg_replication_slots` shows an inactive slot holding WAL back to Sep 4. |
| 14:38 | First attempt to drop the slot fails because the server is not accepting connections in its crash loop. |
| 14:52 | Team frees space by moving old server logs off the volume, giving ~6 GB headroom. Server starts in single-user mode. |
| 15:09 | Slot `dw_migration_v2` dropped. Checkpoint begins recycling WAL; disk usage falls slowly. |
| 15:20 | Cloud volume expansion requested for both nodes (2 TB to 4 TB). |
| 15:41 | Expansion completes on original primary; filesystem resized online. |
| 15:53 | Original primary restarted as leader. Writes succeed. Checkout recovers. |
| 16:05 | Status page updated to "monitoring". |
| 16:30 | Replica rebuild from base backup begins for `pg-orders-2` and `pg-orders-3`. |
| 17:18 | All replicas healthy and caught up. Patroni automation resumed. Incident resolved. |

## Root cause

PostgreSQL keeps WAL segments until every replication slot has confirmed it no longer needs them. A logical slot whose consumer has disappeared therefore pins WAL forever. The slot `dw_migration_v2` had been inactive for 18 days and was holding about 680 GB of WAL by the time of the outage, on top of normal retention.

The query below, run during the incident, showed the problem in one line:

```sql
SELECT slot_name, slot_type, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;
```

```text
     slot_name     | slot_type | active | retained_wal
-------------------+-----------+--------+--------------
 dw_migration_v2   | logical   | f      | 681 GB
 patroni_replica_2 | physical  | t      | 112 MB
 patroni_replica_3 | physical  | t      | 98 MB
```

## Contributing factors

1. **No guardrail on slot retention.** We run PostgreSQL 15, which supports `max_slot_wal_keep_size`, but it was left at its default of `-1` (unlimited). A limit would have invalidated the abandoned slot instead of filling the disk.
2. **No ownership or expiry for ad hoc slots.** Any role with `REPLICATION` privilege could create a slot, and nothing tracked who created it or why.
3. **Alert routing.** The 80% and 95% disk alerts both went to a low-urgency queue. A disk that will be full in hours should page.
4. **Ticket without urgency.** The Sep 19 ticket was triaged as routine capacity growth. The growth rate (38 GB/day, steady) was visible on the dashboard, but the alert did not include a time-to-full projection, and nobody did the arithmetic.
5. **Correlated failure in failover.** Replicas have the same volume size and receive the same WAL, so they were close to full too. Failover moved the problem instead of avoiding it.
6. **Recovery was slowed by the crash loop.** We had no documented procedure for freeing space on a PostgreSQL host that cannot start.

## What went well

- Detection of customer impact was fast: the checkout alarm paged within one minute.
- The team identified the abandoned slot within 25 minutes of declaring the incident.
- Pausing Patroni prevented repeated failovers and further confusion about which node was primary.
- No data was lost, and backups were current had we needed them.
- Status page and support macros were updated within 15 minutes.

## What went poorly

- Three days of warning (the Sep 19 alert) were not acted on.
- The first 20 minutes were spent on failover, which could not succeed.
- Volume expansion took 21 minutes from request to completion; we had not pre-approved an emergency size increase.
- The analytics team was not aware that leaving a slot behind could affect production.

## Action items

| # | Action | Type | Owner | Due | Status |
|---|---|---|---|---|---|
| 1 | Set `max_slot_wal_keep_size = 200GB` on all production clusters | Prevent | P. Natarajan | 2026-09-29 | Done |
| 2 | Alert (page) on any replication slot inactive for more than 1 hour or retaining more than 50 GB | Detect | P. Natarajan | 2026-10-03 | Done |
| 3 | Add time-to-full projection to disk alerts; page when projected full in under 72 h | Detect | T. Okafor | 2026-10-10 | In progress |
| 4 | Restrict `REPLICATION` privilege to the platform role; require a ticket and expiry date for new slots | Prevent | Security Eng. | 2026-10-17 | In progress |
| 5 | Write runbook: "PostgreSQL disk full / will not start" including single-user mode and slot removal | Mitigate | P. Natarajan | 2026-10-10 | In progress |
| 6 | Pre-approve emergency volume expansion up to 2x without change review | Mitigate | T. Okafor | 2026-10-03 | Done |
| 7 | Make Patroni check replica free space before promoting | Mitigate | T. Okafor | 2026-10-24 | Not started |
| 8 | Brief data and analytics teams on replication slots and production impact | Process | L. Vasquez | 2026-10-08 | Scheduled |
| 9 | Quarterly game day: simulate a full data volume on the staging cluster | Process | DBRE team | 2026-11-15 | Not started |

## Lessons learned

An inactive replication slot is a slow leak that only becomes visible when it fills the disk. The fix for that specific leak is a one-line configuration change, and we have made it. The broader lesson is about warnings: we had a clear signal three days early, and our alerting treated "80% full and growing steadily" the same as "80% full and stable." Alerts should describe how much time is left, not just how full something is.

We also learned that failover protects us from a dead host but not from a condition shared by every node. Any problem that replicates with the data, including disk exhaustion from WAL, will follow the primary to its replicas.

## Appendix: configuration change

```ini
# postgresql.conf (all production clusters, applied 2026-09-29)
max_slot_wal_keep_size = 200GB     # invalidate slots that would retain more WAL than this
wal_keep_size = 16GB               # unchanged
```
