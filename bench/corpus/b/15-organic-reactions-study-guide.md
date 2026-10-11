---
title: "Organic Chemistry II Study Guide: Key Reactions"
subtitle: "Substitution, elimination, alkenes, alkynes, alcohols, carbonyls, and aromatic substitution"
date: "Exam 2 review, October 2026"
header-includes:
  - \usepackage[version=4]{mhchem}
---

# How to use this guide

Each section lists the reactions you are expected to know, with the reagents, the product, and the regiochemistry and stereochemistry. For every reaction, make sure you can answer three questions:

1. **What bond breaks and what bond forms?**
2. **Where does the new group go?** (regiochemistry: Markovnikov or anti-Markovnikov, Zaitsev or Hofmann)
3. **What is the stereochemistry?** (syn or anti addition, inversion or racemization)

Notation: R is an alkyl group, X is a halogen, Nu is a nucleophile, and reagents written as "1. ...; 2. ..." are added in separate steps. $\Delta$ means heat.

# 1. Substitution and elimination

## 1.1 The four mechanisms at a glance

| | S~N~2 | S~N~1 | E2 | E1 |
|---|---|---|---|---|
| **Rate law** | $k[\text{RX}][\text{Nu}^-]$ | $k[\text{RX}]$ | $k[\text{RX}][\text{B}^-]$ | $k[\text{RX}]$ |
| **Steps** | One, concerted | Two, via carbocation | One, concerted | Two, via carbocation |
| **Best substrate** | Methyl > 1° > 2° (3° never) | 3° > 2° (1° never) | 3° > 2° > 1° | 3° > 2° |
| **Reagent** | Strong nucleophile, weak base | Weak nucleophile | Strong, often bulky base | Weak base |
| **Solvent** | Polar aprotic (DMSO, acetone, DMF) | Polar protic ($\ce{H2O}$, ROH) | Varies | Polar protic |
| **Stereochemistry** | Inversion (backside attack) | Racemization (mostly) | Anti-periplanar H and X | Mixture |
| **Rearrangements?** | No | Yes | No | Yes |

## 1.2 Representative reactions

S~N~2 with inversion at a stereocenter:

$$
\ce{(R)-CH3CH(Br)CH2CH3 + NaCN ->[DMSO] (S)-CH3CH(CN)CH2CH3 + NaBr}
$$

S~N~1 solvolysis of a tertiary halide (racemic product if the carbon is a stereocenter):

$$
\ce{(CH3)3C-Br + H2O -> (CH3)3C-OH + HBr}
$$

E2 with a small base gives the more substituted (Zaitsev) alkene; a bulky base gives the less substituted (Hofmann) alkene:

$$
\ce{CH3CH2CH(Br)CH3 ->[NaOEt][EtOH, \Delta] CH3CH=CHCH3}\ \text{(major)}
$$

$$
\ce{CH3CH2CH(Br)CH3 ->[KOt-Bu][t-BuOH, \Delta] CH3CH2CH=CH2}\ \text{(major)}
$$

E1 from an alcohol under acid catalysis:

$$
\ce{(CH3)3COH ->[H2SO4][\Delta] (CH3)2C=CH2 + H2O}
$$

## 1.3 Decision shortcut

1. **Methyl or primary substrate?** S~N~2, unless the base is strong and bulky (KO*t*-Bu), which gives E2.
2. **Tertiary substrate?** Never S~N~2. Strong base gives E2; weak nucleophile in protic solvent gives S~N~1/E1 (heat favors E1).
3. **Secondary substrate?** The hardest case. Strong nucleophile and weak base ($\ce{I-}$, $\ce{CN-}$, $\ce{N3-}$, $\ce{RS-}$) in aprotic solvent gives S~N~2. Strong base ($\ce{HO-}$, $\ce{RO-}$) gives mostly E2. Weak nucleophile, protic solvent gives S~N~1/E1.

# 2. Reactions of alkenes

## 2.1 Summary table

