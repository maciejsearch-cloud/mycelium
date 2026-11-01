/* p71core.c – sequential secp256k1 key scan for Bitcoin Puzzle #71 (docs/puzzle71.md). MIT/GPL like the repo.
 *
 * For keys k .. k+n-1: P = k*G (affine), compressed pubkey (02/03 || x), SHA-256, RIPEMD-160, compare with the
 * target hash160. Consecutive points are made by affine addition P + j*G with ONE field inversion per batch of
 * B keys (Montgomery batch inversion). Also returns the XOR of all hash160 values of the range (honesty digest:
 * another node can recompute it; it cannot be produced without hashing every key).
 * Field arithmetic: 4x64-bit limbs, unsigned __int128, p = 2^256 - 2^32 - 977, always fully reduced.
 * Constant-time is NOT a goal (public search over public keys; no secret is processed until a hit).
 */
#include <stdint.h>
#include <string.h>

typedef unsigned __int128 u128;
typedef struct { uint64_t v[4]; } fe;           /* little-endian limbs */
typedef struct { fe x, y; } ge;                 /* affine point */

#define RC 0x1000003D1ULL                        /* 2^256 mod p */
static const fe FP = {{0xFFFFFFFEFFFFFC2FULL, ~0ULL, ~0ULL, ~0ULL}};
static const ge G = {{{0x59F2815B16F81798ULL, 0x029BFCDB2DCE28D9ULL, 0x55A06295CE870B07ULL, 0x79BE667EF9DCBBACULL}},
                     {{0x9C47D08FFB10D4B8ULL, 0xFD17B448A6855419ULL, 0x5DA4FBFC0E1108A8ULL, 0x483ADA7726A3C465ULL}}};

static int fe_ge_p(const uint64_t o[4]) { return o[3] == ~0ULL && o[2] == ~0ULL && o[1] == ~0ULL && o[0] >= FP.v[0]; }
static void fe_norm(uint64_t o[4]) {            /* o < 2^256 -> o mod p (o < 2p always here) */
    if (fe_ge_p(o)) { u128 c = (u128)o[0] + RC; o[0] = (uint64_t)c; c >>= 64;
        for (int i = 1; i < 4; i++) { c += o[i]; o[i] = (uint64_t)c; c >>= 64; } }
}
static void fe_add(fe *r, const fe *a, const fe *b) {
    u128 c = 0; uint64_t o[4];
    for (int i = 0; i < 4; i++) { c += (u128)a->v[i] + b->v[i]; o[i] = (uint64_t)c; c >>= 64; }
    if (c) { c = (u128)o[0] + RC; o[0] = (uint64_t)c; c >>= 64;
        for (int i = 1; i < 4; i++) { c += o[i]; o[i] = (uint64_t)c; c >>= 64; } }
    fe_norm(o); memcpy(r->v, o, 32);
}
static void fe_sub(fe *r, const fe *a, const fe *b) {
    uint64_t o[4]; unsigned borrow = 0;
    for (int i = 0; i < 4; i++) { u128 d = (u128)a->v[i] - b->v[i] - borrow; o[i] = (uint64_t)d; borrow = (unsigned)(d >> 127); }
    if (borrow) { /* add p == subtract RC modulo 2^256 */
        unsigned bw = 0; u128 d = (u128)o[0] - RC; o[0] = (uint64_t)d; bw = (unsigned)(d >> 127);
        for (int i = 1; i < 4; i++) { d = (u128)o[i] - bw; o[i] = (uint64_t)d; bw = (unsigned)(d >> 127); } }
    memcpy(r->v, o, 32);
}
static void fe_red512(fe *r, const uint64_t t[8]) {
    u128 c = 0; uint64_t o[4];
    for (int i = 0; i < 4; i++) { c += (u128)t[4 + i] * RC + t[i]; o[i] = (uint64_t)c; c >>= 64; }
    uint64_t hi = (uint64_t)c;
    c = (u128)hi * RC + o[0]; o[0] = (uint64_t)c; c >>= 64;
    for (int i = 1; i < 4; i++) { c += o[i]; o[i] = (uint64_t)c; c >>= 64; }
    if (c) { c = (u128)o[0] + RC; o[0] = (uint64_t)c; c >>= 64;
        for (int i = 1; i < 4; i++) { c += o[i]; o[i] = (uint64_t)c; c >>= 64; } }
    fe_norm(o); memcpy(r->v, o, 32);
}
static void fe_mul(fe *r, const fe *a, const fe *b) {
    uint64_t t[8] = {0};
    for (int i = 0; i < 4; i++) { u128 c = 0;
        for (int j = 0; j < 4; j++) { c += (u128)a->v[i] * b->v[j] + t[i + j]; t[i + j] = (uint64_t)c; c >>= 64; }
        t[i + 4] = (uint64_t)c; }
    fe_red512(r, t);
}
static void fe_inv(fe *r, const fe *a) {        /* a^(p-2), left-to-right binary */
    fe e = FP; e.v[0] -= 2; fe x = {{1, 0, 0, 0}};
    for (int i = 255; i >= 0; i--) { fe_mul(&x, &x, &x); if ((e.v[i >> 6] >> (i & 63)) & 1) fe_mul(&x, &x, a); }
    *r = x;
}
static int fe_eq(const fe *a, const fe *b) { return !memcmp(a->v, b->v, 32); }

