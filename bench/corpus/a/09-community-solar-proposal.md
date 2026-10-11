---
title: "Millbrook Community Solar Garden"
subtitle: "Project Proposal for a 1.5 MW Shared Solar Array on the Former Route 9 Landfill"
author: "Millbrook Energy Committee"
date: "October 2026"
geometry: margin=1in
fontsize: 11pt
numbersections: true
toc: true
---

# Executive Summary

The Millbrook Energy Committee proposes building a **1.5 MW (DC) community solar garden** on the capped municipal landfill off Route 9. The array would generate about **1.92 million kWh** in its first year, enough to offset the electricity use of roughly 265 average Millbrook households. Residents, small businesses and the Millbrook Housing Authority would subscribe to shares of the array and receive credits on their utility bills, without installing anything on their own roofs.

The program is designed around access. **40% of the array's capacity is reserved for income-qualified households**, who would receive a 30% discount on the value of their bill credits. Market-rate subscribers would receive a 10% discount. On average, subscribers would save about **$48,000 per year** collectively, and a typical income-qualified household would save around $270 per year.

The total installed cost is estimated at **$2.32 million**. We propose financing it with a federal clean energy tax credit received through elective pay, a state community solar grant, a $250,000 contribution from the town's capital reserve, and a 15-year green bank loan. Subscription revenue covers operations and debt service from the first year, and the town recovers its capital contribution in about four years.

We ask the Select Board to (1) authorize a 25-year use agreement for the landfill site, (2) approve the $250,000 capital reserve contribution, and (3) authorize the Town Manager to apply for the state grant and green bank financing by the December 15, 2026 deadline.

# Background and Need

## Why community solar

About 58% of Millbrook's homes cannot host rooftop solar. They are renters, have shaded or unsuitable roofs, or live in multifamily buildings.[^census] Community solar lets these residents buy into local clean energy on the same terms as a homeowner with panels.

The town also has a site that is hard to use for anything else. The Route 9 landfill closed in 2004 and was capped in 2007. Its 11 acres are flat, unshaded, fenced and within 0.4 miles of a three-phase distribution line. Under the cap's post-closure plan, the site cannot be excavated or built on with conventional foundations, but ballasted solar racking is an approved use.

## Energy burden in Millbrook

Energy burden is the share of household income spent on energy. Statewide, households at or below 80% of area median income (AMI) spend an average of 7.9% of income on energy, compared with 2.6% for all households.[^lead] In Millbrook, 1,140 households fall at or below 80% AMI. Electricity bills are one of the few large expenses where a program like this can deliver a guaranteed, recurring saving with no up-front cost to the household.

## Alignment with town goals

The 2024 Millbrook Climate Action Plan sets a goal of sourcing 50% of community-wide electricity from renewable sources by 2035. The solar garden alone would supply about 2.3% of current community-wide electricity use, and it would establish the subscriber model, the utility relationship and the financing structure that later phases can reuse.

# Project Description

## Site and system design

| Parameter | Value |
|---|---|
| Location | Former Route 9 landfill, Parcel 14-022 (town-owned) |
| Usable area | 7.6 acres of 11.0 total |
| DC capacity | 1,498 kW (2,800 modules × 535 W bifacial) |
| AC capacity | 1,250 kW (10 × 125 kW string inverters) |
| DC/AC ratio | 1.20 |
| Racking | Ballasted, fixed tilt at 25°, south-facing; no penetration of landfill cap |
| Interconnection | 13.2 kV three-phase, approximately 2,100 ft new overhead line |
| Expected specific yield | 1,280 kWh/kW<sub>DC</sub> per year (PVWatts, TMY data) |
| Annual degradation | 0.5% per year |
| Design life | 30 years (25-year subscriber program) |

Table: Key design parameters.

## Expected production

First-year production is the product of DC capacity and specific yield:

