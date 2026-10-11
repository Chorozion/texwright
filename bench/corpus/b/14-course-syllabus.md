---
title: "STAT 2050: Introduction to Data Science"
subtitle: "Course Syllabus, Spring 2027"
author: "Department of Statistics, Lakeshore State University"
---

## Course information

| | |
|---|---|
| **Credits** | 4 (3 lecture hours, 1 lab hour per week) |
| **Lectures** | Tuesday and Thursday, 10:30 to 11:45 a.m., Hamill Hall 120 |
| **Labs** | Section L1: Wednesday 1:00 to 1:50 p.m.; Section L2: Wednesday 3:00 to 3:50 p.m.; both in Science Library 214 |
| **Instructor** | Dr. Naomi Achterberg, naomi.achterberg@lakeshore.example.edu |
| **Office hours** | Tuesday 1:00 to 2:30 p.m. (Hamill 318) and Thursday 3:00 to 4:00 p.m. (Zoom, link on Canvas), or by appointment |
| **Teaching assistants** | Luis Ferreira (L1) and Grace Mensah (L2); office hours posted on Canvas |
| **Course website** | Canvas, for announcements, materials, submissions, and grades |
| **Discussion forum** | Ed Discussion, linked from Canvas |

## Course description

Data science combines statistical thinking, computing, and domain knowledge to learn from data. This course introduces the full cycle of a data analysis: formulating a question, importing and cleaning data, exploring it visually, building and evaluating simple models, and communicating results honestly. You will work in Python with Jupyter notebooks, pandas, and Matplotlib, and you will complete a team project on a real data set of your choosing. No prior programming experience is required, but you should be comfortable with algebra and willing to practice coding every week.

**Prerequisites:** MATH 1100 (College Algebra) or placement into MATH 1500. STAT 1010 is recommended but not required.

## Learning outcomes

By the end of the course, you will be able to:

1. Write Python code to import, clean, reshape, and summarize tabular data.
2. Choose and produce appropriate visualizations, and critique misleading ones.
3. Describe distributions and relationships using summary statistics, and explain their limitations.
4. Use simulation and resampling (bootstrap, permutation tests) to quantify uncertainty.
5. Fit and interpret linear and logistic regression models, and evaluate them on held-out data.
6. Identify sources of bias in data collection and discuss the ethical implications of an analysis.
7. Communicate a reproducible analysis to a non-technical audience in writing and orally.

## Materials

- **Textbook (free online):** Adhikari, A., DeNero, J., and Wagner, D. *Computational and Inferential Thinking: The Foundations of Data Science*, 2nd edition. Available at inferentialthinking.com.
- **Supplementary text:** VanderPlas, J. *Python Data Science Handbook*, 2nd edition, O'Reilly, 2023. Selected chapters are on library reserve.
- **Software:** All coding is done on the university JupyterHub (jupyter.lakeshore.example.edu); nothing needs to be installed. If you prefer to work locally, install Python 3.12 through Anaconda and see the setup guide on Canvas.
- **Hardware:** A laptop for lab sessions. Loaner laptops are available from the Science Library for the full semester.

## Assessment

| Component | Weight | Notes |
|---|---:|---|
| Weekly lab notebooks | 15% | 12 labs; lowest 2 scores dropped |
| Homework assignments | 20% | 6 assignments, about every two weeks |
| Reading quizzes | 5% | Short Canvas quizzes before Tuesday lectures; lowest 3 dropped |
| Midterm exam | 20% | In class, Thursday of week 8 |
| Final project | 25% | Team of 3 to 4; proposal, check-in, report, and presentation |
| Final exam | 15% | Cumulative, during the scheduled exam period |

**Final project breakdown.** The 25% for the project is divided as follows: proposal 3%, data check-in 4%, written report 12%, presentation 4%, and peer evaluation 2%. Individual project grades may be adjusted up or down based on peer evaluations and the commit history of the team repository.

**Exam replacement.** If your final exam score is higher than your midterm score, the final exam replaces the midterm, so the final counts for 35%. This rewards improvement, which is the goal of the course.

### Grading scale

Letter grades are assigned using the following minimum percentages. The cutoffs will not be raised, though they may be lowered at the instructor's discretion.

| Grade | Minimum | Grade | Minimum | Grade | Minimum |
|:-----:|:-------:|:-----:|:-------:|:-----:|:-------:|
| A  | 93% | B− | 80% | D+ | 67% |
| A− | 90% | C+ | 77% | D  | 63% |
| B+ | 87% | C  | 73% | D− | 60% |
| B  | 83% | C− | 70% | F  | below 60% |

## Course schedule

The schedule may change; changes will be announced in class and on Canvas at least one week in advance. Readings refer to chapters of *Computational and Inferential Thinking* (CIT) unless noted.

