# FAQ

> **Security review status:** AnonChat has been audited by an AI model (Claude, by Anthropic), but it has not had a human security review yet.

## Getting started

**Do I need an account, email or phone number?**
No. Your identity is your `.anyone` address, created on your computer at the first start. There are no accounts and no central servers.

**How do I add a contact?**
Exchange `.anyone` addresses outside the app (in person or over another secure channel) and add the contact by address. Your app fetches their keys from their own address and pins them. Compare **safety numbers** (the shield in the chat) to be sure no one is in the middle.

**Who can write to me?**
Your contacts, and anyone who knows your address as a **message request** (Settings → Message requests; on by default). Requests wait behind the inbox button: text stays hidden until you open one, and you can Accept, Delete or Block. A request is marked *Not verified yet*; Accept checks the address against the keys it serves, and a forged request is deleted. Members of a group you are in can write to you in that group without being contacts.

**What if a contact removes me, or I remove them?**
Whatever they write afterwards arrives as a message request. If they removed you and you write to them, you can send text only until they accept you again.

**Who sees my picture and status?**
Your contacts and group members. They are served from your own address, so anyone who has the address can fetch them: don't put anything there you wouldn't show a stranger.

## Your data

**Is my data encrypted?**
Messages and calls are end-to-end encrypted. In the desktop app, everything AnonChat keeps on disk is encrypted too (contacts, groups, settings, history, media, queued messages, your keys). A random data key does this; the OS vault keeps it (Keychain, Windows, GNOME Keyring or KWallet), so a copy of the files can't be read on another computer or account. The **PIN** unlocks the app and is combined with the vault's key, so a copied disk can't be attacked by trying PINs. A **passphrase** (at least 12 characters, typed at each start; chosen at first start or in Settings → Security) also protects against someone who can sign in as you. Linux without a keyring asks for a passphrase at first start.

**What is not encrypted?**
The private key of your `.anyone` address (the Anyone network program reads it from its own file; folder permissions protect it), and everything in **browser mode** except keys and history (the PIN alone protects those there). Someone who controls your unlocked computer sees what you see. Deleted and expired messages are removed from the app, but older encrypted copies can stay in the storage files for a while.

**Where is it stored?**
`~/.local/share/anonchat` (Linux), `~/Library/Application Support/anonchat` (macOS), `%APPDATA%\anonchat` (Windows). The window's own storage is the `window` subfolder.

**How much history is kept?**
All of it, encrypted, limited only by free disk space. Settings → Storage shows usage per chat and can remove media older than 30 days while keeping the text. A message that can't be saved is marked **Not saved** instead of disappearing.

**Does uninstalling delete my identity?**
No, so a reinstall picks up where you left off. Use **Settings → Erase everything** first to remove it. On SSDs, deleted files may still be recoverable with forensic tools.

**What if I forget my PIN or passphrase?**
Nobody can reset it: there is no server and no recovery. With a passphrase, the start screen has **Forgot it?**, which erases everything on this computer so you can start over with a new address.

**How do I move to another computer?**
Settings → Backup → **Create backup**, protected by a passphrase of its own (at least 12 characters). On the new computer choose **Restore from a backup** on the welcome screen. The file holds your address, keys, contacts, groups and settings, but not message history. Keep it offline: anyone with the file and its passphrase can be you. Run an address on one computer at a time. After a restore, every contact gets a new encrypted session automatically; messages sent while you were moving may be lost.

## Privacy and network

**What happens when I click a link?**
It opens in your usual browser after a warning. Unless that browser uses AnonChat's SOCKS5 proxy (shown in the Circuits tab), the site sees your IP address.

**Does the app use spell checking or a system proxy?**
On Linux and Windows the spell checker is off (it would download dictionaries from Google). The app never uses the system proxy.