$$
E_1 = P_{\text{DC}} \times Y = 1{,}498 \text{ kW} \times 1{,}280 \text{ kWh/kW} \approx 1{,}917{,}000 \text{ kWh}.
$$

With degradation rate $d = 0.005$, production in year $t$ is $E_t = E_1 (1 - d)^{t-1}$. Total production over the 25-year program is

$$
\sum_{t=1}^{25} E_t = E_1 \cdot \frac{1 - (1 - d)^{25}}{d} \approx 1{,}917{,}000 \times 23.6 \approx 45.2 \text{ million kWh}.
$$

At the regional grid emission factor of 0.30 metric tons of CO~2~ per MWh, the array avoids about 575 t of CO~2~ in its first year and roughly 13,500 t over the program.

## Subscriber model

Subscriptions are sold in 1 kW units, with a cap of 10 kW per household and 150 kW per business. Subscribers pay the program a monthly fee equal to their share of the array's output valued at the utility's net-metering credit rate (currently $0.14/kWh), minus their discount. The utility applies the full credit to their bills.

| Subscriber class | Share of capacity | Discount on credit value | Approx. subscribers |
|---|---:|---:|---:|
| Income-qualified households (≤ 80% AMI) | 40% | 30% | 120 |
| Market-rate households | 35% | 10% | 110 |
| Small businesses and nonprofits | 25% | 10% | 15–20 |

Table: Subscriber allocation.

For an income-qualified household with a 5 kW share, first-year bill credits are about 5 × 1,280 × $0.14 = $896, of which the household pays $627 and saves **$269**. There are no sign-up fees, no credit checks for income-qualified subscribers, and subscribers can leave with 90 days' notice.

# Budget

## Capital costs

| Category | Cost (USD) | Share |
|:---|---:|---:|
| Solar modules (2,800 × 535 W) | $584,200 | 25.1% |
| String inverters (10 × 125 kW) | 142,000 | 6.1% |
| Ballasted racking system | 310,000 | 13.3% |
| Electrical balance of system and wiring | 196,000 | 8.4% |
| Interconnection and utility upgrades | 185,000 | 8.0% |
| Site preparation and landfill cap protection | 95,000 | 4.1% |
| Engineering, permitting and environmental review | 118,000 | 5.1% |
| Installation labor | 342,000 | 14.7% |
| Monitoring and revenue-grade metering | 28,000 | 1.2% |
| Subscriber outreach and enrollment (first 2 years) | 64,000 | 2.8% |
| Project management | 87,000 | 3.7% |
| **Subtotal** | **$2,151,200** | **92.6%** |
| Contingency (8%) | 172,100 | 7.4% |
| **Total project cost** | **$2,323,300** | **100.0%** |

Table: Capital budget. The total corresponds to $1.55 per watt DC.

## Funding sources

| Source | Amount (USD) | Share | Status |
|:---|---:|---:|:---|
| Federal clean energy investment tax credit, received through elective pay (est.)[^itc] | $650,000 | 28.0% | Eligibility review under way |
| State Community Solar Access grant | 400,000 | 17.2% | Application due Dec. 15, 2026 |
| Town capital reserve | 250,000 | 10.8% | Requires Select Board vote |
| Green bank loan (15 years, 4.5% fixed) | 1,023,300 | 44.0% | Term sheet received |
| **Total** | **$2,323,300** | **100.0%** | |

Table: Proposed funding sources.

## Operating budget and cash flow (year 1)

The green bank loan's annual payment follows the standard amortization formula with principal $P$, rate $r$ and term $n$ years:

$$
A = P \cdot \frac{r}{1 - (1 + r)^{-n}} = \$1{,}023{,}300 \times \frac{0.045}{1 - 1.045^{-15}} \approx \$95{,}300.
$$

