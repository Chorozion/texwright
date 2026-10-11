---
title: "Statistics Formula Reference"
subtitle: "Descriptive statistics, inference, regression, and ANOVA"
date: "Revised October 2026"
---

Notation: $n$ is the sample size, $\bar x$ the sample mean, $s$ the sample standard deviation, $\mu$ and $\sigma$ the population mean and standard deviation, $\alpha$ the significance level. $z_{q}$, $t_{q,\nu}$, $\chi^2_{q,\nu}$ and $F_{q;\nu_1,\nu_2}$ denote upper-$q$ quantiles (the value with probability $q$ to its right).

# 1. Descriptive statistics

**Sample mean and variance**

$$\bar x = \frac{1}{n}\sum_{i=1}^{n} x_i, \qquad s^2 = \frac{1}{n-1}\sum_{i=1}^{n}(x_i - \bar x)^2 = \frac{\sum x_i^2 - n\bar x^2}{n-1}$$

**Standard error of the mean:** $\displaystyle \mathrm{SE}(\bar x) = \frac{s}{\sqrt n}$  **Coefficient of variation:** $\displaystyle \mathrm{CV} = \frac{s}{\bar x}$  **z-score:** $\displaystyle z_i = \frac{x_i - \bar x}{s}$

**Covariance and Pearson correlation**

$$s_{xy} = \frac{1}{n-1}\sum_{i=1}^{n}(x_i - \bar x)(y_i - \bar y), \qquad r = \frac{s_{xy}}{s_x s_y} = \frac{\sum (x_i - \bar x)(y_i - \bar y)}{\sqrt{\sum (x_i - \bar x)^2 \sum (y_i - \bar y)^2}}$$

**Quantiles:** IQR $= Q_3 - Q_1$. Tukey's outlier fences are $Q_1 - 1.5\,\mathrm{IQR}$ and $Q_3 + 1.5\,\mathrm{IQR}$.

**Skewness and excess kurtosis** (moment estimators)

$$g_1 = \frac{\frac1n\sum (x_i - \bar x)^3}{\left(\frac1n\sum (x_i-\bar x)^2\right)^{3/2}}, \qquad g_2 = \frac{\frac1n\sum (x_i - \bar x)^4}{\left(\frac1n\sum (x_i-\bar x)^2\right)^{2}} - 3$$

# 2. Common distributions

| Distribution | PMF / PDF | Mean | Variance |
|---|---|---|---|
| Bernoulli$(p)$ | $p^x(1-p)^{1-x},\ x\in\{0,1\}$ | $p$ | $p(1-p)$ |
| Binomial$(n,p)$ | $\binom{n}{x}p^x(1-p)^{n-x}$ | $np$ | $np(1-p)$ |
| Poisson$(\lambda)$ | $\dfrac{e^{-\lambda}\lambda^x}{x!}$ | $\lambda$ | $\lambda$ |
| Geometric$(p)$ (trials to 1st success) | $(1-p)^{x-1}p$ | $1/p$ | $(1-p)/p^2$ |
| Uniform$(a,b)$ | $\dfrac{1}{b-a}$ | $\dfrac{a+b}{2}$ | $\dfrac{(b-a)^2}{12}$ |
| Normal$(\mu,\sigma^2)$ | $\dfrac{1}{\sigma\sqrt{2\pi}}e^{-(x-\mu)^2/2\sigma^2}$ | $\mu$ | $\sigma^2$ |
| Exponential$(\lambda)$ | $\lambda e^{-\lambda x},\ x\ge 0$ | $1/\lambda$ | $1/\lambda^2$ |
| Gamma$(k,\theta)$ | $\dfrac{x^{k-1}e^{-x/\theta}}{\Gamma(k)\theta^k}$ | $k\theta$ | $k\theta^2$ |
| $\chi^2_\nu$ | Gamma$(\nu/2,\,2)$ | $\nu$ | $2\nu$ |
| $t_\nu$ | $\propto \left(1 + \frac{x^2}{\nu}\right)^{-(\nu+1)/2}$ | $0$ ($\nu>1$) | $\dfrac{\nu}{\nu-2}$ ($\nu>2$) |

**Central limit theorem.** For i.i.d. $X_i$ with mean $\mu$ and variance $\sigma^2$,

$$\frac{\bar X - \mu}{\sigma/\sqrt n} \xrightarrow{d} N(0,1) \quad \text{as } n \to \infty.$$

# 3. Confidence intervals

All intervals have confidence level $1-\alpha$.