| Reagents | Product | Regiochemistry | Stereochemistry |
|---|---|---|---|
| $\ce{HBr}$ (or HCl, HI) | Alkyl halide | Markovnikov | Not controlled (carbocation) |
| $\ce{HBr}$, ROOR, $h\nu$ or $\Delta$ | Alkyl bromide | **Anti**-Markovnikov | Not controlled (radical) |
| $\ce{H2O}$, $\ce{H2SO4}$ (cat.) | Alcohol | Markovnikov | Not controlled; rearrangements possible |
| 1. $\ce{Hg(OAc)2}$, $\ce{H2O}$; 2. $\ce{NaBH4}$ | Alcohol | Markovnikov | No rearrangement |
| 1. $\ce{BH3*THF}$; 2. $\ce{H2O2}$, $\ce{NaOH}$ | Alcohol | **Anti**-Markovnikov | **Syn** addition |
| $\ce{Br2}$ in $\ce{CH2Cl2}$ | Vicinal dibromide | n/a | **Anti** addition (bromonium ion) |
| $\ce{Br2}$, $\ce{H2O}$ | Bromohydrin | OH on more substituted C | Anti addition |
| $\ce{H2}$, Pd/C | Alkane | n/a | Syn addition |
| *m*CPBA | Epoxide | n/a | Syn (stereospecific) |
| 1. $\ce{OsO4}$; 2. $\ce{NaHSO3}$ (or cat. $\ce{OsO4}$, NMO) | *cis*-1,2-Diol | n/a | Syn |
| 1. $\ce{O3}$; 2. $\ce{(CH3)2S}$ | Aldehydes and/or ketones | C=C cleaved | n/a |
| Hot $\ce{KMnO4}$, $\ce{H3O+}$ | Ketones and/or carboxylic acids | C=C cleaved | n/a |

## 2.2 Worked examples with 2-methylpropene

Markovnikov addition (the proton adds to the carbon with more H, giving the more stable tertiary cation):

$$
\ce{(CH3)2C=CH2 + HBr -> (CH3)2CBr-CH3}
$$

Anti-Markovnikov addition in the presence of peroxides (bromine radical adds first, to give the more stable radical):

$$
\ce{(CH3)2C=CH2 + HBr ->[ROOR] (CH3)2CH-CH2Br}
$$

Hydroboration–oxidation:

$$
\ce{(CH3)2C=CH2 ->[1. BH3*THF][2. H2O2, NaOH] (CH3)2CH-CH2OH}
$$

Ozonolysis, which is useful for locating a double bond in an unknown:

$$
\ce{(CH3)2C=CH2 ->[1. O3][2. (CH3)2S] (CH3)2C=O + H2C=O}
$$

> **Common mistake.** Hydroboration–oxidation and HBr/ROOR are both anti-Markovnikov, but for different reasons: steric and electronic effects of boron in the first case, radical stability in the second. Only HBr shows the peroxide effect; HCl and HI do not.

# 3. Reactions of alkynes

| Reagents | Product | Notes |
|---|---|---|
| $\ce{H2}$ (excess), Pd/C | Alkane | Both π bonds reduced |
| $\ce{H2}$, Lindlar catalyst | *cis*-Alkene | Poisoned catalyst stops at the alkene |
| Na, $\ce{NH3}$(l) | *trans*-Alkene | Dissolving-metal reduction |
| $\ce{H2O}$, $\ce{H2SO4}$, $\ce{HgSO4}$ | Methyl ketone (from terminal alkyne) | Markovnikov; enol tautomerizes |
| 1. $\ce{R2BH}$ (e.g. 9-BBN); 2. $\ce{H2O2}$, $\ce{NaOH}$ | Aldehyde (from terminal alkyne) | Anti-Markovnikov; enol tautomerizes |
| 1. $\ce{NaNH2}$; 2. R–X (1°) | Internal alkyne | Acetylide alkylation forms C–C bond |

Two reductions of 2-butyne that give different stereoisomers:

