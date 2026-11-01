"""Bitcoin Puzzle #71 – wyszukiwanie klucza w zakresie 2^70..2^71-1 (docs/puzzle71.md).

Publiczna zagadka z 2015 r. (twórca celowo dał klucze w znanych zakresach, żeby mierzyć moc łamania). Ten moduł:
- `core`: hash160 z klucza (secp256k1 → klucz skompresowany → SHA-256 → RIPEMD-160), skan zakresu (C przez ctypes,
  inaczej czysty Python), zgodność z rozwiązanymi zagadkami #20–#30 (testy),
- `seal`: szyfrowanie znalezionego klucza do klucza publicznego właściciela (X25519 + HKDF + ChaCha20-Poly1305),
- `worker`: praca węzła (≈10 % mocy, niski priorytet, za zgodą) i koordynacja zakresów przez Supabase.
"""

TARGET_ADDRESS = "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU"
TARGET_H160 = "f6f5431d25bbf7b12e8add9af5e3475c44a0a5b8"
RANGE_LO = 1 << 70
RANGE_HI = (1 << 71) - 1
CHUNK_BITS = 32  # zakres jednej paczki: 2^32 kluczy (≈ 1 h przy 1,2 mln kluczy/s)