/* affine add / double (inputs never at infinity, never equal-x unless doubling) */
static void ge_add(ge *r, const ge *a, const ge *b) {
    fe l, t, x3, y3; fe_sub(&t, &b->x, &a->x); fe_inv(&t, &t); fe_sub(&l, &b->y, &a->y); fe_mul(&l, &l, &t);
    fe_mul(&x3, &l, &l); fe_sub(&x3, &x3, &a->x); fe_sub(&x3, &x3, &b->x);
    fe_sub(&t, &a->x, &x3); fe_mul(&y3, &l, &t); fe_sub(&y3, &y3, &a->y); r->x = x3; r->y = y3;
}
static void ge_dbl(ge *r, const ge *a) {
    fe l, t, x3, y3; fe_mul(&l, &a->x, &a->x); fe_add(&t, &l, &l); fe_add(&l, &t, &l); /* 3x^2 */
    fe_add(&t, &a->y, &a->y); fe_inv(&t, &t); fe_mul(&l, &l, &t);
    fe_mul(&x3, &l, &l); fe_sub(&x3, &x3, &a->x); fe_sub(&x3, &x3, &a->x);
    fe_sub(&t, &a->x, &x3); fe_mul(&y3, &l, &t); fe_sub(&y3, &y3, &a->y); r->x = x3; r->y = y3;
}
/* k*G for 1 <= k < n (k little-endian limbs); slow path, once per call */
static void ge_mulG(ge *r, const uint64_t k[4]) {
    int started = 0; ge acc = G;
    for (int i = 255; i >= 0; i--) {
        if (started) ge_dbl(&acc, &acc);
        if ((k[i >> 6] >> (i & 63)) & 1) {
            if (!started) { acc = G; started = 1; }
            else if (fe_eq(&acc.x, &G.x)) ge_dbl(&acc, &acc); else ge_add(&acc, &acc, &G);
        }
    }
    *r = acc;
}

