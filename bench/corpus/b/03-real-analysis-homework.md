---
title: "MATH 341 Real Analysis I: Homework 4 Solutions"
author: "Solutions prepared for the course staff"
date: "Fall 2026"
---

**Conventions.** Throughout, $\mathbb{N} = \{1, 2, 3, \dots\}$. A sequence $(a_n)$ *converges* to $L$ if for every $\varepsilon > 0$ there is $N \in \mathbb{N}$ such that $|a_n - L| < \varepsilon$ for all $n \ge N$. For $f$ defined on a set containing a punctured neighborhood of $c$, $\lim_{x \to c} f(x) = L$ means that for every $\varepsilon > 0$ there is $\delta > 0$ such that $0 < |x - c| < \delta$ implies $|f(x) - L| < \varepsilon$.

For each problem I give the scratch work first (how one finds $\delta$ or $N$) and then the proof as it should be written. The scratch work is not part of the proof.

---

## Problem 1

*Prove directly from the definition that $\displaystyle\lim_{x \to 3} (x^2 - 2x) = 3$.*

**Scratch work.** We need to control
$$
|x^2 - 2x - 3| = |x - 3|\,|x + 1|.
$$
The factor $|x - 3|$ is what we make small. The factor $|x + 1|$ must be bounded. If we insist that $|x - 3| < 1$, then $2 < x < 4$, so $3 < x + 1 < 5$ and $|x + 1| < 5$. Then $|x^2 - 2x - 3| < 5|x - 3|$, which is less than $\varepsilon$ once $|x - 3| < \varepsilon / 5$. So take $\delta = \min\{1, \varepsilon/5\}$.

**Proof.** Let $\varepsilon > 0$ and set $\delta = \min\{1, \varepsilon/5\}$. Suppose $0 < |x - 3| < \delta$. Since $\delta \le 1$, we have $2 < x < 4$, hence $0 < x + 1 < 5$. Therefore
$$
|(x^2 - 2x) - 3| = |x - 3|\,|x + 1| < 5|x - 3| < 5 \cdot \frac{\varepsilon}{5} = \varepsilon.
$$
Hence $\lim_{x \to 3}(x^2 - 2x) = 3$. $\blacksquare$

> **Common error.** Several submissions chose $\delta = \varepsilon / |x + 1|$. This is not allowed: $\delta$ may depend on $\varepsilon$ and on the point $c = 3$, but not on $x$.

---

## Problem 2

*Let $f : [0, \infty) \to \mathbb{R}$, $f(x) = \sqrt{x}$. Prove that $f$ is continuous at every $a \ge 0$.*

**Proof.** Fix $\varepsilon > 0$. We treat $a > 0$ and $a = 0$ separately.

*Case $a > 0$.* For $x \ge 0$, rationalizing gives
$$
\left|\sqrt{x} - \sqrt{a}\right| = \frac{|x - a|}{\sqrt{x} + \sqrt{a}} \le \frac{|x - a|}{\sqrt{a}},
$$
since $\sqrt{x} \ge 0$. Let $\delta = \varepsilon \sqrt{a} > 0$. If $x \ge 0$ and $|x - a| < \delta$, then $\left|\sqrt{x} - \sqrt{a}\right| < \delta / \sqrt{a} = \varepsilon$.

*Case $a = 0$.* Let $\delta = \varepsilon^2$. If $0 \le x < \delta$, then $|\sqrt{x} - 0| = \sqrt{x} < \sqrt{\varepsilon^2} = \varepsilon$, because the square root is increasing on $[0, \infty)$.

In both cases $|x - a| < \delta$ implies $|f(x) - f(a)| < \varepsilon$, so $f$ is continuous at $a$. $\blacksquare$

*Remark.* The $\delta$ in the first case shrinks as $a \to 0^+$, which is why $a = 0$ needs its own argument. In fact $f$ is uniformly continuous on $[0, \infty)$: one can check that $|\sqrt{x} - \sqrt{y}| \le \sqrt{|x - y|}$ for all $x, y \ge 0$, so $\delta = \varepsilon^2$ works everywhere.

---

## Problem 3

*Prove that $\displaystyle a_n = \frac{3n^2 + 1}{n^2 + 4}$ converges to $3$.*

