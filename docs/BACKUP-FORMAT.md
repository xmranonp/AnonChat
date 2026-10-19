# AnonChat identity backup — file format v1

A backup moves one AnonChat identity (its Anyone address, its message keys and the people around it) to another install: a new
computer today, the Android app later. Message history is **not** included. This document is the reference for any platform that
reads or writes these files. The reference implementation is `public/backup.js`.

File extension: `.anonchat`. Default name: `anonchat-backup-YYYY-MM-DD.anonchat`. Maximum size accepted: 20 MB.

## Outer file

UTF-8 JSON, readable without the passphrase. It says nothing about whose backup it is.

```json
{
  "format": "anonchat-backup",
  "v": 1,
  "kdf":    { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64, 16 bytes>" },
  "cipher": { "name": "AES-GCM", "iv": "<base64, 12 bytes>" },
  "ct":     "<base64>"
}
```

- Key: `PBKDF2-HMAC-SHA256(passphrase NFC-normalised as UTF-8, salt, iterations) → 32 bytes`, used as an AES-256-GCM key.
- `ct` = AES-256-GCM ciphertext of the UTF-8 JSON payload, with the 16-byte tag appended (WebCrypto layout) and
  additional authenticated data = the ASCII bytes `anonchat-backup v1`.
- Readers must accept `iterations` between 100 000 and 10 000 000 and refuse anything else.
- Writers must require a passphrase of at least 12 characters.
- A reader that sees `v` greater than it knows must say the file comes from a newer version, not that it is damaged.
- A failed GCM decrypt means a wrong passphrase **or** a damaged file; the two can't be told apart.

## Payload (inside `ct`)

```json
{
  "format": "anonchat-backup", "v": 1, "createdAt": 1760000000000,
  "address": "<56 base32 chars>.anyone",
  "hs": { "secret": "<base64, 96 bytes>", "public": "<base64, 64 bytes>", "hostname": "<same as address>" },
  "identity": {
    "ikPriv": <JWK, EC P-256, ECDH private key>,  "ikPub": "<base64 raw P-256 point>",
    "spk":    { "priv": <JWK, ECDH>,  "pub": "<base64 raw>" },
    "ikSig":  { "priv": <JWK, ECDSA>, "pub": "<base64 raw>" }
  },
  "contacts": [ { "address": "...", "petname": "...", "ecdhPub": "...", "ratchetPub": "...", ... } ],
  "peers":    [ { "address": "...", "ecdhPub": "...", ... } ],
  "groups":   [ { "id": "...", "name": "...", "members": [ { "address": "..." } ], "adminAddr": "..." } ],
  "blocked":  [ "<address>", ... ],
  "settings": { "acceptRequests": true, "powAlways": false, "readReceipts": true },
  "profile":  { ... },
  "prefs":    { ... }
}
```

### Hidden-service key (`hs`)

These are the Anyone (Tor-format) v3 onion service files, byte for byte:

| field    | file                      | layout                                                                 |
|----------|---------------------------|------------------------------------------------------------------------|
| `secret` | `hs_ed25519_secret_key`   | 32-byte header `== ed25519v1-secret: type0 ==` NUL-padded + 64-byte expanded ed25519 key |
| `public` | `hs_ed25519_public_key`   | 32-byte header `== ed25519v1-public: type0 ==` NUL-padded + 32-byte ed25519 public key   |
| `hostname` | `hostname`              | the address, newline-terminated on disk                                |

The first 32 bytes of `base32decode(address without ".anyone")` must equal the 32-byte public key; a reader refuses the backup otherwise.
On Android these bytes are handed to the embedded Anyone/Tor client as the onion service key (for example via `ADD_ONION ED25519-V3:`
with the 64-byte expanded secret, base64).

### Message keys (`identity`)

The X3DH identity key (`ikPriv`/`ikPub`), the signed prekey (`spk`) and the signing key (`ikSig`) — all P-256. Contacts have these
public keys pinned, so they must survive the move unchanged. **One-time prekeys are deliberately not included** (single use); the new
install generates fresh ones.

### Lists

`contacts` and `peers` (group members who aren't contacts) are the backend's records with `online`, `lastSeen`, `opkId`, `opkPub` and
`avatar` stripped: other people's pictures are theirs, served from their own address, and come back when they next write (with them, a
backup of many people could grow past what a restore takes). Your own picture (`profile`) and group pictures stay. `groups`, `blocked`, `settings` (only the three fields above), `profile` and `prefs` (pinned chats, verified safety numbers, disappearing-message timers)
are restored as they are; unknown fields should be ignored.

## Restoring

1. Before anything is erased or written, a reader checks the payload's shape **and** that every identity key pair belongs together
   (`ikPriv`/`ikPub` and `spk` by an ECDH exchange with a throwaway key, `ikSig` by signing and verifying), and refuses the file
   otherwise. Restoring is only allowed on an install with **no** contacts, groups or group members. The desktop app erases
   everything first, keeping the exact bytes that were opened (not the file on disk) for the restart.
2. Write the three `hs` files (mode 0600) before the network client starts, set the message keys, import the lists.
3. Restart. Ratchet sessions are not in the backup, so after restart the app offers every contact and group member a new session
   (an `accept` frame carrying a fresh X3DH handshake). Contacts accept a new handshake from the **same pinned identity key** when
   their old session can no longer decrypt. Messages sent during the switch over the old session may be lost.
   The member lists came from the backup, so the app then asks each group's admin for the current one (a `group-update` frame with
   `action: "roster"`); the admin answers that member alone, at most every 10 minutes, with a `group-invite` carrying the full list
   and, in `left`, the addresses of members who left in the last 30 days.
4. Only one install should run a given address at a time: the other copy must be erased or stay off.
