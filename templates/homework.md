---
title: "Course Name: Problem Set 1"
author: [Your Name]
date: today
number-sections: false
---

# Problem 1 {-}

Restate the problem briefly, then solve it.

We have
$$ \int_0^1 x^2 \, dx = \left[ \frac{x^3}{3} \right]_0^1 = \frac{1}{3}. $$

# Problem 2 {-}

::: {.theorem #thm:claim}
For every integer $n \ge 1$, $\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$.
:::

::: proof
By induction on $n$. For $n = 1$ both sides equal $1$. If the claim holds for $n$, then
\begin{align*}
  \sum_{k=1}^{n+1} k &= \frac{n(n+1)}{2} + (n + 1) \\
                     &= \frac{(n+1)(n+2)}{2},
\end{align*}
which is the claim for $n + 1$.
:::

# Problem 3 {-}

A matrix and its eigenvalues:
$$ A = \begin{pmatrix} 2 & 1 \\ 1 & 2 \end{pmatrix}, \qquad \det(A - \lambda I) = (\lambda - 1)(\lambda - 3), $$
so $\lambda \in \{1, 3\}$.

**Answer:** $\lambda_1 = 1$, $\lambda_2 = 3$.
