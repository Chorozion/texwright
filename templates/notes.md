---
title: "Lecture Notes: Topic"
author: [Instructor Name]
date: today
number-sections: true
toc: true
toc-depth: 1
---

# Definitions {#sec:defs}

::: {.definition #def:group}
A *group* is a set $G$ with an operation $\cdot$ that is associative, has an identity $e$, and gives every element an inverse.
:::

::: example
The integers under addition form a group, with identity $0$ and inverses $-n$.
:::

# Main results {#sec:results}

::: {.lemma #lem:unique}
The identity of a group is unique.
:::

::: proof
If $e$ and $e'$ are identities, then $e = e \cdot e' = e'$.
:::

::: {.theorem #thm:lagrange title="Lagrange"}
If $H$ is a subgroup of a finite group $G$, then $|H|$ divides $|G|$.
:::

::: proof
The cosets of $H$ partition $G$ and each has $|H|$ elements, so $|G| = [G:H] \, |H|$.
:::

Lemma @lem:unique and Theorem @thm:lagrange are used throughout.

# Exercises {#sec:exercises}

1. Show that inverses are unique.
2. List all subgroups of $\mathbb{Z}_6$.

::: tip
Try Exercise 2 with Theorem @thm:lagrange: a subgroup's order divides $6$.
:::
