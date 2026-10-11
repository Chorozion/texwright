---
title: "Lab 4: Multiple Linear Regression"
subtitle: "Modelling fuel economy in the 1974 *Motor Trend* road tests"
author:
  - Priya Raman
  - "STAT 3200: Applied Regression Analysis, Section 02"
date: "October 7, 2026"
abstract: |
  We model the fuel economy of 32 automobiles from the 1974 *Motor Trend* road
  tests as a linear function of vehicle weight and gross horsepower. A
  simple regression on weight alone explains 75.3% of the variation in miles
  per gallon; adding horsepower raises $R^2$ to 0.827 and lowers the residual
  standard error from 3.05 to 2.59 mpg. Holding horsepower fixed, each
  additional 1000 lb of weight is associated with a 3.88 mpg decrease in fuel
  economy (95% CI: 2.58 to 5.17). Residual diagnostics show no evidence of
  heteroscedasticity but a mild right skew driven by three small,
  high-mileage imports and one heavy luxury sedan. A model with a
  weight-by-horsepower interaction fits noticeably better
  ($F_{1,28} = 14.09$, $p < 0.001$).
bibliography: 01-references.bib
link-citations: true
numbersections: true
geometry: margin=1in
fontsize: 11pt
header-includes:
  - \usepackage{booktabs}
  - \usepackage{float}
  - \floatplacement{figure}{H}
---

# Introduction

How much does a car's weight cost in fuel economy, once we account for the
fact that heavier cars also tend to have bigger engines? This lab answers that
question with the `mtcars` data set, which ships with R [@rcore2024] and was
extracted from the 1974 *Motor Trend* US magazine road tests. The data were
popularised as a regression teaching example by @henderson1981, who used them
to illustrate interactive model building.

The objectives of the lab were to:

1. fit and interpret a simple linear regression of fuel economy on weight;
2. extend it to a multiple regression that adds horsepower, and interpret the
   partial slopes;
3. check the usual regression assumptions using residual plots and formal
   tests; and
4. compare a small set of candidate models on fit and parsimony.

# Data

The data set contains 32 observations on 11 variables. We use four of them
(Table 1). All 32 cars are 1973--74 model-year vehicles, so the sample is
small and far from representative of the modern fleet; the analysis should be
read as an exercise in method rather than a claim about present-day cars.

Table: Variables used in this lab.

| Variable | Description                         | Units           | Mean   | SD    |
|:---------|:------------------------------------|:----------------|-------:|------:|
| `mpg`    | Fuel economy                        | miles per US gallon | 20.09  | 6.03  |
| `wt`     | Curb weight                         | 1000 lb         | 3.217  | 0.978 |
| `hp`     | Gross horsepower[^gross]            | hp              | 146.7  | 68.6  |
| `am`     | Transmission (0 = automatic, 1 = manual) | indicator  | 0.406  | 0.499 |

[^gross]: Gross horsepower was measured on an engine without accessories
    such as the alternator and water pump attached. US manufacturers switched
    to the lower *net* rating from the 1972 model year, so the figures in this
    data set are not directly comparable to modern ratings.

Fuel economy is strongly negatively correlated with both weight
($r = -0.868$) and horsepower ($r = -0.776$). The two predictors are
themselves positively correlated ($r = 0.659$), which is the reason a
multiple regression is needed: a simple regression on weight alone credits
weight with some of the effect that really belongs to engine size.