**Scratch work.**
$$
\left| \frac{3n^2 + 1}{n^2 + 4} - 3 \right| = \left| \frac{3n^2 + 1 - 3n^2 - 12}{n^2 + 4} \right| = \frac{11}{n^2 + 4} < \frac{11}{n^2} \le \frac{11}{n}.
$$
The last quantity is less than $\varepsilon$ when $n > 11/\varepsilon$.

**Proof.** Let $\varepsilon > 0$. By the Archimedean property there is $N \in \mathbb{N}$ with $N > 11/\varepsilon$. For $n \ge N$,
$$
|a_n - 3| = \frac{11}{n^2 + 4} < \frac{11}{n} \le \frac{11}{N} < \varepsilon.
$$
Thus $a_n \to 3$. $\blacksquare$

---

## Problem 4

*Define $a_1 = 1$ and $a_{n+1} = \sqrt{2 + a_n}$ for $n \ge 1$. Prove that $(a_n)$ converges and find its limit.*

We show that $(a_n)$ is increasing and bounded above by $2$, then apply the Monotone Convergence Theorem.

**Claim A.** $0 < a_n < 2$ for all $n$.

*Proof by induction.* $a_1 = 1$ satisfies the claim. If $0 < a_n < 2$, then $2 < 2 + a_n < 4$, so $\sqrt{2} < a_{n+1} < 2$, and in particular $0 < a_{n+1} < 2$.

**Claim B.** $a_{n+1} > a_n$ for all $n$.

*Proof.* Since $a_n > 0$ and $a_{n+1} > 0$, the inequality $a_{n+1} > a_n$ is equivalent to $a_{n+1}^2 > a_n^2$, that is, to $2 + a_n > a_n^2$. Now
$$
2 + a_n - a_n^2 = (2 - a_n)(1 + a_n),
$$
and both factors are positive by Claim A. Hence $a_{n+1} > a_n$.

**Conclusion.** By Claims A and B, $(a_n)$ is increasing and bounded above, so by the Monotone Convergence Theorem it converges to some $L$. Since $a_n \ge a_1 = 1$ for all $n$, we have $L \ge 1$. Because $t \mapsto \sqrt{2 + t}$ is continuous on $[0, \infty)$ (Problem 2 and the algebra of continuous functions), passing to the limit in the recursion gives
$$
L = \lim_{n \to \infty} a_{n+1} = \lim_{n \to \infty} \sqrt{2 + a_n} = \sqrt{2 + L}.
$$
Squaring, $L^2 - L - 2 = 0$, so $(L - 2)(L + 1) = 0$. Since $L \ge 1$, we conclude $L = 2$. $\blacksquare$

> **Why the order matters.** Writing "$L = \sqrt{2 + L}$, so $L = 2$" without first proving convergence is a gap. The sequence $b_{n+1} = 2b_n$, $b_1 = 1$ satisfies the same kind of manipulation ($L = 2L$, so $L = 0$), yet it diverges.

---

## Problem 5

*Suppose $a_n \to L$ and $b_n \to M$. Prove that $a_n b_n \to LM$.*

**Scratch work.** Add and subtract $a_n M$:
$$
|a_n b_n - LM| = |a_n(b_n - M) + M(a_n - L)| \le |a_n|\,|b_n - M| + |M|\,|a_n - L|.
$$
We need a bound on $|a_n|$, which comes from the fact that convergent sequences are bounded.

**Lemma.** A convergent sequence is bounded.

*Proof.* Take $\varepsilon = 1$ in the definition of $a_n \to L$: there is $N_0$ with $|a_n - L| < 1$ for $n \ge N_0$, hence $|a_n| < |L| + 1$ for those $n$. Let
$$
K = \max\{|a_1|, |a_2|, \dots, |a_{N_0 - 1}|, |L| + 1\}.
$$
Then $|a_n| \le K$ for every $n$. $\square$

**Proof of Problem 5.** Let $K > 0$ bound $|a_n|$, as in the lemma. Let $\varepsilon > 0$. Choose $N_1$ such that $|b_n - M| < \varepsilon / (2K)$ for $n \ge N_1$, and $N_2$ such that $|a_n - L| < \varepsilon / (2|M| + 1)$ for $n \ge N_2$. (The $+1$ avoids dividing by zero when $M = 0$.) For $n \ge N = \max\{N_1, N_2\}$,
$$
\begin{aligned}
|a_n b_n - LM| &\le |a_n|\,|b_n - M| + |M|\,|a_n - L| \\
&< K \cdot \frac{\varepsilon}{2K} + |M| \cdot \frac{\varepsilon}{2|M| + 1} \\
&< \frac{\varepsilon}{2} + \frac{\varepsilon}{2} = \varepsilon.
\end{aligned}
$$
Hence $a_n b_n \to LM$. $\blacksquare$

