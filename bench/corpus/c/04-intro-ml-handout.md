# Introduction to Machine Learning

**CS 3410 · Lecture 1 Handout**
*Covers slides 1 to 38. Bring this to the Thursday lab.*

---

## 1. What is machine learning?

A program **learns** from experience $E$ with respect to a task $T$ and performance measure $P$ if its performance on $T$, as measured by $P$, improves with $E$ (Mitchell, 1997).

Example: a spam filter.

- **Task $T$:** classify each email as spam or not spam
- **Experience $E$:** a set of emails labeled by users
- **Performance $P$:** fraction of new emails classified correctly

The key shift from ordinary programming: instead of writing the rules, we write a program that *finds* the rules from examples.

| Traditional programming | Machine learning |
|---|---|
| Input: data + rules | Input: data + desired outputs |
| Output: answers | Output: rules (a model) |
| Rules are hand-written | Rules are fit to data |
| Works when we can state the rules | Works when we have examples but cannot state the rules |

## 2. Kinds of learning

| Type | Training data | Goal | Examples |
|---|---|---|---|
| Supervised | Pairs $(x_i, y_i)$ | Predict $y$ for a new $x$ | House prices, image labels, spam |
| Unsupervised | Only $x_i$ | Find structure | Customer segments, anomaly detection |
| Reinforcement | Rewards from actions | Choose actions that maximize reward | Games, robotics, ad placement |
| Self-supervised | Unlabeled data with labels made from the data itself | Learn useful representations | Language models predicting the next word |

Within supervised learning:

- **Regression:** $y$ is a number (price, temperature).
- **Classification:** $y$ is a category (spam/not spam, digit 0 to 9).

## 3. The supervised learning setup

We have a training set of $n$ examples

$$\mathcal{D} = \{(x_1, y_1), (x_2, y_2), \dots, (x_n, y_n)\}, \qquad x_i \in \mathbb{R}^d.$$

We pick a **model** $f_\theta$ with parameters $\theta$, and a **loss function** $\ell(\hat y, y)$ that says how bad a prediction is. Training means finding parameters that minimize the average loss on the training data (the *empirical risk*):

$$\hat\theta = \arg\min_\theta \; \frac{1}{n}\sum_{i=1}^{n} \ell\big(f_\theta(x_i),\, y_i\big).$$

What we actually care about is performance on *new* data drawn from the same distribution, which we can only estimate.

## 4. Linear regression

The simplest model predicts $y$ as a weighted sum of the features:

$$\hat y = f_\theta(x) = w^\top x + b = w_1 x_1 + w_2 x_2 + \dots + w_d x_d + b.$$

With the **mean squared error** loss,

$$J(w, b) = \frac{1}{n}\sum_{i=1}^{n}\big(w^\top x_i + b - y_i\big)^2.$$

If we stack the inputs into a matrix $X \in \mathbb{R}^{n \times d}$ (with a column of ones absorbing $b$), the minimizer has a closed form, the **normal equations**:

$$\hat w = (X^\top X)^{-1} X^\top y.$$

This is fine for small $d$, but inverting $X^\top X$ costs $O(d^3)$, so for large problems we use gradient descent instead.

## 5. Gradient descent

Start from some initial $\theta$ and repeatedly step downhill:

$$\theta \leftarrow \theta - \eta \, \nabla_\theta J(\theta),$$

where $\eta > 0$ is the **learning rate**. For linear regression with MSE,

$$\frac{\partial J}{\partial w} = \frac{2}{n}\sum_{i=1}^{n}\big(w^\top x_i + b - y_i\big)\,x_i, \qquad \frac{\partial J}{\partial b} = \frac{2}{n}\sum_{i=1}^{n}\big(w^\top x_i + b - y_i\big).$$

Choosing $\eta$:

- **Too small:** training is slow.
- **Too large:** the loss oscillates or diverges.
- **In practice:** try values on a log scale (0.1, 0.01, 0.001) and plot the loss curve.

**Stochastic gradient descent (SGD)** estimates the gradient from a small random *mini-batch* of examples instead of all $n$. Each step is noisier but far cheaper, and this is how nearly all large models are trained.

## 6. Classification with logistic regression

For a binary label $y \in \{0, 1\}$ we want a probability, so we squash the linear score through the **sigmoid**:

$$\sigma(z) = \frac{1}{1 + e^{-z}}, \qquad P(y = 1 \mid x) = \sigma(w^\top x + b).$$

The matching loss is **cross-entropy** (also called log loss):