![Fuel economy against weight for the 32 cars in the sample, coloured by
transmission type. The dashed line is the least-squares fit of `mpg` on `wt`
alone.](01-scatter.svg){#fig:scatter width=85%}

Figure @fig:scatter shows the relationship. It is clearly decreasing and
roughly linear, with some curvature at the extremes: the three lightest cars
(Lotus Europa, Honda Civic, Toyota Corolla) sit above the line, and so does
the heavy Chrysler Imperial. Manual-transmission cars are concentrated at the
light end of the range, so any apparent transmission effect will be heavily
confounded with weight.

# Methods

## Models

We fit four nested and non-nested linear models by ordinary least squares:

$$
\begin{aligned}
\text{M1:}\quad \text{mpg}_i &= \beta_0 + \beta_1\,\text{wt}_i + \varepsilon_i \\
\text{M2:}\quad \text{mpg}_i &= \beta_0 + \beta_1\,\text{wt}_i + \beta_2\,\text{hp}_i + \varepsilon_i \\
\text{M3:}\quad \text{mpg}_i &= \beta_0 + \beta_1\,\text{wt}_i + \beta_2\,\text{hp}_i + \beta_3\,(\text{wt}_i \times \text{hp}_i) + \varepsilon_i \\
\text{M4:}\quad \text{mpg}_i &= \beta_0 + \beta_1\,\text{wt}_i + \beta_2\,\text{hp}_i + \beta_3\,\text{am}_i + \varepsilon_i
\end{aligned}
$$

with $\varepsilon_i \overset{\text{iid}}{\sim} N(0, \sigma^2)$ for
$i = 1, \dots, 32$. In matrix form $\mathbf{y} = X\boldsymbol\beta +
\boldsymbol\varepsilon$, and the least-squares estimate and its estimated
covariance are

$$
\hat{\boldsymbol\beta} = (X^\top X)^{-1} X^\top \mathbf{y},
\qquad
\widehat{\operatorname{Var}}(\hat{\boldsymbol\beta}) = \hat\sigma^2 (X^\top X)^{-1},
\qquad
\hat\sigma^2 = \frac{\lVert \mathbf{y} - X\hat{\boldsymbol\beta} \rVert^2}{n - p},
$$

where $p$ is the number of columns of $X$ including the intercept.

## Diagnostics

For the main model (M2) we examined residuals against fitted values and
against each predictor, and a normal Q--Q plot. Normality of the residuals
was tested with the Shapiro--Wilk test [@shapiro1965]. Constant variance was
tested with the studentised Breusch--Pagan test [@breusch1979; @koenker1981],
which regresses the squared residuals on the predictors and compares
$nR^2_{\text{aux}}$ with a $\chi^2_2$ distribution. Influence was measured
with Cook's distance [@cook1977],

$$
D_i = \frac{e_i^2}{p\,\hat\sigma^2}\,\frac{h_{ii}}{(1 - h_{ii})^2},
$$

where $e_i$ is the $i$-th residual and $h_{ii}$ the $i$-th diagonal element
of the hat matrix $H = X(X^\top X)^{-1}X^\top$. Collinearity was summarised by
the variance inflation factor $\text{VIF}_j = 1/(1 - R_j^2)$. We follow
@kutner2005 in treating $D_i > 4/n$ as worth a closer look and $D_i > 1$ as
seriously influential.

All analysis was done in R 4.4 using base functions and the `car` package
[@fox2019]. The core commands were:

```r
data(mtcars)

m1 <- lm(mpg ~ wt, data = mtcars)
m2 <- lm(mpg ~ wt + hp, data = mtcars)
m3 <- lm(mpg ~ wt * hp, data = mtcars)
m4 <- lm(mpg ~ wt + hp + am, data = mtcars)

summary(m2)
confint(m2)

shapiro.test(residuals(m2))
lmtest::bptest(m2)            # studentised (Koenker) version by default
car::vif(m2)
sort(cooks.distance(m2), decreasing = TRUE)[1:5]

anova(m2, m3)                 # partial F-test for the interaction
AIC(m1, m2, m3, m4)
```

# Results

## Simple regression on weight

Table: Simple linear regression of `mpg` on `wt` (M1). Residual standard
error 3.046 on 30 df; $R^2 = 0.7528$, adjusted $R^2 = 0.7446$;
$F_{1,30} = 91.38$, $p = 1.29 \times 10^{-10}$.

| Term        | Estimate | Std. Error | $t$ value | $\Pr(>\lvert t\rvert)$ |
|:------------|---------:|-----------:|----------:|---------------------:|
| (Intercept) | 37.2851  | 1.8776     | 19.858    | $< 2 \times 10^{-16}$ |
| `wt`        | −5.3445  | 0.5591     | −9.559    | $1.29 \times 10^{-10}$ |

On its own, weight explains about three quarters of the variation in fuel
economy. The slope says that cars 1000 lb heavier average 5.34 mpg less.

## Multiple regression on weight and horsepower

Table: Multiple linear regression of `mpg` on `wt` and `hp` (M2). Residual
standard error 2.593 on 29 df; $R^2 = 0.8268$, adjusted $R^2 = 0.8148$;
$F_{2,29} = 69.21$, $p = 9.11 \times 10^{-12}$.

| Term        | Estimate  | Std. Error | $t$ value | $\Pr(>\lvert t\rvert)$ | 95% CI               |
|:------------|----------:|-----------:|----------:|---------------------:|:---------------------|
| (Intercept) | 37.22727  | 1.59879    | 23.285    | $< 2 \times 10^{-16}$ | (33.957, 40.497)     |
| `wt`        | −3.87783  | 0.63273    | −6.129    | $1.12 \times 10^{-6}$ | (−5.172, −2.584)     |
| `hp`        | −0.03177  | 0.00903    | −3.519    | 0.00145              | (−0.0502, −0.0133)   |

The fitted model is

$$
\widehat{\text{mpg}} = 37.23 - 3.878\,\text{wt} - 0.0318\,\text{hp}.
$$

Adding horsepower shrinks the weight slope from −5.34 to −3.88, which is the
confounding we anticipated: part of what M1 attributed to weight was really
engine size. Holding horsepower fixed, an extra 1000 lb is associated with
3.88 mpg lower fuel economy (95% CI 2.58 to 5.17). Holding weight fixed, an
extra 100 hp is associated with 3.18 mpg lower fuel economy (95% CI 1.33 to
5.02). Both slopes are clearly different from zero.

The variance inflation factor for both predictors is 1.77, well below the
usual worry threshold of 5 to 10, so the two slopes are estimated with
reasonable precision despite the correlation between weight and horsepower.

## Residual diagnostics

![Residuals against fitted values for model M2. The three largest positive
residuals are labelled.](01-residuals.svg){#fig:residuals width=85%}

The residual plot (Figure @fig:residuals) shows no fan shape, and the
studentised Breusch--Pagan test agrees: $\text{LM} = 0.88$ on 2 df,
$p = 0.64$. There is, however, a hint of a U shape: residuals are mostly
positive at both ends of the fitted range and mostly negative in the middle.
That pattern is what an omitted interaction or curvature term would produce.

The Shapiro--Wilk test gives $W = 0.928$, $p = 0.034$, so normality is
rejected at the 5% level. The departure comes from the right tail: the Toyota
Corolla, Fiat 128 and Chrysler Imperial all have residuals of about +5.5 to
+5.9 mpg (studentised residuals 2.33 to 2.38). With $n = 32$ the $t$-based
intervals are fairly robust to this, but it is a second argument for looking
at a richer model.

Table: The five most influential observations under M2.

| Car               | Fitted mpg | Residual | Leverage $h_{ii}$ | Cook's $D_i$ |
|:------------------|-----------:|---------:|------------------:|-------------:|
| Chrysler Imperial | 9.19       | 5.51     | 0.186             | 0.424        |
| Maserati Bora     | 12.74      | 2.26     | 0.394             | 0.272        |
| Toyota Corolla    | 28.05      | 5.85     | 0.100             | 0.208        |
| Fiat 128          | 26.60      | 5.80     | 0.080             | 0.157        |
| Lotus Europa      | 27.77      | 2.63     | 0.154             | 0.074        |

Five cars exceed the $4/n = 0.125$ screening threshold but none comes close
to $D_i = 1$. The Maserati Bora is the interesting case: its residual is
modest, but at 335 hp it is far outside the rest of the sample and has the
highest leverage of any car. Refitting M2 without it moves the `hp` slope
from −0.032 to −0.040 (just under one standard error) and the `wt` slope from
−3.88 to −3.56. Neither change alters the conclusions, so we kept it.

## Model comparison

Table: Comparison of candidate models. AIC is computed on the log-likelihood
scale used by R's `AIC()`; lower is better.

| Model | Predictors                | $p$ | $R^2$  | Adj. $R^2$ | RSE   | AIC    |
|:------|:--------------------------|----:|-------:|-----------:|------:|-------:|
| M1    | `wt`                      | 2   | 0.7528 | 0.7446     | 3.046 | 166.03 |
| M2    | `wt + hp`                 | 3   | 0.8268 | 0.8148     | 2.593 | 156.65 |
| M3    | `wt * hp`                 | 4   | 0.8848 | 0.8724     | 2.153 | 145.61 |
| M4    | `wt + hp + am`            | 4   | 0.8399 | 0.8227     | 2.538 | 156.13 |

Adding transmission type (M4) barely helps: its coefficient is 2.08 mpg
($SE = 1.38$, $p = 0.14$), and AIC improves by only 0.5. Once weight and
power are in the model, manual cars are not detectably more economical.

The interaction model M3 is a different story. The partial $F$-test comparing
M3 with M2 gives $F_{1,28} = 14.09$, $p = 0.0008$, and AIC drops by 11. The
fitted interaction is positive ($\hat\beta_3 = 0.0278$, $SE = 0.0074$),
meaning the fuel-economy penalty for extra weight shrinks as horsepower rises:

$$
\frac{\partial\,\widehat{\text{mpg}}}{\partial\,\text{wt}}
= -8.217 + 0.0278\,\text{hp},
$$

which is about −5.4 mpg per 1000 lb at 100 hp and −2.9 at 190 hp. One
plausible physical reading is that powerful cars are already running large,
thirsty engines, so extra mass adds proportionally less to their
consumption.

# Discussion

Weight and horsepower together explain about 83% of the variation in fuel
economy among these 32 cars, and both have a clear, independent negative
association with mpg. The effect of weight is the larger of the two in
practical terms: one standard deviation of weight (978 lb) corresponds to
3.8 mpg, compared with 2.2 mpg for one standard deviation of horsepower
(68.6 hp).

The main weaknesses of M2 are the mild non-normality and the curvature
visible in Figure @fig:residuals. Both point the same way. @henderson1981
argued that fuel *consumption* (gallons per 100 miles) is the more natural
response, because it is closer to linear in weight on physical grounds; we
did not pursue that transformation here but it would be the obvious next
step, along with the interaction model M3.

Three caveats apply to any interpretation. First, this is observational
data, so the slopes describe associations among the cars tested, not the
effect of adding ballast to a particular car. Second, $n = 32$ is small, and
the confidence intervals reflect that. Third, the sample consists of
hand-picked 1970s cars spanning Italian exotica to American luxury sedans,
so extrapolating to other vehicles is not justified.

# References

::: {#refs}
:::
