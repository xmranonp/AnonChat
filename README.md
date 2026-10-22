<div align="center">

<img src="public/app-icon.png" alt="AnonChat" width="96" height="96" />

# AnonChat

**Serverless · End-to-End Encrypted · Onion Routing**

A privacy-first desktop messenger that routes every message through the **Anyone Protocol** onion routing hidden services. No central servers. No phone number. No metadata harvesting. Your `.anyone` address is your only identity.

</div>

[Features](<#features>) · [How It Works](<#how-it-works>) · [Architecture](<#architecture>) · [Security Model](<#security-model>) · [Roadmap](<#roadmap>) · [FAQ](<FAQ.md>) · [License](<#license>)

---

## Why AnonChat ?

Most messengers route your conversations through corporate servers that can see who you talk to, when, and how often - even when they can't read the contents. AnonChat is built differently:

## Features

###  Privacy & Security

- **End-to-end encryption** \- Double Ratchet (X3DH handshake, forward secrecy) over NIST **P-256**, AES-256-GCM, HKDF/HMAC-SHA256.

- **Signed prekeys** \- your medium-term prekey is signed by a separate identity signing key (ECDSA P-256), so a man-in-the-middle can't substitute it. Verification is fail-closed.

- **Anyone Protocol hidden services** for all transport - content *and* network location are hidden.

- **Encrypted at rest** \- what AnonChat keeps on disk (contacts, groups, message keys, history, media, waiting messages) is sealed with AES-256-GCM under a random data key. The one exception is the private key of your `.anyone` address: the Anyone network program reads it from its own file, which only your user account can open (see the [FAQ](FAQ.md)). The operating system's vault keeps that key (Keychain, Windows, GNOME Keyring or KWallet) and a 6-digit PIN unlocks the app; or choose a passphrase (at least 12 characters) typed at each start, which also protects a stolen disk or backup.

- **Message requests** \- someone who isn't a contact lands in Requests, text only until you accept; Delete, Block, or turn requests off. A request is marked *Not verified yet*: the address on it is only what the sender wrote, and Accept checks it against the keys that address serves.

- **Keys never change silently** \- a contact's keys are pinned when you add them; adding someone already in your contacts is refused, and the *verified* mark shows only for the keys you verified.

- **Message stamps** \- every message between two contacts carries a stamp made with a key only those two share, so nobody can pose as a contact to get past your limits. Strangers get small allowances, and proof of work is asked for only during a flood.

- **Network lock** \- the window can only talk to the local backend, the backend only through the SOCKS proxy (`socks5h`, names resolved inside the network), and WebRTC is removed: nothing can leave outside the Anyone network. Links in messages open in your own browser only after a warning: unless that browser uses AnonChat's SOCKS5 proxy, the site sees your IP address.

- **Traffic padding** \- the link to the first relay always carries padding (`ConnectionPadding 1`), hidden-service routes are padded too, and no two relays on a route share a network (`CircuitPadding`, `EnforceDistinctSubnets`), so an observer of your connection can't easily tell when you send or receive.

- **Trust-on-first-use pinning** with safety-number verification per contact.

###  Messaging

- Real-time 1:1 messaging over the onion network, with optimistic send and delivery status.

- **Group chats** (up to 10 members) with admin controls, descriptions, and member management. Each person's picture appears beside the first of their messages in a row. Members talk directly to each other, so a group works while its admin is offline; only joining with the invite code and changes to the group wait for the admin. Your own message shows at once (⏳ while it is handed to every member), and when someone leaves, the admin's app passes the new member list on to everyone.

- **Identity backup** \- Settings → Backup saves your address, message keys, contacts, groups and settings in one file encrypted with a passphrase; restore it on another computer from the welcome screen. Message history and other people's pictures aren't included, and only one computer should run an address at a time (format: [docs/BACKUP-FORMAT.md](docs/BACKUP-FORMAT.md)).

- **Replies**, **reactions**, and **disappearing messages** (per-conversation TTL).

- **Voice calls** \- full-duplex, end-to-end encrypted calls with a contact, entirely inside the Anyone network (see *Voice calls* below).

- **Voice messages** (up to one minute, with a live timer, level meter and cancel) and drag-and-drop **file / image / video sharing** (up to 5 MB), kept encrypted on disk; Settings → Storage shows usage per chat and clears old media.

- **Offline delivery** \- a message to a contact who is offline waits on your computer and is retried every 15 s for 1, 12 or 24 hours (per chat). It goes out as soon as they are back: their app tells yours when it comes online, and so does any message from them. A route that stopped working is replaced by itself after a failed try, and **Rebuild network path** (the chat's ⋮ menu) does it at once. A dot shows whether each contact can be reached.

- **Messages in the order written** \- each message goes out on its own (no waiting behind the one before), and the receiving app shows them in the order they were written even when the network delivers them out of order.

- **Read receipts** (opt-in), **pinned conversations**, unread separators, and jump-to-latest.

- **Message search** across a conversation, and local petnames for contacts.

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



## How It Works

1. **Identity creation** — on first launch, AnonChat generates your encryption keys and starts an Anyone Protocol hidden service. Your `.anyone` address is derived from your key.

2. **Address exchange** — you and your contact share `.anyone` addresses through a channel you already trust (in person, or another secure app). Never rely on a stranger sending you one.

3. **Session establishment** — adding a contact fetches and pins their public keys and signed prekey; the first message runs an X3DH handshake to derive a shared secret.

4. **Secure messaging** — every message is sealed with the Double Ratchet and routed as ciphertext through the onion network. Your node only ever relays encrypted payloads.

### Voice calls

Press the phone button in a conversation header. The other side gets a ringing card and can accept or decline; calls are only possible between contacts, and Settings has a switch to refuse incoming calls.

- **Signalling** (invite / accept / decline / cancel / end) is sent as ordinary Double-Ratchet messages, so the caller and callee are authenticated exactly like chat messages. Each side adds a fresh ephemeral P-256 key; call keys come from ECDH + HKDF (one key per direction) and exist only for that call.
- **Audio** is Opus (WebCodecs, 24 kbit/s constant bit rate) in 40 ms frames, each sealed with AES-256-GCM using a counter nonce (replayed, altered or forged frames are dropped). Frames have a fixed size and are sent at a constant rate even while you are muted, so the stream does not reveal when you speak.
- **Transport** is one WebSocket per call: your browser → your local backend → the loopback SOCKS proxy → the other node's hidden service. The backend only forwards ciphertext. If a circuit breaks, the caller redials the same path and the call carries on. Live audio is never queued: when a link is congested, frames are dropped rather than delayed.
- **No clearnet, ever**: voice uses no WebRTC, STUN, TURN or UDP. The WebRTC API is removed from the page before any other script runs, the desktop shell forces `disable_non_proxied_udp`, the Content-Security-Policy only allows the local backend, and the backend can only open the call link through the SOCKS proxy (`socks5h`, so the `.anyone` name is resolved inside the network). `npm test` checks all of this (check 14).
- **What to expect**: a call crosses five relays plus the rendezvous point, so expect about 2 to 3 seconds from mouth to ear, like a satellite call: about a second of network, plus a cushion that rides out the route's pauses instead of cutting out. The call card shows the live delay. The other side's voice is played through an ordinary audio player in the page, which the system's echo cancellation knows about; headphones still give the cleanest sound.

### No metadata leaks

- No phone number or email

- No account or central server logs

- No IP exposure to peers

- Only encrypted payloads over anonymous routing

---

## Architecture

AnonChat is an **Electron desktop app** wrapping a local Node.js backend and a sandboxed web UI. There is no cloud component — the "server" is a loopback process on your own machine that speaks to the Anyone network.

| Layer                                                                                    | Technology                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Desktop shell**                                                                        | Electron 44 (Chromium 152); backend on Node 22 LTS                                       |
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
| Prekey substitution / MITM                             | ECDSA-signed prekeys, pinned per contact (fail-closed) |
| Replay                                                 | Per-message consumed-key set in the ratchet            |
| Offline disk access                                    | Everything on disk encrypted; key in the OS vault or under a passphrase |
| Inbox flooding by strangers                            | Small stranger allowances, proof of work during a flood, a hard total with "retry later" |
| Posing as a contact to get their inbox allowance       | Every message carries a stamp made with a key only the two people share (deniable: proves nothing to others) |
| Another program on the computer taking the port your address uses | The app takes it first and stops (saying so) if it can't |
| A recipient demanding endless proof of work            | Difficulty capped; anything higher refused at once     |
| Draining one-time prekeys                              | Handed out sparingly (20, then 10 an hour); unused private halves dropped after 14 days, 500 at most |
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

- [ ] Android app (native Kotlin, using the Anyone `anon` client for Android)

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