**Does AnonChat check for updates?**
Only when you ask, or when you switch it on. Settings → Updates → **Check for updates** asks the project's releases page whether a newer version exists. With **Check for updates when AnonChat starts** on (it is off by default), the same check runs once at every start, after the network is ready, and a window appears only for a version you haven't seen yet. Either way the request leaves through the Anyone network on a route of its own, new at every start. AnonChat never downloads or installs anything: it shows the version and the link. Open the link in a SOCKS5 compatible browser (your usual browser would reach GitHub directly and show your IP address), using the Anyone proxy `127.0.0.1`, normally port 9050, then compare the file with `SHA256SUMS.txt` on the release page.

**What does "Exit country" do?**
In the Circuits tab it chooses where SOCKS5 traffic leaves the Anyone network, for apps you point at the proxy (`127.0.0.1`, normally port 9050). Messages to `.anyone` contacts never use exits. AnonChat doesn't change your system or browser proxy settings.

**What is "Dynamic port"?**
If port 9050 is taken, the next free one is used. With it off and 9050 taken, AnonChat doesn't start rather than use a port that isn't its own.

**Why did AnonChat stop with "The Anyone network program stopped"?**
Its own `anon` program exited. Without it, another program could take the port, so AnonChat stops instead of sending anything. Start it again; if it repeats, read the last lines of `anon/anon.log` in the data folder.

**Does closing AnonChat stop everything?**
Yes: the backend, `anon` and the proxy stop with it. Only one copy of the app runs at a time.

## Messages and delivery

**Can I message someone who's offline?**
Yes. There is no store-and-forward server, so your message waits in a local queue and is retried about every 15 seconds for 1, 12 or 24 hours (per chat, 24 by default). **Your app must be running to deliver**, and the two of you must be online together at least once within that time. After that it is marked as not delivered.

**A message shows ⏳.**
The contact isn't reachable right now; the message is queued and will go out by itself. In a group, ⏳ shows until every member has received it. To see why, open the network panel (antenna button) → **Status**: lines marked `[AnonChat]` say what happened on the last tries.

**I can receive from a contact but my messages to them wait.**
Their app can reach yours, but yours can't reach theirs. Use **Test connection** in the chat's ⋮ menu: it checks your own address, the contact's address, whether their app answers and whether the two clocks agree, then says what to do. **Rebuild network path** (same menu) clears the old route. Common causes are a computer that slept, a wrong clock, or the same address running on two computers.

**What do the colours beside the app name mean?**
Cyan: ready, and your address can be found. Amber: the network is starting, or your address is not reachable yet (hover to see which). Red: the window lost its link to the app. Cyan says people can reach *you*, not that a given contact is online (that is the dot on their picture).

**I got a "safety number changed" warning.**
The contact's identity key no longer matches what you pinned. They may have reinstalled, or, rarely, someone is intercepting. Compare the new number with them outside the app before trusting the chat. AnonChat never replaces a contact's keys by itself: if they reinstalled without a backup, remove them, add them again and verify.

## Voice calls

**How private are calls?**
Signalling uses the same encrypted ratchet as messages; the audio travels through one connection inside the Anyone network, encrypted again with keys made for that call. No WebRTC, STUN, TURN or UDP, so nothing can reveal your IP address.

**Why the delay?**
A call crosses the onion network in both directions: expect 2 to 3 seconds from mouth to ear. Take turns speaking. An echo means the other side isn't cancelling it; headphones fix it.

**Who can call me?**
Only your contacts. Switch calls off in Settings → Privacy. If the call says "Reconnecting…", a circuit broke and the caller's side rebuilds it (it gives up after about a minute).

## First launch

**Windows blocks the installer.**
AnonChat isn't signed yet. On "Windows protected your PC", choose More info → Run anyway. If Smart App Control blocks it, you must turn Smart App Control off in Windows Security → App & browser control; this applies to all programs and may not be reversible without resetting Windows. Check the file against `SHA256SUMS.txt` before installing.

**It says another program is using port 47822.**
Everything that reaches your address is handed to that port. If another program holds it, AnonChat stops rather than let it receive your messages. Close the other program (or restart the computer) and start again.

**The first start is slow, or the map says "Locating relays…".**
The first time, `anon` has to join the network and publish your address, and the relay-map database downloads through it. This usually takes about a minute. Later starts are faster.
