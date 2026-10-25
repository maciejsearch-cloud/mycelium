"""Rozbiór zdania (warstwa rozumienia grzybni): części mowy, morfologia, części zdania, role przypadków, zdania składowe.

- conllu.py – czytnik CoNLL-U (Universal Dependencies),
- analiza.py – reguły: drzewo zależności UD → części zdania, role (KTO? CO? KOMU? …), zdania składowe, ramy orzeczeń,
- miary.py – UPOS / cechy / UAS / LAS / role-F1 / części zdania,
- model.py – mały tagger + parser (numpy: przejście w przód; ten sam algorytm w web/src/myc/rozbior.ts),
- pytania.py – generator pytań z ramy z odpowiedziami sprawdzanymi automatycznie.
"""
