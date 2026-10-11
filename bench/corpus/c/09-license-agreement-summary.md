# Contract Summary: Software License and Services Agreement

**Agreement:** Master Software License and Services Agreement, including Order Form No. 1 and Exhibit B (Service Level Agreement)
**Licensor:** Northpeak Software, Inc. ("Northpeak"), a Delaware corporation
**Licensee:** Cobalt Ridge Manufacturing LLC ("Cobalt Ridge" or "we")
**Effective date:** November 1, 2026 (assuming signature by October 24)
**Prepared by:** Procurement & Legal Operations, for internal review
**Date of summary:** October 7, 2026

> This summary is a plain-language guide to the main business terms. It is not legal advice and does not replace the agreement. Where this summary and the contract differ, the contract controls. Section references (§) are to the Master Agreement unless noted.

---

## 1. At a glance

| Term | Summary | Reference |
|---|---|---|
| Product | Northpeak Plant Operations Suite (cloud-hosted MES), Enterprise tier | Order Form 1 |
| License type | Non-exclusive, non-transferable subscription | § 2.1 |
| Users | Up to 250 named users; 3 production sites | Order Form 1 |
| Initial term | 3 years | § 10.1 |
| Renewal | Automatic 1-year renewals unless notice given 90 days before end of term | § 10.2 |
| Annual fee | $186,000 (Year 1), increases capped at 5% per year | Order Form 1, § 4.3 |
| One-time fees | $42,500 implementation | Order Form 1 |
| Uptime commitment | 99.9% monthly, with service credits | Exhibit B |
| Liability cap | 12 months of fees paid, with carve-outs | § 9.2 |
| Governing law | State of New York; courts in New York County | § 13.4 |

## 2. License grant and restrictions (§ 2)

Northpeak grants Cobalt Ridge a **non-exclusive, non-transferable, non-sublicensable** right to access and use the software during the subscription term, for our internal business operations only (§ 2.1). Our affiliates may use it if we list them in the Order Form and remain responsible for their compliance (§ 2.2).

We may **not** (§ 2.4):

- copy, modify, or create derivative works of the software;
- reverse engineer, decompile, or disassemble it, except where applicable law expressly allows this despite the restriction;
- sell, rent, or provide the software to third parties, or use it to run a service bureau;
- access it to build a competing product; or
- exceed the user or site limits in the Order Form.

**Contractors.** Third-party contractors may use the software on our behalf, but only for our benefit and under confidentiality terms at least as protective as the agreement's (§ 2.3). Each contractor counts against the 250 named-user limit.

## 3. Fees and payment (§ 4 and Order Form 1)

| Item | Amount | When due |
|---|---:|---|
| Subscription, Year 1 | $186,000 | Invoiced on the effective date |
| Subscription, Year 2 | up to $195,300 | Invoiced annually in advance |
| Subscription, Year 3 | up to $205,065 | Invoiced annually in advance |
| Implementation services (fixed fee) | $42,500 | 50% at kickoff, 50% at go-live |
| Additional named users | $620 per user per year | Prorated, invoiced quarterly |
| Premium support (optional, declined) | 15% of subscription | n/a |
| **Maximum 3-year total (as ordered)** | **$628,865** | |

- **Payment terms:** net 45 days from invoice (§ 4.2). Late amounts accrue interest at 1% per month or the legal maximum, if lower.
- **Price increases:** renewal and annual increases are capped at **5%** (§ 4.3). Years 2 and 3 above assume the full cap.
- **Taxes:** fees exclude sales and use taxes, which we pay; Northpeak pays taxes on its own income (§ 4.5).
- **Suspension:** Northpeak may suspend access if an undisputed invoice is more than 30 days overdue, after 10 business days' written notice (§ 4.6).
- **Disputes:** we may withhold amounts disputed in good faith, provided we notify Northpeak within 30 days of the invoice date (§ 4.4).

## 4. Service levels (Exhibit B)

Northpeak commits to **99.9% monthly availability**, excluding scheduled maintenance (up to 8 hours a month, announced 72 hours ahead, outside 6 a.m. to 8 p.m. Eastern on weekdays).

| Monthly availability | Service credit (% of monthly fee) |
|---|---:|
| 99.9% or higher | 0% |
| 99.0% to < 99.9% | 10% |
| 95.0% to < 99.0% | 25% |
| below 95.0% | 50% |

**Support response times** (Exhibit B, § 3):

| Severity | Definition | Initial response | Target workaround |
|---|---|---|---|
| 1 (Critical) | Production down at any site | 1 hour, 24/7 | 4 hours |
| 2 (High) | Major function impaired, no workaround | 4 business hours | 2 business days |
| 3 (Medium) | Function impaired, workaround exists | 1 business day | Next release |
| 4 (Low) | Question or cosmetic issue | 2 business days | As scheduled |

Service credits are our **sole and exclusive remedy** for missed availability targets (Exhibit B, § 2.4), with one exception: if availability falls below 95% in any two months within a rolling six-month period, we may terminate for cause and receive a prorated refund of prepaid fees (Exhibit B, § 2.5). Credits must be requested in writing within 30 days after the month ends.[^1]

## 5. Data, security, and confidentiality (§§ 6 and 7)