/* ---------------- SHA-256 (single block, 33-byte message) */
static const uint32_t K256[64] = {
 0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,
 0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
 0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
 0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
 0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,
 0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
 0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
static void sha256_33(const uint8_t m[33], uint8_t out[32]) {
    uint32_t w[64]; uint8_t blk[64] = {0}; memcpy(blk, m, 33); blk[33] = 0x80; blk[62] = 0x01; blk[63] = 0x08; /* 264 bits */
    for (int i = 0; i < 16; i++) w[i] = (uint32_t)blk[4*i] << 24 | (uint32_t)blk[4*i+1] << 16 | (uint32_t)blk[4*i+2] << 8 | blk[4*i+3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROR(w[i-15], 7) ^ ROR(w[i-15], 18) ^ (w[i-15] >> 3), s1 = ROR(w[i-2], 17) ^ ROR(w[i-2], 19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1; }
    uint32_t h[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = hh + (ROR(e,6) ^ ROR(e,11) ^ ROR(e,25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i];
        uint32_t t2 = (ROR(a,2) ^ ROR(a,13) ^ ROR(a,22)) + ((a & b) ^ (a & c) ^ (b & c));
        hh=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2; }
    h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
    for (int i = 0; i < 8; i++) { out[4*i] = h[i] >> 24; out[4*i+1] = h[i] >> 16; out[4*i+2] = h[i] >> 8; out[4*i+3] = h[i]; }
}

/* ---------------- RIPEMD-160 (single block, 32-byte message) */
#define ROL(x, n) (((x) << (n)) | ((x) >> (32 - (n))))
static const uint8_t RL[80] = {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15, 7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,
 3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12, 1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2, 4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13};
static const uint8_t RR[80] = {5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12, 6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,
 15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13, 8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14, 12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11};
static const uint8_t SL[80] = {11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8, 7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,
 11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5, 11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12, 9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6};
static const uint8_t SR[80] = {8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6, 9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,
 9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5, 15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8, 8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11};
static uint32_t rf(int j, uint32_t x, uint32_t y, uint32_t z) {
    switch (j >> 4) { case 0: return x ^ y ^ z; case 1: return (x & y) | (~x & z); case 2: return (x | ~y) ^ z;
        case 3: return (x & z) | (y & ~z); default: return x ^ (y | ~z); }
}
static const uint32_t KL[5] = {0x00000000,0x5A827999,0x6ED9EBA1,0x8F1BBCDC,0xA953FD4E};
static const uint32_t KR[5] = {0x50A28BE6,0x5C4DD124,0x6D703EF3,0x7A6D76E9,0x00000000};
static void rmd160_32(const uint8_t m[32], uint8_t out[20]) {
    uint32_t X[16]; uint8_t blk[64] = {0}; memcpy(blk, m, 32); blk[32] = 0x80; blk[56] = 0x00; blk[57] = 0x01; /* 256 bits LE */
    for (int i = 0; i < 16; i++) X[i] = blk[4*i] | (uint32_t)blk[4*i+1] << 8 | (uint32_t)blk[4*i+2] << 16 | (uint32_t)blk[4*i+3] << 24;
    uint32_t h[5] = {0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476,0xC3D2E1F0};
    uint32_t al=h[0],bl=h[1],cl=h[2],dl=h[3],el=h[4], ar=al,br=bl,cr=cl,dr=dl,er=el,t;
    for (int j = 0; j < 80; j++) {
        t = ROL(al + rf(j, bl, cl, dl) + X[RL[j]] + KL[j >> 4], SL[j]) + el; al = el; el = dl; dl = ROL(cl, 10); cl = bl; bl = t;
        t = ROL(ar + rf(79 - j, br, cr, dr) + X[RR[j]] + KR[j >> 4], SR[j]) + er; ar = er; er = dr; dr = ROL(cr, 10); cr = br; br = t;
    }
    t = h[1] + cl + dr; h[1] = h[2] + dl + er; h[2] = h[3] + el + ar; h[3] = h[4] + al + br; h[4] = h[0] + bl + cr; h[0] = t;
    for (int i = 0; i < 5; i++) { out[4*i] = h[i]; out[4*i+1] = h[i] >> 8; out[4*i+2] = h[i] >> 16; out[4*i+3] = h[i] >> 24; }
}

static void hash160_pt(const ge *p, uint8_t out[20]) {
    uint8_t pk[33], s[32]; pk[0] = 2 | (p->y.v[0] & 1);
    for (int i = 0; i < 4; i++) for (int b = 0; b < 8; b++) pk[1 + 8*i + b] = (uint8_t)(p->x.v[3 - i] >> (56 - 8*b));
    sha256_33(pk, s); rmd160_32(s, out);
}

/* exported helpers for tests */
void p71_hash160_of_key(const uint8_t kbe[32], uint8_t out[20]) {
    uint64_t k[4]; for (int i = 0; i < 4; i++) { k[i] = 0; for (int b = 0; b < 8; b++) k[i] |= (uint64_t)kbe[31 - 8*i - b] << (8*b); }
    ge p; ge_mulG(&p, k); hash160_pt(&p, out);
}
void p71_sha256_33(const uint8_t m[33], uint8_t out[32]) { sha256_33(m, out); }
void p71_rmd160_32(const uint8_t m[32], uint8_t out[20]) { rmd160_32(m, out); }

#define B 1024
/* Scan keys start..start+n-1 (start big-endian, must be > B and start+n < 2^255). Returns 1 on hit (key in out_key,
 * big-endian; scanning continues so the digest stays complete), 0 otherwise, -1 on bad input. xor_out = XOR of all
 * hash160 values in the range. */
int p71_scan(const uint8_t sbe[32], uint64_t n, const uint8_t target[20], uint8_t out_key[32], uint8_t xor_out[20]) {
    static ge T[B + 1]; static int init = 0;
    if (!init) { T[1] = G; ge_dbl(&T[2], &G); for (int j = 3; j <= B; j++) ge_add(&T[j], &T[j - 1], &G); init = 1; }
    uint64_t k[4]; for (int i = 0; i < 4; i++) { k[i] = 0; for (int b = 0; b < 8; b++) k[i] |= (uint64_t)sbe[31 - 8*i - b] << (8*b); }
    if (k[3] >> 62 || (k[3] == 0 && k[2] == 0 && k[1] == 0 && k[0] <= B + 1)) return -1;
    memset(xor_out, 0, 20);
    int hit = 0; ge P; ge_mulG(&P, k);
    static fe dx[B + 1], pre[B + 1];
    uint8_t h[20];
    uint64_t done = 0;
    while (done < n) {
        uint64_t m = n - done < B ? n - done : B;   /* keys hashed in this batch: P, P+G .. P+(m-1)G */
        for (int j = 1; j <= B; j++) fe_sub(&dx[j], &T[j].x, &P.x);
        pre[1] = dx[1]; for (int j = 2; j <= B; j++) fe_mul(&pre[j], &pre[j - 1], &dx[j]);
        fe inv; fe_inv(&inv, &pre[B]);
        /* walk back: inv(dx[j]) = inv * pre[j-1]; inv *= dx[j] */
        for (int j = B; j >= 1; j--) {
            fe ij; if (j > 1) fe_mul(&ij, &inv, &pre[j - 1]); else ij = inv;
            fe_mul(&inv, &inv, &dx[j]);
            dx[j] = ij;  /* now holds 1/dx[j] */
        }
        for (uint64_t j = 0; j < m; j++) {
            ge Q;
            if (j == 0) Q = P;
            else { fe l, t; fe_sub(&l, &T[j].y, &P.y); fe_mul(&l, &l, &dx[j]);
                fe_mul(&Q.x, &l, &l); fe_sub(&Q.x, &Q.x, &P.x); fe_sub(&Q.x, &Q.x, &T[j].x);
                fe_sub(&t, &P.x, &Q.x); fe_mul(&Q.y, &l, &t); fe_sub(&Q.y, &Q.y, &P.y); }
            hash160_pt(&Q, h);
            for (int b = 0; b < 20; b++) xor_out[b] ^= h[b];
            if (!memcmp(h, target, 20)) {
                uint64_t kk[4] = {k[0], k[1], k[2], k[3]}; u128 c = (u128)kk[0] + j; kk[0] = (uint64_t)c; c >>= 64;
                for (int i = 1; i < 4; i++) { c += kk[i]; kk[i] = (uint64_t)c; c >>= 64; }
                for (int i = 0; i < 4; i++) for (int b = 0; b < 8; b++) out_key[8*i + b] = (uint8_t)(kk[3 - i] >> (56 - 8*b));
                hit = 1;
            }
        }
        done += m;
        if (done < n) { /* P += B*G (uses 1/dx[B]) */
            fe l, t; ge Q; fe_sub(&l, &T[B].y, &P.y); fe_mul(&l, &l, &dx[B]);
            fe_mul(&Q.x, &l, &l); fe_sub(&Q.x, &Q.x, &P.x); fe_sub(&Q.x, &Q.x, &T[B].x);
            fe_sub(&t, &P.x, &Q.x); fe_mul(&Q.y, &l, &t); fe_sub(&Q.y, &Q.y, &P.y); P = Q;
            u128 c = (u128)k[0] + B; k[0] = (uint64_t)c; c >>= 64;
            for (int i = 1; i < 4; i++) { c += k[i]; k[i] = (uint64_t)c; c >>= 64; }
        }
    }
    return hit;
}
