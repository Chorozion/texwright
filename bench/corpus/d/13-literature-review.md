---
title: "Spacing, Retrieval and Durable Learning"
subtitle: "A narrative review of distributed practice and retrieval practice, 1885–2021"
author:
  - name: Jordan Avery
    affiliation: Department of Educational Psychology
date: October 2026
abstract: |
  Two learning techniques have unusually strong empirical support: spreading
  study over time (distributed practice, or *spacing*) and actively recalling
  information rather than re-reading it (retrieval practice, or the *testing
  effect*). This review traces both from their origins in nineteenth-century
  memory research to recent classroom meta-analyses. We summarise what is
  known about the size and reliability of each effect, how they interact,
  why learners tend not to use them, and how computational scheduling
  systems try to exploit them. We close with the boundary conditions that
  remain poorly understood and with practical recommendations for
  instructors.
keywords: [spacing effect, retrieval practice, testing effect, interleaving, spaced repetition]
bibliography: 13-references.bib
link-citations: true
reference-section-title: References
numbersections: true
geometry: margin=1in
fontsize: 11pt
linestretch: 1.2
---

# Introduction

Most students study by re-reading their notes shortly before an exam
[@dunlosky2013]. This strategy feels productive, produces passable short-term
results, and is close to the least efficient way to build knowledge that
lasts. Over a century of laboratory research and several decades of classroom
studies point instead to two simple changes: spread study sessions out, and
spend those sessions recalling material rather than reviewing it.

Both findings are old. Ebbinghaus reported the benefit of distributed
repetitions in 1885 [@ebbinghaus1913], and the advantage of recitation over
re-reading was documented in the early twentieth century. What has changed
since the early 2000s is the scale and quality of the evidence: large
quantitative syntheses [@cepeda2006; @rowland2014; @adesope2017], careful
studies of long retention intervals [@cepeda2008; @bahrick1993], and a
growing body of research conducted in real classrooms with real course
material [@agarwal2021; @yang2021].

This review is organised as follows. Section 2 describes the scope of the
literature covered. Sections 3 and 4 review the spacing effect and the
retrieval practice effect separately. Section 5 considers their combination,
including the question of how retrieval sessions should be scheduled.
Section 6 discusses interleaving, a related technique, and Section 7 the
metacognitive reasons learners avoid these strategies. Section 8 reviews
algorithmic scheduling. Section 9 sets out open questions, and Section 10
draws practical implications.

# Scope of the review

This is a narrative rather than systematic review. We focused on (a) the
foundational experimental papers, (b) all major meta-analyses published
between 2006 and 2021, and (c) classroom studies with retention intervals of
at least one week. We did not attempt to cover the neuroscience of memory
consolidation, the large literature on motor-skill learning, or the
spacing of practice in sport.

Effect sizes are reported as Hedges' $g$ where available. As a rough guide, a
$g$ of 0.5 means the average student in the treatment condition scored higher
than about 69% of students in the comparison condition.[^cohen]

[^cohen]: This interpretation assumes normal distributions with equal
    variances, so that the proportion is $\Phi(g)$. For $g = 0.5$,
    $\Phi(0.5) \approx 0.69$.

# The spacing effect

## Origins and laboratory evidence

Ebbinghaus [-@ebbinghaus1913], learning lists of nonsense syllables on
himself, found that spreading repetitions over several days required fewer
total repetitions to reach a criterion than massing them on one day. His
forgetting curve has been replicated with modern methods [@murre2015], and
the spacing effect itself has since been demonstrated with words, facts,
foreign-language vocabulary, text passages, mathematics and motor skills,
in learners from young children to older adults [@carpenter2012; @kang2016].

The most comprehensive quantitative synthesis remains that of
@cepeda2006, who analysed 839 assessments of distributed practice drawn
from 317 experiments in 184 articles. Spaced study outperformed massed study
across nearly all conditions. Crucially, they also found that the *optimal*
gap between study sessions depends on how long the material must be
remembered: longer retention intervals call for longer gaps.

## The temporal ridgeline

@cepeda2008 tested this relationship directly in a large online study in
which more than 1,350 participants learned obscure trivia facts, restudied
them after a gap of up to 3.5 months, and were tested after a retention
interval of up to one year. For each retention interval, recall first rose
and then slowly fell as the gap increased, tracing what the authors called a
"temporal ridgeline." The optimal gap was roughly 20–40% of the retention
interval when the test came one week later, falling to about 5–10% when the
test came one year later. Gaps that were too long cost relatively little,
whereas gaps that were too short cost a great deal.

The longest-term evidence comes from @bahrick1993, a nine-year study in which
four members of one family learned foreign-language vocabulary with sessions
spaced 14, 28 or 56 days apart. Retention five years after training was
best with the 56-day spacing, even when that schedule involved fewer total
sessions. The design is small and the participants were unusually motivated
(they were the authors), but the result has been influential precisely
because so few studies follow learners for years.

## Why spacing works

