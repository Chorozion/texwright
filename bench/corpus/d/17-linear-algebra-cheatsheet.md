---
title: "Linear Algebra Cheat Sheet"
author: "MATH 2210 · Final exam review"
date: "Fall 2026"
documentclass: article
classoption:
  - twocolumn
geometry: "landscape, margin=1.3cm"
fontsize: 10pt
pagestyle: empty
header-includes:
  - \usepackage{amsmath,amssymb}
  - \setlength{\columnsep}{1cm}
  - \setlength{\parskip}{2pt}
  - \newcommand{\R}{\mathbb{R}}
---

# Notation

$A \in \R^{m \times n}$ has $m$ rows and $n$ columns. Vectors are columns.
$A^\top$ is the transpose, $I_n$ the $n \times n$ identity, $\mathbf{e}_i$ the
$i$-th standard basis vector. $\operatorname{tr}(A) = \sum_i a_{ii}$.

# Vectors

| Quantity | Formula |
|:---------|:--------|
| Dot product | $\mathbf{u}\cdot\mathbf{v} = \mathbf{u}^\top\mathbf{v} = \sum_i u_i v_i$ |
| Euclidean norm | $\lVert\mathbf{v}\rVert = \sqrt{\mathbf{v}\cdot\mathbf{v}}$ |
| Angle | $\cos\theta = \dfrac{\mathbf{u}\cdot\mathbf{v}}{\lVert\mathbf{u}\rVert\,\lVert\mathbf{v}\rVert}$ |
| Projection of $\mathbf{u}$ onto $\mathbf{v}$ | $\operatorname{proj}_{\mathbf{v}}\mathbf{u} = \dfrac{\mathbf{u}\cdot\mathbf{v}}{\mathbf{v}\cdot\mathbf{v}}\,\mathbf{v}$ |
| Cauchy–Schwarz | $\lvert\mathbf{u}\cdot\mathbf{v}\rvert \le \lVert\mathbf{u}\rVert\,\lVert\mathbf{v}\rVert$ |
| Triangle inequality | $\lVert\mathbf{u}+\mathbf{v}\rVert \le \lVert\mathbf{u}\rVert + \lVert\mathbf{v}\rVert$ |

**Cross product** (only in $\R^3$):
$$
\mathbf{u}\times\mathbf{v} =
\begin{vmatrix}
\mathbf{e}_1 & \mathbf{e}_2 & \mathbf{e}_3\\
u_1 & u_2 & u_3\\
v_1 & v_2 & v_3
\end{vmatrix},
\qquad
\lVert\mathbf{u}\times\mathbf{v}\rVert = \lVert\mathbf{u}\rVert\,\lVert\mathbf{v}\rVert\sin\theta.
$$

# Matrix algebra

- $(AB)^\top = B^\top A^\top$, $\quad (AB)^{-1} = B^{-1}A^{-1}$, $\quad (A^\top)^{-1} = (A^{-1})^\top$
- $AB \ne BA$ in general.
- $\operatorname{tr}(AB) = \operatorname{tr}(BA)$, $\quad \operatorname{tr}(A + B) = \operatorname{tr}A + \operatorname{tr}B$
- Inverse of a $2\times 2$ matrix:
$$
\begin{bmatrix} a & b\\ c & d \end{bmatrix}^{-1}
= \frac{1}{ad - bc}\begin{bmatrix} d & -b\\ -c & a \end{bmatrix},
\qquad ad - bc \ne 0.
$$

# Linear systems $A\mathbf{x} = \mathbf{b}$

Row reduce $[\,A \mid \mathbf{b}\,]$ to (reduced) row echelon form.
**Elementary row operations:** swap two rows; multiply a row by $c \ne 0$;
add a multiple of one row to another.

| Situation | Solutions |
|:----------|:----------|
| Pivot in last column of $[A \mid \mathbf{b}]$ | none (inconsistent) |
| Consistent, $\operatorname{rank} A = n$ | exactly one |
| Consistent, $\operatorname{rank} A < n$ | infinitely many ($n - r$ free variables) |

**Rank–nullity:** $\operatorname{rank} A + \dim\operatorname{Null} A = n$.

# The invertible matrix theorem

For $A \in \R^{n\times n}$, the following are **equivalent**:

1. $A$ is invertible.
2. $\det A \ne 0$.
3. $\operatorname{rank} A = n$; the columns form a basis of $\R^n$.
4. $A\mathbf{x} = \mathbf{0}$ has only the trivial solution.
5. $A\mathbf{x} = \mathbf{b}$ has a unique solution for every $\mathbf{b}$.
6. $0$ is not an eigenvalue of $A$.
7. $A^\top$ is invertible.

# Determinants

$$
\det\begin{bmatrix} a & b\\ c & d\end{bmatrix} = ad - bc,
\qquad
\det A = \sum_{j=1}^{n} (-1)^{i+j} a_{ij} M_{ij}
\ \text{(expand along row } i\text{)}.
$$

