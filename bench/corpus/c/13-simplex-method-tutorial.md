---
title: "Linear Programming and the Simplex Method: A Worked Tutorial"
author: "Operations Research Study Group"
date: "October 2026"
bibliography: 13-references.bib
---

## 1. What is a linear program?

A **linear program** (LP) optimizes a linear objective subject to linear constraints. In *standard inequality form*,

$$
\begin{aligned}
\text{maximize}\quad & c^\top x \\
\text{subject to}\quad & Ax \le b, \\
& x \ge 0,
\end{aligned}
$$

where $x \in \mathbb{R}^n$ are the decision variables, $c \in \mathbb{R}^n$ the objective coefficients, $A \in \mathbb{R}^{m \times n}$ the constraint matrix, and $b \in \mathbb{R}^m$ with $b \ge 0$ the right-hand sides.

The simplex method, introduced by George Dantzig in 1947 [@dantzig1963], is still one of the most widely used algorithms for solving LPs. This tutorial walks through it by hand on a small problem, then shows the same steps in matrix form.

## 2. The example problem

A small factory makes two products: doors ($x_1$, profit \$3 thousand per batch) and windows ($x_2$, profit \$5 thousand per batch). Each product passes through some of three plants with limited weekly hours.[^wyndor]

| Plant | Hours per batch of doors | Hours per batch of windows | Hours available |
|---|:---:|:---:|:---:|
| 1 | 1 | 0 | 4 |
| 2 | 0 | 2 | 12 |
| 3 | 3 | 2 | 18 |
| **Profit (\$000/batch)** | **3** | **5** | |

The LP is

$$
\begin{aligned}
\text{maximize}\quad & Z = 3x_1 + 5x_2 \\
\text{subject to}\quad & x_1 \le 4 \\
& 2x_2 \le 12 \\
& 3x_1 + 2x_2 \le 18 \\
& x_1, x_2 \ge 0.
\end{aligned}
$$

In matrix notation:

$$
c = \begin{bmatrix} 3 \\ 5 \end{bmatrix}, \qquad
A = \begin{bmatrix} 1 & 0 \\ 0 & 2 \\ 3 & 2 \end{bmatrix}, \qquad
b = \begin{bmatrix} 4 \\ 12 \\ 18 \end{bmatrix}.
$$

### Geometric picture

The feasible region is a polygon in the $(x_1, x_2)$ plane with corners (vertices) at $(0,0)$, $(4,0)$, $(4,3)$, $(2,6)$, and $(0,6)$. A fundamental theorem of linear programming says that if an LP has an optimal solution, then some vertex is optimal. Evaluating $Z$ at each corner:

| Vertex $(x_1, x_2)$ | $Z = 3x_1 + 5x_2$ |
|---|---:|
| $(0, 0)$ | 0 |
| $(4, 0)$ | 12 |
| $(4, 3)$ | 27 |
| $(2, 6)$ | **36** |
| $(0, 6)$ | 30 |

Enumerating vertices works for two variables, but the number of vertices grows combinatorially with problem size. The simplex method walks from vertex to adjacent vertex, improving $Z$ at every step, and stops when no neighbor is better.

## 3. Slack variables and the initial tableau

Turn each inequality into an equation by adding a nonnegative **slack variable** that measures unused capacity:

$$
\begin{aligned}
x_1 + s_1 &= 4 \\
2x_2 + s_2 &= 12 \\
3x_1 + 2x_2 + s_3 &= 18, \qquad x_1, x_2, s_1, s_2, s_3 \ge 0.
\end{aligned}
$$

We also write the objective as $Z - 3x_1 - 5x_2 = 0$. Setting the original variables to zero gives an obvious starting solution: $x_1 = x_2 = 0$, $s = b$. The slacks are the **basic** variables (nonzero, one per row) and $x_1, x_2$ are **nonbasic** (fixed at zero). This is the vertex $(0, 0)$.

**Tableau 0**

| Basis | $x_1$ | $x_2$ | $s_1$ | $s_2$ | $s_3$ | RHS |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| $s_1$ | 1 | 0 | 1 | 0 | 0 | 4 |
| $s_2$ | 0 | 2 | 0 | 1 | 0 | 12 |
| $s_3$ | 3 | 2 | 0 | 0 | 1 | 18 |
| $Z$ | −3 | −5 | 0 | 0 | 0 | 0 |