| Week | Dates | Topics | Reading | Due |
|:---:|---|---|---|---|
| 1 | Jan 12, 14 | What is data science? Jupyter and Python basics | CIT 1, 3 | Lab 1 |
| 2 | Jan 19, 21 | Data types, arrays, tables with pandas | CIT 4, 5 | Lab 2 |
| 3 | Jan 26, 28 | Selecting, filtering, sorting; tidy data | CIT 6; VanderPlas 3.1–3.4 | HW 1, Lab 3 |
| 4 | Feb 2, 4 | Visualization: distributions and relationships | CIT 7 | Lab 4 |
| 5 | Feb 9, 11 | Functions, grouping, joining tables | CIT 8 | HW 2, Lab 5 |
| 6 | Feb 16, 18 | Randomness and simulation | CIT 9 | Lab 6 |
| 7 | Feb 23, 25 | Sampling, sampling distributions | CIT 10 | HW 3, project teams formed |
| 8 | Mar 2, 4 | Review (Tuesday); **midterm exam (Thursday)** | | |
| | Mar 9, 11 | *Spring break, no classes* | | |
| 9 | Mar 16, 18 | Hypothesis testing and permutation tests | CIT 11, 12 | Lab 7, project proposal |
| 10 | Mar 23, 25 | Bootstrap and confidence intervals | CIT 13 | HW 4, Lab 8 |
| 11 | Mar 30, Apr 1 | Correlation and simple linear regression | CIT 15 | Lab 9 |
| 12 | Apr 6, 8 | Multiple regression; train/test splits | CIT 16; VanderPlas 5.1–5.3 | HW 5, project check-in |
| 13 | Apr 13, 15 | Classification: logistic regression, confusion matrices | CIT 17 | Lab 10 |
| 14 | Apr 20, 22 | Data ethics: privacy, bias, and fairness | Readings on Canvas | HW 6, Lab 11 |
| 15 | Apr 27, 29 | Project presentations | | Lab 12, presentations |
| Finals | May 6 | **Final exam**, 10:30 a.m. to 12:30 p.m. | | Project report due May 4 |

## Course policies

### Attendance and participation

Attendance at lectures is not graded, but lectures include worked examples and short exercises that appear on exams. Lab attendance is expected because labs are completed and submitted during the session. If you must miss a lab, you may complete it on your own and submit it by Friday at 11:59 p.m. for full credit; the two dropped lab scores cover longer absences.

### Late work

Homework is due at 11:59 p.m. on the listed date. Each student has **four late days** for the semester, which can be applied to homework (not labs, quizzes, or project deadlines) in whole-day units without asking. After your late days are used, late homework loses 10% per day and is not accepted more than three days late. Extensions beyond this for illness, family emergencies, or university-sanctioned events are granted when you contact me before the deadline whenever possible.

### Collaboration and academic integrity

You are encouraged to discuss labs and homework with classmates, the TAs, and me. However, the code and writing you submit must be your own. A useful rule: you may talk about approaches, but do not share or copy code, and do not look at another student's solution. List everyone you worked with at the top of each assignment. Exams are individual.

Suspected violations of the Lakeshore State University Academic Integrity Policy will be reported to the Office of Student Conduct, as the policy requires. Penalties range from a zero on the assignment to failure of the course.

### Use of generative AI tools

AI coding assistants and chatbots can be useful in data science, and learning to use them well is part of modern practice. In this course:

- **Allowed:** using AI tools to explain error messages, look up syntax, or explain a concept, much as you would use documentation or a search engine.
- **Allowed with disclosure:** using AI tools to generate or revise code for the final project. Add a short note in your report describing which tool you used and for what.
- **Not allowed:** submitting AI-generated answers to homework, quizzes, or labs, or using AI tools during exams.

You are responsible for every line you submit. If you cannot explain your code during office hours or a check-in, it will not receive credit.

### Accessibility

Lakeshore State University is committed to providing equal access to learning. If you have a disability and need accommodations, please register with Accessibility Resources (Student Center 140, 555-0136) and send me your accommodation letter as early as possible. Exam accommodations require one week's notice to arrange with the testing center. I am also glad to discuss any other circumstances that affect your learning.

### Basic needs and well-being

If you are having difficulty affording food or housing, or if stress is affecting your work, you are not alone and support is available. The Student Resource Center (Student Center 210) runs the campus food pantry and emergency grants, and Counseling Services offers free, confidential appointments (555-0150, or 988 for crisis support at any hour). Please let me know if I can help connect you with these resources.

### Communication

Post questions about course content on Ed Discussion so that everyone benefits from the answer; you may post anonymously to classmates. Use email for personal matters, and include "STAT 2050" in the subject line. I respond to messages within one business day.

---

*This syllabus is a guide, not a contract. Any changes will be announced in class and posted on Canvas.*