| Parameter | Interval | Conditions |
|---|---|---|
| $\mu$, $\sigma$ known | $\bar x \pm z_{\alpha/2}\,\dfrac{\sigma}{\sqrt n}$ | Normal data or large $n$ |
| $\mu$, $\sigma$ unknown | $\bar x \pm t_{\alpha/2,\,n-1}\,\dfrac{s}{\sqrt n}$ | Normal data or moderate $n$ |
| $p$ (Wald) | $\hat p \pm z_{\alpha/2}\sqrt{\dfrac{\hat p(1-\hat p)}{n}}$ | $n\hat p \ge 10$ and $n(1-\hat p) \ge 10$ |
| $\mu_1 - \mu_2$ (Welch) | $(\bar x_1 - \bar x_2) \pm t_{\alpha/2,\,\nu}\sqrt{\dfrac{s_1^2}{n_1} + \dfrac{s_2^2}{n_2}}$ | Independent samples; $\nu$ from (1) |
| $\mu_d$ (paired) | $\bar d \pm t_{\alpha/2,\,n-1}\,\dfrac{s_d}{\sqrt n}$ | $d_i = x_i - y_i$ |
| $p_1 - p_2$ | $(\hat p_1 - \hat p_2) \pm z_{\alpha/2}\sqrt{\dfrac{\hat p_1(1-\hat p_1)}{n_1} + \dfrac{\hat p_2(1-\hat p_2)}{n_2}}$ | Large samples |
| $\sigma^2$ | $\left[\dfrac{(n-1)s^2}{\chi^2_{\alpha/2,\,n-1}},\ \dfrac{(n-1)s^2}{\chi^2_{1-\alpha/2,\,n-1}}\right]$ | Normal data (sensitive to this) |

**Wilson score interval for $p$** (better than Wald for small $n$ or $p$ near 0 or 1):

$$\frac{\hat p + \dfrac{z^2}{2n} \pm z\sqrt{\dfrac{\hat p(1-\hat p)}{n} + \dfrac{z^2}{4n^2}}}{1 + \dfrac{z^2}{n}}, \qquad z = z_{\alpha/2}.$$

**Welch–Satterthwaite degrees of freedom** (1):

$$\nu = \frac{\left(\dfrac{s_1^2}{n_1} + \dfrac{s_2^2}{n_2}\right)^2}{\dfrac{(s_1^2/n_1)^2}{n_1 - 1} + \dfrac{(s_2^2/n_2)^2}{n_2 - 1}}$$

# 4. Hypothesis tests

General recipe: test statistic $= \dfrac{\text{estimate} - \text{null value}}{\text{standard error}}$. Reject $H_0$ when $p < \alpha$.

| Test | $H_0$ | Statistic | Null distribution |
|---|---|---|---|
| One-sample $z$ | $\mu = \mu_0$ | $z = \dfrac{\bar x - \mu_0}{\sigma/\sqrt n}$ | $N(0,1)$ |
| One-sample $t$ | $\mu = \mu_0$ | $t = \dfrac{\bar x - \mu_0}{s/\sqrt n}$ | $t_{n-1}$ |
| Paired $t$ | $\mu_d = 0$ | $t = \dfrac{\bar d}{s_d/\sqrt n}$ | $t_{n-1}$ |
| Two-sample pooled $t$ | $\mu_1 = \mu_2$ | $t = \dfrac{\bar x_1 - \bar x_2}{s_p\sqrt{1/n_1 + 1/n_2}}$ | $t_{n_1+n_2-2}$ |
| Welch $t$ | $\mu_1 = \mu_2$ | $t = \dfrac{\bar x_1 - \bar x_2}{\sqrt{s_1^2/n_1 + s_2^2/n_2}}$ | $t_\nu$, $\nu$ from (1) |
| One proportion | $p = p_0$ | $z = \dfrac{\hat p - p_0}{\sqrt{p_0(1-p_0)/n}}$ | $N(0,1)$ |
| Two proportions | $p_1 = p_2$ | $z = \dfrac{\hat p_1 - \hat p_2}{\sqrt{\bar p(1-\bar p)(1/n_1 + 1/n_2)}}$ | $N(0,1)$ |
| $\chi^2$ goodness of fit | Data follow given $p_i$ | $\chi^2 = \sum_{i=1}^{k}\dfrac{(O_i - E_i)^2}{E_i}$ | $\chi^2_{k-1-m}$ |
| $\chi^2$ independence | Rows ⟂ columns | $\chi^2 = \sum_{i,j}\dfrac{(O_{ij} - E_{ij})^2}{E_{ij}}$ | $\chi^2_{(r-1)(c-1)}$ |
| $F$ for variances | $\sigma_1^2 = \sigma_2^2$ | $F = s_1^2 / s_2^2$ | $F_{n_1-1,\,n_2-1}$ |

