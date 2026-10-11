---
title: "Product Requirements Document: Ripple Habit Tracker (v1.0)"
author: "Product: Maya Castellanos"
date: "Last updated October 7, 2026"
---

| Field | Value |
|---|---|
| **Product** | Ripple (iOS and Android) |
| **Document owner** | Maya Castellanos, Product Manager |
| **Status** | Draft for review |
| **Version** | 0.4 |
| **Engineering lead** | Tomás Reyes |
| **Design lead** | Priya Natarajan |
| **Stakeholders** | Growth, Data Science, Customer Support, Legal |
| **Target launch** | March 2027 (public beta January 2027) |

# 1. Overview

Ripple is a mobile app that helps people build small daily habits and keep them. Most habit trackers are built around a single streak counter, which works until the first missed day and then becomes a reason to quit. Our research shows that the moment a streak breaks is the moment most users abandon a tracker. Ripple is designed around **consistency over perfection**: flexible weekly targets, forgiving streaks, and feedback that rewards getting back on track.

## 1.1 Problem statement

In interviews with 24 people who had tried at least two habit apps in the past year:

- 19 of 24 stopped using their last app within six weeks.
- 15 of those 19 named a broken streak or "falling behind" as the reason.
- 17 of 24 said they wanted habits that do not need to happen every day (for example, "run 3 times a week").
- 11 of 24 found existing apps cluttered or time-consuming to update.

**Problem:** People who want to build habits abandon trackers because rigid daily streaks punish normal life, and logging takes too much effort.

## 1.2 Product vision

> Ripple makes it easy to log a habit in under two seconds and shows people the progress they have made, not just the days they missed.

# 2. Goals, non-goals, and success metrics

## 2.1 Goals

1. Let users create a habit and log their first check-in within 60 seconds of installing the app.
2. Support flexible schedules (daily, specific weekdays, or *N* times per week).
3. Keep users engaged after a missed day through forgiving streak rules and recovery prompts.
4. Make logging nearly effortless through widgets, notification actions, and watch support.

## 2.2 Non-goals for v1.0

- Social features (friends, sharing, leaderboards). Planned for evaluation in v1.2.
- Integration with health platforms beyond step count (Apple Health, Health Connect).
- Coaching content or AI-generated habit plans.
- Web or desktop clients.

## 2.3 Success metrics

| Metric | Definition | Target (90 days after launch) |
|---|---|---:|
| Activation rate | New users who create a habit and log a check-in on day 0 | ≥ 70% |
| Day-30 retention | Users active (≥ 1 check-in) in days 28–30 after install | ≥ 30% |
| Weekly consistency | Share of active habits meeting their weekly target | ≥ 55% |
| Recovery rate | Users who log again within 3 days after a missed scheduled day | ≥ 60% |
| Logging time | Median time from app open (or widget tap) to check-in saved | ≤ 2 s |
| Premium conversion | Users starting a paid subscription within 30 days | ≥ 4% |
| Crash-free sessions | Sessions without a crash | ≥ 99.8% |

**Counter-metric:** we will track the share of check-ins that are later undone, as a signal of accidental or dishonest logging. It should stay below 3%.

# 3. Target users

| Persona | Description | Primary need | Key frustration |
|---|---|---|---|
| **Steady Sam**, 34, project manager | Wants to exercise 3 times a week and read before bed | Flexible weekly targets | Daily streak apps make him feel he failed on rest days |
| **Restart Riya**, 27, graduate student | Has tried four habit apps, quit each after a bad week | Encouragement after setbacks | Losing a 40-day streak to one sick day |
| **Minimal Mo**, 45, nurse on rotating shifts | Wants to drink more water and stretch | Logging in one tap, odd schedules | Apps that assume a 9-to-5 week |

# 4. User stories

| ID | As a... | I want to... | So that... | Priority |
|---|---|---|---|:---:|
| US-01 | new user | create a habit from a template in a few taps | I can start without setting everything up | P0 |
| US-02 | user | set a habit to "3 times per week" | rest days don't count as failures | P0 |
| US-03 | user | check in from a home-screen widget | logging takes one tap | P0 |
| US-04 | user | get a reminder at a time I choose | I don't forget | P0 |
| US-05 | user | see my weekly progress at a glance | I know where I stand | P0 |
| US-06 | user | keep my streak if I miss one day occasionally | one bad day doesn't erase my effort | P0 |
| US-07 | user | pause a habit while traveling or sick | my stats aren't distorted | P1 |
| US-08 | user | log a quantity (e.g. 6 glasses of water) | I can track measurable habits | P1 |
| US-09 | user | see a monthly heat map and completion rate | I can see long-term trends | P1 |
| US-10 | user | check in from my watch | I don't need my phone | P2 |
| US-11 | user | export my data as CSV | I own my history | P2 |

