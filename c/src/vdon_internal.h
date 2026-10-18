/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
#ifndef VDON_INTERNAL_H
#define VDON_INTERNAL_H

#include <stddef.h>
#include <stdint.h>

/* crypto */
void vdon_sha256(const uint8_t *data, size_t len, uint8_t out[32]);
/* AES-256-CBC with PKCS#7; *out is malloc'd. Returns length or -1. */
int vdon_aes256_cbc_encrypt(const uint8_t key[32], const uint8_t iv[16], const uint8_t *in, size_t len, uint8_t **out);
int vdon_aes256_cbc_decrypt(const uint8_t key[32], const uint8_t iv[16], const uint8_t *in, size_t len, uint8_t **out);
void vdon_hex_encode(const uint8_t *in, size_t len, char *out); /* out needs 2*len+1 */
int vdon_hex_decode(const char *hex, uint8_t **out, size_t *out_len);
void vdon_random_bytes(uint8_t *out, size_t len);

/* ids */
void vdon_generate_stream_id(char out[13]);
void vdon_generate_session(char out[9]);
void vdon_generate_uuid(char out[37]);
char *vdon_strdup(const char *s);
int64_t vdon_now_ms(void);

#endif