$$J(w,b) = -\frac{1}{n}\sum_{i=1}^{n}\Big[y_i \log \hat p_i + (1 - y_i)\log(1 - \hat p_i)\Big].$$

There is no closed form here, so we train with gradient descent. Conveniently, the gradient has the same shape as in linear regression: $\nabla_w J = \frac{1}{n}\sum_i (\hat p_i - y_i)\,x_i$.

## 7. Overfitting and generalization

A model that is too simple **underfits**: it misses real patterns and does badly on both training and test data. A model that is too flexible **overfits**: it memorizes noise in the training set and does badly on new data.

| | Training error | Test error | Fix |
|---|---|---|---|
| Underfitting | High | High | More features, more flexible model, train longer |
| Good fit | Low | Low (close to training) | Ship it |
| Overfitting | Very low | High | More data, regularization, simpler model, early stopping |

For squared error, the expected test error at a point splits into three parts:

$$\mathbb{E}\big[(y - \hat f(x))^2\big] = \underbrace{\big(\mathbb{E}[\hat f(x)] - f(x)\big)^2}_{\text{bias}^2} + \underbrace{\operatorname{Var}\big[\hat f(x)\big]}_{\text{variance}} + \underbrace{\sigma^2}_{\text{noise}}.$$

Simple models have high bias and low variance; flexible models the reverse. The noise term is a floor no model can beat.

### Regularization

Add a penalty on large weights to the loss. **Ridge** (L2) regression:

$$J_\lambda(w) = \frac{1}{n}\sum_{i=1}^{n}\big(w^\top x_i - y_i\big)^2 + \lambda \lVert w \rVert_2^2.$$

**Lasso** uses $\lambda \lVert w \rVert_1$ instead and tends to set some weights exactly to zero, which doubles as feature selection. Larger $\lambda$ means a simpler model.

## 8. Evaluating a model

**Never evaluate on the data you trained on.** The standard split:

| Split | Typical share | Used for |
|---|---|---|
| Training set | 60 to 80% | Fitting parameters |
| Validation set | 10 to 20% | Choosing hyperparameters ($\lambda$, $\eta$, model type) |
| Test set | 10 to 20% | One final, honest estimate. Touch it once. |

With little data, use **$k$-fold cross-validation**: split the data into $k$ parts, train on $k-1$ and validate on the remaining one, rotate, and average the $k$ scores.

### Classification metrics

The **confusion matrix** for a binary classifier:

| | Predicted positive | Predicted negative |
|---|---|---|
| **Actually positive** | True positive (TP) | False negative (FN) |
| **Actually negative** | False positive (FP) | True negative (TN) |

$$\text{Accuracy} = \frac{TP + TN}{TP + TN + FP + FN}, \qquad
\text{Precision} = \frac{TP}{TP + FP}, \qquad
\text{Recall} = \frac{TP}{TP + FN},$$

$$F_1 = 2\cdot\frac{\text{Precision}\cdot\text{Recall}}{\text{Precision} + \text{Recall}}.$$

Accuracy misleads on imbalanced data. If 1% of transactions are fraud, a model that always says "not fraud" is 99% accurate and completely useless. Look at precision and recall instead.

## 9. A first model in code

```python
from sklearn.datasets import load_breast_cancer
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report

X, y = load_breast_cancer(return_X_y=True)
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y)

scaler = StandardScaler().fit(X_train)      # fit on training data only!
model = LogisticRegression(C=1.0, max_iter=1000)
model.fit(scaler.transform(X_train), y_train)

y_pred = model.predict(scaler.transform(X_test))
print(classification_report(y_test, y_pred))
```

Note that the scaler is fit on the training set only. Fitting it on all the data leaks information about the test set into training, a mistake called **data leakage**.

## 10. The ML workflow

1. Define the problem and the metric that matters.
2. Collect and clean data; look at it.
3. Split into train / validation / test.
4. Start with a simple baseline (mean prediction, logistic regression).
5. Iterate: features, models, hyperparameters, judged on the validation set.
6. Evaluate once on the test set.
7. Deploy, monitor, and retrain when the data drift.

## Key terms

**Feature:** an input variable. **Label:** the output we want to predict. **Parameter:** learned from data ($w$, $b$). **Hyperparameter:** set by us before training ($\eta$, $\lambda$, $k$). **Loss:** penalty for a single prediction. **Generalization:** performance on unseen data.

## For next time

- Read Chapter 2 of *An Introduction to Statistical Learning* (James et al.).
- Lab 1: implement gradient descent for linear regression in NumPy, then compare your weights to `np.linalg.lstsq`.
- Think about: why might a model with 100% training accuracy be a bad sign?
