---
title: "Subscriber Churn Model: Project Report"
subtitle: "pantrybox-churn v1.2"
author: "Data Science Team: Lena Fischer, Marcus Oyelaran"
date: "2026-10-07"
toc: true
toc-depth: 2
numbersections: false
geometry: margin=2.2cm
fontsize: 10pt
highlight-style: tango
colorlinks: true
---

# Overview

This repository contains the code, configuration and documentation for the
model that predicts which PantryBox meal-kit subscribers are likely to cancel
in the next 30 days. Retention uses the weekly scores to decide who gets a
save offer (a free box, a plan downgrade suggestion, or a call from the care
team).

**TL;DR**

- A LightGBM classifier on 41 behavioural features reaches a test ROC AUC of
  **0.846** and PR AUC of **0.472**, against a churn base rate of 11.8%.
- Contacting the top 10% of scored subscribers reaches **36.3%** of all
  churners, a lift of 3.6× over random targeting.
- The strongest signals are recency of the last order, order frequency over
  the last 90 days and the share of weeks skipped.
- Scores are well calibrated after isotonic calibration (Brier score 0.081),
  so they can be read as probabilities in the retention budget model.

> **Status:** v1.2 is in production as of 2026-09-28, scoring every Monday at
> 04:00 UTC. v1.1 is retained as a fallback for one release cycle.

# Repository layout

```text
pantrybox-churn/
├── README.md
├── pyproject.toml
├── configs/
│   ├── features.yaml          # feature definitions and windows
│   └── train.yaml             # model + CV hyperparameters
├── sql/
│   └── extract_snapshot.sql   # weekly snapshot pulled from the warehouse
├── src/churn/
│   ├── __init__.py
│   ├── data.py                # loading, label construction, splits
│   ├── features.py            # feature engineering
│   ├── train.py               # training + calibration entry point
│   ├── evaluate.py            # metrics, lift tables, plots
│   └── score.py               # batch scoring job
├── notebooks/
│   ├── 01_eda.ipynb
│   └── 02_error_analysis.ipynb
└── tests/
    ├── test_features.py
    └── test_leakage.py
```

# Setup