Several mechanisms have been proposed and they are not mutually exclusive.
Encoding-variability accounts hold that spaced presentations occur in more
varied contexts, providing more retrieval routes. Deficient-processing
accounts hold that massed repetitions receive less attention because the
item still feels familiar. Study-phase retrieval accounts hold that a
spaced repetition prompts the learner to retrieve the earlier presentation,
and that this retrieval strengthens memory [@carpenter2012]. The last
explanation links spacing directly to the testing effect discussed next,
and helps explain why the two combine so well.

# Retrieval practice

## The testing effect

Taking a test is not just a way of measuring learning; it changes what is
learned. In a widely cited demonstration, @roediger2006 had students read
short prose passages and then either reread them or take a free-recall test
without feedback. On a test five minutes later, rereading produced slightly
better recall. One week later the pattern reversed: students who had been
tested recalled 56% of the idea units, compared with 42% for those who had
reread.

@karpicke2008 showed that retrieval, not additional study, drives the
benefit. Students learned 40 Swahili–English word pairs. Once a pair had been
recalled correctly, it was either still studied and tested on later trials,
or dropped from further study, testing, or both. Dropping items from further
*study* had no effect on recall a week later. Dropping items from further
*testing* reduced recall from roughly 80% to about 35%. Students' own
predictions of their performance did not differ across conditions, a point
we return to in Section 7.

Retrieval practice also compares well against strategies that feel more
sophisticated. @karpicke2011 found that practising free recall of a science
text produced better performance on a one-week test than building a concept
map with the text available, including on questions that required inference
rather than verbatim recall.

## Meta-analytic evidence

Table 1 summarises the main meta-analyses. Their estimates converge on a
moderate effect, with $g$ around 0.5 for testing against restudy and larger
effects when retrieval sessions are themselves spaced.

Table: Meta-analyses of retrieval practice, spacing and interleaving.
Effect sizes are pooled Hedges' $g$ for the main comparison.

| Study | Comparison | Pooled effect |
|:------|:-----------|:--------------|
| @cepeda2006 | Spaced vs. massed study (verbal recall) | Benefit in nearly all conditions; reported as recall differences |
| @rowland2014 | Testing vs. restudy | $g = 0.50$ |
| @adesope2017 | Practice tests vs. all other conditions | $g = 0.61$ |
| @brunmair2019 | Interleaved vs. blocked practice | $g = 0.42$, strongly moderated by material |
| @latimier2021 | Spaced vs. massed retrieval practice | $g = 0.74$ |
| @yang2021 | Classroom quizzing vs. no quizzing or restudy | $g \approx 0.50$ |

@rowland2014 identified two moderators of particular practical interest. The
testing effect was larger when initial retrieval was more effortful (for
example, free recall rather than recognition) and when the test was followed
by feedback. @adesope2017 found benefits for both multiple-choice and
short-answer practice tests, and across a wide range of ages and settings.

## Evidence from classrooms

Laboratory effects do not always survive contact with real courses, where
the material is complex, the students have other demands on their time, and
exams test more than recall. Two recent syntheses are therefore especially
important. @agarwal2021 reviewed 50 classroom experiments and found that
retrieval practice improved performance in 57% of reported comparisons with a
medium or large effect, with only a small number showing no benefit or a
disadvantage. @yang2021, pooling a larger set of studies, estimated a
classroom effect of about half a standard deviation, which was robust across
subject areas, education levels and test formats, and which transferred, to a
lesser degree, to questions not practised during quizzing.

# Combining spacing and retrieval

## Expanding versus uniform schedules

If retrieval should be spaced, how should the gaps be arranged? An
influential proposal by @landauer1978 was the *expanding* schedule: test an
item soon after learning, while retrieval is still likely to succeed, and
then lengthen the gap after each successful retrieval. The idea underlies
most flashcard schedules.

The evidence for expansion over equal spacing is weaker than its popularity
suggests. @karpicke2007 found that expanding schedules helped on an
immediate test, but that equally spaced retrieval produced better retention
two days later. The key variable appeared to be the delay before the *first*
retrieval attempt: a longer first gap made the first retrieval harder and
more beneficial. @latimier2021 found no reliable difference between expanding
and uniform schedules in their meta-analysis, while confirming a large
advantage for spacing over massing.

## Successive relearning

@rawson2011 asked a different question: how many times should an item be
correctly recalled, and how many separate sessions are needed? Their answer
was that recalling an item correctly once per session, across three or more
sessions spread over days, gave far better long-term retention than reaching
a higher criterion within a single session. They named this approach
*successive relearning*. It combines both effects and is now one of the most
specific evidence-based study recommendations available [@dunlosky2013].

# Interleaving

Interleaving mixes different types of problems or categories within a study
session rather than practising one type at a time (blocking). It is related
to spacing, because interleaving necessarily spaces repetitions of each
type, but it also forces learners to decide *which* strategy or category
applies.

@kornell2008 showed that learners who studied paintings by different artists
interleaved were better at identifying the artist of new paintings than
learners who studied each artist's paintings in a block, even though most
participants believed blocking had helped them more. In mathematics,
@rohrer2007 found that shuffling practice problems across topics led to much
better performance on a delayed test, despite worse performance during
practice.

