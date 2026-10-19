/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
/* Conformance against spec/vectors.json (generated from the JavaScript SDK). */
#include "vdon_internal.h"
#include "vdoninja.h"

#include <cJSON.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef VDON_VECTORS_PATH
#define VDON_VECTORS_PATH "../spec/vectors.json"
#endif

static int failures = 0;

#define CHECK(cond, ...)                                                                                               \
    do {                                                                                                               \
        if (!(cond)) {                                                                                                 \
            failures++;                                                                                                \
            fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__);                                                       \
            fprintf(stderr, __VA_ARGS__);                                                                              \
            fputc('\n', stderr);                                                                                       \
        }                                                                                                              \
    } while (0)

static const char *S(const cJSON *o, const char *k) {
    const char *v = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(o, k));
    return v ? v : "";
}

static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    long n;
    char *buf;
    if (!f)
        return NULL;
    fseek(f, 0, SEEK_END);
    n = ftell(f);
    fseek(f, 0, SEEK_SET);
    buf = (char *)malloc((size_t)n + 1);
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) {
        fclose(f);
        free(buf);
        return NULL;
    }
    buf[n] = 0;
    fclose(f);
    return buf;
}

int main(int argc, char **argv) {
    const char *path = argc > 1 ? argv[1] : VDON_VECTORS_PATH;
    char *text = read_file(path);
    cJSON *root, *it;
    char out[1024];
    if (!text) {
        fprintf(stderr, "cannot read %s\n", path);
        return 2;
    }
    root = cJSON_Parse(text);
    free(text);
    if (!root) {
        fprintf(stderr, "invalid JSON in %s\n", path);
        return 2;
    }

    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(root, "hash")) {
        char hex[65];
        vdon_generate_hash(S(it, "input"), (int)cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(it, "length")), hex);
        CHECK(strcmp(hex, S(it, "expected")) == 0, "hash(%s) = %s, want %s", S(it, "input"), hex, S(it, "expected"));
    }

    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(root, "streamHash")) {
        char pw[512], phrase[1024], suffix[65], full[256];
        vdon_sanitize_password(S(it, "rawPassword"), pw, sizeof(pw));
        CHECK(strcmp(pw, S(it, "sanitizedPassword")) == 0, "sanitizePassword(%s) = %s", S(it, "rawPassword"), pw);
        snprintf(phrase, sizeof(phrase), "%s%s", pw, S(it, "salt"));
        vdon_generate_hash(phrase, 6, suffix);
        CHECK(strcmp(suffix, S(it, "hashSuffix")) == 0, "stream hash suffix %s want %s", suffix, S(it, "hashSuffix"));
        snprintf(full, sizeof(full), "%s%s", S(it, "streamID"), suffix);
        CHECK(strcmp(full, S(it, "hashedStreamID")) == 0, "hashed stream id %s want %s", full, S(it, "hashedStreamID"));
    }

    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(root, "roomHash")) {
        char pw[512], buf[1024], hashed[65];
        vdon_sanitize_password(S(it, "rawPassword"), pw, sizeof(pw));
        snprintf(buf, sizeof(buf), "%s%s%s", S(it, "room"), pw, S(it, "salt"));
        vdon_generate_hash(buf, 16, hashed);
        CHECK(strcmp(hashed, S(it, "hashedRoom")) == 0, "room hash %s want %s", hashed, S(it, "hashedRoom"));
    }

    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(root, "encryption")) {
        uint8_t key[32], *iv = NULL, *ct = NULL;
        size_t ivlen, ctlen;
        char keyhex[65];
        int n;
        const char *phrase = S(it, "phrase");
        vdon_sha256((const uint8_t *)phrase, strlen(phrase), key);
        vdon_hex_encode(key, 32, keyhex);
        CHECK(strcmp(keyhex, S(it, "keyHex")) == 0, "key %s want %s", keyhex, S(it, "keyHex"));
        CHECK(vdon_hex_decode(S(it, "ivHex"), &iv, &ivlen) == 0 && ivlen == 16, "iv decode");
        n = vdon_aes256_cbc_encrypt(key, iv, (const uint8_t *)S(it, "plaintext"), strlen(S(it, "plaintext")), &ct);
        if (n > 0) {
            char *cthex = (char *)malloc((size_t)n * 2 + 1);
            vdon_hex_encode(ct, (size_t)n, cthex);
            CHECK(strcmp(cthex, S(it, "ciphertextHex")) == 0, "ciphertext mismatch for %s", S(it, "plaintext"));
            free(cthex);
        } else
            CHECK(0, "encrypt failed");
        free(ct);
        free(iv);
        {
            char *plain = NULL;
            CHECK(vdon_decrypt_message(S(it, "ciphertextHex"), S(it, "ivHex"), phrase, &plain) == VDON_OK && plain &&
                      strcmp(plain, S(it, "plaintext")) == 0,
                  "decrypt mismatch for %s", S(it, "plaintext"));
            free(plain);
        }
        {
            /* round trip with a random IV */
            char *enc = NULL, *ivhex = NULL, *plain = NULL;
            CHECK(vdon_encrypt_message(S(it, "plaintext"), phrase, &enc, &ivhex) == VDON_OK, "encrypt_message");
            CHECK(vdon_decrypt_message(enc, ivhex, phrase, &plain) == VDON_OK && strcmp(plain, S(it, "plaintext")) == 0,
                  "round trip");
            free(enc);
            free(ivhex);
            free(plain);
        }
    }

    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(root, "sanitizeStreamID")) {
        vdon_sanitize_stream_id(S(it, "input"), out, sizeof(out));
        if (S(it, "expected")[0])
            CHECK(strcmp(out, S(it, "expected")) == 0, "sanitizeStreamID(%s) = %s want %s", S(it, "input"), out,
                  S(it, "expected"));
        else
            CHECK(strlen(out) == 12, "empty stream id should be generated (12 chars), got %s", out);
    }
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(root, "sanitizeRoom")) {
        vdon_sanitize_room(S(it, "input"), out, sizeof(out));
        CHECK(strcmp(out, S(it, "expected")) == 0, "sanitizeRoom(%s) = %s want %s", S(it, "input"), out, S(it, "expected"));
    }
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(root, "sanitizePassword")) {
        vdon_sanitize_password(S(it, "input"), out, sizeof(out));
        CHECK(strcmp(out, S(it, "expected")) == 0, "sanitizePassword(%s) = %s want %s", S(it, "input"), out,
              S(it, "expected"));
    }
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(root, "sanitizeLabel")) {
        vdon_sanitize_label(S(it, "input"), out, sizeof(out));
        CHECK(strcmp(out, S(it, "expected")) == 0, "sanitizeLabel(%s) = %s want %s", S(it, "input"), out, S(it, "expected"));
    }

    {
        const cJSON *d = cJSON_GetObjectItemCaseSensitive(root, "defaults");
        CHECK(strcmp(S(d, "host"), VDON_DEFAULT_HOST) == 0, "default host");
        CHECK(strcmp(S(d, "password"), VDON_DEFAULT_PASSWORD) == 0, "default password");
        CHECK(strcmp(S(d, "salt"), VDON_DEFAULT_SALT) == 0, "default salt");
        CHECK(strcmp(S(d, "controlChannelLabel"), VDON_CONTROL_CHANNEL) == 0, "control channel label");
        CHECK(strcmp(S(d, "binaryChannelLabel"), VDON_BINARY_CHANNEL) == 0, "binary channel label");
    }
    cJSON_Delete(root);
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("vectors: all checks passed\n");
    return 0;
}