| Operation / property | Effect on $\det$ |
|:---------------------|:-----------------|
| Swap two rows | multiply by $-1$ |
| Scale a row by $c$ | multiply by $c$ |
| Add multiple of a row to another | unchanged |
| $\det(AB)$ | $\det A \cdot \det B$ |
| $\det(A^\top)$, $\det(A^{-1})$ | $\det A$, $\;1/\det A$ |
| $\det(cA)$, $A$ is $n\times n$ | $c^n \det A$ |
| Triangular $A$ | product of diagonal entries |

**Cramer's rule:** $x_i = \det A_i(\mathbf{b}) / \det A$, where $A_i(\mathbf{b})$
replaces column $i$ of $A$ with $\mathbf{b}$.

# The four fundamental subspaces

For $A \in \R^{m\times n}$ with rank $r$:

| Subspace | Lives in | Dimension | Orthogonal complement |
|:---------|:---------|:---------:|:----------------------|
| Column space $\operatorname{Col}A$ | $\R^m$ | $r$ | $\operatorname{Null}A^\top$ |
| Row space $\operatorname{Col}A^\top$ | $\R^n$ | $r$ | $\operatorname{Null}A$ |
| Null space $\operatorname{Null}A$ | $\R^n$ | $n - r$ | $\operatorname{Col}A^\top$ |
| Left null space $\operatorname{Null}A^\top$ | $\R^m$ | $m - r$ | $\operatorname{Col}A$ |

A basis for $\operatorname{Col}A$: the **pivot columns of $A$** (not of the
echelon form). A basis for $\operatorname{Null}A$: the vectors multiplying
the free variables in the parametric solution of $A\mathbf{x}=\mathbf{0}$.

# Eigenvalues and eigenvectors

$A\mathbf{v} = \lambda\mathbf{v}$, $\mathbf{v} \ne \mathbf{0}$. Find
$\lambda$ from the **characteristic equation**
$\det(A - \lambda I) = 0$, then $\mathbf{v}$ from
$\operatorname{Null}(A - \lambda I)$.

- $\sum_i \lambda_i = \operatorname{tr}A$, $\quad \prod_i \lambda_i = \det A$
- For $2\times 2$: $\lambda^2 - (\operatorname{tr}A)\lambda + \det A = 0$
- Triangular matrix: eigenvalues are the diagonal entries.
- $A^k$ has eigenvalues $\lambda_i^k$; $A^{-1}$ has $1/\lambda_i$.
- Eigenvectors for distinct eigenvalues are linearly independent.

**Diagonalisation.** $A = PDP^{-1}$, with the eigenvectors as columns of $P$
and eigenvalues on the diagonal of $D$. Possible iff $A$ has $n$ linearly
independent eigenvectors (i.e. for each $\lambda$, geometric multiplicity =
algebraic multiplicity). Then $A^k = PD^kP^{-1}$.

**Spectral theorem.** If $A = A^\top$ (real symmetric), all eigenvalues are
real and $A = Q\Lambda Q^\top$ with $Q$ orthogonal.

# Orthogonality and least squares

- $Q$ is **orthogonal** if $Q^\top Q = I$. Then $Q^{-1} = Q^\top$,
  $\lVert Q\mathbf{x}\rVert = \lVert\mathbf{x}\rVert$, $\det Q = \pm 1$.
- **Gram–Schmidt:**
  $\mathbf{u}_k = \mathbf{a}_k - \sum_{j<k}(\mathbf{q}_j^\top\mathbf{a}_k)\,\mathbf{q}_j$,
  $\ \mathbf{q}_k = \mathbf{u}_k/\lVert\mathbf{u}_k\rVert$.
- **Projection onto $\operatorname{Col}A$** (full column rank):
$$
P = A(A^\top A)^{-1}A^\top, \qquad P^2 = P = P^\top.
$$
- **Least squares** $\min_{\mathbf{x}}\lVert A\mathbf{x} - \mathbf{b}\rVert^2$
  solves the **normal equations**
$$
A^\top A\,\hat{\mathbf{x}} = A^\top\mathbf{b}
\quad\Longrightarrow\quad
\hat{\mathbf{x}} = (A^\top A)^{-1}A^\top\mathbf{b} = R^{-1}Q^\top\mathbf{b}
\ \text{ if } A = QR.
$$

# Matrix decompositions

| Name | Form | Exists when | Used for |
|:-----|:-----|:------------|:---------|
| LU | $PA = LU$ | any square $A$ (with pivoting $P$) | solving systems, $\det$ |
| Cholesky | $A = LL^\top$ | $A$ symmetric positive definite | fast SPD solves |
| QR | $A = QR$ | any $A$ | least squares, eigenvalue algorithms |
| Eigen | $A = PDP^{-1}$ | $n$ independent eigenvectors | powers, ODEs |
| Spectral | $A = Q\Lambda Q^\top$ | $A$ symmetric | quadratic forms |
| SVD | $A = U\Sigma V^\top$ | **always** | rank, low-rank approximation, pseudo-inverse |

