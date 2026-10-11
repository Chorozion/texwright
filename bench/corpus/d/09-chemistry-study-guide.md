---
title: "Unit 7 Study Guide: Chemical Equilibrium"
subtitle: "CHEM 1220, General Chemistry II"
author: "Prepared for the Unit 7 exam (Chapters 15–17)"
date: "Fall 2026"
geometry: margin=1in
fontsize: 11pt
toc: true
header-includes:
  - \usepackage[version=4]{mhchem}
  - \usepackage{siunitx}
---

# How to use this guide

Each section lists what you need to know, the key equations, and at least one
worked example. Practice problems with answers are at the end. All
equilibrium constants are at 25 °C (298 K) unless stated otherwise.

On the exam you will be given $R$, $K_w$ and any $K_a$, $K_b$ or $K_{sp}$
values you need. You will **not** be given the expressions themselves, so
make sure you can write them from a balanced equation.

# Dynamic equilibrium

A reversible reaction reaches equilibrium when the forward and reverse rates
are equal. Concentrations stop changing, but both reactions keep going.

$$\ce{N2(g) + 3H2(g) <=> 2NH3(g)} \qquad \Delta H^\circ = -92.2~\text{kJ/mol}$$

Key ideas:

- Equilibrium can be approached from either direction and ends at the same
  ratio of products to reactants (at a given temperature).
- "At equilibrium" does **not** mean equal concentrations of reactants and
  products.
- Only temperature changes the value of $K$.

# The equilibrium constant

## Writing $K_c$ and $K_p$

For a general reaction $a\,\ce{A} + b\,\ce{B} <=> c\,\ce{C} + d\,\ce{D}$,

$$
K_c = \frac{[\ce{C}]^c\,[\ce{D}]^d}{[\ce{A}]^a\,[\ce{B}]^b}
\qquad\qquad
K_p = \frac{P_\ce{C}^{\,c}\,P_\ce{D}^{\,d}}{P_\ce{A}^{\,a}\,P_\ce{B}^{\,b}}
$$

Rules:

1. Products over reactants, each raised to its stoichiometric coefficient.
2. **Leave out pure solids and pure liquids** (their "concentration" is
   constant). Water is left out when it is the solvent.
3. $K$ has no units in the thermodynamic definition; we report it as a pure
   number.

| Reaction | Equilibrium expression |
|:---------|:-----------------------|
| $\ce{N2(g) + 3H2(g) <=> 2NH3(g)}$ | $K_c = \dfrac{[\ce{NH3}]^2}{[\ce{N2}][\ce{H2}]^3}$ |
| $\ce{CaCO3(s) <=> CaO(s) + CO2(g)}$ | $K_p = P_{\ce{CO2}}$ |
| $\ce{CH3COOH(aq) + H2O(l) <=> H3O+(aq) + CH3COO-(aq)}$ | $K_a = \dfrac{[\ce{H3O+}][\ce{CH3COO-}]}{[\ce{CH3COOH}]}$ |
| $\ce{PbI2(s) <=> Pb^2+(aq) + 2I-(aq)}$ | $K_{sp} = [\ce{Pb^2+}][\ce{I-}]^2$ |

## Manipulating $K$

| If you…                                 | then the new constant is |
|:----------------------------------------|:-------------------------|
| reverse the reaction                    | $K' = 1/K$               |
| multiply all coefficients by $n$        | $K' = K^n$               |
| add two reactions                       | $K' = K_1 \times K_2$    |

## Converting between $K_c$ and $K_p$

$$
K_p = K_c\,(RT)^{\Delta n}, \qquad R = 0.08206~\text{L·atm·mol}^{-1}\text{K}^{-1},
$$

where $\Delta n$ = (moles of gaseous products) − (moles of gaseous reactants).

> **Worked example.** For the Haber process at 500 °C, $K_c = 6.0 \times 10^{-2}$.
> Here $\Delta n = 2 - 4 = -2$ and $T = 773$ K, so
> $RT = (0.08206)(773) = 63.4$ and
> $$K_p = (6.0 \times 10^{-2})(63.4)^{-2} = 1.5 \times 10^{-5}.$$

A common mistake is using $R = 8.314$ here. Use the value with litres and
atmospheres, because $K_p$ is written in atmospheres.

# The reaction quotient $Q$

$Q$ has the same form as $K$ but uses the *current* concentrations, not the
equilibrium ones. Comparing $Q$ with $K$ tells you which way the reaction
will go:

| Comparison | Meaning                    | Net reaction goes |
|:-----------|:---------------------------|:------------------|
| $Q < K$    | too few products           | forward (→)       |
| $Q = K$    | at equilibrium             | no net change     |
| $Q > K$    | too many products          | reverse (←)       |

# ICE tables

Use an ICE table (Initial, Change, Equilibrium) whenever you know starting
amounts and $K$ and need equilibrium concentrations.

> **Worked example 1.** $0.0400$ mol of $\ce{N2O4}$ is placed in a 1.00 L
> flask at 25 °C. For $\ce{N2O4(g) <=> 2NO2(g)}$, $K_c = 4.64 \times 10^{-3}$.
> Find the equilibrium concentrations.

