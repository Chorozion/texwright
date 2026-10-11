---
title: "Math 2270: Problem Set 7 Solutions"
subtitle: "Eigenvalues, Eigenvectors and Diagonalization"
author: "Solutions prepared by the course staff"
date: "Fall 2026"
geometry: margin=1in
---

Throughout, $I$ denotes the identity matrix of the appropriate size, and $E_\lambda = \ker(A - \lambda I)$ is the eigenspace of $A$ for the eigenvalue $\lambda$.

## Problem 1

*Find the eigenvalues and eigenvectors of*
$$
A = \begin{pmatrix} 4 & 1 \\ 2 & 3 \end{pmatrix}.
$$

**Solution.** The characteristic polynomial is
$$
\det(A - \lambda I) = \det\begin{pmatrix} 4 - \lambda & 1 \\ 2 & 3 - \lambda \end{pmatrix}
= (4 - \lambda)(3 - \lambda) - 2 = \lambda^2 - 7\lambda + 10 = (\lambda - 5)(\lambda - 2).
$$
So the eigenvalues are $\lambda_1 = 5$ and $\lambda_2 = 2$.

For $\lambda_1 = 5$:
$$
A - 5I = \begin{pmatrix} -1 & 1 \\ 2 & -2 \end{pmatrix} \;\longrightarrow\; \begin{pmatrix} 1 & -1 \\ 0 & 0 \end{pmatrix},
$$
so $x_1 = x_2$ and $E_5 = \operatorname{span}\left\{ \begin{pmatrix} 1 \\ 1 \end{pmatrix} \right\}$.

For $\lambda_2 = 2$:
$$
A - 2I = \begin{pmatrix} 2 & 1 \\ 2 & 1 \end{pmatrix} \;\longrightarrow\; \begin{pmatrix} 2 & 1 \\ 0 & 0 \end{pmatrix},
$$
so $x_2 = -2x_1$ and $E_2 = \operatorname{span}\left\{ \begin{pmatrix} 1 \\ -2 \end{pmatrix} \right\}$.

*Check:* $A\begin{pmatrix} 1 \\ -2 \end{pmatrix} = \begin{pmatrix} 4 - 2 \\ 2 - 6 \end{pmatrix} = \begin{pmatrix} 2 \\ -4 \end{pmatrix} = 2\begin{pmatrix} 1 \\ -2 \end{pmatrix}$. ✓

As a sanity check, the eigenvalues sum to $7 = \operatorname{tr} A$ and multiply to $10 = \det A$.

## Problem 2

*Diagonalize*
$$
B = \begin{pmatrix} 1 & 2 & 0 \\ 0 & 3 & 0 \\ 2 & -4 & 2 \end{pmatrix},
$$
*that is, find an invertible $P$ and a diagonal $D$ with $B = PDP^{-1}$. Then use the factorization to compute $B^n$ for every positive integer $n$.*

**Solution.** Expanding $\det(B - \lambda I)$ along the third column, which has only one nonzero entry,
$$
\det(B - \lambda I) = (2 - \lambda)\det\begin{pmatrix} 1 - \lambda & 2 \\ 0 & 3 - \lambda \end{pmatrix} = (1 - \lambda)(2 - \lambda)(3 - \lambda).
$$
The eigenvalues are $1$, $2$ and $3$. They are distinct, so $B$ is diagonalizable (see Problem 5).

**$\lambda = 1$.** $B - I = \begin{pmatrix} 0 & 2 & 0 \\ 0 & 2 & 0 \\ 2 & -4 & 1 \end{pmatrix}$ gives $x_2 = 0$ and $2x_1 + x_3 = 0$, so $v_1 = (1, 0, -2)^T$.

**$\lambda = 2$.** $B - 2I = \begin{pmatrix} -1 & 2 & 0 \\ 0 & 1 & 0 \\ 2 & -4 & 0 \end{pmatrix}$ gives $x_2 = 0$ and $x_1 = 0$ with $x_3$ free, so $v_2 = (0, 0, 1)^T$.

**$\lambda = 3$.** $B - 3I = \begin{pmatrix} -2 & 2 & 0 \\ 0 & 0 & 0 \\ 2 & -4 & -1 \end{pmatrix}$ gives $x_1 = x_2$ and $x_3 = 2x_1 - 4x_2 = -2x_1$, so $v_3 = (1, 1, -2)^T$.

Placing the eigenvectors in the columns of $P$, in the same order as the eigenvalues in $D$:
$$
P = \begin{pmatrix} 1 & 0 & 1 \\ 0 & 0 & 1 \\ -2 & 1 & -2 \end{pmatrix}, \qquad
D = \begin{pmatrix} 1 & 0 & 0 \\ 0 & 2 & 0 \\ 0 & 0 & 3 \end{pmatrix}, \qquad
P^{-1} = \begin{pmatrix} 1 & -1 & 0 \\ 2 & 0 & 1 \\ 0 & 1 & 0 \end{pmatrix}.
$$
(Here $\det P = -1$, and $P^{-1}$ was computed from the adjugate; multiplying out confirms $PP^{-1} = I$.)