The project uses Python 3.11 and [uv](https://github.com/astral-sh/uv) for
dependency management.

```bash
git clone git@git.internal:data/pantrybox-churn.git
cd pantrybox-churn
uv sync                      # creates .venv and installs locked deps
uv run pytest -q             # 38 tests, ~20 s
```

Warehouse credentials are read from the environment. Copy `.env.example` to
`.env` and fill in the values from the team vault; never commit `.env`.

```bash
export SNOWFLAKE_ACCOUNT=...
export SNOWFLAKE_USER=...
export SNOWFLAKE_ROLE=ANALYTICS_RO
```

# Problem definition

For each active subscriber $i$ on a snapshot date $t$, the label is

$$
y_{i,t} = \begin{cases}
1 & \text{if subscriber } i \text{ cancels or lapses during } (t, t + 30\text{ days}],\\
0 & \text{otherwise.}
\end{cases}
$$

A *lapse* is four consecutive skipped weeks, which the business treats as
equivalent to a cancellation. Subscribers who are paused by the care team are
excluded from that week's snapshot, and so are subscribers in their first 14
days, because their behaviour is dominated by onboarding.

Snapshots are taken weekly. To avoid leaking the future into the past, every
feature for snapshot $t$ is computed from events strictly before $t$, and the
train, validation and test sets are split by **time**, not by subscriber:

| Split      | Snapshot dates           | Rows      | Subscribers | Churn rate |
|:-----------|:-------------------------|----------:|------------:|-----------:|
| Train      | 2025-01-06 to 2025-12-29 | 1,142,880 | 61,207      | 12.4%      |
| Validation | 2026-01-05 to 2026-03-30 | 236,515   | 22,961      | 11.9%      |
| Test       | 2026-04-06 (single)      | 18,402    | 18,402      | 11.8%      |

The test set is a single snapshot so that each subscriber appears exactly
once, which is how the model is used in production.

# Data and features

The weekly snapshot is built in the warehouse:

```sql
-- sql/extract_snapshot.sql (abridged)
WITH active AS (
    SELECT s.subscriber_id, s.plan_size, s.region, s.created_at
    FROM   subscriptions s
    WHERE  s.status = 'active'
      AND  s.created_at <= DATEADD(day, -14, :snapshot_date)
),
orders_90d AS (
    SELECT o.subscriber_id,
           COUNT(*)                         AS orders_last_90d,
           MAX(o.delivered_at)              AS last_delivery,
           AVG(IFF(o.discount_cents > 0, 1, 0)) AS discount_share
    FROM   orders o
    WHERE  o.delivered_at <  :snapshot_date
      AND  o.delivered_at >= DATEADD(day, -90, :snapshot_date)
    GROUP  BY o.subscriber_id
)
SELECT a.*, o.orders_last_90d, o.last_delivery, o.discount_share
FROM   active a
LEFT   JOIN orders_90d o USING (subscriber_id);
```

Feature definitions live in `configs/features.yaml`. A few examples:

```yaml
features:
  days_since_last_order:
    source: orders
    agg: days_between(max(delivered_at), snapshot_date)
    fill: 999
  skip_rate_8w:
    source: weekly_selections
    agg: mean(skipped)
    window: 8w
  support_tickets_90d:
    source: zendesk_tickets
    agg: count
    window: 90d
    filter: "category != 'billing_address_change'"
  avg_rating_last5:
    source: recipe_ratings
    agg: mean(stars)
    window: last_n(5)
    fill: null            # LightGBM handles missing natively
```

The 41 features fall into five groups:

| Group        | Count | Examples                                              |
|:-------------|------:|:------------------------------------------------------|
| Engagement   | 12    | orders in last 30/60/90 days, skip rate, recency      |
| Satisfaction | 7     | average recipe rating, ratings below 3 stars, NPS     |
| Service      | 8     | support tickets, late or damaged deliveries, refunds  |
| Commercial   | 9     | plan size, price per serving, discount share, tenure  |
| Context      | 5     | region, delivery day, household size, acquisition channel |

# Modelling

## Baseline

The baseline is an L2-regularised logistic regression on standardised
features, with missing values imputed by the median and an indicator column
for each imputed feature.

## Main model

The production model is a LightGBM gradient-boosted tree ensemble. The
training entry point is short:

```python
# src/churn/train.py (abridged)
import lightgbm as lgb
from sklearn.isotonic import IsotonicRegression

from churn.data import load_splits
from churn.features import build_features
from churn.config import load_config


def train(config_path: str = "configs/train.yaml") -> None:
    cfg = load_config(config_path)
    train_df, valid_df, _ = load_splits(cfg.data)

    X_train, y_train = build_features(train_df, cfg.features)
    X_valid, y_valid = build_features(valid_df, cfg.features)

    model = lgb.LGBMClassifier(
        n_estimators=2000,
        learning_rate=0.03,
        num_leaves=63,
        min_child_samples=200,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.7,
        reg_lambda=1.0,
        random_state=cfg.seed,
    )
    model.fit(
        X_train, y_train,
        eval_set=[(X_valid, y_valid)],
        eval_metric="auc",
        callbacks=[lgb.early_stopping(100), lgb.log_evaluation(200)],
    )

    # Calibrate on the validation snapshots (not the training data).
    raw_valid = model.predict_proba(X_valid)[:, 1]
    calibrator = IsotonicRegression(out_of_bounds="clip").fit(raw_valid, y_valid)

    save_artifacts(model, calibrator, cfg.output_dir)
```

Early stopping selected 1,184 trees. Hyperparameters were tuned with 40
Optuna trials on the validation AUC; the search space is in
`configs/train.yaml`. Because the validation set also feeds calibration,
neither tuning nor calibration ever sees the test snapshot.

## Evaluation metrics

With an 11.8% base rate, accuracy is not informative (always predicting "no
churn" scores 88.2%). We report:

- **ROC AUC**, the probability that a random churner is scored above a random
  non-churner;
- **PR AUC** (average precision), which is more sensitive to performance among
  the highest scores;
- **Recall at top $k$%**, the share of all churners captured if Retention
  contacts the $k$% highest-scored subscribers;
- **Brier score**, $\frac{1}{n}\sum_i (\hat p_i - y_i)^2$, for calibration.

# Results

All numbers are on the held-out test snapshot (2026-04-06, $n = 18{,}402$,
2,171 churners).

| Model                           | ROC AUC | PR AUC | Recall @ 5% | Recall @ 10% | Recall @ 20% | Brier |
|:--------------------------------|--------:|-------:|------------:|-------------:|-------------:|------:|
| Random                          | 0.500   | 0.118  | 5.0%        | 10.0%        | 20.0%        | 0.104 |
| Rule: no order in 21 days       | 0.682   | 0.231  | n/a         | n/a          | n/a          | n/a   |
| Logistic regression             | 0.781   | 0.341  | 18.9%       | 30.2%        | 48.7%        | 0.090 |
| LightGBM (uncalibrated)         | 0.846   | 0.472  | 23.4%       | 36.3%        | 57.9%        | 0.086 |
| **LightGBM + isotonic (v1.2)**  | **0.846** | **0.472** | **23.4%** | **36.3%** | **57.9%** | **0.081** |

Isotonic calibration is monotone, so it leaves the ranking metrics unchanged
and only improves the Brier score. The rule-based baseline is what Retention
used before v1.0; it flags 14.6% of subscribers, so it has no top-$k$ figures.

Bootstrap 95% confidence intervals (1,000 resamples of the test snapshot):
ROC AUC 0.838 to 0.854; PR AUC 0.455 to 0.490.

## What drives the predictions

![Mean absolute SHAP value for the ten most important features on the test
snapshot. Larger values mean the feature moves predictions more on
average.](05-feature-importance.svg){width=90%}

Recency dominates: subscribers who have not received a box in three or more
weeks are, unsurprisingly, the most likely to leave. More useful for
Retention are the next tier of signals, which can be acted on:

- a **skip rate** above 50% over the last eight weeks roughly doubles the
  predicted risk, all else equal;
- each **support ticket** in the last 90 days adds risk, but tickets that were
  resolved with a refund add noticeably less than unresolved ones;
- a high **discount share** (subscribers who mostly order on promotions) is
  associated with churn once promotions stop.

SHAP values describe the model, not causal effects. A subscriber with many
tickets is not necessarily churning *because* of the tickets.

## Error analysis

The notebook `notebooks/02_error_analysis.ipynb` has the details. Two patterns
stand out:

1. **Sudden churners.** About 22% of churners had no warning signs: regular
   orders, good ratings, no tickets. Their median score was 0.06. Exit
   surveys for this group mostly cite moving house, a change in household,
   or budget. These are not things our features can see.
2. **Holiday skippers.** Long-tenure subscribers who skip several weeks over
   summer or year-end look like lapsing customers and are over-scored. We added
   `tenure_days` interactions in v1.2, which reduced false positives in this
   group by about a third compared with v1.1, but some remain.

# Reproducing the results

```bash
# 1. Pull snapshots (needs warehouse access, ~15 min)
uv run python -m churn.data --start 2025-01-06 --end 2026-04-06 --out data/

# 2. Train and calibrate
uv run python -m churn.train --config configs/train.yaml

# 3. Evaluate on the test snapshot
uv run python -m churn.evaluate --model artifacts/v1.2 --split test
```

The evaluation step writes `reports/metrics.json`, the lift table and the
SHAP summary plot. With the fixed seed (`seed: 20260406` in `train.yaml`)
the metrics should match the table above to three decimal places.

# Limitations and known issues

- **Policy feedback.** Once Retention acts on the scores, saved subscribers
  appear as non-churners in future labels. Training on those labels would
  teach the model that high-risk profiles do not churn. v1.2 excludes
  subscribers who received a save offer in the 30 days before a snapshot;
  a holdout group that receives no offers is planned for Q1 2027 so that we
  can measure uplift directly.
- **Drift.** The April 2026 price change shifted `price_per_serving` for
  every subscriber. The feature is monitored weekly with the population
  stability index (PSI); an alert fires above 0.2.
- **Coverage.** Gift subscriptions and corporate accounts are excluded and
  are not scored.

# Next steps

| Item                                                     | Owner   | Target   |
|:---------------------------------------------------------|:--------|:---------|
| Uplift model using the Q1 2027 holdout                   | Lena    | 2027-Q2  |
| Add recipe-level features (cuisine fatigue)              | Marcus  | 2026-11  |
| Move scoring from weekly batch to daily                  | Platform | 2027-Q1 |
| Fairness review by region and household size             | Lena    | 2026-12  |

Questions and issues go to `#ds-retention` or the repository issue tracker.
