"""Wnioskowanie o prawdzie z odpowiedzi wielu węzłów (Dawid-Skene, wariant „one-coin”).

Każdy węzeł/użytkownik ``j`` ma nieznaną trafność ``a_j``. Algorytm EM naprzemiennie:

1. liczy rozkład a posteriori prawdziwej odpowiedzi każdego pytania z ważonych głosów
   (waga = log-iloraz ``a_j (K-1) / (1 - a_j)``; kłamca z ``a_j < 1/K`` dostaje wagę
   ujemną, więc jego odpowiedzi *obniżają* wiarygodność tego, co wskazał),
2. aktualizuje ``a_j`` jako zgodność z konsensusem, z apriori Beta i wynikami na pytaniach
   kontrolnych (gold), które liczą się podwójnie.

Identyczny algorytm działa w przeglądarce (``web/src/myc/consensus.ts``); testy pilnują,
że oba dają te same wyniki na wspólnym przykładzie.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

PRIOR_A, PRIOR_B = 2.0, 1.0  # apriori trafności nowego węzła: średnio 0.67
OWNER_A, OWNER_B = 8.0, 1.0  # właściciel (zweryfikowany klucz): start z wagą ~0.89
GOLD_WEIGHT = 2.0
CLAMP = (0.02, 0.98)


@dataclass
class Answer:
    question_id: str
    node_id: str
    answer: str
    owner: bool = False  # odpowiedź z kluczem właściciela (zweryfikowanym w bazie)


@dataclass
class Consensus:
    posterior: dict[str, dict[str, float]] = field(default_factory=dict)  # pytanie -> opcja -> p
    trust: dict[str, float] = field(default_factory=dict)  # węzeł -> szacowana trafność
    agreement: dict[str, float] = field(default_factory=dict)  # węzeł -> zgodność z konsensusem
    answers_per_node: dict[str, int] = field(default_factory=dict)

    def truth(self, qid: str) -> tuple[str, float]:
        post = self.posterior[qid]
        best = max(post, key=post.__getitem__)
        return best, post[best]


def infer(
    answers: Iterable[Answer],
    options: Mapping[str, list[str]],
    gold_stats: Mapping[str, tuple[int, int]] | None = None,
    iters: int = 30,
    owners: set[str] | None = None,
) -> Consensus:
    """``options``: pytanie -> możliwe odpowiedzi; ``gold_stats``: węzeł -> (n, poprawne)."""
    gold_stats = gold_stats or {}
    answers = list(answers)
    owners = set(owners or ()) | {a.node_id for a in answers if a.owner}

    def prior(n: str) -> tuple[float, float]:
        return (OWNER_A, OWNER_B) if n in owners else (PRIOR_A, PRIOR_B)

    by_q: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for a in answers:
        if a.question_id in options and a.answer in options[a.question_id]:
            by_q[a.question_id].append((a.node_id, a.answer))
    nodes = sorted({n for votes in by_q.values() for n, _ in votes} | set(gold_stats))
    n_ans = {n: 0 for n in nodes}
    for votes in by_q.values():
        for n, _ in votes:
            n_ans[n] += 1

    def gold(n: str) -> tuple[float, float]:
        g_n, g_c = gold_stats.get(n, (0, 0))
        return GOLD_WEIGHT * g_c, GOLD_WEIGHT * g_n

    acc = {}
    for n in nodes:
        gc, gn = gold(n)
        pa, pb = prior(n)
        acc[n] = min(max((pa + gc) / (pa + pb + gn), CLAMP[0]), CLAMP[1])

    post: dict[str, dict[str, float]] = {}
    for _ in range(iters):
        for q, votes in by_q.items():
            opts = options[q]
            k = len(opts)
            logp = dict.fromkeys(opts, 0.0)
            for n, ans in votes:
                a = acc[n]
                wrong = math.log((1 - a) / (k - 1))
                for o in opts:
                    logp[o] += math.log(a) if o == ans else wrong
            m = max(logp.values())
            z = sum(math.exp(v - m) for v in logp.values())
            post[q] = {o: math.exp(v - m) / z for o, v in logp.items()}
        soft = dict.fromkeys(nodes, 0.0)
        for q, votes in by_q.items():
            for n, ans in votes:
                soft[n] += post[q][ans]
        new = {}
        for n in nodes:
            gc, gn = gold(n)
            pa, pb = prior(n)
            new[n] = min(max((pa + gc + soft[n]) / (pa + pb + gn + n_ans[n]), CLAMP[0]), CLAMP[1])
        delta = max((abs(new[n] - acc[n]) for n in nodes), default=0.0)
        acc = new
        if delta < 1e-6:
            break

    agreement = {}
    for n in nodes:
        hits = [
            1.0 if max(post[q], key=post[q].__getitem__) == ans else 0.0
            for q, votes in by_q.items()
            for m, ans in votes
            if m == n
        ]
        agreement[n] = sum(hits) / len(hits) if hits else 0.0
    return Consensus(posterior=post, trust=acc, agreement=agreement, answers_per_node=n_ans)