| Line item | Year 1 (USD) |
|:---|---:|
| Value of bill credits generated (1,917,000 kWh × $0.14) | $268,400 |
| Less subscriber discounts (weighted average 18%) | (48,300) |
| **Program revenue** | **220,100** |
| Operations and maintenance ($22/kW-yr) | (33,000) |
| Insurance, administration and billing | (18,000) |
| Inverter replacement reserve | (10,000) |
| Loan debt service | (95,300) |
| **Net cash flow to the town** | **$63,800** |

Table: First-year operating budget.

At roughly $63,800 per year, the town recovers its $250,000 capital contribution in about **3.9 years**. After the loan is retired in year 15, net cash flow rises by the amount of the loan payment, to about $159,000 per year before degradation and any change in the credit rate. The Energy Committee proposes to direct that surplus to an energy-efficiency fund for income-qualified households.

# Implementation Timeline

| Phase | Months | Milestones |
|:---|:---|:---|
| 1. Approvals and financing | Nov 2026 – Feb 2027 | Select Board votes; grant application; loan closing; elective-pay registration |
| 2. Design and permitting | Jan – May 2027 | Geotechnical survey of cap; final engineering; conservation commission and DEP approvals |
| 3. Interconnection | Dec 2026 – Aug 2027 | Utility impact study; interconnection agreement; line extension |
| 4. Subscriber enrollment | Mar – Sep 2027 | Outreach with Housing Authority and library; 90% of capacity subscribed before energization |
| 5. Construction | Jun – Sep 2027 | Racking, module installation, inverters, metering |
| 6. Commissioning | Oct 2027 | Utility witness test; permission to operate; first bill credits in November 2027 |

Table: Project timeline.

# Risks and Mitigation

| Risk | Likelihood | Impact | Mitigation |
|:---|:---|:---|:---|
| Federal tax credit is smaller than estimated or construction-start deadlines are missed | Medium | High | Begin physical work on interconnection before the statutory deadline; budget a scenario without the credit (see note below) |
| Interconnection costs exceed estimate | Medium | Medium | Utility pre-application report already received; 8% contingency |
| Damage to landfill cap | Low | High | Ballasted racking only; geotechnical review; DEP-approved post-closure plan amendment |
| Low subscriber uptake | Low | Medium | Pre-enrollment pledges already cover 46% of capacity; anchor subscription from Housing Authority |
| Changes to net-metering credit rate | Medium | Medium | Subscription contracts priced as a percentage discount, so subscribers always save; reserve fund covers short-term shortfalls |

Table: Risk register.

If the federal credit were unavailable, the green bank loan would need to grow to about $1.67 million. Annual debt service would rise to about $155,800, and year-1 net cash flow would be roughly $3,300. The project would still break even, but the town's payback would stretch past the loan term. For this reason, securing the credit is the committee's first priority in Phase 1.

# Evaluation

The Energy Committee will report to the Select Board annually on:

- energy produced (kWh) compared with the PVWatts forecast;
- the number of subscribers by class, and total and per-household savings;
- the share of capacity held by income-qualified households (target: at least 40% at all times);
- net cash flow to the town and the status of the reserve fund;
- avoided CO~2~ emissions.

# Conclusion

The Route 9 landfill is a liability that can become a public asset. The Millbrook Community Solar Garden would cut electricity bills for hundreds of households, nearly half of them income-qualified, with no up-front cost to any resident, and it would pay for itself from subscriber revenue. We ask the Select Board to approve the three actions listed in the Executive Summary so that the town can meet the December 15 funding deadline.

[^census]: U.S. Census Bureau, American Community Survey 5-year estimates (2019–2023), Table B25003 (tenure) and B25024 (units in structure), combined with the committee's 2025 rooftop suitability screening.
[^lead]: U.S. Department of Energy, Low-Income Energy Affordability Data (LEAD) Tool, state-level summary, 2024 update.
[^itc]: Estimate assumes a 30% credit on eligible basis. Eligibility and the applicable deadlines depend on current federal law at the time construction begins; the committee will confirm with tax counsel before closing the loan.