The bottom row holds the **reduced costs**. A negative entry means increasing that variable would increase $Z$.

## 4. The simplex iterations

Each iteration has three steps:

1. **Entering variable (pivot column).** Pick the nonbasic variable with the most negative entry in the $Z$ row. If none is negative, stop: the current solution is optimal.
2. **Leaving variable (pivot row).** For each row with a positive entry in the pivot column, compute the ratio $\text{RHS} / \text{entry}$. The row with the smallest ratio leaves the basis. This **minimum ratio test** keeps every variable nonnegative.
3. **Pivot.** Divide the pivot row by the pivot element, then subtract multiples of it from every other row (including $Z$) so that the pivot column becomes a unit vector.

### Iteration 1

*Entering:* $x_2$ (reduced cost −5 is the most negative).

*Ratio test:*

| Row | Entry in $x_2$ column | RHS | Ratio |
|:---:|:---:|:---:|:---:|
| $s_1$ | 0 | 4 | (skip) |
| $s_2$ | 2 | 12 | **6** |
| $s_3$ | 2 | 18 | 9 |

*Leaving:* $s_2$. The pivot element is 2.

*Row operations:*

- New $x_2$ row $= \tfrac12 \times$ old $s_2$ row.
- New $s_3$ row $=$ old $s_3$ row $- 2 \times$ new $x_2$ row.
- New $Z$ row $=$ old $Z$ row $+ 5 \times$ new $x_2$ row.

**Tableau 1**

| Basis | $x_1$ | $x_2$ | $s_1$ | $s_2$ | $s_3$ | RHS |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| $s_1$ | 1 | 0 | 1 | 0 | 0 | 4 |
| $x_2$ | 0 | 1 | 0 | 1/2 | 0 | 6 |
| $s_3$ | 3 | 0 | 0 | −1 | 1 | 6 |
| $Z$ | −3 | 0 | 0 | 5/2 | 0 | 30 |

We are now at the vertex $(x_1, x_2) = (0, 6)$ with $Z = 30$.

### Iteration 2

*Entering:* $x_1$ (reduced cost −3).

*Ratio test:*

| Row | Entry in $x_1$ column | RHS | Ratio |
|:---:|:---:|:---:|:---:|
| $s_1$ | 1 | 4 | 4 |
| $x_2$ | 0 | 6 | (skip) |
| $s_3$ | 3 | 6 | **2** |

*Leaving:* $s_3$. The pivot element is 3.

*Row operations:*

- New $x_1$ row $= \tfrac13 \times$ old $s_3$ row.
- New $s_1$ row $=$ old $s_1$ row $- 1 \times$ new $x_1$ row.
- New $Z$ row $=$ old $Z$ row $+ 3 \times$ new $x_1$ row.

**Tableau 2 (optimal)**

| Basis | $x_1$ | $x_2$ | $s_1$ | $s_2$ | $s_3$ | RHS |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| $s_1$ | 0 | 0 | 1 | 1/3 | −1/3 | 2 |
| $x_2$ | 0 | 1 | 0 | 1/2 | 0 | 6 |
| $x_1$ | 1 | 0 | 0 | −1/3 | 1/3 | 2 |
| $Z$ | 0 | 0 | 0 | 3/2 | 1 | **36** |

No reduced cost is negative, so we stop. The optimal solution is

$$
x_1^* = 2, \quad x_2^* = 6, \quad s_1^* = 2, \quad s_2^* = s_3^* = 0, \qquad Z^* = 36.
$$

Plant 1 has 2 hours of spare capacity; plants 2 and 3 are fully used. The path was $(0,0) \to (0,6) \to (2,6)$, two pivots instead of checking all five vertices.

## 5. Reading the final tableau: shadow prices

The $Z$-row entries under the slack columns are the **shadow prices** (optimal dual values) $y_i^*$. Each one is the increase in optimal profit per extra hour in that plant, valid as long as the basis stays the same:

| Plant | Shadow price $y_i^*$ | Interpretation |
|---|:---:|---|
| 1 | 0 | Plant 1 has slack; more hours are worthless right now. |
| 2 | 3/2 | One more hour in plant 2 adds \$1,500 profit. |
| 3 | 1 | One more hour in plant 3 adds \$1,000 profit. |