# 5. Functional requirements

Priorities: **P0** is required for launch, **P1** is targeted for launch but can slip to v1.1, **P2** is nice to have.

## 5.1 Habit creation

| ID | Requirement | Priority |
|---|---|:---:|
| FR-1.1 | User can create a habit with a name (1–60 characters), an icon, and a color. | P0 |
| FR-1.2 | Schedule types: every day; specific weekdays; *N* times per week ($1 \le N \le 7$); every *k* days. | P0 |
| FR-1.3 | Habit type: yes/no, or quantity with a unit and a daily goal (e.g. 8 glasses). | P1 |
| FR-1.4 | Onboarding offers 12 templates (walk, read, water, meditate, etc.) with sensible defaults. | P0 |
| FR-1.5 | Free tier allows up to 5 active habits; Premium is unlimited. | P0 |

**Acceptance criteria for FR-1.2:**

- [ ] Choosing "3 times per week" shows a weekly progress ring with three segments, not a daily checklist.
- [ ] Changing a schedule applies from the current day forward and does not rewrite past results.
- [ ] Weeks start on the user's locale default (Monday or Sunday), configurable in settings.
- [ ] "Every *k* days" habits show the next due date on the habit card.

## 5.2 Check-ins

| ID | Requirement | Priority |
|---|---|:---:|
| FR-2.1 | Tapping a habit card toggles today's check-in, with haptic feedback and an undo toast for 5 seconds. | P0 |
| FR-2.2 | User can log or edit check-ins for the previous 7 days; older days are read-only. | P0 |
| FR-2.3 | Home-screen widgets (small: 1 habit; medium: 4 habits) support check-in without opening the app. | P0 |
| FR-2.4 | Reminder notifications include a "Done" action that logs the check-in. | P0 |
| FR-2.5 | Check-ins work offline and sync when connectivity returns, with last-write-wins per habit-day. | P0 |
| FR-2.6 | Apple Watch and Wear OS complications for check-in. | P2 |

## 5.3 Streaks and consistency

Ripple tracks streaks in **periods**: days for daily habits and weeks for weekly-target habits. A period is *met* when the user completes at least the scheduled number of check-ins in it.

**Grace rule.** Each habit earns one *grace token* for every 7 consecutive met periods, up to a maximum of 2 banked tokens. When a period is missed, a banked token is spent automatically and the streak continues. The streak resets only when a period is missed with no token available.

The current streak $S$ after period $t$ is therefore

$$
S_t = \begin{cases}
S_{t-1} + 1 & \text{if period } t \text{ is met}, \\
S_{t-1} & \text{if period } t \text{ is missed and a grace token is spent}, \\
0 & \text{if period } t \text{ is missed and no token is available}.
\end{cases}
$$

Alongside the streak, each habit shows a **consistency score**, the share of scheduled periods met over the last 30 days:

$$
\text{consistency} = \frac{\text{periods met in the last 30 days}}{\text{periods scheduled in the last 30 days}} \times 100\%.
$$

Paused days are excluded from both numerator and denominator.

| ID | Requirement | Priority |
|---|---|:---:|
| FR-3.1 | Implement streak counting with grace tokens as defined above. | P0 |
| FR-3.2 | Show the current streak, best streak, banked grace tokens, and consistency score on the habit detail screen. | P0 |
| FR-3.3 | When a token is spent, show a non-judgmental message ("Grace day used. Your 12-day streak is safe.") the next time the app opens. | P0 |
| FR-3.4 | After a streak resets, show a "fresh start" prompt that highlights the consistency score instead of the lost streak. | P1 |
| FR-3.5 | User can pause a habit for 1 to 30 days; paused periods neither break nor extend streaks. | P1 |

**Acceptance criteria for FR-3.1:**

- [ ] A daily habit met for 7 days in a row shows one banked grace token on day 7.
- [ ] Missing day 8 with one token keeps the streak at 7; meeting day 9 makes it 8.
- [ ] Tokens never exceed 2, regardless of streak length.
- [ ] Streak and token state are computed identically on device and server (shared test vectors in the repo).
- [ ] Time zone changes never cause a period to be counted twice or skipped; periods use the time zone in effect at the start of the period.

## 5.4 Reminders

| ID | Requirement | Priority |
|---|---|:---:|
| FR-4.1 | Per-habit reminders at a user-chosen time, on scheduled days only. | P0 |
| FR-4.2 | For weekly-target habits, an optional "catch-up" reminder when the target is at risk (e.g. 0 of 3 done by Friday). | P1 |
| FR-4.3 | Global quiet hours (default 22:00 to 07:00) suppress all reminders. | P0 |
| FR-4.4 | No more than 3 Ripple notifications per day in total, regardless of the number of habits. | P0 |

## 5.5 Insights

