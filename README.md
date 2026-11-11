<div align="center">

<img src="public/app-icon.png" alt="AnonChat" width="96" height="96" />

# AnonChat

**Serverless · End-to-end encrypted · Onion routed**

A desktop messenger that sends every message over **Anyone Protocol** hidden services. No central server, no phone number, no account: your `.anyone` address is your only identity.

</div>

[Features](<#features>) · [Architecture](<#architecture>) · [Download](<#download>) · [Quick start](<#quick-start>) · [Roadmap](<#roadmap>) · [FAQ](<FAQ.md>) · [Build](<BUILD.md>) · [License](<#license>) · [Website](<https://xmranonp.github.io/anonchat-website/>) · [Guide (PDF)](<https://xmranonp.github.io/anonchat-website/assets/AnonChat-Official-Guide.pdf>)

> **Security review status:** AnonChat has been extensively audited by an AI model (Claude, by Anthropic), however, it has not yet undergone a security review by an expert.

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
- Offline delivery: messages wait on your computer and go out when the contact is back (1 hour to 7 days, per chat; 24 hours by default).
- Encrypted identity backup and restore.
- Ten languages, dark and light themes, notifications that show only the name by default.

**Network view**
- Live Circuits panel and relay map, exit-country choice for SOCKS5 traffic, manual circuit rotation.

---

## Architecture

AnonChat is an Electron app that wraps a local Node.js backend and a sandboxed web UI. There is no cloud component: the "server" is a process on your own computer that talks to the Anyone network.

| Layer | Technology |
|---|---|
| Transport | Anyone Protocol hidden services (`.anyone` addresses) |
| Messages | WebCrypto: X3DH + Double Ratchet, P-256, AES-256-GCM, ECDSA-signed prekeys |
| Storage | AES-256-GCM data key kept by the OS vault (with PIN) or under a passphrase |
| Backend | Express / Node.js: `server.js` (public port for your address, loopback port for the window) |
| UI | Vanilla JavaScript in a sandboxed renderer (`contextIsolation`, `sandbox`, no `nodeIntegration`) |
| Shell | Electron 45.3, Node 24 |

## Download

Get the installer for your system from the [latest release](<https://github.com/xmranonp/AnonChat/releases/latest>): `.deb` (Ubuntu, Debian), `.pacman` (Arch, CachyOS), `.rpm` (Fedora, openSUSE) or the Windows `.exe`. Everything is included; nothing else to install.

| System | Install |
|---|---|
| Ubuntu / Debian | `sudo apt install ./anonchat*.deb` |
| Arch / CachyOS | `sudo pacman -U ./anonchat*.pacman` |
| Fedora / openSUSE | `sudo dnf install ./anonchat*.rpm` |
| Windows | Run the installer. The builds are not signed yet, so SmartScreen says **More info → Run anyway**. |

## Quick start

1. Start AnonChat and choose a PIN (or a passphrase). Wait for the shield to turn green: this is the Anyone network connecting, usually under a minute.
2. Copy your `.anyone` address and send it to a friend. Paste theirs under **Add contact**, then compare the **safety number** with them, in person or by phone.
3. Write. If your friend is offline, the message waits on your computer and goes out when they are back.

The [Official Guide](<https://xmranonp.github.io/anonchat-website/assets/AnonChat-Official-Guide.pdf>) (PDF) covers groups, calls, backups and settings.

---

## Roadmap

- [x] Hidden-service transport, end-to-end encryption, groups, files, voice messages and calls
- [x] Encryption on disk, backups, simple offline delivery, notifications, 10 languages
- [x] Linux packages (`.deb`, `.pacman`, `.rpm`) and a Windows installer
- [ ] macOS build (planned)
- [ ] Mailbox Swarms (offline delivery)
- [ ] Move to a new device and add a contact by QR code
- [ ] Android app (native Kotlin)

This roadmap can change without notice.

## License

Licensed under the **GNU Affero General Public License v3.0 or later**. See [LICENSE](<LICENSE>). Bundled third-party components keep their own licenses: see [THIRD-PARTY-LICENSES.md](<THIRD-PARTY-LICENSES.md>).

**Built for people who believe privacy is a right, not a feature.**