Where: $s_p^2 = \dfrac{(n_1-1)s_1^2 + (n_2-1)s_2^2}{n_1+n_2-2}$, $\bar p = \dfrac{x_1 + x_2}{n_1 + n_2}$, $E_{ij} = \dfrac{(\text{row}_i\ \text{total})(\text{col}_j\ \text{total})}{N}$, and $m$ is the number of parameters estimated from the data. The $\chi^2$ approximation needs all $E_i \ge 5$ (or at most 20% below 5 and none below 1).

**Errors and power**

| | $H_0$ true | $H_0$ false |
|---|---|---|
| Reject $H_0$ | Type I error ($\alpha$) | Correct (power $= 1-\beta$) |
| Fail to reject | Correct ($1-\alpha$) | Type II error ($\beta$) |

**Sample size** for estimating $\mu$ to margin $E$, and for a two-sided two-sample $t$-test detecting difference $\delta$ with power $1-\beta$:

$$n = \left(\frac{z_{\alpha/2}\,\sigma}{E}\right)^2, \qquad n_{\text{per group}} \approx \frac{2\,(z_{\alpha/2} + z_{\beta})^2\,\sigma^2}{\delta^2}.$$

For a proportion: $n = \dfrac{z_{\alpha/2}^2\, p(1-p)}{E^2}$, using $p = 0.5$ if unknown.

# 5. Simple linear regression

**Model:** $Y_i = \beta_0 + \beta_1 x_i + \varepsilon_i$, with $\varepsilon_i \overset{\text{iid}}{\sim} N(0, \sigma^2)$.

**Least-squares estimates**

$$\hat\beta_1 = \frac{S_{xy}}{S_{xx}} = r\,\frac{s_y}{s_x}, \qquad \hat\beta_0 = \bar y - \hat\beta_1 \bar x,$$

$$S_{xx} = \sum (x_i - \bar x)^2, \qquad S_{xy} = \sum (x_i - \bar x)(y_i - \bar y), \qquad S_{yy} = \sum (y_i - \bar y)^2.$$

**Residuals and error variance**

$$e_i = y_i - \hat y_i, \qquad \hat\sigma^2 = s_e^2 = \frac{\mathrm{SSE}}{n-2} = \frac{\sum e_i^2}{n-2}.$$

**Standard errors and inference on the slope**

$$\mathrm{SE}(\hat\beta_1) = \frac{s_e}{\sqrt{S_{xx}}}, \qquad \mathrm{SE}(\hat\beta_0) = s_e\sqrt{\frac{1}{n} + \frac{\bar x^2}{S_{xx}}}, \qquad t = \frac{\hat\beta_1 - 0}{\mathrm{SE}(\hat\beta_1)} \sim t_{n-2}.$$

**Mean response vs. prediction** at $x = x_0$:

$$\text{CI for } E[Y \mid x_0]: \quad \hat y_0 \pm t_{\alpha/2,\,n-2}\; s_e\sqrt{\frac{1}{n} + \frac{(x_0 - \bar x)^2}{S_{xx}}}$$

$$\text{Prediction interval for } Y_0: \quad \hat y_0 \pm t_{\alpha/2,\,n-2}\; s_e\sqrt{1 + \frac{1}{n} + \frac{(x_0 - \bar x)^2}{S_{xx}}}$$

**Decomposition of variation**

$$\underbrace{\sum (y_i - \bar y)^2}_{\mathrm{SST}} = \underbrace{\sum (\hat y_i - \bar y)^2}_{\mathrm{SSR}} + \underbrace{\sum (y_i - \hat y_i)^2}_{\mathrm{SSE}}, \qquad R^2 = \frac{\mathrm{SSR}}{\mathrm{SST}} = 1 - \frac{\mathrm{SSE}}{\mathrm{SST}} = r^2.$$

# 6. Multiple linear regression

**Model** with $p$ predictors, in matrix form: $\mathbf y = X\boldsymbol\beta + \boldsymbol\varepsilon$, where $X$ is $n \times (p+1)$ with a leading column of ones and $\boldsymbol\varepsilon \sim N(\mathbf 0, \sigma^2 I)$.

