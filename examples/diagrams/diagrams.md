---
title: Diagrams in texwright
subtitle: Mermaid and TikZ, drawn without a browser or a TeX install
number-sections: true
---

# Mermaid

Every diagram on this page comes from a fenced block of text. @fig:pipeline is a flowchart with subgraphs, @fig:plan a gantt chart, and @fig:login a sequence diagram.

```{.mermaid #fig:pipeline caption="A build pipeline."}
flowchart LR
  src[Source] --> parse[Parse]
  subgraph engine [Engine]
    parse --> number[Number] --> layout[Lay out]
  end
  layout --> pdf([PDF]) & html([HTML])
  layout -.->|diagnostics| agent{{Agent}}
```

```{.mermaid #fig:plan caption="The release plan."}
gantt
  dateFormat YYYY-MM-DD
  section Engine
    Parser          :done, p1, 2026-09-01, 10d
    Layout          :active, p2, after p1, 14d
  section Release
    Documentation   :p3, after p2, 7d
    Launch          :milestone, after p3, 0d
```

```{.mermaid #fig:login caption="Signing in."}
sequenceDiagram
  actor User
  participant App
  participant Auth
  User->>App: Open the dashboard
  App->>Auth: Check the session
  alt session valid
    Auth-->>App: OK
    App-->>User: Dashboard
  else expired
    Auth-->>App: 401
    App-->>User: Sign-in page
  end
```

```{.mermaid #fig:usage caption="Pages rendered per day."}
xychart-beta
  x-axis [Mon, Tue, Wed, Thu, Fri]
  y-axis "Pages" 0 --> 1200
  bar [420, 610, 780, 940, 1130]
  line [420, 610, 780, 940, 1130]
```

# TikZ and pgfplots

TikZ pictures are drawn by texwright's own interpreter, and their labels use the document's math. @fig:fit is a pgfplots axis.

```{.tikz #fig:fit caption="A least-squares fit."}
\begin{tikzpicture}
\begin{axis}[width=9cm, height=6cm, xlabel={$x$}, ylabel={$y$}, legend pos=north west, grid=major]
  \addplot[only marks, mark=*] coordinates {(0,1.1) (1,2.9) (2,5.2) (3,6.8) (4,9.1) (5,11.0)};
  \addlegendentry{measured}
  \addplot[domain=0:5, thick] {1.0 + 2.0*x};
  \addlegendentry{$y = 1 + 2x$}
\end{axis}
\end{tikzpicture}
```
