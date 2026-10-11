---
title: "Platform Engineering: Q4 Planning Meeting"
subtitle: "Agenda, notes and decision log"
date: "Thursday, October 8, 2026"
author: "Prepared by Sam Whitfield (facilitator)"
geometry: "margin=0.9in"
fontsize: 10pt
mainfont: "Source Sans Pro"
colorlinks: true
---

# Meeting details

|                 |                                                               |
|:----------------|:--------------------------------------------------------------|
| **When**        | Thursday, October 8, 2026, 13:00–15:00 Eastern (17:00–19:00 UTC) |
| **Where**       | Room 4B (Harbor building) and video link in the calendar invite |
| **Facilitator** | Sam Whitfield                                                 |
| **Note-taker**  | Ines Duarte                                                   |
| **Decision-maker** | Rachel Kim (Director, Platform Engineering)                |
| **Pre-reads**   | Q3 reliability review; Kubernetes 1.33 upgrade RFC; cost dashboard export (Sept) |

**Purpose.** Agree the platform team's Q4 commitments, settle the open
questions on the Kubernetes upgrade and the logging migration, and confirm
on-call changes before the holiday freeze starts on December 14.

**Desired outcomes.**

1. A ranked list of no more than five Q4 commitments, each with an owner.
2. A go/no-go on the Kubernetes 1.33 upgrade window.
3. A decision on whether to finish the logging migration this quarter or
   defer it to Q1.
4. Agreement on the holiday on-call rota.

# Attendees

| Name            | Role                                   | Attending      |
|:----------------|:---------------------------------------|:---------------|
| Rachel Kim      | Director, Platform Engineering         | In person      |
| Sam Whitfield   | Engineering Manager, Compute           | In person      |
| Ines Duarte     | Staff Engineer, Observability          | In person      |
| Kwame Asante    | Senior SRE, Compute                    | Remote         |
| Hannah Bergström | Engineering Manager, Developer Experience | In person   |
| Leo Marchetti   | Senior Engineer, Networking            | Remote         |
| Aisha Rahman    | Product Manager, Internal Platform     | In person      |
| Priya Nair      | Finance Business Partner (item 5 only) | Remote         |

Apologies: Tomás Ortega (on leave; Kwame covering for Compute on-call).

# Agenda

| #  | Time         | Item                                              | Lead      | Type        |
|---:|:-------------|:--------------------------------------------------|:----------|:------------|
| 1  | 13:00–13:05  | Welcome, purpose, review of previous actions      | Sam       | Information |
| 2  | 13:05–13:20  | Q3 reliability review: headline numbers           | Kwame     | Information |
| 3  | 13:20–13:50  | Kubernetes 1.33 upgrade: risks and window         | Kwame     | **Decision** |
| 4  | 13:50–14:15  | Logging migration: finish in Q4 or defer?         | Ines      | **Decision** |
| —  | 14:15–14:25  | *Break*                                           |           |             |
| 5  | 14:25–14:40  | Cloud cost: September overrun and Q4 forecast     | Priya     | Discussion  |
| 6  | 14:40–14:50  | Q4 commitments: rank and assign owners            | Rachel    | **Decision** |
| 7  | 14:50–14:57  | Holiday on-call rota                              | Sam       | **Decision** |
| 8  | 14:57–15:00  | Recap of decisions and actions                    | Ines      | Information |

Items marked **Decision** will be closed in the meeting where possible. If a
decision needs more information, the owner and the date by which it will be
made are recorded instead.

# Previous actions (from September 10)

- [x] Kwame: publish the Kubernetes 1.33 upgrade RFC. *Done, September 24.*
- [x] Ines: cost estimate for running both logging stacks through Q1. *Done.*
- [x] Hannah: survey service teams on CI runner wait times. *Done; 61 responses.*
- [ ] Leo: proposal for retiring the legacy NAT gateways. *Carried over; blocked
      on the networking vendor's quote, now expected October 16.*

# Notes

## 2. Q3 reliability review

Kwame summarised the review that was circulated last week.

| Metric                                     | Target  | Q2 actual | Q3 actual |
|:-------------------------------------------|--------:|----------:|----------:|
| Platform API availability                  | 99.95%  | 99.97%    | 99.91%    |
| Sev-1 incidents                            | ≤ 1     | 0         | 2         |
| Sev-2 incidents                            | ≤ 6     | 5         | 4         |
| Median time to mitigate (Sev-1/2)          | ≤ 45 min | 38 min   | 52 min    |
| Deploys rolled back automatically          | —       | 31        | 44        |

The availability miss is almost entirely the August 19 incident (expired
intermediate certificate on the internal ingress; 3 h 10 min of partial
outage). The second Sev-1, on September 2, was a 22-minute DNS resolver
failure. Both post-incident reviews are complete; four of their seven
follow-ups are done and the remaining three are on the Q4 list below.

Discussion: Hannah asked whether the rise in automatic rollbacks is good
news (the canary analysis is catching bad deploys) or bad news (more bad
deploys). Kwame thinks mostly the former, since the canary thresholds were
tightened in July, but nobody has checked. Taken as an action.

## 3. Kubernetes 1.33 upgrade

Kwame presented the RFC. The current version, 1.31, leaves extended support
with our cloud provider in early 2027, after which the per-cluster fee
rises sharply. The upgrade goes through 1.32 to 1.33, one minor version at a
time, across 14 clusters.