Interleaving is not universally beneficial. @brunmair2019 found an overall
advantage, but it depended strongly on the material: interleaving helped
most when categories were similar and hard to discriminate (such as
paintings by artists with related styles), and it was ineffective or harmful
for some verbal materials such as word lists and expository texts.

# Why learners avoid effective strategies

If spacing and retrieval work so well, why do so few students use them? A
central explanation is the distinction between performance during learning
and learning itself [@bjork1994; @bjork2011]. Massed and blocked practice
produce fast, fluent performance, which learners mistake for durable
learning. Spacing, retrieval and interleaving slow performance down and
produce more errors, so they feel less effective even when they are more
effective. Bjork called these *desirable difficulties*.

The evidence for this illusion is consistent. Students in @karpicke2008
predicted similar performance regardless of condition. In @kornell2008, a
majority of participants judged blocked study to be at least as effective as
interleaved study, after having performed better with interleaving. @kornell2009
found that 72% of participants believed massing flashcards had been more
effective than spacing them, while spacing was in fact superior for 90% of
participants. Survey data suggest that most students rely on rereading and
cramming, and that many who self-test do so mainly to check what they know,
not to learn [@dunlosky2013].

# Algorithmic scheduling

Flashcard software attempts to put the spacing and testing literature into
practice by scheduling reviews automatically. Early systems used fixed rules.
@pimsleur1967 proposed a graduated interval schedule for language learning in
which each gap is roughly five times the previous one (5 seconds, 25
seconds, 2 minutes, 10 minutes, and so on). The physical "Leitner box"
system moves cards to less frequently reviewed boxes after correct answers
and back to the first box after errors.

More recent work treats scheduling as a learning problem. @settles2016
introduced *half-life regression*, which models the probability of recalling
an item as an exponentially decaying function of time since the last
practice, $p = 2^{-\Delta/h}$, where the half-life $h$ is estimated from the
learner's history and features of the item. Trained on millions of practice
sessions from a commercial language-learning app, the model predicted recall
more accurately than the Pimsleur and Leitner heuristics, and deploying it
increased daily user engagement in a controlled experiment.

@tabibian2019 framed review scheduling as a stochastic optimal control
problem and derived an algorithm, *Memorize*, whose optimal review rate is
proportional to the current probability of forgetting. In a large natural
experiment using data from the same platform, learners whose review timing
happened to be close to the Memorize schedule showed better retention than
learners following uniform or threshold-based schedules.

These systems are promising, but the evidence base is mostly drawn from
vocabulary learning in commercial apps, where "learning" is measured as
recall of individual items. Whether the same algorithms help with
conceptual material that must be integrated and applied is largely untested.

# Open questions

Several important questions remain open.

1. **Complex and conceptual material.** Most studies use discrete facts,
   word pairs or short texts. Evidence is thinner for material that requires
   integration, such as solving novel physics problems or writing an
   argument, although classroom studies suggest the benefits extend
   to applied questions [@agarwal2021; @yang2021].
2. **Optimal spacing in practice.** The ridgeline of @cepeda2008 implies
   that the best gap depends on when the knowledge will be needed. In real
   courses, knowledge is needed at many future times (the next exam, the
   final, the next course, a career), so a single optimal gap may not
   exist.
3. **Individual differences.** Effects are generally robust across learners,
   but the role of prior knowledge, working memory and motivation in
   moderating them is not well characterised.
4. **Implementation fidelity.** Classroom interventions vary in how much
   feedback is given, whether quizzes count towards grades, and how much
   class time they take. These details probably matter and are inconsistently
   reported.
5. **Long-term transfer.** Very few studies follow learners for more than a
   semester; @bahrick1993 remains one of the only multi-year studies.

# Implications for instruction

The evidence supports a small number of concrete practices, consistent with
the recommendations of the U.S. Institute of Education Sciences practice
guide [@pashler2007] and later reviews [@dunlosky2013; @kang2016]:

- Build **cumulative, low-stakes quizzes** into courses, so that students
  retrieve earlier material repeatedly over the term. Provide feedback.
- **Revisit key material** after a delay of days to weeks rather than
  covering each topic once. Homework sets that mix new and old problems
  achieve both spacing and interleaving at little cost.
- Teach students **successive relearning** explicitly: recall each item
  correctly once per session, across at least three sessions on different
  days [@rawson2011].
- Tell students directly that effective strategies **feel harder** and less
  productive than rereading, and why. Without this, students tend to
  abandon them [@bjork2011].

# Conclusion

Few findings in educational psychology have as much support as the spacing
and testing effects. They have been replicated across more than a century,
across materials and populations, in the laboratory and in classrooms, with
moderate-to-large effect sizes. The main barrier to their use is not lack of
evidence but the persistent, and understandable, illusion that fluent
performance during study means learning has occurred. Closing the gap between
what is known and what students and instructors do is now the central
practical challenge for this literature.