---

## Problem 6

*(a) Let $f(x) = x \sin(1/x)$ for $x \ne 0$ and $f(0) = 0$. Prove that $f$ is continuous at $0$.*

*(b) Prove that $\displaystyle\lim_{x \to 0} \sin(1/x)$ does not exist.*

**(a) Proof.** Let $\varepsilon > 0$ and take $\delta = \varepsilon$. If $|x| < \delta$ and $x \ne 0$, then since $|\sin t| \le 1$ for all real $t$,
$$
|f(x) - f(0)| = |x|\,|\sin(1/x)| \le |x| < \varepsilon.
$$
If $x = 0$ the difference is $0$. So $f$ is continuous at $0$. $\blacksquare$

**(b) Proof.** We use the sequential criterion: if $\lim_{x \to 0} g(x) = L$, then $g(x_n) \to L$ for *every* sequence $x_n \to 0$ with $x_n \ne 0$. Define
$$
x_n = \frac{1}{2\pi n}, \qquad y_n = \frac{1}{2\pi n + \pi/2}.
$$
Both sequences are nonzero and tend to $0$. But $\sin(1/x_n) = \sin(2\pi n) = 0$ for every $n$, while $\sin(1/y_n) = \sin(2\pi n + \pi/2) = 1$ for every $n$. If the limit existed and equaled $L$, we would need $L = 0$ and $L = 1$ at once, a contradiction. $\blacksquare$

---

## Problem 7

*Prove that the sequence $a_n = (-1)^n$ diverges.*

**Proof.** Suppose, for contradiction, that $a_n \to L$ for some $L \in \mathbb{R}$. Apply the definition with $\varepsilon = 1$: there is $N$ such that $|a_n - L| < 1$ for all $n \ge N$. Taking $n = 2N$ (even) and $n = 2N + 1$ (odd), both at least $N$, we get
$$
2 = |a_{2N} - a_{2N+1}| \le |a_{2N} - L| + |L - a_{2N+1}| < 1 + 1 = 2,
$$
which is impossible. Hence $(a_n)$ diverges. $\blacksquare$

---

## Problem 8 (bonus)

*Prove that $g(x) = x^2$ is uniformly continuous on $[0, 1]$ but not on $\mathbb{R}$.*

**On $[0,1]$.** For $x, y \in [0, 1]$, $|x^2 - y^2| = |x + y|\,|x - y| \le 2|x - y|$. Given $\varepsilon > 0$, the choice $\delta = \varepsilon / 2$ works for all $x, y \in [0,1]$ simultaneously, which is exactly uniform continuity.

**Not on $\mathbb{R}$.** Uniform continuity would give, for $\varepsilon = 1$, a single $\delta > 0$ such that $|x - y| < \delta$ implies $|x^2 - y^2| < 1$. Take $x = n$ and $y = n + \delta/2$ with $n \in \mathbb{N}$. Then $|x - y| = \delta/2 < \delta$, yet
$$
|x^2 - y^2| = \frac{\delta}{2}\left(2n + \frac{\delta}{2}\right) > n\delta,
$$
which exceeds $1$ as soon as $n > 1/\delta$. This contradicts the choice of $\delta$. $\blacksquare$

---

### Grading notes

| Problem | Points | Most common deduction |
|:-------:|:------:|:----------------------|
| 1 | 10 | $\delta$ depending on $x$ |
| 2 | 10 | Missing the case $a = 0$ |
| 3 | 10 | Inequalities in the wrong direction |
| 4 | 15 | Solving $L = \sqrt{2 + L}$ before proving convergence |
| 5 | 15 | No bound on $\lvert a_n \rvert$; dividing by $\lvert M \rvert$ when $M = 0$ |
| 6 | 15 | In (b), using only one sequence |
| 7 | 10 | Arguing from "it oscillates" without an $\varepsilon$ |
| 8 | +5 | Negating uniform continuity with the quantifiers in the wrong order |
| **Total** | **85 (+5)** | |
