<div align="center">

<img src="public/app-icon.png" alt="AnonChat" width="96" height="96" />

# AnonChat

**Serverless · End-to-end encrypted · Onion routed**

A desktop messenger that sends every message over **Anyone Protocol** hidden services. No central server, no phone number, no account: your `.anyone` address is your only identity.

</div>

[Features](<#features>) · [How it works](<#how-it-works>) · [Roadmap](<#roadmap>) · [FAQ](<FAQ.md>) · [Build](<BUILD.md>) · [License](<#license>)

> **Security review status:** AnonChat has been audited by an AI model (Claude, by Anthropic), but it has not had a human security review yet.

---

## Features

**Privacy**
- End-to-end encryption: X3DH and Double Ratchet over P-256, AES-256-GCM and HKDF-SHA-256, with signed prekeys.
- All traffic goes through Anyone hidden services, so content and network location are hidden. The app only talks to the local backend, and the backend only through the SOCKS proxy; WebRTC is removed.
- A contact's keys are fetched from their own address and pinned; they never change silently. Safety numbers let you verify a contact.
- Everything the app keeps on disk is encrypted with a random data key held by the OS vault (Keychain, Windows, GNOME Keyring, KWallet) and unlocked with a 6-digit PIN, or wrapped with a passphrase you type at each start.
- Strangers land in **Message requests** (text only until you accept). Contacts' messages carry a stamp that only the two of you can make, so nobody can pose as a contact to use their allowance.
- Photos, videos and audio are cleaned of location, camera, time and file names before sending. Other files are sent as you chose them.

**Messaging**
- 1:1 chats, groups of up to 10, replies, reactions, disappearing messages, read receipts (opt-in).
- Voice messages (1 minute), files, images and video (5 MB), encrypted voice calls inside the Anyone network.
- Offline delivery: messages wait on your computer and go out when the contact is back (1, 12 or 24 hours, per chat).
- Encrypted identity backup and restore.
- Ten languages, dark and light themes, notifications that show only the name by default.

**Network view**
- Live Circuits panel and relay map, exit-country choice for SOCKS5 traffic, manual circuit rotation.

---

## How it works

AnonChat is an Electron app (Electron 45, Node 24) that wraps a local Node.js backend and a sandboxed web UI. There is no cloud component: the "server" is a process on your own computer that talks to the Anyone network.

| Layer | Technology |
|---|---|
| Transport | Anyone Protocol hidden services (`.anyone` addresses) |
| Messages | WebCrypto: X3DH + Double Ratchet, P-256, AES-256-GCM, ECDSA-signed prekeys |
| Storage | AES-256-GCM data key kept by the OS vault (with PIN) or under a passphrase |
| Backend | Express / Node.js: `server.js` (public port for your address, loopback port for the window) |
| UI | Vanilla JavaScript in a sandboxed renderer (`contextIsolation`, `sandbox`, no `nodeIntegration`) |

Code layout: `server.js` and `start.js` (backend), `public/` (UI, ratchet, calls), `lib/` (circuits, outbox, limits, storage), `desktop/` (Electron shell and packaging).

## Roadmap

- [x] Hidden-service transport, end-to-end encryption, groups, files, voice messages and calls
- [x] Encryption on disk, backups, offline delivery, notifications, ten languages
- [x] Linux packages (`.deb`, `.pacman`, `.rpm`) and a Windows installer
- [ ] macOS build (set up, not yet tested on a Mac)
- [ ] **Mailbox swarms** (planned): volunteer nodes that hold end-to-end encrypted queued messages until the recipient is back online
- [ ] Android app (native Kotlin; depends on mailbox swarms)

This roadmap can change without notice.

## License

Licensed under the **GNU Affero General Public License v3.0 or later**. See [LICENSE](<LICENSE>). Bundled third-party components keep their own licenses: see [THIRD-PARTY-LICENSES.md](<THIRD-PARTY-LICENSES.md>).

**Built for people who believe privacy is a right, not a feature.**
