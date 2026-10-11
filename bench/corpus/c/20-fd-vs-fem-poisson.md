---
title: "Finite Differences versus Finite Elements for the Poisson Equation: Accuracy, Cost, and the Role of the Mesh"
author:
  - name: Laura Chen
    affiliation: Department of Mathematics, Westbrook University
  - name: Mateo Alvarez
    affiliation: Department of Mathematics, Westbrook University
date: October 2026
abstract: |
  We compare the five-point finite difference (FD) scheme and the piecewise linear (P1) finite element method (FEM) for the two-dimensional Poisson equation on two test problems: a smooth manufactured solution on the unit square and a harmonic function with a corner singularity on an L-shaped domain. On uniform meshes of right triangles the FEM stiffness matrix is identical to the FD matrix, so the methods differ only in the right-hand side and in how the error is measured. Both converge at the predicted rates: second order at the nodes for the smooth problem, and a reduced rate of $h^{2/3}$ in the energy norm for the singular one. The FEM's advantage appears when the mesh can adapt: a radially graded mesh with the same number of unknowns restores first-order energy-norm convergence and reduces the $L^2$ error by a factor of 14 on the finest mesh. On uniform grids, FD assembly was 10 to 16 times faster in our implementation, while solve times were identical once explicit zeros were removed from the FEM matrix.
keywords: [Poisson equation, finite difference method, finite element method, convergence, corner singularity, graded meshes]
bibliography: 20-references.bib
link-citations: true
numbersections: true
---

# Introduction {#sec:intro}

Finite difference and finite element methods are the two discretizations most students meet first for elliptic equations, and they are often presented as rival approaches: finite differences as simple and fast but tied to rectangular grids, finite elements as flexible but more expensive to implement [@leveque2007; @larson2013]. Both views are correct, but they can obscure how closely the two methods are related on simple geometries, and they say little about *when* the extra machinery of finite elements pays off.

This note makes the comparison concrete for the model problem