Since $B^n = (PDP^{-1})^n = PD^nP^{-1}$, with all the inner $P^{-1}P$ factors cancelling,
$$
B^n = \begin{pmatrix} 1 & 0 & 3^n \\ 0 & 0 & 3^n \\ -2 & 2^n & -2\cdot 3^n \end{pmatrix}
\begin{pmatrix} 1 & -1 & 0 \\ 2 & 0 & 1 \\ 0 & 1 & 0 \end{pmatrix}
= \boxed{\begin{pmatrix} 1 & 3^n - 1 & 0 \\ 0 & 3^n & 0 \\ 2^{n+1} - 2 & 2 - 2\cdot 3^n & 2^n \end{pmatrix}}.
$$

*Check:* at $n = 1$ the formula returns $\begin{pmatrix} 1 & 2 & 0 \\ 0 & 3 & 0 \\ 2 & -4 & 2 \end{pmatrix} = B$. ✓

## Problem 3

*Show that $C = \begin{pmatrix} 1 & 1 \\ 0 & 1 \end{pmatrix}$ is not diagonalizable.*

**Solution.** $C$ is upper triangular, so its only eigenvalue is $\lambda = 1$, with algebraic multiplicity 2. The eigenspace is
$$
E_1 = \ker\begin{pmatrix} 0 & 1 \\ 0 & 0 \end{pmatrix} = \operatorname{span}\left\{\begin{pmatrix} 1 \\ 0 \end{pmatrix}\right\},
$$
which has dimension 1. A $2 \times 2$ matrix is diagonalizable exactly when it has two linearly independent eigenvectors, and every eigenvector of $C$ is a multiple of $(1, 0)^T$. So $C$ is not diagonalizable.

Another way to see it: if $C = PDP^{-1}$ then $D$ would have to be $I$, since $1$ is the only eigenvalue, and then $C = PIP^{-1} = I$, which is false.

## Problem 4

*Find an orthogonal matrix $Q$ and a diagonal matrix $\Lambda$ with $S = Q\Lambda Q^T$, where*
$$
S = \begin{pmatrix} 2 & 1 & 1 \\ 1 & 2 & 1 \\ 1 & 1 & 2 \end{pmatrix}.
$$

**Solution.** Write $S = I + J$, where $J$ is the all-ones matrix. $J$ has rank 1, with $J\mathbf{1} = 3\cdot\mathbf{1}$ for $\mathbf{1} = (1,1,1)^T$, and $Jx = 0$ whenever $x_1 + x_2 + x_3 = 0$. Therefore:

- $\lambda = 4$, with eigenspace spanned by $(1, 1, 1)^T$;
- $\lambda = 1$, with the two-dimensional eigenspace $\{x : x_1 + x_2 + x_3 = 0\}$.

(Check: $\operatorname{tr} S = 6 = 4 + 1 + 1$.)

Since $S$ is symmetric, eigenvectors for different eigenvalues are automatically orthogonal. Inside $E_1$ we need an orthogonal basis, so we pick $(1, -1, 0)^T$ and then a vector in $E_1$ orthogonal to it, such as $(1, 1, -2)^T$. Normalizing,
$$
Q = \begin{pmatrix}
\frac{1}{\sqrt{3}} & \frac{1}{\sqrt{2}} & \frac{1}{\sqrt{6}} \\[4pt]
\frac{1}{\sqrt{3}} & -\frac{1}{\sqrt{2}} & \frac{1}{\sqrt{6}} \\[4pt]
\frac{1}{\sqrt{3}} & 0 & -\frac{2}{\sqrt{6}}
\end{pmatrix}, \qquad
\Lambda = \begin{pmatrix} 4 & 0 & 0 \\ 0 & 1 & 0 \\ 0 & 0 & 1 \end{pmatrix}.
$$
The columns of $Q$ are orthonormal, so $Q^{-1} = Q^T$ and $S = Q\Lambda Q^T$.

## Problem 5

*Let $v_1, \dots, v_k$ be eigenvectors of $A$ with distinct eigenvalues $\lambda_1, \dots, \lambda_k$. Prove that $v_1, \dots, v_k$ are linearly independent.*

**Proof.** We use induction on $k$. For $k = 1$, the set $\{v_1\}$ is independent because eigenvectors are nonzero by definition.

