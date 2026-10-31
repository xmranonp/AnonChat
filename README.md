<div align="center">

<img src="public/app-icon.png" alt="AnonChat" width="96" height="96" />

# AnonChat

**Serverless · End-to-End Encrypted · Onion Routing**

A privacy-first desktop messenger that routes every message through the **Anyone Protocol** onion routing hidden services. No central servers. No phone number. No metadata harvesting. Your `.anyone` address is your only identity.

</div>

[Features](<#features>) · [Architecture](<#architecture>) · [Security Model](<#security-model>) · [Roadmap](<#roadmap>) · [FAQ](<FAQ.md>) · [License](<#license>)

---

## Why AnonChat ?

Most messengers route your conversations through corporate servers that can see who you talk to, when, and how often - even when they can't read the contents. AnonChat is built differently:

## Features

###  Privacy & Security

- **End-to-end encryption** \- Double Ratchet (X3DH handshake, forward secrecy) over NIST **P-256**, AES-256-GCM, HKDF/HMAC-SHA256. Messages written before the other side's first reply rest on their signed prekey (and a one-time prekey, when one is left), so their forward secrecy is limited to that key's lifetime: it is replaced every week and the old private half deleted after 60 days.

- **Signed prekeys** \- your medium-term prekey, replaced every week, is signed by a separate identity signing key (ECDSA P-256); contacts take a new one only with a valid signature by the signing key pinned when they added you. The keys themselves are authenticated by your `.anyone` address, which only your computer can answer at; compare safety numbers to rule out a substitution at the moment you add someone. Verification is fail-closed.

- **Anyone Protocol hidden services** for all transport - content *and* network location are hidden.

- **Encrypted at rest** \- what AnonChat keeps on disk (contacts, groups, message keys, history, media, waiting messages) is sealed with AES-256-GCM under a random data key. The operating system's vault keeps that key (Keychain, Windows, GNOME Keyring or KWallet) and a 6-digit PIN unlocks the app; or choose a passphrase (at least 12 characters) typed at each start, which also protects a stolen disk or backup.

- **Message requests** \- someone who isn't a contact lands in Requests, text only until you accept; Delete, Block, or turn requests off. A request is marked *Not verified yet*: the address on it is only what the sender wrote, and Accept checks it against the keys that address serves.

- **Keys never change silently** \- a contact's keys are pinned when you add them; adding someone already in your contacts is refused, and the *verified* mark shows only for the keys you verified.

- **Message stamps** \- every message between two contacts carries a stamp made with a key only those two share, so nobody can pose as a contact to get past your limits. Strangers get small allowances, and proof of work is asked for only during a flood.

- **Network lock** \- the window can only talk to the local backend, the backend only through the SOCKS proxy (`socks5h`, names resolved inside the network), and WebRTC is removed: nothing can leave outside the Anyone network. Links in messages open in your own browser only after a warning: unless that browser uses AnonChat's SOCKS5 proxy, the site sees your IP address.

- **Traffic padding** \- the link to the first relay always carries padding (`ConnectionPadding 1`), hidden-service routes are padded too, and no two relays on a route share a network (`CircuitPadding`, `EnforceDistinctSubnets`), so an observer of your connection can't easily tell when you send or receive.

- **Trust-on-first-use pinning** with safety-number verification per contact.

###  Messaging

- Real-time 1:1 messaging over the onion network, with optimistic send and delivery status.

- **Group chats** (up to 10 members) with admin controls, descriptions, and member management. Each person's picture appears beside the first of their messages in a row. Members talk directly to each other, so a group works while its admin is offline; only joining with the invite code and changes to the group wait for the admin.

- **Identity backup** \- Settings → Backup saves your address, message keys, contacts, groups and settings in one file encrypted with a passphrase; restore it on another computer from the welcome screen. Message history and other people's pictures aren't included, and only one computer should run an address at a time.

- **Replies**, **reactions**, and **disappearing messages** (per-conversation TTL).

- **Voice calls** \- full-duplex, end-to-end encrypted calls with a contact, entirely inside the Anyone network, with no WebRTC, STUN or TURN.

- **Voice messages** (up to one minute, with a live timer, level meter and cancel) and drag-and-drop **file / image / video sharing** (up to 5 MB). Photos, videos and audio are cleaned of location, camera and time, and get a neutral name, before they are sent; everything is kept encrypted on disk; Settings → Storage shows usage per chat and clears old media.

- **Offline delivery** \- a message to a contact who is offline waits on your computer, is retried every 15 s for 1, 12 or 24 hours (per chat) and goes out as soon as they are back. A dot shows whether each contact can be reached, and the chat's ⋮ menu has **Test connection** and **Rebuild network path** for when a route fails. The light beside the app name shows your own side: cyan when you are ready and reachable, amber while the network starts or the address is being repaired, red when the window has lost its link to the app.

- **Read receipts** (opt-in), **pinned conversations**, unread separators, jump-to-latest and local petnames for contacts.


###  Experience

- Clean **dark & light themes**, adjustable chat font size.

- **Notifications** \- a sound, unread counts (window title, taskbar dot on Windows, Dock number on macOS, launcher count on Linux docks), and optional desktop notifications showing the name only (default), the name and message, or nothing. Message requests never show who wrote or what.

- **Incoming calls** make the caller's card in the contact list glow until the call is answered or ends.

- **Check for updates** in Settings: a manual check against the project's GitHub releases, sent through the Anyone network. Nothing runs in the background and nothing is installed automatically.

- **Emoji picker** with the full Noto Emoji set (Google artwork, 1,923 emoji in nine categories, with skin-tone choices) and every country flag, plus **search by English name** (Unicode CLDR). Emoji in messages use the same artwork, and a message of just a few emoji is shown extra large.

- **Ten languages** out of the box: English, Spanish, French, Italian, German, Portuguese, Simplified Chinese, Japanese, Polish, Hindi.

###  Network insight (unique to onion-native messaging)

- Live **Circuits** panel and World globe showing the actual relays your traffic passes through - nickname, fingerprint, bandwidth, and flags. During a call you make, the route carrying it is marked.
- **Exit country** (Circuits tab): choose which country SOCKS5 traffic leaves the network from, with flags and the number of exit relays per country. Default is *Global* (automatic). Only traffic that leaves the network is affected; messages to `.anyone` contacts never use exit relays. Apps are routed only if they (or your system) are set to use the SOCKS5 proxy shown in the tab.
- **Dynamic port** toggle: if the SOCKS port (9050) is busy, the next free port is used automatically. The current address is shown in the Circuits tab.

- Hidden-service health (with the number of introduction points) and bootstrap status. When messages to someone wait, the Status log says why (address not found, introduction failed, busy…), with the address shortened, and when they got through. Kept in memory only.

- Manual circuit rotation.



## No metadata leaks

- No phone number or email

- No account or central server logs

- No IP exposure to peers

- Photos, videos and audio are cleaned of location, camera, time stamps and file names before they are sent. Other files are sent as you chose them

- Only encrypted payloads over anonymous routing

---

## Architecture

AnonChat is an **Electron desktop app** wrapping a local Node.js backend and a sandboxed web UI. There is no cloud component — the "server" is a loopback process on your own machine that speaks to the Anyone network.

| Layer                                                                                    | Technology                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Desktop shell**                                                                        | Electron 45 (Chromium 156); backend on Node 24 LTS                                       |
| **UI**                                                                                   | Vanilla JS in a sandboxed renderer (`contextIsolation`, `sandbox`, no `nodeIntegration`) |
| **Local backend**                                                                        | Express / Node.js (`server.js`) — onion-facing + loopback routers                        |
| **Encryption**                                                                           | WebCrypto: Double Ratchet + X3DH, P-256, AES-256-GCM, ECDSA-signed prekeys               |
| **Transport**                                                                            | Anyone Protocol hidden services (`.anyone` addresses)                                    |
| **At-rest**                                                                              | AES-256-GCM data key, kept by the OS vault (PIN) or wrapped with a passphrase            |
| **i18n**                                                                                 | 10 languages, every string translated (checked by `npm test`)                            |

```
AnonChat/
├── server.js            # local backend: onion-facing + loopback APIs
├── start.js             # bootstrap + process supervision
├── public/              # web UI (sandboxed renderer)
│   ├── app.js           #   client logic
│   ├── ratchet.js       #   Double Ratchet + X3DH + signed prekeys
│   ├── call.js          #   voice calls: call crypto, Opus audio, jitter buffer, call card
│   ├── auth.js          #   browser mode: keeps the access token from the link in the tab and sends it as a header (no cookie)
│   ├── no-rtc.js        #   removes the WebRTC API before anything else runs
│   ├── crypto.js        #   primitives
│   ├── i18n.js          #   UI strings, 10 languages
│   ├── emoji/           #   Noto Emoji PNGs
│   └── styles.css
├── lib/                 # circuits, call bridge, outbox, pow, ratelimit, store, updater
└── desktop/             # Electron main process, preload, splash, packaging
```



## Security Model

AnonChat layers three independent protections:

1. **Transport** — Anyone Protocol onion routing hides both message content and your network location.

2. **Application** — a Double Ratchet (X3DH + forward secrecy) encrypts every message end-to-end, with signed prekeys authenticating the handshake.

3. **Storage** — contacts, groups, message keys, history and media are encrypted at rest (AES-256-GCM) with a data key kept by the OS vault and unlocked with your PIN, or protected by a passphrase. The address's own private key is protected by folder permissions only, because the Anyone network program reads it directly.

### Threat model

| Threat                                                 | Mitigation                                             |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Server compromise                                      | No servers exist to compromise                         |
| Network surveillance                                   | Anyone Protocol onion routing                          |
| Message interception                                   | Double Ratchet end-to-end encryption                   |
| Prekey substitution / MITM                             | Keys fetched from the contact's own `.anyone` address and pinned; prekeys signed (fail-closed); safety numbers |
| Replay                                                 | Per-message consumed-key set in the ratchet            |
| Offline disk access                                    | Everything on disk encrypted; key in the OS vault or under a passphrase |
| Inbox flooding by strangers                            | Small stranger allowances, proof of work during a flood (asked before anything that would tell who your contacts are), a hard total with "retry later" |
| Posing as a contact to get their inbox allowance       | Every message carries a stamp made with a key only the two people share (deniable: proves nothing to others) |
| Another program on the computer taking the port your address uses | The app takes it first and stops (saying so) if it can't; the same for the network's proxy port, and it stops if its network program stops |
| A recipient demanding endless proof of work            | Difficulty capped; anything higher refused at once     |
| A contact answering one byte at a time to stall the app | Every request to another node has a hard deadline; a slow recipient never holds up the others |
| Draining one-time prekeys                              | Handed out sparingly (20, then 10 an hour); unused private halves dropped after 14 days, 4,000 at most; without one, the weekly signed prekey limits what a later key theft could read |
| Metadata analysis                                      | No central server means no central metadata to collect |

---

##  Roadmap

- [x] Anyone Protocol hidden-service transport

- [x] Double Ratchet + X3DH end-to-end encryption

- [x] Signed prekeys (authenticated handshake)

- [x] Group conversations

- [x] Voice messages & file sharing (image, video and files)

- [x] Reactions, replies, disappearing messages

- [x] End-to-end encrypted voice calls over hidden services

- [x] Everything on disk encrypted: data key kept by the OS vault (Keychain, Windows, GNOME Keyring/KWallet) or an optional passphrase; PIN + device key for keys and history

- [x] Emoji picker with skin tones and English-name search, 10-language UI, dark/light themes

- [x] Live circuits panel, exit-country selection and dynamic SOCKS port

- [x] Visualization of the latest used circuits via an interactive world map of relays

- [x] Linux packages: `.deb` (Ubuntu/Debian), `.pacman` (Arch), `.rpm` (Fedora/openSUSE)

- [ ] macOS build (build setup ready; not yet tested on a Mac)

- [ ] **Mailbox swarms** (planned): volunteer nodes that hold end-to-end encrypted blobs (queued messages and media) in per-contact mailboxes until the recipient is back online.

- [ ] Android app (native Kotlin, using the Anyone `anon` client for Android). It depends on mailbox swarms: a phone is often unreachable, so it collects its messages from mailboxes instead

- [x] Offline delivery: per-recipient retries, instant send when a contact writes, two-strike online status

- [x] Desktop notifications with privacy levels, unread counts on taskbar and docks



Note: It is worth noting that this roadmap is a living document and is subject to change without prior notice.



---

## Disclaimer

AnonChat uses established cryptographic techniques, but no software can guarantee absolute security, and its cryptography has not been formally audited by an independent third party. You are responsible for your own operational security.

---

## License

Licensed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. See [LICENSE](<LICENSE>) for the full text.

Bundled third-party components (globe.gl, three.js, Noto Emoji, Natural Earth data, the Anyone `anon` daemon, and npm dependencies) remain under their own licenses — see [THIRD-PARTY-LICENSES.md](<THIRD-PARTY-LICENSES.md>).

---

**Built for people who believe privacy is a right, not a feature.**