Main risks raised:

- Two internal operators (the certificate rotator and the batch scheduler)
  use API versions removed in 1.32. Fixes are written and in review.
- Upgrading during the November retail peak would be unwise; the trading
  teams have asked for no platform changes between November 23 and
  December 4.
- The staging clusters are not fully representative: they lack the GPU node
  pools, so the GPU device plugin upgrade will only be exercised in
  production.

Leo suggested upgrading one production GPU cluster early, in the first week
of November, as a canary. General agreement.

**Outcome:** see decision D-2026-14.

## 4. Logging migration

Ines reported that 68% of services by log volume have moved to the new
OpenTelemetry-based pipeline. The remainder are the hardest: 40 services,
mostly older Java applications using a custom log appender. Running both
stacks costs about \$38,000 per month more than running the new one alone.

Options presented:

A. **Finish in Q4.** Needs two engineers from Developer Experience for six
   weeks to help service teams migrate. Risk: competes with the Kubernetes
   upgrade for the same review capacity.
B. **Defer to Q1.** Continue dual running for three more months (about
   \$114,000). No migration work in the holiday freeze.
C. **Partial.** Migrate the 15 highest-volume remaining services in Q4
   (about 80% of remaining volume), defer the long tail to Q1.

Hannah could lend one engineer, not two, before December. Aisha noted that
the long tail includes three services scheduled for decommissioning in Q1
anyway, which would not need migrating at all.

**Outcome:** see decision D-2026-15.

## 5. Cloud cost

Priya reported September spend 11% over forecast. Two causes account for
nearly all of it: dual-running logging (known, see item 4) and a
misconfigured autoscaler on the analytics cluster that kept 40 large nodes
running over three weekends. The autoscaler was fixed on September 29.
Q4 forecast is now 4% over the original budget if option C above is
chosen, 2% over if A, 6% over if B.

## 6. Q4 commitments

The group ranked the candidate list. Final ranking, with owners:

1. Kubernetes 1.33 upgrade on all 14 clusters (Kwame).
2. Logging migration, high-volume services only (Ines).
3. Close remaining post-incident follow-ups from August 19 and September 2
   (Kwame), including certificate-expiry alerting at 30, 14 and 7 days.
4. CI runner autoscaling to cut median queue wait below 2 minutes (Hannah).
5. NAT gateway retirement, *conditional* on the vendor quote (Leo).

Dropped from Q4 and moved to the Q1 candidate list: service mesh upgrade,
self-service database provisioning beta.

## 7. Holiday on-call

The freeze runs December 14 to January 4. Rota agreed as proposed in the
pre-read, with one swap: Leo and Kwame exchange the December 21 and
December 28 weeks. Secondary on-call for each week will be a manager.

# Decision log

| ID         | Decision | Rationale | Decided by | Date |
|:-----------|:---------|:----------|:-----------|:-----|
| D-2026-14  | Upgrade to Kubernetes 1.33 in Q4. Canary on one production GPU cluster in the week of November 2; remaining clusters December 7–11, after the retail peak. | Extended-support fees start in early 2027; the peak-season change freeze rules out late November. | Rachel Kim | 2026-10-08 |
| D-2026-15  | Logging migration option C: move the 15 highest-volume remaining services in Q4; defer the rest to Q1 and drop the three services being decommissioned. | Captures about 80% of the savings with one borrowed engineer, without competing with the Kubernetes upgrade for December capacity. | Rachel Kim | 2026-10-08 |
| D-2026-16  | Q4 commitments are the five items in section 6, in that order. Item 5 proceeds only if the vendor quote arrives by October 23. | Keeps the list to five; lower-ranked items yield if capacity is short. | Rachel Kim | 2026-10-08 |
| D-2026-17  | Holiday on-call rota approved with the Leo/Kwame swap. | Rota balances weeks across the team; swap requested for personal reasons. | Sam Whitfield | 2026-10-08 |

# Action items

| #  | Action                                                                 | Owner   | Due          |
|---:|:-----------------------------------------------------------------------|:--------|:-------------|
| 1  | Merge the API version fixes for the certificate rotator and batch scheduler | Kwame | October 20 |
| 2  | Announce the Kubernetes upgrade windows to service teams               | Aisha   | October 13   |
| 3  | Confirm the DX engineer on loan for the logging migration, start date  | Hannah  | October 15   |
| 4  | Publish the list of 15 services for the Q4 logging migration           | Ines    | October 16   |
| 5  | Analyse Q3 automatic rollbacks: true catches vs. false positives       | Kwame   | October 30   |
| 6  | Chase the NAT gateway vendor quote; escalate if not received by Oct 23 | Leo     | October 23   |
| 7  | Add certificate-expiry alerts (30/14/7 days) for internal ingress      | Kwame   | October 27   |
| 8  | Update the cost forecast for option C and share with Finance           | Priya   | October 22   |
| 9  | Publish the final holiday rota in the on-call tool                     | Sam     | October 12   |

# Parking lot

- Whether platform should own GPU capacity planning or hand it to the ML
  infrastructure team. Rachel to raise with the ML director.
- Request from two service teams for ARM node pools. Needs a cost and
  compatibility study; candidate for Q1.

# Next meeting

Q4 mid-quarter check-in: **Thursday, November 12, 2026, 13:00–14:00
Eastern**, same room. Agenda items to Sam by November 9.
