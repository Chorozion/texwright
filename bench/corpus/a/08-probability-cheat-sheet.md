---
title: "Probability Distributions Cheat Sheet"
geometry: "landscape, margin=0.5in"
fontsize: 9pt
pagestyle: empty
---

**Notation.** $X$ is a random variable with mean $\mu = E[X]$ and variance $\sigma^2 = \operatorname{Var}(X)$. The moment generating function (MGF) is $M_X(t) = E[e^{tX}]$, defined for $t$ in a neighborhood of 0 where the expectation is finite. $q = 1 - p$ throughout.

## Discrete distributions

| Distribution | PMF $P(X = k)$ | Support | Mean | Variance | MGF $M_X(t)$ |
|:--|:--|:--|:--|:--|:--|
| Bernoulli$(p)$ | $p^k q^{1-k}$ | $k \in \{0, 1\}$ | $p$ | $pq$ | $q + pe^t$ |
| Binomial$(n, p)$ | $\binom{n}{k} p^k q^{n-k}$ | $k = 0, 1, \dots, n$ | $np$ | $npq$ | $(q + pe^t)^n$ |
| Geometric$(p)$, trials to 1st success | $q^{k-1} p$ | $k = 1, 2, \dots$ | $\frac{1}{p}$ | $\frac{q}{p^2}$ | $\frac{pe^t}{1 - qe^t}$, $t < -\ln q$ |
| Negative binomial$(r, p)$, trials to $r$th success | $\binom{k-1}{r-1} p^r q^{k-r}$ | $k = r, r+1, \dots$ | $\frac{r}{p}$ | $\frac{rq}{p^2}$ | $\left(\frac{pe^t}{1 - qe^t}\right)^r$ |
| Poisson$(\lambda)$ | $\frac{e^{-\lambda}\lambda^k}{k!}$ | $k = 0, 1, 2, \dots$ | $\lambda$ | $\lambda$ | $\exp\{\lambda(e^t - 1)\}$ |
| Hypergeometric$(N, K, n)$ | $\frac{\binom{K}{k}\binom{N-K}{n-k}}{\binom{N}{n}}$ | $\max(0, n{+}K{-}N) \le k \le \min(n, K)$ | $\frac{nK}{N}$ | $n\frac{K}{N}\frac{N-K}{N}\frac{N-n}{N-1}$ | no simple form |
| Discrete uniform$\{a, \dots, b\}$ | $\frac{1}{m}$, $m = b - a + 1$ | $k = a, \dots, b$ | $\frac{a+b}{2}$ | $\frac{m^2 - 1}{12}$ | $\frac{e^{at} - e^{(b+1)t}}{m(1 - e^t)}$ |

> **Geometric, other convention.** If $Y$ counts *failures* before the first success, then $Y = X - 1$, $P(Y = k) = q^k p$ for $k \ge 0$, $E[Y] = q/p$, and $\operatorname{Var}(Y) = q/p^2$.

## Continuous distributions