- **Ownership of data.** We own all data we put into the system ("Customer Data"). Northpeak may use it only to provide the service (§ 6.1).
- **Aggregated data.** Northpeak may use de-identified, aggregated usage data to improve its products, as long as it does not identify us or any individual (§ 6.3).
- **Security.** Northpeak must maintain a security program consistent with SOC 2 Type II and provide its annual report on request (§ 6.4).
- **Breach notice.** Northpeak must notify us of a security incident affecting our data **within 72 hours** of confirming it (§ 6.5).
- **Data location.** Data is hosted in the United States (AWS us-east-2 and us-west-2).
- **Return of data.** On termination, we have **60 days** to export our data in CSV or SQL format, after which Northpeak deletes it within a further 30 days and certifies deletion on request (§ 10.6).
- **Confidentiality.** Mutual obligations, lasting 5 years after termination, and indefinitely for trade secrets (§ 7).

## 6. Intellectual property (§ 5)

Northpeak keeps all rights in the software, documentation, and any improvements. Configurations and reports we create belong to us, but custom code written by Northpeak during implementation belongs to Northpeak and is licensed to us as part of the subscription (§ 5.2). **Feedback** we give may be used by Northpeak freely and without payment (§ 5.4).

## 7. Warranties (§ 8)

Northpeak warrants that:

1. the software will perform materially as described in its documentation;
2. implementation services will be performed in a professional and workmanlike manner; and
3. it will not knowingly introduce malicious code.

For a breach of warranty, Northpeak will try to fix the problem; if it cannot within 30 days, either party may terminate the affected service and we receive a refund of prepaid, unused fees (§ 8.2). All other warranties, including merchantability and fitness for a particular purpose, are disclaimed (§ 8.4).

## 8. Liability and indemnities (§ 9)

**Cap.** Each party's total liability is limited to the **fees paid or payable in the 12 months** before the claim (§ 9.2). For Year 1 that is about $186,000, plus implementation fees paid.

**Excluded damages.** Neither party is liable for indirect, consequential, or punitive damages, or lost profits (§ 9.1).

**Carve-outs** (not subject to the cap or the exclusion, § 9.3):

- breach of confidentiality;
- indemnification obligations;
- gross negligence or willful misconduct; and
- our obligation to pay fees.

> **Note:** data breaches caused by Northpeak's failure to meet its security obligations are capped separately at **2× the 12-month fees** (§ 9.4), a "super-cap." This is better than the general cap but may be low relative to our potential exposure. See Section 11.

**Indemnification.** Northpeak defends us against claims that the software infringes a third party's intellectual property (§ 9.5). If the software is found to infringe, Northpeak may modify it, get us a license, or terminate and refund prepaid fees. We indemnify Northpeak for claims arising from our data or our misuse of the software (§ 9.6).

## 9. Term and termination (§ 10)

- **Initial term:** 3 years from the effective date.
- **Renewal:** renews automatically for successive 1-year terms unless either party gives written notice at least **90 days** before the current term ends (§ 10.2).
- **For cause:** either party may terminate on 30 days' notice if the other materially breaches and does not cure within that period (§ 10.3).
- **For convenience:** **not permitted** for either party during the initial term. After the initial term, we may terminate on 90 days' notice (§ 10.4).
- **Insolvency:** either party may terminate immediately if the other becomes insolvent or enters bankruptcy (§ 10.5).
- **Effect:** access ends, unpaid fees become due, and the data-export window in Section 5 begins.

## 10. Other provisions (§§ 11 to 13)

| Provision | What it says |
|---|---|
| Assignment (§ 13.1) | Neither party may assign without consent, except to a successor in a merger or sale of substantially all assets. |
| Insurance (§ 11) | Northpeak carries $5M cyber liability and $2M general liability coverage. |
| Audit (§ 2.6) | Northpeak may audit our usage once a year on 30 days' notice. Overuse is billed at list price. |
| Force majeure (§ 13.3) | Neither party is liable for delays beyond reasonable control; the SLA still applies to Northpeak's own infrastructure. |
| Non-solicitation (§ 13.6) | Neither party may solicit the other's employees involved in the project for 12 months. |
| Dispute resolution (§ 13.5) | Executive escalation for 30 days, then courts in New York County. |
| Notices (§ 13.7) | Written, by courier or email with confirmation, to the addresses in the Order Form. |

## 11. Issues to flag before signing

1. **Auto-renewal with a 90-day window.** Easy to miss. The renewal notice deadline for the initial term falls on **August 2, 2029**. Add it to the contract calendar now.
2. **No termination for convenience in the initial term.** We are committed to roughly $629,000 over three years, even if the implementation fails to meet our needs. Consider asking for an exit right after Year 1 with a fee.
3. **Data breach super-cap of 2× fees.** Our cyber-risk team estimates breach costs for a plant-floor data exposure in the low millions. Ask for 3× or a fixed floor of $2M.
4. **Custom code ownership.** Northpeak owns integrations it writes for us (§ 5.2). If we move vendors, we may need to rebuild them. Ask for a perpetual license to implementation deliverables.
5. **Service credits as sole remedy.** Credits top out at 50% of a monthly fee, about $7,750. The chronic-outage termination right in Exhibit B, § 2.5 helps; keep it.
6. **Audit overuse billed at list price.** Ask for overuse to be billed at our contracted per-user rate.

## 12. Key dates

| Date | Event |
|---|---|
| October 24, 2026 | Target signature date |
| November 1, 2026 | Effective date; Year 1 invoice issued |
| December 16, 2026 | Year 1 invoice due (net 45) |
| Q2 2027 (est.) | Go-live; second implementation payment due |
| November 1, 2027 | Year 2 begins; price increase of up to 5% |
| November 1, 2028 | Year 3 begins |
| **August 2, 2029** | **Last day to give non-renewal notice** |
| October 31, 2029 | End of initial term |

[^1]: Service credits are applied to the next invoice and are never paid out in cash, even after termination, except in the chronic-outage case in Exhibit B, § 2.5.
