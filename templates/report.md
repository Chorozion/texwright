---
title: "Report Title"
subtitle: "What the report covers"
author:
  - name: Your Name
    affiliation: Team or Company
date: today
theme: modern
number-sections: true
toc: true
toc-depth: 2
---

# Summary {#sec:summary}

Three to five sentences a busy reader can stop after: the question, the answer, and what should happen next.

- **Finding:** the most important result, with a number.
- **Recommendation:** the action you propose.

# Background {#sec:background}

Why this work was done and what was known before.

# Findings {#sec:findings}

## First finding

Explain it, and point at the evidence in @tbl:data.

| Metric | Before | After | Change |
|:-------|-------:|------:|-------:|
| Requests per second | 1,200 | 1,850 | +54% |
| p95 latency (ms) | 340 | 210 | −38% |

Table: Key metrics before and after the change. {#tbl:data}

## Second finding

Further detail. A footnote adds context without breaking the flow.[^source]

[^source]: Where the numbers came from.

::: note
A callout for something the reader must not miss.
:::

# Recommendations {#sec:recommendations}

1. First action, who owns it, by when.
2. Second action.

# Appendix: method {.unnumbered}

How the data was collected.