| Distribution | PDF $f(x)$ | Support | Mean | Variance | MGF $M_X(t)$ |
|:--|:--|:--|:--|:--|:--|
| Uniform$(a, b)$ | $\frac{1}{b - a}$ | $a \le x \le b$ | $\frac{a + b}{2}$ | $\frac{(b - a)^2}{12}$ | $\frac{e^{tb} - e^{ta}}{t(b - a)}$ |
| Normal$(\mu, \sigma^2)$ | $\frac{1}{\sigma\sqrt{2\pi}} e^{-(x - \mu)^2/(2\sigma^2)}$ | $\mathbb{R}$ | $\mu$ | $\sigma^2$ | $e^{\mu t + \sigma^2 t^2/2}$ |
| Exponential$(\lambda)$, rate | $\lambda e^{-\lambda x}$ | $x \ge 0$ | $\frac{1}{\lambda}$ | $\frac{1}{\lambda^2}$ | $\frac{\lambda}{\lambda - t}$, $t < \lambda$ |
| Gamma$(\alpha, \beta)$, rate | $\frac{\beta^\alpha}{\Gamma(\alpha)} x^{\alpha - 1} e^{-\beta x}$ | $x > 0$ | $\frac{\alpha}{\beta}$ | $\frac{\alpha}{\beta^2}$ | $\left(\frac{\beta}{\beta - t}\right)^\alpha$, $t < \beta$ |
| Beta$(\alpha, \beta)$ | $\frac{x^{\alpha - 1}(1 - x)^{\beta - 1}}{B(\alpha, \beta)}$ | $0 < x < 1$ | $\frac{\alpha}{\alpha + \beta}$ | $\frac{\alpha\beta}{(\alpha + \beta)^2(\alpha + \beta + 1)}$ | no simple form |
| Chi-squared$(k)$ | $\frac{x^{k/2 - 1} e^{-x/2}}{2^{k/2}\Gamma(k/2)}$ | $x > 0$ | $k$ | $2k$ | $(1 - 2t)^{-k/2}$, $t < \frac12$ |
| Student's $t_\nu$ | $\frac{\Gamma\left(\frac{\nu + 1}{2}\right)}{\sqrt{\nu\pi}\,\Gamma\left(\frac{\nu}{2}\right)}\left(1 + \frac{x^2}{\nu}\right)^{-\frac{\nu + 1}{2}}$ | $\mathbb{R}$ | $0$ ($\nu > 1$) | $\frac{\nu}{\nu - 2}$ ($\nu > 2$) | does not exist |
| Log-normal$(\mu, \sigma^2)$ | $\frac{1}{x\sigma\sqrt{2\pi}} e^{-(\ln x - \mu)^2/(2\sigma^2)}$ | $x > 0$ | $e^{\mu + \sigma^2/2}$ | $(e^{\sigma^2} - 1)e^{2\mu + \sigma^2}$ | does not exist |
| Cauchy$(x_0, \gamma)$ | $\frac{1}{\pi\gamma\left[1 + \left(\frac{x - x_0}{\gamma}\right)^2\right]}$ | $\mathbb{R}$ | undefined | undefined | does not exist |

**Scale vs. rate.** Many texts (and `scipy.stats`) parametrize the exponential and gamma by a scale $\theta = 1/\beta$. Then Gamma has mean $\alpha\theta$, variance $\alpha\theta^2$ and MGF $(1 - \theta t)^{-\alpha}$. Always check which convention a source uses.

## Moments and identities

$$
\operatorname{Var}(X) = E[X^2] - (E[X])^2, \qquad E[X^n] = M_X^{(n)}(0), \qquad \operatorname{Cov}(X, Y) = E[XY] - E[X]E[Y]
$$

$$
\operatorname{Var}(aX + bY + c) = a^2\operatorname{Var}(X) + b^2\operatorname{Var}(Y) + 2ab\operatorname{Cov}(X, Y)
$$

$$
\rho_{XY} = \frac{\operatorname{Cov}(X, Y)}{\sigma_X\sigma_Y} \in [-1, 1], \qquad M_{aX + b}(t) = e^{bt}M_X(at)
$$

- **Independent sums.** If $X \perp Y$, then $M_{X+Y}(t) = M_X(t)\,M_Y(t)$ and $\operatorname{Var}(X + Y) = \operatorname{Var}(X) + \operatorname{Var}(Y)$.
- **Law of total expectation.** $E[X] = E\bigl[E[X \mid Y]\bigr]$.
- **Law of total variance.** $\operatorname{Var}(X) = E\bigl[\operatorname{Var}(X \mid Y)\bigr] + \operatorname{Var}\bigl(E[X \mid Y]\bigr)$.
- **Tail sum (nonnegative integer $X$).** $E[X] = \sum_{k=1}^{\infty} P(X \ge k)$. For continuous $X \ge 0$: $E[X] = \int_0^\infty P(X > x)\,dx$.
- **Skewness and kurtosis.** $\gamma_1 = E[(X - \mu)^3]/\sigma^3$ and $\kappa = E[(X - \mu)^4]/\sigma^4$; a normal distribution has $\gamma_1 = 0$ and $\kappa = 3$.

## Relationships between distributions