|                 | $[\ce{N2O4}]$ (M) | $[\ce{NO2}]$ (M) |
|:----------------|------------------:|-----------------:|
| **I**nitial     | 0.0400            | 0                |
| **C**hange      | $-x$              | $+2x$            |
| **E**quilibrium | $0.0400 - x$      | $2x$             |

$$
\frac{(2x)^2}{0.0400 - x} = 4.64 \times 10^{-3}
\;\Longrightarrow\;
4x^2 + (4.64 \times 10^{-3})x - 1.856 \times 10^{-4} = 0.
$$

The quadratic formula gives $x = 6.26 \times 10^{-3}$ (the negative root is
not physical), so $[\ce{NO2}] = 0.0125$ M and $[\ce{N2O4}] = 0.0337$ M.

*Check:* $(0.0125)^2 / 0.0337 = 4.6 \times 10^{-3}$ ✓.

**Can I use the "small $x$" approximation?** Only if $x$ turns out to be less
than 5% of the initial concentration. Here $x/0.0400 = 16\%$, so the
approximation would have failed and the quadratic was necessary.

> **Worked example 2.** $0.500$ M $\ce{H2}$ and $0.500$ M $\ce{I2}$ react at
> 430 °C: $\ce{H2(g) + I2(g) <=> 2HI(g)}$, $K_c = 54.3$.

Because both sides of the expression are perfect squares, take the square
root instead of solving a quadratic:

$$
\frac{(2x)^2}{(0.500 - x)^2} = 54.3
\;\Longrightarrow\;
\frac{2x}{0.500 - x} = 7.37
\;\Longrightarrow\;
x = 0.393.
$$

So $[\ce{HI}] = 0.787$ M and $[\ce{H2}] = [\ce{I2}] = 0.107$ M.

# Le Châtelier's principle

When a system at equilibrium is disturbed, it shifts to partly undo the
disturbance.

| Disturbance                                | Shift              | Does $K$ change? |
|:-------------------------------------------|:-------------------|:----------------:|
| Add a reactant (or remove a product)       | toward products    | No               |
| Add a product (or remove a reactant)       | toward reactants   | No               |
| Decrease volume (increase pressure)        | toward fewer moles of gas | No        |
| Add inert gas at constant volume           | no shift           | No               |
| Raise temperature, exothermic reaction     | toward reactants   | **Yes**, $K$ decreases |
| Raise temperature, endothermic reaction    | toward products    | **Yes**, $K$ increases |
| Add a catalyst                             | no shift (equilibrium reached faster) | No |

**Trick for temperature:** treat heat as a reactant (endothermic) or a
product (exothermic), then apply the concentration rule. For the Haber
process, heat is a product, so raising $T$ pushes the equilibrium back
toward $\ce{N2}$ and $\ce{H2}$.

# Acid–base equilibria

## Key relationships at 25 °C

$$
K_w = [\ce{H3O+}][\ce{OH-}] = 1.0 \times 10^{-14}, \qquad
\text{pH} + \text{pOH} = 14.00, \qquad
K_a K_b = K_w
$$

$$
\text{pH} = -\log[\ce{H3O+}], \qquad \text{p}K_a = -\log K_a
$$

## Weak acids and bases

For a weak acid HA with initial concentration $C$, when $x \ll C$:

$$
x = [\ce{H3O+}] \approx \sqrt{K_a C}.
$$

> **Example.** pH of 0.10 M acetic acid ($K_a = 1.8 \times 10^{-5}$):
> $[\ce{H3O+}] = \sqrt{(1.8 \times 10^{-5})(0.10)} = 1.3 \times 10^{-3}$ M,
> so pH $= 2.87$. Check: $1.3 \times 10^{-3}/0.10 = 1.3\% < 5\%$ ✓.

## Buffers

A buffer contains a weak acid and its conjugate base in comparable amounts.
Use the Henderson–Hasselbalch equation:

$$
\text{pH} = \text{p}K_a + \log\frac{[\ce{A-}]}{[\ce{HA}]}.
$$

> **Example.** A buffer is 0.10 M $\ce{CH3COOH}$ and 0.15 M $\ce{CH3COONa}$.
> $\text{p}K_a = -\log(1.8 \times 10^{-5}) = 4.74$, so
> $\text{pH} = 4.74 + \log(0.15/0.10) = 4.74 + 0.18 = 4.92$.

A buffer works best within about one pH unit of its p$K_a$.

# Solubility equilibria

For a sparingly soluble salt, the molar solubility $s$ is related to $K_{sp}$
through the stoichiometry:

| Salt     | $K_{sp}$ (25 °C)        | $K_{sp}$ in terms of $s$ | Molar solubility $s$ (M) |
|:---------|:------------------------|:-------------------------|:-------------------------|
| $\ce{AgCl}$  | $1.8 \times 10^{-10}$ | $s^2$                    | $1.3 \times 10^{-5}$     |
| $\ce{BaSO4}$ | $1.1 \times 10^{-10}$ | $s^2$                    | $1.0 \times 10^{-5}$     |
| $\ce{PbI2}$  | $9.8 \times 10^{-9}$  | $4s^3$                   | $1.3 \times 10^{-3}$     |
| $\ce{CaF2}$  | $3.9 \times 10^{-11}$ | $4s^3$                   | $2.1 \times 10^{-4}$     |
| $\ce{Mg(OH)2}$ | $5.6 \times 10^{-12}$ | $4s^3$                 | $1.1 \times 10^{-4}$     |

**Do not compare $K_{sp}$ values directly across different formula types.**
$\ce{CaF2}$ has a *smaller* $K_{sp}$ than $\ce{AgCl}$, yet it is about 16
times *more* soluble, because its $K_{sp}$ depends on $s^3$ rather than
$s^2$. Convert to $s$ first.

**Common-ion effect.** Adding an ion that is already in the equilibrium
lowers the solubility. In 0.10 M NaCl, the solubility of AgCl is

$$
s = \frac{K_{sp}}{[\ce{Cl-}]} = \frac{1.8 \times 10^{-10}}{0.10} = 1.8 \times 10^{-9}~\text{M},
$$

about 7,000 times less than in pure water.

**Will a precipitate form?** Compute $Q_{sp}$ from the ion concentrations
*after mixing*. If $Q_{sp} > K_{sp}$, a precipitate forms.

# Equilibrium and thermodynamics

$$
\Delta G^\circ = -RT\ln K \qquad (R = 8.314~\text{J·mol}^{-1}\text{K}^{-1})
$$

- $K > 1 \iff \Delta G^\circ < 0$ (products favoured)
- $K < 1 \iff \Delta G^\circ > 0$ (reactants favoured)

For the HI reaction at 430 °C (703 K):
$\Delta G^\circ = -(8.314)(703)\ln(54.3) = -2.33 \times 10^{4}$ J/mol
$= -23.3$ kJ/mol.

The **van 't Hoff equation** relates $K$ at two temperatures:

$$
\ln\frac{K_2}{K_1} = -\frac{\Delta H^\circ}{R}\left(\frac{1}{T_2} - \frac{1}{T_1}\right).
$$

# Practice problems

1. Write $K_c$ for $\ce{4NH3(g) + 5O2(g) <=> 4NO(g) + 6H2O(g)}$.
2. For $\ce{2SO2(g) + O2(g) <=> 2SO3(g)}$, $K_c = 2.8 \times 10^2$ at
   1000 K. Calculate $K_p$.
3. For $\ce{H2(g) + I2(g) <=> 2HI(g)}$ at 430 °C ($K_c = 54.3$), a flask
   contains 0.10 M $\ce{H2}$, 0.10 M $\ce{I2}$ and 0.50 M $\ce{HI}$. Is the
   system at equilibrium? If not, which way will it shift?
4. Calculate the pH of 0.050 M $\ce{NH3}$ ($K_b = 1.8 \times 10^{-5}$).
5. Predict the effect of each change on
   $\ce{PCl5(g) <=> PCl3(g) + Cl2(g)}$, $\Delta H^\circ = +88$ kJ/mol:
   (a) adding $\ce{Cl2}$; (b) halving the volume; (c) raising the temperature;
   (d) adding argon at constant volume.
6. What is the molar solubility of $\ce{CaF2}$ in 0.020 M NaF?
7. A reaction has $K = 1.0 \times 10^{-3}$ at 298 K. Calculate
   $\Delta G^\circ$ and say whether products or reactants are favoured.

## Answers

1. $K_c = \dfrac{[\ce{NO}]^4[\ce{H2O}]^6}{[\ce{NH3}]^4[\ce{O2}]^5}$. (Water
   is a gas here, so it is included.)
2. $\Delta n = 2 - 3 = -1$, so
   $K_p = K_c(RT)^{-1} = 280/(0.08206 \times 1000) = 3.4$.
3. $Q = (0.50)^2 / [(0.10)(0.10)] = 25$. Since $Q < K$, not at equilibrium;
   it shifts forward, making more HI.
4. $[\ce{OH-}] = \sqrt{(1.8 \times 10^{-5})(0.050)} = 9.5 \times 10^{-4}$ M;
   pOH $= 3.02$; pH $= 10.98$.
5. (a) shifts left; (b) shifts left (2 mol gas → 1 mol gas on the left);
   (c) shifts right and $K$ increases (endothermic); (d) no change.
6. $K_{sp} = s(0.020 + 2s)^2 \approx s(0.020)^2$, so
   $s = 3.9 \times 10^{-11} / 4.0 \times 10^{-4} = 9.8 \times 10^{-8}$ M.
7. $\Delta G^\circ = -(8.314)(298)\ln(1.0 \times 10^{-3}) = +1.71 \times 10^{4}$
   J/mol $= +17.1$ kJ/mol; reactants are favoured.

---

*Exam tip:* before any calculation, write the balanced equation, the
expression for $K$, and an ICE table. Most lost marks come from skipping one
of those three steps, not from the algebra.