$$ -\Delta u = f \quad \text{in } \Omega, \qquad u = g \quad \text{on } \partial\Omega, $$ {#eq:poisson}

with $\Omega \subset \mathbb{R}^2$ polygonal. We implement both methods on the same family of meshes, measure errors in several norms, and record assembly and solve times. Our aims are modest: to give a reproducible side-by-side comparison, to explain the differences we observe, and to show one situation, a re-entrant corner, where the methods part ways.

# Methods {#sec:methods}

## Five-point finite differences {#sec:fd}

On a uniform grid $x_i = ih$, $y_j = jh$, the five-point scheme replaces the Laplacian by

$$ -\Delta_h U_{ij} = \frac{4U_{ij} - U_{i+1,j} - U_{i-1,j} - U_{i,j+1} - U_{i,j-1}}{h^2} = f(x_i, y_j), $$ {#eq:fd}

with $U_{ij} = g(x_i, y_j)$ at boundary nodes. A Taylor expansion gives the local truncation error

$$ \tau_{ij} = -\frac{h^2}{12}\left(\partial_x^4 u + \partial_y^4 u\right)(x_i, y_j) + O(h^4). $$ {#eq:truncation}

The discrete operator satisfies a maximum principle, and on the unit square $\lVert (-\Delta_h)^{-1} \rVert_\infty \le 1/8$ [@leveque2007; @morton2005]. Combining stability with consistency gives the nodal error bound

$$ \max_{i,j} \lvert u(x_i, y_j) - U_{ij} \rvert \le \frac{h^2}{96}\left( \lVert \partial_x^4 u \rVert_\infty + \lVert \partial_y^4 u \rVert_\infty \right). $$ {#eq:fd-bound}

We also report the discrete $L^2$ error $\lVert e \rVert_{h} = \bigl(h^2 \sum_{i,j} e_{ij}^2\bigr)^{1/2}$.

## Piecewise linear finite elements {#sec:fem}

The weak form of @eq:poisson with $g = 0$ is: find $u \in H^1_0(\Omega)$ such that

$$ a(u, v) := \int_\Omega \nabla u \cdot \nabla v \,dx = \int_\Omega f v \,dx \quad \text{for all } v \in H^1_0(\Omega). $$ {#eq:weak}

Given a triangulation $\mathcal{T}_h$, let $V_h$ be the continuous piecewise linear functions vanishing on $\partial\Omega$, with nodal basis $\{\varphi_k\}$. The Galerkin approximation $u_h = \sum_k U_k \varphi_k$ solves the linear system $KU = F$ with

$$ K_{kl} = \int_\Omega \nabla\varphi_l \cdot \nabla\varphi_k \,dx, \qquad F_k = \int_\Omega f \varphi_k \,dx. $$ {#eq:system}

Nonhomogeneous boundary data are imposed by interpolating $g$ at boundary nodes. Céa's lemma and the Aubin–Nitsche duality argument give, for $u \in H^2(\Omega)$ on a convex domain [@ciarlet1978; @brenner2008],

$$ \lvert u - u_h \rvert_{H^1} \le C h \lvert u \rvert_{H^2}, \qquad \lVert u - u_h \rVert_{L^2} \le C h^2 \lvert u \rvert_{H^2}. $$ {#eq:fem-bounds}

We compute $F$ and both error norms with the 7-point degree-5 rule of Dunavant [@dunavant1985] on each triangle.

## The two methods on a uniform mesh {#sec:equivalence}

Divide each grid square into two right triangles by the diagonal of the same orientation. For a right isosceles triangle, the P1 element stiffness entry between the two vertices at the ends of the hypotenuse is $-\tfrac12\cot(\pi/2) = 0$, and assembling the six triangles around an interior node gives exactly the stencil in @eq:fd multiplied by $h^2$:

$$ K = h^2 \, A_{\mathrm{FD}}. $$ {#eq:equivalence}

This is classical [@strang1973], and we confirmed it numerically (the matrices agree to the last bit after dropping explicit zeros). On such meshes the two methods therefore differ in only two ways: the load vector ($F_k = \int f\varphi_k$ instead of $h^2 f(x_k)$), and the fact that the FEM produces a function defined everywhere, whose error can be measured in $L^2$ and $H^1$ rather than only at nodes.

# Numerical experiments {#sec:experiments}

All computations used Python 3.10 with NumPy and SciPy [@virtanen2020]. Linear systems were solved with SciPy's sparse direct solver (SuperLU). Timings are the best of three runs on a single core of a desktop workstation.

## Smooth solution on the unit square {#sec:smooth}

We take $\Omega = (0,1)^2$ and the manufactured solution

$$ u(x, y) = \sin(\pi x)\sin(\pi y), \qquad f = 2\pi^2 \sin(\pi x)\sin(\pi y), \qquad g = 0. $$ {#eq:smooth}

Here $\partial_x^4 u = \pi^4 u$, so @eq:fd-bound predicts a nodal error of at most $\pi^4 h^2/48 \approx 2.03\,h^2$. @tbl:smooth and panel (a) of @fig:convergence show the results.

| $h$ | $N$ | FD max | rate | FD $\lVert e \rVert_h$ | rate | FEM $L^2$ | rate | FEM $H^1$ | rate |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1/8 | 49 | 1.295e-2 | | 6.475e-3 | | 2.113e-2 | | 4.318e-1 | |
| 1/16 | 225 | 3.219e-3 | 2.01 | 1.610e-3 | 2.01 | 5.378e-3 | 1.97 | 2.175e-1 | 0.99 |
| 1/32 | 961 | 8.036e-4 | 2.00 | 4.018e-4 | 2.00 | 1.350e-3 | 1.99 | 1.090e-1 | 1.00 |
| 1/64 | 3,969 | 2.008e-4 | 2.00 | 1.004e-4 | 2.00 | 3.380e-4 | 2.00 | 5.451e-2 | 1.00 |
| 1/128 | 16,129 | 5.020e-5 | 2.00 | 2.510e-5 | 2.00 | 8.452e-5 | 2.00 | 2.726e-2 | 1.00 |

: Errors and observed convergence rates for the smooth problem @eq:smooth. $N$ is the number of unknowns, identical for both methods. Rates are $\log_2$ of the ratio of successive errors. {#tbl:smooth}

Every column converges at its predicted rate. The FD nodal error is $0.82\,h^2$, comfortably inside the bound of @eq:fd-bound. The maximum nodal error of the FEM solution (not shown in the table) agrees with the FD value to within 1.5% at $h = 1/8$ and 0.01% at $h = 1/128$; in our runs the gap between the two shrinks by a factor of about 16 per halving of $h$.

The FEM $L^2$ error is larger than the FD discrete $L^2$ error by a factor of about 3.3 on every mesh. This is not a sign that the FEM is less accurate. The continuous norm also measures the error *between* nodes, where the piecewise linear function cannot follow the curvature of $u$, while the discrete norm samples only the nodes. Comparing an FD grid norm with an FEM continuous norm, as is sometimes done in the literature, mixes two different quantities.

![Convergence of the error with mesh size. (a) Smooth solution on the unit square: all errors converge at their optimal rates. (b) L-shaped domain: on uniform meshes all errors converge at reduced rates, and the FD discrete $L^2$ and FEM $L^2$ curves nearly coincide; the graded FEM mesh restores rates close to 2 ($L^2$) and 1 ($H^1$). Triangles show reference slopes.](20-convergence.svg){#fig:convergence width=100%}

## L-shaped domain with a corner singularity {#sec:lshape}

Let $\Omega = (-1,1)^2 \setminus [0,1) \times (-1,0]$, which has a re-entrant corner of angle $3\pi/2$ at the origin. In polar coordinates the function

$$ u(r, \theta) = r^{2/3}\sin\!\left(\tfrac{2}{3}\theta\right), \qquad 0 \le \theta \le \tfrac{3\pi}{2}, $$ {#eq:lshape}

is harmonic ($f = 0$), vanishes on the two edges meeting at the corner, and has gradient behaving like $r^{-1/3}$, so $u \notin H^2(\Omega)$ [@grisvard1985]. We prescribe $g = u$ on $\partial\Omega$. For uniform meshes the theory predicts $\lvert u - u_h \rvert_{H^1} = O(h^{2/3})$ and $\lVert u - u_h \rVert_{L^2} = O(h^{4/3})$.

The FEM also lets us move nodes without changing the matrix structure. We grade the uniform mesh toward the corner with the radial map

$$ \boldsymbol{x} \mapsto \boldsymbol{x}\,\lVert \boldsymbol{x} \rVert_\infty^{\beta - 1}, \qquad \beta = 2, $$ {#eq:grading}

which keeps the outer boundary fixed and shrinks elements near the origin to size $O(h^\beta)$. Grading with $\beta > 3/2$ is known to restore the optimal rates for this singularity [@babuska1979]. The number of unknowns is unchanged. A five-point FD scheme has no equally simple counterpart, because a graded tensor grid would lose the symmetry and second-order consistency of @eq:fd.

| $h$ | $N$ | FD max | FD $\lVert e \rVert_h$ | FEM $L^2$ | FEM $H^1$ | graded FEM $L^2$ | graded FEM $H^1$ |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1/8 | 161 | 2.011e-2 | 6.294e-3 | 6.622e-3 | 1.193e-1 | 2.903e-3 | 7.674e-2 |
| 1/16 | 705 | 1.303e-2 | 2.669e-3 | 2.713e-3 | 7.625e-2 | 7.700e-4 | 3.994e-2 |
| 1/32 | 2,945 | 8.298e-3 | 1.100e-3 | 1.102e-3 | 4.849e-2 | 1.998e-4 | 2.047e-2 |
| 1/64 | 12,033 | 5.250e-3 | 4.468e-4 | 4.451e-4 | 3.073e-2 | 5.111e-5 | 1.039e-2 |
| 1/128 | 48,641 | 3.313e-3 | 1.798e-4 | 1.788e-4 | 1.943e-2 | 1.297e-5 | 5.247e-3 |
| *rate* | | *0.66* | *1.31* | *1.32* | *0.66* | *1.98* | *0.99* |
| *theory* | | *2/3* | *4/3* | *4/3* | *2/3* | *2* | *1* |

: Errors for the L-shaped problem @eq:lshape. "Rate" is the observed rate between the two finest meshes. All methods use the same $N$ on each row. {#tbl:lshape}

@tbl:lshape and panel (b) of @fig:convergence confirm the reduced rates on uniform meshes for both methods. The singularity pollutes the whole solution, not just the region near the corner: the FD maximum error converges at only $h^{2/3}$. As in the smooth case, the uniform FD and FEM results are nearly identical, since the matrices are again the same.

Grading changes the picture. With the same 48,641 unknowns, the graded FEM mesh reduces the $L^2$ error from $1.79 \times 10^{-4}$ to $1.30 \times 10^{-5}$, a factor of 14, and the $H^1$ error by a factor of 3.7. Its observed rates, 1.98 and 0.99, are close to the optimal values. Reaching the graded mesh's $L^2$ accuracy with uniform refinement at rate $4/3$ would take about three more halvings of $h$, or roughly 50 times as many unknowns.

## Computational cost {#sec:cost}

@tbl:cost compares assembly and solve times for the smooth problem on finer meshes.

| $h$ | $N$ | FD assembly | FD solve | FEM assembly | FEM solve | FEM solve, zeros removed |
|---:|---:|---:|---:|---:|---:|---:|
| 1/128 | 16,129 | 0.011 | 0.094 | 0.117 | 0.175 | 0.091 |
| 1/256 | 65,025 | 0.036 | 0.585 | 0.427 | 0.940 | 0.529 |
| 1/512 | 261,121 | 0.109 | 4.00 | 1.78 | 9.77 | 3.84 |

: Wall-clock times in seconds for the smooth problem (best of three runs). {#tbl:cost}

FD assembly, which builds the matrix from Kronecker products of one-dimensional difference matrices, is 10 to 16 times faster than our vectorized element-by-element FEM assembly. The FEM matrix as assembled also stores the zero entries coming from the hypotenuse edges (about 40% more nonzeros), which changes the fill-reducing ordering and more than doubles the direct solve time at $h = 1/512$. Once these explicit zeros are dropped, the two matrices are identical and so are the solve times. For both methods the solve dominates on fine meshes; an iterative solver such as algebraic multigrid would change the absolute numbers but not the comparison.

# Discussion {#sec:discussion}

Three conclusions follow from these experiments.

First, on uniform meshes of simple domains, the five-point scheme and P1 finite elements are, for practical purposes, the same method. The stiffness matrices coincide (@eq:equivalence), the nodal errors are nearly indistinguishable, and reported differences in accuracy usually come from measuring the error in different norms. Papers comparing the methods should state precisely which norm is used.

Second, where the solution is singular, both methods suffer equally on uniform meshes. Neither is "more robust" to a re-entrant corner; the loss of regularity sets the rate.

Third, the decisive difference is geometric flexibility. The finite element formulation tolerates arbitrary triangles, so the mesh can be graded or adaptively refined without changing the discretization or losing symmetry. On the L-shaped problem this flexibility bought more than an order of magnitude in accuracy at no cost in unknowns. Finite differences can be extended to nonuniform grids and curved boundaries, but each extension requires new stencils and new analysis, and typically sacrifices either symmetry or order of accuracy near the boundary [@leveque2007].

For problems on rectangles with smooth data, finite differences remain hard to beat for simplicity and speed. For anything else, the extra cost of finite element assembly is small compared with what a well-designed mesh can save.

# Conclusion {#sec:conclusion}

We compared five-point finite differences and P1 finite elements for the Poisson equation on a smooth and a singular test problem. The methods produce identical linear systems on uniform right-triangle meshes and converge at the rates predicted by theory. Finite elements gain a large advantage when the mesh can be adapted to the solution, as on the L-shaped domain, while finite differences are cheaper to assemble on uniform grids. Natural extensions are variable coefficients, where the two methods no longer coincide even on uniform meshes, and adaptive refinement driven by a posteriori error estimators.

# Code availability {.unnumbered}

The scripts that generate every table and figure in this note are available from the authors on request.

# References {.unnumbered}

::: {#refs}
:::
