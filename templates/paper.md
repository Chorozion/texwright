---
title: "Title of the Paper"
author:
  - name: First Author
    affiliation: Institution
  - name: Second Author
    affiliation: Institution
date: today
abstract: |
  One paragraph: the problem, what you did, the main result with a number, and why it matters.
keywords: [first keyword, second keyword]
bibliography: refs.bib
number-sections: true
---

# Introduction {#sec:intro}

State the problem and why it matters. Cite prior work like this [@knuth1984] or name it in the sentence: @knuth1984 showed that ...

Our contributions are:

1. The first contribution (@sec:method).
2. The second contribution (@sec:results).

# Method {#sec:method}

Define the model. Numbered equations get labels so the text can refer to them:

$$ f(x) = \sum_{k=1}^{n} a_k \, x^k $$ {#eq:model}

Equation @eq:model has $n$ coefficients. Multi-line derivations number each row:

\begin{align}
  L(\theta) &= \frac{1}{2} \lVert y - X\theta \rVert^2 \label{eq:loss} \\
  \nabla L(\theta) &= X^\top (X\theta - y) \label{eq:grad}
\end{align}

::: {.theorem #thm:main title="Main result"}
Under the assumptions above, the estimate converges at rate $O(1/n)$.
:::

::: proof
Sketch the argument, referring to \eqref{eq:grad}.
:::

# Results {#sec:results}

| Method | Error | Time (s) |
|:-------|------:|---------:|
| Baseline | 0.21 | 1.0 |
| Ours | 0.12 | 1.3 |

Table: Results on the test set. {#tbl:results}

@tbl:results shows that ...

<!-- A figure: an SVG or PNG next to this file, then
![What the figure shows, in one sentence.](figure.svg){#fig:main width=80%}
and refer to it as @fig:main. -->

# Conclusion {#sec:conclusion}

Summarize the result and what comes next.
