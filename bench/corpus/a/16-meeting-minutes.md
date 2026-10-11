# Meeting Minutes: Mobile App v3.2 Release Planning

**Date:** Tuesday, October 6, 2026
**Time:** 10:00–11:05 a.m. ET
**Location:** Conference Room 4B and video call
**Facilitator:** Nadia Haddad (Product Manager)
**Note-taker:** Owen Pratt (Engineering Program Manager)

**Attendees:** Nadia Haddad (Product), Owen Pratt (Program Management), Luis Moreno (iOS Lead), Grace Kim (Android Lead), Tobias Lindqvist (Backend), Aisha Bello (QA Lead), Ren Takahashi (Design), Camille Dubois (Customer Support)

**Absent:** Victor Osei (Marketing). Nadia will brief him separately.

---

## Agenda

1. Review of action items from September 29
2. v3.2 scope and feature freeze
3. QA status and open defects
4. Offline sync incident follow-up
5. App store submission plan
6. Any other business

---

## 1. Review of previous action items

| Item | Owner | Status |
|---|---|---|
| Finalize empty-state illustrations for Saved Searches | Ren | **Done.** Assets delivered on Oct 2. |
| Add rate limiting to `/v2/sync` endpoint | Tobias | **Done.** Deployed to production Oct 1. |
| Draft support macro for new notification settings | Camille | **In progress.** First draft circulated; due Oct 8. |
| Get legal sign-off on updated privacy labels | Nadia | **Blocked.** Waiting on legal review; follow-up scheduled Oct 7. |

## 2. v3.2 scope and feature freeze

Nadia reviewed the planned scope. Five of the six features are code-complete on both platforms:

- Saved Searches with push alerts
- Redesigned notification settings
- Dark mode for the onboarding flow
- Faster image upload (client-side compression)
- Accessibility fixes from the August audit (34 issues)

The sixth, **in-app receipt scanning**, is complete on iOS but about a week behind on Android. Grace explained that the Android camera library has a known autofocus bug on several Samsung models, and the workaround needs more testing than planned.

The group discussed three options: delay the release by a week, ship receipt scanning on iOS only, or hold receipt scanning for v3.3 on both platforms. Luis argued for shipping on iOS, since the feature is ready and has tested well. Camille raised the concern that a feature available on only one platform generates confusing support tickets, as happened with widgets in v2.8. Nadia agreed with Camille.

**Decision:** Receipt scanning moves to v3.3 on both platforms. The iOS code stays on the main branch behind the `receipt_scan_enabled` feature flag, turned off.

**Decision:** Feature freeze for v3.2 is **Thursday, October 8, at 6:00 p.m. ET**. After the freeze, only fixes for P0 and P1 defects will be merged, and each needs approval from Aisha or Owen.

## 3. QA status and open defects

Aisha presented the current defect counts for the v3.2 release branch:

| Severity | iOS | Android | Backend | Total | Change since last week |
|---|---:|---:|---:|---:|---:|
| P0 (blocker) | 0 | 1 | 0 | 1 | −2 |
| P1 (critical) | 2 | 3 | 1 | 6 | −4 |
| P2 (major) | 7 | 9 | 2 | 18 | +3 |
| P3 (minor) | 12 | 15 | 0 | 27 | +5 |

The remaining P0 is an Android crash when a user opens a Saved Search notification while the app is fully closed (cold start). Grace has a fix in review and expects to merge it today.

Aisha noted that the rising P2 and P3 counts come mostly from the accessibility regression pass, which is now finding issues in older screens outside the audit's scope. The group agreed these should be logged but should not block the release.

Regression testing will run October 9–13 on the 14-device matrix, plus a two-day beta with about 400 internal and TestFlight / Play Console testers.

## 4. Offline sync incident follow-up

Tobias summarized the September 24 incident, in which roughly 2,300 users saw duplicate entries after reconnecting from offline mode. The root cause was a retry path in the sync client that did not send the idempotency key. The server-side fix (deduplication by idempotency key, plus the rate limiting noted above) has been in production since October 1, with no recurrences.

The client-side fix is included in v3.2. Tobias proposed also running a one-time cleanup job to merge existing duplicates. Camille asked that affected users be notified in the app, rather than discovering silently merged entries.

**Decision:** Run the cleanup job after v3.2 reaches 50% adoption, and show affected users a one-time in-app message. Camille and Ren will draft the message copy.

## 5. App store submission plan

Owen walked through the proposed timeline:

| Milestone | Target date |
|---|---|
| Feature freeze | Thu, Oct 8, 6:00 p.m. |
| Regression testing | Fri, Oct 9 – Tue, Oct 13 |
| Release candidate build | Wed, Oct 14 |
| Submit to App Store and Google Play | Thu, Oct 15 |
| Phased rollout begins (10%) | Mon, Oct 19 (pending review) |
| 100% rollout | Mon, Oct 26, if crash-free sessions stay ≥ 99.7% |

Luis reminded the group that the updated privacy labels must be approved before App Store submission, which makes the legal sign-off from item 1 a hard dependency. Nadia will escalate if legal has not responded by Friday.

## 6. Any other business

- Ren shared early mock-ups for the v3.3 home screen redesign. Feedback is welcome in the design channel before Oct 13.
- Aisha will be out of office Oct 20–23. Mateo Ruiz will cover QA approvals during that time.

---

## Action items

| # | Action | Owner | Due |
|---|---|---|---|
| 1 | Merge fix for Android cold-start crash (P0) | Grace | Oct 6 |
| 2 | Set `receipt_scan_enabled` flag to off in v3.2 release config and update release notes | Luis | Oct 8 |
| 3 | Send feature-freeze announcement to all engineering channels | Owen | Oct 6 |
| 4 | Escalate privacy label review with legal if no response | Nadia | Oct 9 |
| 5 | Draft in-app message for users affected by the sync incident | Camille, Ren | Oct 13 |
| 6 | Prepare and test the duplicate cleanup job in staging | Tobias | Oct 16 |
| 7 | Finalize support macro for notification settings | Camille | Oct 8 |
| 8 | Brief Victor on scope change and release dates | Nadia | Oct 7 |

## Next meeting

**Tuesday, October 13, 2026, 10:00 a.m. ET**, Conference Room 4B and video call. Main topics: regression results and the go/no-go decision for submission.

*Minutes submitted by Owen Pratt on October 6, 2026. Please send corrections by end of day October 7.*