Check with **strong duality**: $b^\top y^* = 4(0) + 12(\tfrac32) + 18(1) = 36 = Z^*$. ✓

## 6. The same computation in matrix form

Software does not store full tableaux. The *revised simplex method* keeps only the basis matrix $B$ (the columns of $[A \mid I]$ belonging to basic variables) and works with its inverse [@bertsimas1997].

At the optimum the basic variables are $(s_1, x_2, x_1)$, so

$$
B = \begin{bmatrix} 1 & 0 & 1 \\ 0 & 2 & 0 \\ 0 & 2 & 3 \end{bmatrix},
\qquad
B^{-1} = \begin{bmatrix} 1 & \tfrac13 & -\tfrac13 \\[2pt] 0 & \tfrac12 & 0 \\[2pt] 0 & -\tfrac13 & \tfrac13 \end{bmatrix}.
$$

Notice that $B^{-1}$ is exactly the block under the slack columns in Tableau 2. Everything in the final tableau follows from it:

$$
x_B = B^{-1} b = \begin{bmatrix} 1 & \tfrac13 & -\tfrac13 \\[2pt] 0 & \tfrac12 & 0 \\[2pt] 0 & -\tfrac13 & \tfrac13 \end{bmatrix}
\begin{bmatrix} 4 \\ 12 \\ 18 \end{bmatrix}
= \begin{bmatrix} 2 \\ 6 \\ 2 \end{bmatrix},
$$

$$
y^{*\top} = c_B^\top B^{-1} = \begin{bmatrix} 0 & 5 & 3 \end{bmatrix} B^{-1} = \begin{bmatrix} 0 & \tfrac32 & 1 \end{bmatrix},
$$

and the reduced cost of any nonbasic variable $j$ is

$$
\bar c_j = c_j - y^{*\top} A_j,
$$

which for a maximization problem must be $\le 0$ at optimality. (In the tableau we store $-\bar c_j$, which is why optimality there means "no negative entries".)

## 7. Things that can go wrong

**Unboundedness.** If the entering column has no positive entries, the ratio test has no candidates. The entering variable can grow forever and $Z \to \infty$. Usually this means a constraint is missing from the model.

**Degeneracy.** If a ratio is zero (a basic variable equals 0), a pivot can change the basis without moving to a new vertex. In rare cases the method then cycles forever. **Bland's rule** (always choose the lowest-indexed eligible variable for both entering and leaving) prevents cycling [@bland1977].

**No obvious starting basis.** Constraints of the form $\ge$ or $=$ don't give a slack-variable basis for free. The standard fix is the **two-phase method**: add artificial variables, first minimize their sum to find a feasible vertex, then optimize the real objective from there.

**Efficiency.** Klee and Minty [-@klee1972] built LPs on which the most-negative-reduced-cost rule visits all $2^n$ vertices. In practice simplex typically takes a modest multiple of $m$ pivots, and interior-point methods are the main alternative for very large problems.

## 8. Checking the answer in Python

```python
from scipy.optimize import linprog

# linprog minimizes, so negate the objective
c = [-3, -5]
A_ub = [[1, 0],
        [0, 2],
        [3, 2]]
b_ub = [4, 12, 18]

res = linprog(c, A_ub=A_ub, b_ub=b_ub, bounds=[(0, None)] * 2, method="highs")
print(res.x)                      # [2. 6.]
print(-res.fun)                   # 36.0
print(-res.ineqlin.marginals)     # shadow prices: [0.  1.5 1. ]
```

## 9. Practice problems

1. Solve by the simplex method: maximize $Z = 2x_1 + 3x_2$ subject to $x_1 + x_2 \le 4$, $x_1 + 3x_2 \le 6$, $x_1, x_2 \ge 0$. *(Answer: $x^* = (3, 1)$, $Z^* = 9$.)*
2. In the factory problem, suppose plant 3 gains 6 hours ($b_3 = 24$). Use $B^{-1}$ to compute the new $x_B$. Is the old basis still feasible? What is the new profit?
3. Show that the problem "maximize $x_1 + x_2$ subject to $x_1 - x_2 \le 1$, $x \ge 0$" is unbounded by running one simplex iteration.

## References

[^wyndor]: This is the well-known "Wyndor Glass" example from Hillier and Lieberman's textbook [@hillier2021], which is a good next step for anyone who wants more practice.
