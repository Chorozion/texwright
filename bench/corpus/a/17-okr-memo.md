# MEMORANDUM

|  |  |
|---|---|
| **To:** | Executive Leadership Team |
| **From:** | Dana Whitfield, Chief Operating Officer |
| **CC:** | Department heads |
| **Date:** | October 7, 2026 |
| **Subject:** | Q3 2026 OKR results and Q4 priorities |

---

## Summary

Q3 was a solid quarter for revenue and a weak one for product delivery. We ended the quarter at **$4.82M in annual recurring revenue (ARR)**, up 11.3% from $4.33M at the end of Q2, and we beat our net revenue retention target. We missed both delivery key results on the integrations roadmap, which pushed the Salesforce connector into Q4 and cost us at least two enterprise deals that were waiting on it.

Across the company's four objectives and twelve key results, the average score was **0.69**. Our target range for a well-calibrated quarter is 0.6 to 0.7. Scores below use the usual scale: 1.0 means fully achieved, 0.7 is a strong result on a stretch goal, and anything below 0.4 is a miss we need to understand.

I am asking the leadership team for three decisions, listed at the end of this memo, before our planning session on October 14.

## Scorecard

### Objective 1: Grow revenue efficiently

| Key result | Target | Actual | Score |
|---|---:|---:|---:|
| KR1.1 Reach $4.90M ARR | $4.90M | $4.82M | 0.85 |
| KR1.2 Net revenue retention ≥ 112% | 112% | 115% | 1.00 |
| KR1.3 CAC payback period ≤ 14 months | 14 mo | 16 mo | 0.50 |
| **Objective score** | | | **0.78** |

New business was slightly below plan, with $318K of new ARR against a target of $400K, but expansion revenue more than made up for it. Seat expansion in our 40 largest accounts drove most of the NRR outperformance. CAC payback worsened because paid search costs rose 22% while conversion stayed flat.

### Objective 2: Ship the integrations customers are asking for

| Key result | Target | Actual | Score |
|---|---:|---:|---:|
| KR2.1 Launch Salesforce connector (GA) | Launched | Beta only | 0.30 |
| KR2.2 Launch HubSpot connector (GA) | Launched | Launched Aug 19 | 1.00 |
| KR2.3 30% of active accounts use ≥ 1 integration | 30% | 17% | 0.40 |
| **Objective score** | | | **0.57** |

The Salesforce connector is the quarter's main miss. Engineering underestimated the work needed to handle custom objects and field-level permissions, and two engineers were pulled into the September 9 reliability incident for most of a sprint. The connector has been in beta with 11 customers since September 22 and is on track for general availability on November 4. Integration adoption (KR2.3) depends heavily on Salesforce, so it will lag until the connector ships.

### Objective 3: Make the product dependable

| Key result | Target | Actual | Score |
|---|---:|---:|---:|
| KR3.1 Monthly uptime ≥ 99.95% | 99.95% | 99.91% | 0.60 |
| KR3.2 Median support first-response time ≤ 2 hours | 2.0 h | 1.6 h | 1.00 |
| KR3.3 Reduce P1 bugs open > 30 days from 14 to 0 | 0 | 3 | 0.80 |
| **Objective score** | | | **0.80** |

Uptime met the target in July and August. The September 9 incident, a database failover that took 38 minutes instead of the expected 2, pulled the quarter below target. The postmortem's six remediation items are complete except for automated failover testing, due October 31.

### Objective 4: Build a team that can scale

| Key result | Target | Actual | Score |
|---|---:|---:|---:|
| KR4.1 Fill 9 open roles | 9 | 6 | 0.67 |
| KR4.2 Employee engagement score ≥ 78 | 78 | 74 | 0.50 |
| KR4.3 Every manager completes coaching program | 100% | 92% | 0.70 |
| **Objective score** | | | **0.62** |

We hired 6 of 9 roles. The two senior backend positions remain open after 14 weeks, which contributed to the integrations delay. Engagement fell from 77 to 74. Comments point to workload on the engineering team and unclear priorities during the incident response.

### Company summary

| Objective | Score |
|---|---:|
| 1. Grow revenue efficiently | 0.78 |
| 2. Ship the integrations customers are asking for | 0.57 |
| 3. Make the product dependable | 0.80 |
| 4. Build a team that can scale | 0.62 |
| **Company average** | **0.69** |

*(Each objective has three key results, so this is also the average of all twelve key-result scores.)*

## What we learned

1. **Our estimates for integration work are too optimistic.** Both connectors took about 40% longer than estimated. For Q4 planning, engineering will add explicit discovery spikes before committing to dates on any work that touches a partner's API.
2. **Incidents consume roadmap capacity, and we do not plan for it.** The September incident took roughly 60 engineer-days across response, postmortem and remediation. Starting in Q4, each engineering team will reserve 15% of capacity for unplanned reliability work.
3. **Expansion is our most efficient growth channel.** Expansion revenue cost about $0.30 in sales and success spend per dollar of new ARR, compared with $1.40 for new business. Q4 should shift effort accordingly.

## Proposed Q4 objectives

1. **Close the integrations gap.** Salesforce connector GA by November 4; 25% of active accounts on at least one integration by December 31.
2. **Grow through existing customers.** $5.30M ARR by year end, with at least $250K coming from expansion.
3. **Raise the reliability bar.** 99.95% uptime in each month; automated failover tested monthly.
4. **Stabilize the engineering team.** Fill both senior backend roles; engagement back to 77 or above in the December pulse survey.

Reaching $5.30M ARR requires $480K of net new ARR in Q4, compared with $490K in Q3. The target is ambitious but consistent with the current pipeline of $1.9M, assuming our trailing win rate of 24% and the expansion trend holds.

## Decisions needed by October 14

1. **Approve the Q4 objectives above**, or propose changes before the planning session.
2. **Approve a $45K increase in the Q4 recruiting budget** to engage a specialist agency for the two senior backend roles.
3. **Approve reallocating $60K of Q4 paid search budget to customer success**, to fund a second expansion-focused account manager on a six-month contract.

Please send questions or comments to me before the session. Department-level scorecards are in the shared OKR workspace.

Dana
