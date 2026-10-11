# Project Status Report: Customer Self-Service Portal v2

| | |
|---|---|
| **Reporting period** | September 21 to October 2, 2026 (Sprint 9) |
| **Project manager** | Daniel Reyes |
| **Executive sponsor** | Karen Liu, VP Customer Experience |
| **Overall status** | 🟡 **Amber**: on track for go-live, with schedule risk in integration |
| **Next report** | October 16, 2026 |

## 1. Executive summary

The portal remains on course for the **December 7 go-live**, but with less margin than at the last report. The billing API integration (milestone M3) slipped three weeks, from September 18 to **October 9**, because the vendor's sandbox did not support the refund endpoints we need. The vendor delivered a fix on September 29 and integration testing is now 70% complete. We have absorbed the slip by running UAT preparation in parallel, but the buffer before go-live has fallen from 15 working days to 6.

Spending is $742K against a plan of $715K at this point (+3.8%). The forecast at completion is **$1.31M** against an approved budget of $1.24M. A change request for the $70K difference is attached for steering committee decision (Section 7).

| Area | Status | Trend | Comment |
|---|:---:|:---:|---|
| Schedule | 🟡 | ↓ | M3 slipped 3 weeks; go-live date holds |
| Budget | 🟡 | → | Forecast 5.6% over; change request raised |
| Scope | 🟢 | → | No changes this period |
| Quality | 🟢 | ↑ | Defect backlog down from 41 to 23 |
| Resources | 🟡 | → | One QA contractor leaving October 30 |
| Stakeholders | 🟢 | → | Support team trained on admin console |

## 2. Timeline

Each cell is roughly two weeks. ▓ = completed, █ = planned / in progress, ░ = slipped (original plan), ◆ = milestone.

| Workstream | Jun | Jul | Aug | Sep | Oct | Nov | Dec | Jan |
|---|---|---|---|---|---|---|---|---|
| Requirements & discovery | ▓▓◆ | | | | | | | |
| UX design | ▓ | ▓▓◆ | | | | | | |
| Front-end build | | ▓ | ▓▓ | ▓▓ | ██ | | | |
| Billing API integration | | | ▓▓ | ▓░◆ | █◆ | | | |
| Identity / SSO | | | ▓ | ▓▓ | | | | |
| Data migration | | | | ▓ | ██ | █◆ | | |
| UAT | | | | | ◆█ | ██ | | |
| Training & comms | | | | | █ | ██ | █ | |
| Go-live & hypercare | | | | | | | ◆██ | ██◆ |

## 3. Milestones

| ID | Milestone | Baseline date | Forecast / actual | Status |
|---|---|---|---|---|
| M1 | Requirements signed off | Jun 26 | Jun 26 | ✅ Complete |
| M2 | UX design approved | Jul 31 | Jul 30 | ✅ Complete |
| M3 | Billing API integration complete | Sep 18 | **Oct 9** | 🟡 At risk (3 weeks late) |
| M4 | UAT begins | Oct 26 | Oct 26 | 🟢 On track |
| M5 | Data migration dress rehearsal | Nov 13 | Nov 13 | 🟢 On track |
| M6 | Go-live | Dec 7 | Dec 7 | 🟡 On track, reduced buffer |
| M7 | Hypercare ends; handover to support | Jan 15 | Jan 15 | 🟢 On track |

## 4. Progress this period

**Completed**

- SSO with the corporate identity provider passed security review (zero high or critical findings).
- Account dashboard, order history, and address book pages finished and demoed to stakeholders on September 25.
- Vendor sandbox fix received; 14 of 20 billing integration test cases now pass.
- Data migration script run against a full copy of production: 1.82M customer records migrated in 3 h 40 min, with 0.3% flagged for manual review (mostly duplicate email addresses).

**Not completed as planned**