| If ... | then ... |
|:--|:--|
| $X_1, \dots, X_n \overset{\text{iid}}{\sim}$ Bernoulli$(p)$ | $\sum X_i \sim$ Binomial$(n, p)$ |
| $X \sim$ Binomial$(n, p)$, $n \to \infty$, $np \to \lambda$ | $X \xrightarrow{d}$ Poisson$(\lambda)$ |
| $X \sim$ Poisson$(\lambda_1)$, $Y \sim$ Poisson$(\lambda_2)$, independent | $X + Y \sim$ Poisson$(\lambda_1 + \lambda_2)$ |
| $X_1, \dots, X_n \overset{\text{iid}}{\sim}$ Exponential$(\lambda)$ | $\sum X_i \sim$ Gamma$(n, \lambda)$ |
| $X \sim$ Exponential$(\lambda)$ | $P(X > s + t \mid X > s) = P(X > t)$ (memoryless) |
| $Z \sim N(0, 1)$ | $Z^2 \sim \chi^2_1$ |
| $Z_1, \dots, Z_k \overset{\text{iid}}{\sim} N(0, 1)$ | $\sum Z_i^2 \sim \chi^2_k =$ Gamma$\left(\frac{k}{2}, \frac12\right)$ |
| $Z \sim N(0,1)$, $V \sim \chi^2_\nu$, independent | $Z / \sqrt{V/\nu} \sim t_\nu$ |
| $U \sim \chi^2_{d_1}$, $V \sim \chi^2_{d_2}$, independent | $\frac{U/d_1}{V/d_2} \sim F_{d_1, d_2}$ |
| $X \sim$ Gamma$(\alpha, \lambda)$, $Y \sim$ Gamma$(\beta, \lambda)$, independent | $\frac{X}{X + Y} \sim$ Beta$(\alpha, \beta)$ |
| $X \sim N(\mu, \sigma^2)$ | $e^X \sim$ Log-normal$(\mu, \sigma^2)$ |
| $U \sim$ Uniform$(0, 1)$ | $-\frac{1}{\lambda}\ln U \sim$ Exponential$(\lambda)$ |

## Limit theorems and inequalities

**Central limit theorem.** If $X_1, X_2, \dots$ are iid with mean $\mu$ and finite variance $\sigma^2$, then
$$
\frac{\bar{X}_n - \mu}{\sigma/\sqrt{n}} \xrightarrow{d} N(0, 1), \qquad \bar{X}_n = \frac{1}{n}\sum_{i=1}^n X_i.
$$

**Normal approximation to the binomial** (rule of thumb $np \ge 10$ and $nq \ge 10$), with continuity correction:
$$
P(X \le k) \approx \Phi\!\left(\frac{k + 0.5 - np}{\sqrt{npq}}\right).
$$

**Markov.** For $X \ge 0$ and $a > 0$: $\displaystyle P(X \ge a) \le \frac{E[X]}{a}$.

**Chebyshev.** For $k > 0$: $\displaystyle P\bigl(|X - \mu| \ge k\sigma\bigr) \le \frac{1}{k^2}$.

**Jensen.** For convex $g$: $g(E[X]) \le E[g(X)]$. For example, $(E[X])^2 \le E[X^2]$.

**Chernoff bound.** For any $t > 0$: $P(X \ge a) \le e^{-ta}M_X(t)$; minimize over $t$.

## Handy values

| $z$ | 1.000 | 1.282 | 1.645 | 1.960 | 2.326 | 2.576 | 3.291 |
|:--|--:|--:|--:|--:|--:|--:|--:|
| $\Phi(z)$ | 0.8413 | 0.9000 | 0.9500 | 0.9750 | 0.9900 | 0.9950 | 0.9995 |

$\Gamma(n) = (n-1)!$, $\quad \Gamma\!\left(\tfrac12\right) = \sqrt{\pi}$, $\quad \Gamma(x + 1) = x\,\Gamma(x)$, $\quad B(\alpha, \beta) = \dfrac{\Gamma(\alpha)\Gamma(\beta)}{\Gamma(\alpha + \beta)}$.

The 68–95–99.7 rule: for a normal distribution, $P(|X - \mu| < k\sigma) \approx 0.683$, $0.954$ and $0.997$ for $k = 1, 2, 3$.
