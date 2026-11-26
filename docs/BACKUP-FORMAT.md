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

### Mailbox (`swarm`, optional, from 1.1.0)

Present only when the install uses mailbox peers or has contacts' mailbox details. Versioned inside: a reader that sees a `v` greater
than it knows restores everything else and says the mailbox part comes from a newer version (the person joins their peers again).

```json
"swarm": {
  "v": 1, "at": 1795400000000, "seq": 1795400000000, "keepFor": 604800,
  "capable": [ "<contact address>", ... ],
  "peers": [ {
    "address": "<peer>.anyone", "state": "active",
    "mailbox": "<32 hex>", "secret": "<base64url, 32 bytes: the owner secret>",
    "key":    { "kid": "<16 hex>", "pk": "<base64url, 65-byte P-256 point>", "sk": "<base64url, 32 bytes>" },
    "oldKey": { "kid": "...", "pk": "...", "sk": "...", "until": 1795400000000 },
    "tokens": { "<contact address>": "<base64url, 32 bytes>", ... },
    "retiring": [ { "h": "<64 hex: SHA-256 of a token replaced by a key rotation>", "until": 1795400000000 } ]
  } ],
  "contacts": { "<contact address>": { "v": 1, "seq": ..., "keepFor": ..., "peers": [ ... ] } }
}
```

- `at`: when the backup was made (to tell, after a restore, whether another install used the mailbox since).
- `peers`: each mailbox peer, at most 4 (a peer still being joined has `state: "joining"` and its `invite` instead of `mailbox`; a peer
  being left has `state: "leaving"`, no secret keys, and is told again after the restore). `kid` must be the one `pk` gives at that
  address, `pk` a point on the curve and `sk` its secret key (design section 6); a peer that fails any check, or repeats an address, is
  left out. `tokens` are the drop tokens each contact holds (registered or not yet); the peer only knows their SHA-256. Times in the
  future are kept at most 8 days ahead.
- `contacts`: the latest mailbox details each contact sent us, checked as if they had just arrived.
- `capable`: contacts whose apps read mailbox details.
- After the restart, the app asks each peer whether the mailbox still exists (one that doesn't is removed, and the person is told) and
  whether another install used it since the backup (its keys, or a collection after `at`: the person is warned and that install's keys
  stay accepted 8 days); then it registers the backup's tokens again (added, in requests of at most 1,000, so tokens another install
  made since are left alone) and sends every capable contact fresh details naming that peer. A peer that doesn't answer is asked again
  every minute; the others don't wait for it, and contacts get nothing until at least one peer is checked. Tokens stay the same, so
  contacts' copies of the old details keep working meanwhile.
- A restore without this field (or with a newer `v`) sets `seq`, so contacts who still hold mailbox details from before are told
  "write to me directly" once they show they read details.

These are secrets: with them anyone can collect the mailbox. They are only ever written inside the encrypted payload.

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