- Refund and partial-refund flows (blocked on billing sandbox until September 29; now in progress).
- Load test at 2× peak traffic deferred to Sprint 10 so the environment could be used for integration testing.

## 5. Plan for the next two weeks

1. Complete the remaining 6 billing integration test cases and close M3 by **October 9**.
2. Run the load test at 2× expected peak (target: p95 page load under 2 seconds at 1,200 concurrent users).
3. Finalize UAT scripts with the customer service team and schedule 18 business testers.
4. Resolve the 5,460 flagged migration records with the data steward.
5. Start recruiting a replacement for the departing QA contractor.

## 6. Risks

Scores are likelihood × impact, each rated 1 (low) to 5 (high).

| ID | Risk | L | I | Score | Mitigation | Owner | Trend |
|---|---|:---:|:---:|:---:|---|---|:---:|
| R1 | Further delays in the billing vendor's API consume the remaining 6-day buffer | 3 | 5 | **15** | Daily vendor stand-up; escalation path agreed with vendor account manager; fallback to manual refunds for first 30 days | D. Reyes | ↑ |
| R2 | Performance under peak load (holiday season) below target | 2 | 5 | 10 | Load test in Sprint 10; CDN caching for static pages; auto-scaling configured | S. Patel | → |
| R3 | Loss of QA contractor on October 30 reduces test capacity during UAT | 4 | 3 | 12 | Backfill request submitted; two developers allocated 50% to test automation | D. Reyes | new |
| R4 | Migrated customer data has quality issues visible to customers | 2 | 4 | 8 | Dress rehearsal on Nov 13; data steward review of flagged records; rollback plan | M. Okonkwo | ↓ |
| R5 | Low adoption: customers keep calling instead of using the portal | 3 | 3 | 9 | Email campaign at launch; IVR message pointing to portal; in-app guided tour | K. Liu | → |

**Closed this period:** R6 (SSO security review findings could delay launch) closed after a clean review.

## 7. Budget

| Category | Approved budget | Spent to date | Forecast at completion | Variance |
|---|---:|---:|---:|---:|
| Internal labor | $610,000 | $388,000 | $640,000 | +$30,000 |
| Contractors | $280,000 | $171,000 | $305,000 | +$25,000 |
| Software & licenses | $210,000 | $148,000 | $210,000 | $0 |
| Infrastructure | $80,000 | $35,000 | $95,000 | +$15,000 |
| Contingency | $60,000 | $0 | $60,000 | $0 |
| **Total** | **$1,240,000** | **$742,000** | **$1,310,000** | **+$70,000 (+5.6%)** |

The overrun comes from the integration delay (extra contractor and internal labor time) and higher-than-planned cloud costs for the additional test environment. We propose keeping the $60K contingency untouched for go-live risks and funding the overrun through a change request.

## 8. Decisions needed from the steering committee

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| D1 | Approve change request CR-07 for +$70,000 | Approve | October 16 |
| D2 | Accept manual refund processing as a fallback for up to 30 days if R1 occurs | Approve as contingency only | October 16 |
| D3 | Confirm go-live date of December 7 versus moving to January 11 to avoid peak season | Keep December 7; revisit at the November 13 checkpoint | October 16 |

## 9. Issues log (open)

| ID | Issue | Impact | Action | Owner | Due |
|---|---|---|---|---|---|
| I-14 | Billing sandbox unavailable 4 hours a day for vendor maintenance | Slows integration testing | Vendor moved maintenance to 22:00 to 02:00 | Vendor / D. Reyes | Oct 5 |
| I-17 | 5,460 migration records with duplicate emails | Customers could see merged accounts | Data steward to define merge rules | M. Okonkwo | Oct 14 |
| I-18 | Accessibility audit found 7 contrast issues on dashboard | WCAG 2.2 AA compliance | Design fix in Sprint 10 | A. Kim | Oct 16 |

---

*Questions about this report: Daniel Reyes, Project Manager, ext. 4417.*