$$
\ce{CH3-C#C-CH3 ->[H2][Lindlar] }\textit{cis}\text{-}\ce{CH3CH=CHCH3}
\qquad
\ce{CH3-C#C-CH3 ->[Na][NH3(l)] }\textit{trans}\text{-}\ce{CH3CH=CHCH3}
$$

Building a carbon chain with an acetylide:

$$
\ce{HC#CH ->[1. NaNH2][2. CH3CH2Br] HC#C-CH2CH3}
$$

# 4. Alcohols

## 4.1 Oxidation

| Starting alcohol | PCC or DMP or Swern | Jones ($\ce{CrO3}$, $\ce{H2SO4}$, acetone) |
|---|---|---|
| Primary, $\ce{RCH2OH}$ | Aldehyde, $\ce{RCHO}$ | Carboxylic acid, $\ce{RCOOH}$ |
| Secondary, $\ce{R2CHOH}$ | Ketone | Ketone |
| Tertiary | No reaction | No reaction |

$$
\ce{CH3CH2CH2OH ->[PCC][CH2Cl2] CH3CH2CHO}
\qquad
\ce{CH3CH2CH2OH ->[CrO3, H2SO4][acetone] CH3CH2COOH}
$$

## 4.2 Converting OH into a leaving group

The hydroxide ion is a poor leaving group, so alcohols must be activated before substitution.

$$
\ce{ROH ->[SOCl2][pyridine] RCl} \qquad
\ce{ROH ->[PBr3] RBr} \qquad
\ce{ROH ->[TsCl][pyridine] ROTs}
$$

With $\ce{SOCl2}$ and $\ce{PBr3}$, a stereocenter bearing the OH is **inverted** (S~N~2 step). Tosylation **retains** configuration, because the C–O bond is not broken; a later S~N~2 on the tosylate then inverts it.

# 5. Aldehydes and ketones

| Reagents | Product | Notes |
|---|---|---|
| $\ce{NaBH4}$, MeOH | Alcohol | Reduces aldehydes and ketones only |
| 1. $\ce{LiAlH4}$, ether; 2. $\ce{H3O+}$ | Alcohol | Also reduces esters, acids, amides |
| 1. RMgBr, ether; 2. $\ce{H3O+}$ | Alcohol with new C–C bond | Formaldehyde → 1°, aldehyde → 2°, ketone → 3° |
| $\ce{Ph3P=CHR}$ (Wittig) | Alkene | Replaces C=O with C=C at a defined position |
| 2 ROH, $\ce{H+}$ (cat.), remove $\ce{H2O}$ | Acetal | Protecting group; stable to base, removed by aqueous acid |
| $\ce{RNH2}$, $\ce{H+}$ (cat.), pH ≈ 4–5 | Imine | Reversible |
| NaOH, $\ce{H2O}$, then $\Delta$ | α,β-Unsaturated carbonyl | Aldol addition then condensation |

Grignard addition to a ketone:

$$
\ce{CH3COCH3 ->[1. CH3CH2MgBr, ether][2. H3O+] (CH3)2C(OH)CH2CH3}
$$

Wittig reaction:

$$
\ce{(CH3)2C=O + Ph3P=CH2 -> (CH3)2C=CH2 + Ph3P=O}
$$

Acetal formation is an equilibrium driven forward by removing water:

$$
\ce{RCHO + 2 CH3OH <=>[H+] RCH(OCH3)2 + H2O}
$$

Aldol condensation of acetaldehyde:

$$
\ce{2 CH3CHO ->[NaOH] CH3CH(OH)CH2CHO ->[\Delta] CH3CH=CHCHO + H2O}
$$

# 6. Electrophilic aromatic substitution

## 6.1 The five core reactions of benzene

| Reaction | Reagents | Electrophile | Product |
|---|---|---|---|
| Halogenation | $\ce{Br2}$, $\ce{FeBr3}$ | $\ce{Br+}$ (as $\ce{Br2-FeBr3}$ complex) | Bromobenzene |
| Nitration | $\ce{HNO3}$, $\ce{H2SO4}$ | $\ce{NO2+}$ (nitronium) | Nitrobenzene |
| Sulfonation | $\ce{SO3}$, $\ce{H2SO4}$ | $\ce{SO3H+}$ | Benzenesulfonic acid (reversible) |
| Friedel–Crafts alkylation | R–Cl, $\ce{AlCl3}$ | $\ce{R+}$ | Alkylbenzene (rearrangements, polyalkylation) |
| Friedel–Crafts acylation | RCOCl, $\ce{AlCl3}$ | $\ce{RC#O+}$ (acylium) | Aryl ketone (no rearrangement) |

$$
\ce{C6H6 + HNO3 ->[H2SO4] C6H5NO2 + H2O}
\qquad
\ce{C6H6 + CH3COCl ->[AlCl3] C6H5COCH3 + HCl}
$$

## 6.2 Directing effects of substituents

| Substituent | Examples | Effect on rate | Directs to |
|---|---|---|---|
| Strong activators | $\ce{-NH2}$, $\ce{-NHR}$, $\ce{-OH}$, $\ce{-O^-}$ | Strongly activating | *ortho*, *para* |
| Moderate activators | $\ce{-OR}$, $\ce{-NHCOR}$ | Activating | *ortho*, *para* |
| Weak activators | $\ce{-R}$, $\ce{-C6H5}$ | Weakly activating | *ortho*, *para* |
| Halogens | $\ce{-F}$, $\ce{-Cl}$, $\ce{-Br}$, $\ce{-I}$ | Weakly **deactivating** | *ortho*, *para* |
| Moderate deactivators | $\ce{-CHO}$, $\ce{-COR}$, $\ce{-COOR}$, $\ce{-COOH}$ | Deactivating | *meta* |
| Strong deactivators | $\ce{-NO2}$, $\ce{-CN}$, $\ce{-SO3H}$, $\ce{-CF3}$, $\ce{-NR3+}$ | Strongly deactivating | *meta* |

Halogens are the exception to remember: they withdraw electrons inductively (slowing the reaction) but donate a lone pair by resonance (directing *ortho*/*para*).

> **Friedel–Crafts fails** on rings bearing a moderate or strong deactivator, and on anilines (the $\ce{-NH2}$ group complexes with $\ce{AlCl3}$).

# 7. Practice problems

1. Predict the major product and mechanism: (*S*)-2-iodobutane with $\ce{NaN3}$ in DMSO.
2. Give reagents to convert 1-methylcyclohexene into (a) 1-methylcyclohexanol, (b) *trans*-2-methylcyclohexanol, (c) 1-bromo-1-methylcyclohexane, (d) 6-oxoheptanal.
3. Starting from acetylene and any alkyl halides, propose a synthesis of *cis*-3-hexene.
4. Which ketone and which Grignard reagent would you combine to make 2-phenyl-2-butanol? Give two different answers.
5. Predict the major product of nitrating (a) toluene, (b) nitrobenzene, (c) bromobenzene.
6. Explain why heating *tert*-butyl bromide in ethanol gives a mixture of an ether and an alkene, while treating it with KO*t*-Bu gives almost entirely alkene.

## Answers

1. S~N~2 with inversion: (*R*)-2-azidobutane.
2. (a) $\ce{H2O}$, $\ce{H2SO4}$ or 1. $\ce{Hg(OAc)2}$, $\ce{H2O}$; 2. $\ce{NaBH4}$. (b) 1. $\ce{BH3*THF}$; 2. $\ce{H2O2}$, $\ce{NaOH}$ (syn addition of H and OH places them *cis*, so OH and $\ce{CH3}$ end up *trans*). (c) HBr. (d) 1. $\ce{O3}$; 2. $\ce{(CH3)2S}$.
3. $\ce{HC#CH ->[1. NaNH2][2. CH3CH2Br] HC#CCH2CH3 ->[1. NaNH2][2. CH3CH2Br] CH3CH2C#CCH2CH3}$, then $\ce{H2}$, Lindlar catalyst.
4. Acetophenone ($\ce{C6H5COCH3}$) with $\ce{CH3CH2MgBr}$, or 2-butanone ($\ce{CH3COCH2CH3}$) with $\ce{C6H5MgBr}$, each followed by $\ce{H3O+}$ workup. (A third option: propiophenone with $\ce{CH3MgBr}$.)
5. (a) *ortho*- and *para*-nitrotoluene (*para* major for steric reasons). (b) 1,3-dinitrobenzene (*meta*), slowly. (c) *ortho*- and *para*-bromonitrobenzene, more slowly than benzene.
6. In ethanol (weak nucleophile, protic solvent), the tertiary carbocation forms and is captured by ethanol (S~N~1, giving *tert*-butyl ethyl ether) or loses a proton (E1, giving 2-methylpropene). KO*t*-Bu is a strong, bulky base that cannot act as a nucleophile at a hindered carbon, so concerted E2 dominates.