Suppose the claim holds for $k - 1$ eigenvectors, and suppose
$$
c_1 v_1 + c_2 v_2 + \cdots + c_k v_k = 0. \tag{1}
$$
Applying $A$ to (1) gives
$$
c_1 \lambda_1 v_1 + c_2 \lambda_2 v_2 + \cdots + c_k \lambda_k v_k = 0, \tag{2}
$$
and multiplying (1) by $\lambda_k$ gives
$$
c_1 \lambda_k v_1 + c_2 \lambda_k v_2 + \cdots + c_k \lambda_k v_k = 0. \tag{3}
$$
Subtracting (3) from (2) eliminates $v_k$:
$$
c_1(\lambda_1 - \lambda_k) v_1 + \cdots + c_{k-1}(\lambda_{k-1} - \lambda_k) v_{k-1} = 0.
$$
By the induction hypothesis $v_1, \dots, v_{k-1}$ are independent, so $c_i(\lambda_i - \lambda_k) = 0$ for $i < k$. The eigenvalues are distinct, so $\lambda_i - \lambda_k \neq 0$ and therefore $c_i = 0$ for all $i < k$. Equation (1) then reduces to $c_k v_k = 0$, and $v_k \neq 0$ forces $c_k = 0$. $\blacksquare$

**Consequence.** An $n \times n$ matrix with $n$ distinct eigenvalues has $n$ independent eigenvectors and is therefore diagonalizable. This is what we used in Problem 2. The converse fails: $I$ has a single eigenvalue and is already diagonal.

## Problem 6

*A square matrix $A$ is idempotent if $A^2 = A$. Show that every eigenvalue of an idempotent matrix is 0 or 1, and that every idempotent matrix is diagonalizable.*

**Solution.** If $Av = \lambda v$ with $v \neq 0$, then
$$
\lambda v = Av = A^2 v = A(\lambda v) = \lambda^2 v,
$$
so $(\lambda^2 - \lambda)v = 0$. Since $v \neq 0$, $\lambda(\lambda - 1) = 0$, which means $\lambda \in \{0, 1\}$.

For diagonalizability, take any $x \in \mathbb{R}^n$ and write
$$
x = Ax + (x - Ax).
$$
The first piece is in $E_1$, because $A(Ax) = A^2x = Ax$. The second is in $E_0$, because $A(x - Ax) = Ax - A^2x = 0$. Hence $\mathbb{R}^n = E_1 + E_0$, and the sum is direct because a vector in both eigenspaces satisfies $v = Av = 0$. Taking a basis of $E_1$ together with a basis of $E_0$ gives a basis of $\mathbb{R}^n$ consisting of eigenvectors, so $A$ is diagonalizable, with $D = \operatorname{diag}(1, \dots, 1, 0, \dots, 0)$ and $\operatorname{rank} A$ ones on the diagonal.

## Problem 7

*The Fibonacci numbers satisfy $F_0 = 0$, $F_1 = 1$ and $F_{n+1} = F_n + F_{n-1}$. Use diagonalization to derive a closed formula for $F_n$.*

**Solution.** The recurrence in matrix form is
$$
\begin{pmatrix} F_{n+1} \\ F_n \end{pmatrix} = M \begin{pmatrix} F_n \\ F_{n-1} \end{pmatrix},
\qquad M = \begin{pmatrix} 1 & 1 \\ 1 & 0 \end{pmatrix},
$$
so $\begin{pmatrix} F_{n+1} \\ F_n \end{pmatrix} = M^n \begin{pmatrix} 1 \\ 0 \end{pmatrix}$.

The characteristic polynomial of $M$ is $\lambda^2 - \lambda - 1$, with roots
$$
\varphi = \frac{1 + \sqrt{5}}{2}, \qquad \psi = \frac{1 - \sqrt{5}}{2}.
$$
For each root $\lambda$, the vector $(\lambda, 1)^T$ is an eigenvector, since $M(\lambda, 1)^T = (\lambda + 1, \lambda)^T = (\lambda^2, \lambda)^T$. Decompose the initial vector in this eigenbasis:
$$
\begin{pmatrix} 1 \\ 0 \end{pmatrix} = \frac{1}{\varphi - \psi}\left[ \begin{pmatrix} \varphi \\ 1 \end{pmatrix} - \begin{pmatrix} \psi \\ 1 \end{pmatrix} \right],
\qquad \varphi - \psi = \sqrt{5}.
$$
Applying $M^n$ multiplies each eigenvector by $\lambda^n$:
$$
\begin{pmatrix} F_{n+1} \\ F_n \end{pmatrix} = \frac{1}{\sqrt{5}}\left[ \varphi^n \begin{pmatrix} \varphi \\ 1 \end{pmatrix} - \psi^n \begin{pmatrix} \psi \\ 1 \end{pmatrix} \right].
$$
Reading off the second component gives Binet's formula:
$$
\boxed{F_n = \frac{\varphi^n - \psi^n}{\sqrt{5}} = \frac{1}{\sqrt{5}}\left[\left(\frac{1 + \sqrt{5}}{2}\right)^{n} - \left(\frac{1 - \sqrt{5}}{2}\right)^{n}\right]}
$$

Since $|\psi| < 1$, the second term shrinks to zero, and $F_n$ is the integer nearest to $\varphi^n / \sqrt{5}$. For example, $\varphi^{10}/\sqrt{5} \approx 55.004$ and $F_{10} = 55$.