$$\hat{\boldsymbol\beta} = (X^\top X)^{-1} X^\top \mathbf y, \qquad \operatorname{Var}(\hat{\boldsymbol\beta}) = \sigma^2 (X^\top X)^{-1}, \qquad \hat\sigma^2 = \frac{\mathrm{SSE}}{n - p - 1}.$$

**Hat matrix and leverage:** $H = X(X^\top X)^{-1}X^\top$, $\hat{\mathbf y} = H\mathbf y$, leverage $h_{ii} = H_{ii}$, with $\sum_i h_{ii} = p + 1$.

**Coefficient test:** $t_j = \hat\beta_j / \mathrm{SE}(\hat\beta_j) \sim t_{n-p-1}$, where $\mathrm{SE}(\hat\beta_j) = \hat\sigma\sqrt{[(X^\top X)^{-1}]_{jj}}$.

**Overall $F$-test** ($H_0$: $\beta_1 = \cdots = \beta_p = 0$):

$$F = \frac{\mathrm{SSR}/p}{\mathrm{SSE}/(n-p-1)} = \frac{R^2/p}{(1-R^2)/(n-p-1)} \sim F_{p,\;n-p-1}.$$

**Partial $F$-test** comparing a reduced model (R) nested in a full model (F), dropping $q$ predictors:

$$F = \frac{(\mathrm{SSE}_R - \mathrm{SSE}_F)/q}{\mathrm{SSE}_F/(n - p - 1)} \sim F_{q,\;n-p-1}.$$

**Model comparison**

$$R^2_{\text{adj}} = 1 - (1 - R^2)\frac{n-1}{n-p-1}, \qquad \mathrm{AIC} = n\ln\!\left(\frac{\mathrm{SSE}}{n}\right) + 2(p+1), \qquad \mathrm{BIC} = n\ln\!\left(\frac{\mathrm{SSE}}{n}\right) + (p+1)\ln n.$$

**Diagnostics**

- Variance inflation factor: $\mathrm{VIF}_j = \dfrac{1}{1 - R_j^2}$, where $R_j^2$ comes from regressing $x_j$ on the other predictors. Values above 5 to 10 suggest problematic collinearity.
- Studentized residual: $r_i = \dfrac{e_i}{\hat\sigma\sqrt{1 - h_{ii}}}$.
- Cook's distance: $D_i = \dfrac{r_i^2}{p+1}\cdot\dfrac{h_{ii}}{1 - h_{ii}}$. Values above $4/n$ (or above 1) merit a look.

# 7. Analysis of variance (ANOVA)

## 7.1 One-way ANOVA

$k$ groups, group $i$ has $n_i$ observations $y_{ij}$, group mean $\bar y_{i\cdot}$, grand mean $\bar y_{\cdot\cdot}$, total $N = \sum n_i$.

$$\mathrm{SS}_{\text{between}} = \sum_{i=1}^{k} n_i(\bar y_{i\cdot} - \bar y_{\cdot\cdot})^2, \qquad \mathrm{SS}_{\text{within}} = \sum_{i=1}^{k}\sum_{j=1}^{n_i}(y_{ij} - \bar y_{i\cdot})^2,$$

$$\mathrm{SS}_{\text{total}} = \mathrm{SS}_{\text{between}} + \mathrm{SS}_{\text{within}}.$$

| Source | SS | df | MS | $F$ |
|---|---|---|---|---|
| Between groups | $\mathrm{SS}_B$ | $k - 1$ | $\mathrm{MS}_B = \mathrm{SS}_B/(k-1)$ | $\mathrm{MS}_B / \mathrm{MS}_W$ |
| Within groups (error) | $\mathrm{SS}_W$ | $N - k$ | $\mathrm{MS}_W = \mathrm{SS}_W/(N-k)$ | |
| Total | $\mathrm{SS}_T$ | $N - 1$ | | |