# Singular value decomposition

$A = U\Sigma V^\top$ with $U \in \R^{m\times m}$, $V \in \R^{n\times n}$
orthogonal and $\Sigma = \operatorname{diag}(\sigma_1, \dots, \sigma_r, 0, \dots)$,
$\sigma_1 \ge \dots \ge \sigma_r > 0$.

- $\sigma_i^2$ are the nonzero eigenvalues of $A^\top A$ (and of $AA^\top$).
- Columns of $V$: eigenvectors of $A^\top A$; columns of $U$: eigenvectors of $AA^\top$.
- $\operatorname{rank}A = r$ = number of nonzero singular values.
- **Pseudo-inverse:** $A^{+} = V\Sigma^{+}U^\top$, where $\Sigma^{+}$ inverts the nonzero $\sigma_i$.
- **Eckart–Young:** the best rank-$k$ approximation is
  $A_k = \sum_{i=1}^{k}\sigma_i\mathbf{u}_i\mathbf{v}_i^\top$, with
  $\lVert A - A_k\rVert_2 = \sigma_{k+1}$.

# Positive definite matrices

For symmetric $A$, these are equivalent ways to say $A \succ 0$:

1. $\mathbf{x}^\top A\mathbf{x} > 0$ for all $\mathbf{x} \ne \mathbf{0}$;
2. all eigenvalues are positive;
3. all leading principal minors are positive (Sylvester's criterion);
4. $A = LL^\top$ with $L$ lower triangular with positive diagonal (Cholesky);
5. $A = B^\top B$ for some $B$ with independent columns.

# Norms and conditioning

$$
\lVert\mathbf{x}\rVert_1 = \sum_i\lvert x_i\rvert,
\quad
\lVert\mathbf{x}\rVert_2 = \Bigl(\sum_i x_i^2\Bigr)^{1/2},
\quad
\lVert\mathbf{x}\rVert_\infty = \max_i\lvert x_i\rvert
$$

$$
\lVert A\rVert_2 = \sigma_1,
\qquad
\lVert A\rVert_F = \Bigl(\sum_{i,j}a_{ij}^2\Bigr)^{1/2} = \Bigl(\sum_i\sigma_i^2\Bigr)^{1/2},
\qquad
\kappa_2(A) = \frac{\sigma_1}{\sigma_n}.
$$

Rule of thumb: solving $A\mathbf{x} = \mathbf{b}$ in floating point loses about
$\log_{10}\kappa(A)$ significant digits.

# Useful identities

**Sherman–Morrison:**
$$
(A + \mathbf{u}\mathbf{v}^\top)^{-1} = A^{-1} - \frac{A^{-1}\mathbf{u}\mathbf{v}^\top A^{-1}}{1 + \mathbf{v}^\top A^{-1}\mathbf{u}}
$$

**Woodbury:**
$$
(A + UCV)^{-1} = A^{-1} - A^{-1}U\left(C^{-1} + VA^{-1}U\right)^{-1}VA^{-1}
$$

**Block determinant** ($A$ invertible):
$$
\det\begin{bmatrix} A & B\\ C & D\end{bmatrix} = \det A\cdot\det\!\left(D - CA^{-1}B\right)
$$

**Gradients** (for $\mathbf{x} \in \R^n$):

| $f(\mathbf{x})$ | $\nabla f(\mathbf{x})$ |
|:----------------|:-----------------------|
| $\mathbf{a}^\top\mathbf{x}$ | $\mathbf{a}$ |
| $\mathbf{x}^\top A\mathbf{x}$ | $(A + A^\top)\mathbf{x}$ ($= 2A\mathbf{x}$ if symmetric) |
| $\lVert A\mathbf{x} - \mathbf{b}\rVert^2$ | $2A^\top(A\mathbf{x} - \mathbf{b})$ |

# Worked mini-example

Let $A = \begin{bmatrix} 2 & 1\\ 1 & 2\end{bmatrix}$.
Then $\operatorname{tr}A = 4$, $\det A = 3$, so
$\lambda^2 - 4\lambda + 3 = 0$ and $\lambda \in \{1, 3\}$.
Eigenvectors: $\lambda = 3$: $(1, 1)^\top$; $\lambda = 1$: $(1, -1)^\top$.
Normalising,
$$
A = Q\Lambda Q^\top,\quad
Q = \frac{1}{\sqrt 2}\begin{bmatrix} 1 & 1\\ 1 & -1\end{bmatrix},\quad
\Lambda = \begin{bmatrix} 3 & 0\\ 0 & 1\end{bmatrix}.
$$
Both eigenvalues are positive, so $A \succ 0$; $\kappa_2(A) = 3$.