| ID | Requirement | Priority |
|---|---|:---:|
| FR-5.1 | Weekly summary screen every Monday: habits met, consistency trend, best day of week. | P1 |
| FR-5.2 | Monthly heat map per habit, colored by completion. | P1 |
| FR-5.3 | Export all data as CSV (Premium). | P2 |

# 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Cold start to interactive home screen in under 1.5 s on a three-year-old mid-range device; check-in feedback within 100 ms. |
| Offline | All core features work offline; sync conflicts resolved without user intervention. |
| Reliability | Crash-free sessions ≥ 99.8%; no data loss across app updates (migration tests required). |
| Accessibility | WCAG 2.2 AA; full VoiceOver and TalkBack support; Dynamic Type up to the largest size; color is never the only indicator of state. |
| Privacy | Habit data is encrypted in transit and at rest. No habit names or check-in data are sent to analytics or advertising partners. Account deletion removes all server data within 30 days. |
| Localization | Launch in English and Spanish; all strings externalized; dates and week starts follow locale. |
| Pricing | Free tier plus Premium at $3.99 per month or $29.99 per year, with a 7-day free trial. |

# 7. Analytics events

| Event | Properties | Used for |
|---|---|---|
| `habit_created` | `schedule_type`, `habit_type`, `from_template` | Activation, template usefulness |
| `checkin_logged` | `source` (app, widget, notification, watch), `latency_ms`, `is_backfill` | Logging time, surface usage |
| `checkin_undone` | `seconds_since_log` | Counter-metric |
| `grace_token_spent` | `streak_length` | Recovery analysis |
| `streak_reset` | `streak_length`, `consistency_30d` | Churn risk |
| `reminder_sent` / `reminder_actioned` | `reminder_type` | Reminder effectiveness |
| `paywall_viewed` / `subscription_started` | `trigger`, `plan` | Conversion |

Event properties never include habit names or free-text input.

# 8. Release plan

| Milestone | Date | Scope | Exit criteria |
|---|---|---|---|
| Design complete | Nov 13, 2026 | All P0 flows in high fidelity; usability test with 8 participants | No critical usability issues open |
| Alpha (internal) | Dec 11, 2026 | All P0 requirements | Streak test vectors pass on both platforms |
| Public beta | Jan 22, 2027 | P0 plus available P1; TestFlight and Play open testing, up to 2,000 users | Crash-free ≥ 99.5%; activation ≥ 60% |
| Launch (v1.0) | Mar 10, 2027 | Final P0 and P1 scope | All launch checklist items complete |
| v1.1 | May 2027 | Remaining P1, watch apps | To be defined after launch review |

# 9. Launch checklist

**Product and design**

- [x] Problem interviews and synthesis complete
- [x] Streak and grace rules approved by product, design, and data science
- [ ] Final copy for all empty states, errors, and streak messages reviewed
- [ ] Usability test round 2 complete, findings addressed

**Engineering**

- [ ] All P0 requirements implemented and passing QA
- [ ] Offline sync conflict tests passing on iOS and Android
- [ ] Time zone and daylight saving time test suite passing
- [ ] Performance budgets verified on reference devices
- [ ] Accessibility audit complete (VoiceOver, TalkBack, Dynamic Type)

**Data and analytics**

- [ ] All events in Section 7 implemented and validated in the staging dashboard
- [ ] Success-metric dashboard live before public beta

**Legal, privacy, and support**

- [x] Privacy policy draft reviewed by Legal
- [ ] App Store and Google Play data safety disclosures completed
- [ ] Support FAQ published (streaks, grace tokens, subscriptions, data export)
- [ ] Account deletion flow verified end to end

**Go to market**

- [ ] App store screenshots and preview video in English and Spanish
- [ ] Launch blog post and press kit
- [ ] Beta user referral campaign configured

# 10. Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| Grace tokens confuse users or feel like cheating | Lower trust in streaks | Usability test the explanation; make tokens visible but low-key; measure `checkin_undone` |
| Widget check-ins fail silently when the OS restricts background work | Lost check-ins, support tickets | Optimistic UI plus retry queue; telemetry on widget sync failures |
| Free tier limit of 5 habits feels restrictive | Lower activation | Test limits of 3, 5, and unlimited in beta |
| Notification fatigue | Users disable notifications or uninstall | Hard cap of 3 per day; smart catch-up reminders only when a target is at risk |

**Open questions**

1. Should grace tokens be earned faster for weekly-target habits (for example, one per 4 met weeks)? *Owner: Data Science; decide by Nov 6.*
2. Do we allow backfilling beyond 7 days for Premium users? *Owner: Product; decide by Nov 13.*
3. Should the first-run experience ask for notification permission immediately or after the first check-in? *Owner: Design; resolve through beta A/B test.*