Under $H_0$: $\mu_1 = \cdots = \mu_k$, $F \sim F_{k-1,\,N-k}$. Assumptions: independence, normal errors, equal variances (check with Levene's test).

**Effect size:** $\eta^2 = \mathrm{SS}_B / \mathrm{SS}_T$; less biased is $\omega^2 = \dfrac{\mathrm{SS}_B - (k-1)\mathrm{MS}_W}{\mathrm{SS}_T + \mathrm{MS}_W}$.

**Tukey HSD** for pairwise comparisons (equal $n$ per group):

$$\lvert \bar y_{i\cdot} - \bar y_{j\cdot} \rvert > q_{\alpha;\,k,\,N-k}\sqrt{\frac{\mathrm{MS}_W}{n}},$$

where $q$ is the studentized range quantile.

## 7.2 Two-way ANOVA with interaction

Factor A with $a$ levels, factor B with $b$ levels, $n$ replicates per cell. Model: $y_{ijk} = \mu + \alpha_i + \beta_j + (\alpha\beta)_{ij} + \varepsilon_{ijk}$.

| Source | df | $F$ |
|---|---|---|
| A | $a - 1$ | $\mathrm{MS}_A / \mathrm{MS}_E$ |
| B | $b - 1$ | $\mathrm{MS}_B / \mathrm{MS}_E$ |
| A × B | $(a-1)(b-1)$ | $\mathrm{MS}_{AB} / \mathrm{MS}_E$ |
| Error | $ab(n-1)$ | |
| Total | $abn - 1$ | |

Test the interaction first. If it is significant, main effects must be interpreted within levels of the other factor.

# 8. Nonparametric tests

| Test | Use instead of | Statistic | Large-sample approximation |
|---|---|---|---|
| Wilcoxon signed-rank | Paired / one-sample $t$ | $W^+ = $ sum of ranks of positive differences | $z = \dfrac{W^+ - n(n+1)/4}{\sqrt{n(n+1)(2n+1)/24}}$ |
| Mann–Whitney $U$ | Two-sample $t$ | $U_1 = R_1 - \dfrac{n_1(n_1+1)}{2}$ | $z = \dfrac{U_1 - n_1 n_2/2}{\sqrt{n_1 n_2(n_1+n_2+1)/12}}$ |
| Kruskal–Wallis | One-way ANOVA | $H = \dfrac{12}{N(N+1)}\sum_{i=1}^{k}\dfrac{R_i^2}{n_i} - 3(N+1)$ | $\chi^2_{k-1}$ |
| Spearman's $\rho$ | Pearson $r$ | $\rho = 1 - \dfrac{6\sum d_i^2}{n(n^2-1)}$ (no ties) | $t = \rho\sqrt{\dfrac{n-2}{1-\rho^2}} \sim t_{n-2}$ |

$R_i$ is the sum of ranks in group $i$ after ranking all observations together; $d_i$ is the difference between the ranks of $x_i$ and $y_i$.

# 9. Effect sizes

$$\text{Cohen's } d = \frac{\bar x_1 - \bar x_2}{s_p}, \qquad \text{Hedges' } g = d\left(1 - \frac{3}{4(n_1+n_2) - 9}\right), \qquad \text{Cramér's } V = \sqrt{\frac{\chi^2}{N\,(\min(r,c) - 1)}}.$$

Rough benchmarks (Cohen): $d$ = 0.2 small, 0.5 medium, 0.8 large; $r$ = 0.1, 0.3, 0.5.

**Odds ratio** from a 2×2 table with cells $a, b$ (row 1) and $c, d$ (row 2):

$$\mathrm{OR} = \frac{ad}{bc}, \qquad \mathrm{SE}(\ln \mathrm{OR}) = \sqrt{\frac1a + \frac1b + \frac1c + \frac1d}.$$

# 10. Multiple comparisons

For $m$ tests with ordered p-values $p_{(1)} \le \cdots \le p_{(m)}$:

| Method | Controls | Rule |
|---|---|---|
| Bonferroni | FWER | Reject $H_{(i)}$ if $p_{(i)} \le \alpha/m$ |
| Holm | FWER | Find smallest $i$ with $p_{(i)} > \alpha/(m - i + 1)$; reject all hypotheses before it |
| Benjamini–Hochberg | FDR | Find largest $i$ with $p_{(i)} \le \dfrac{i}{m}\alpha$; reject $H_{(1)}, \dots, H_{(i)}$ |

# 11. Critical values

| Confidence level | 90% | 95% | 99% |
|---|---|---|---|
| $z_{\alpha/2}$ | 1.645 | 1.960 | 2.576 |
| $t_{\alpha/2,\,10}$ | 1.812 | 2.228 | 3.169 |
| $t_{\alpha/2,\,30}$ | 1.697 | 2.042 | 2.750 |
| $\chi^2_{\alpha,\,1}$ (upper tail) | 2.706 | 3.841 | 6.635 |

One-sided tests at level $\alpha$ use $z_\alpha$: 1.282 (10%), 1.645 (5%), 2.326 (1%).
