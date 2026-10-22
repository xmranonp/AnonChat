# FAQ & Troubleshooting

## Getting started

**Do I need an account, email, or phone number?**
No. Your identity is your `.anyone` address, generated locally on first run. There
are no accounts and no central servers.

**How do I add a contact?**
Exchange `.anyone` addresses **out-of-band** (in person, or over another secure
channel) and add the contact by their address. Your device connects to their
hidden service to fetch their keys — the onion address itself authenticates them,
and their identity key is pinned on first contact.

**Where is my data stored, and is it encrypted?**
Messages and calls are end-to-end encrypted in transit, and in the desktop app **what AnonChat keeps on disk
is encrypted too**: contacts, groups, settings, the block list, waiting and unsent messages, your identity keys
and your message history. The one exception, the private key of your `.anyone` address, is explained under
*Limits* below. Settings → Security shows how.

- A random **data key** encrypts it all. It is never stored in the clear: by default the operating system's
  own vault keeps it (Keychain on macOS, Windows' per-user encryption, the GNOME keyring or KWallet on
  Linux). Nothing to type, and a copy of the files can't be read on another computer or by another user.
- The **PIN** unlocks the app. Your keys and history are encrypted with the PIN *and* the vault's key
  together, so the PIN's million possible values can't be tried against a copied disk.
- **Optional passphrase** (on the first start, *Use a passphrase instead* under the PIN keypad; or later in Settings →
  Security → Use a passphrase): you type it when AnonChat starts,
  instead of the PIN. It also protects a stolen disk or backup against someone who can sign in as you,
  which the vault can't. Use several words; at least 12 characters.
- **Linux without a keyring** (some minimal desktops): AnonChat asks you to choose a passphrase on the
  first start instead.
- **Limits:** the private key of your `.anyone` address is read by the Anyone network program from its
  own file, so that file is protected by folder permissions only. Someone who controls your running,
  unlocked computer can see what you see. The browser mode (`npm start`) has no vault: there the PIN
  protects keys and history, and contacts and groups are stored unencrypted.

Data lives in one folder, in the OS-standard per-user location — `~/.local/share/anonchat` on
Linux, `~/Library/Application Support/anonchat` on macOS, `%APPDATA%\anonchat` on Windows.
The app window's own storage (keys, history, media) is the `window` subfolder.

**Are photos and voice messages kept? How much history is kept?**
Yes. Messages, photos, voice messages and files are kept on this computer, encrypted, with no limit other
than free disk space.
**Settings → Storage** shows how much each chat uses and can remove media — from one chat, or from all chats
for anything older than 30 days — while keeping the text. If the disk ever runs short, a banner says so, and a
message that couldn't be saved is marked **Not saved** instead of disappearing silently.

**Does uninstalling delete my identity and messages?**
No, so a reinstall picks up where you left off. To remove them, use **Settings → Erase
everything** before uninstalling: it deletes the whole data folder and closes the app. On
Windows the uninstaller also asks whether to delete them (the answer defaults to No). On
Linux (`apt remove`, `pacman -R`) and macOS (dragging the app to the Trash), the package
tools never touch your home folder; if the app is already gone, delete the data folder above
by hand. On SSDs, deleted files may still be recoverable with forensic tools.

**Who can write to me?**
Your contacts, and anyone who knows your address as a **message request** (Settings →
Message requests, on by default). Requests wait behind the inbox button next to Add contact:
a dot shows when one arrives, the text stays hidden until you open it, and you can Accept
(you choose the name), Delete or Block. A request is marked **Not verified yet**: the address on it
is only what the sender wrote. Accept checks it against the keys served at that address, and a forged
request is deleted. Until someone accepts your own request, you can send them text only. Members of a group you're in can write to you in that group without being
contacts; their keys are fetched from their own address and pinned, like a contact's.

**What happens if I remove a contact, or they remove me?**
Whatever they write afterwards arrives as a message request. If they removed you and you
write to them, their app tells yours, and you can send text only until they accept you
again: that also means you learn that they removed you.

**Who sees my profile picture?**
In the app: your contacts see your picture and status line, and the members of your groups
see your picture beside your group messages. Both are served from your own address, so
anyone who has your address can fetch them: don't put anything there you wouldn't show a
stranger who has it.

**How do I move AnonChat to another computer?**
Settings → Backup → **Create backup**: confirm with your PIN or passphrase, then choose a passphrase
for the file (at least 12 characters). On the new computer, choose **Restore from a backup** on the
welcome screen. The file holds your address, message keys, contacts, groups and settings; not your
message history, and not other people's pictures (they come back when they next write). Keep it
offline: anyone with the file and its passphrase can be you. Run your address on one computer at a time.

**What happens after a restore?**
Every contact and group member gets a new encrypted session from your app automatically. Messages
sent to your old app while you were moving may be lost. Each group's admin sends the current member
list, so anyone who joined or left meanwhile is caught up. Restoring from Settings on a computer
already in use erases everything on it first.

**What happens when a link in a message is clicked?**
It opens in your usual browser, outside AnonChat, after a warning. If that browser uses
AnonChat's SOCKS5 proxy (shown in the Circuits tab), the visit goes through the Anyone
network; if not, it is a direct connection and the site sees your IP address.

**What if I forget my PIN or passphrase?**
There is **no server and no account recovery**: nobody can reset either one, and the data can't be
decrypted without it. With a passphrase, the start screen has **Forgot it?**, which erases everything
on this computer so you can start over with a new identity (your contacts will need your new address).
Treat both as important.

**What does "Exit country" do?**
In the Circuits tab you can choose which country your SOCKS5 traffic exits from.
The list shows each country with its flag and the number of exit relays
available (countries with fewer than three exit relays are not listed, and Russia and Serbia are never offered). *Global* (the default) lets the network choose. With a country
selected, only exit relays in that country are used, and if none are available
the traffic pauses rather than quietly using another country. This only affects
traffic that leaves the Anyone network (for example a browser or another app
using the SOCKS5 proxy, or the update check). Messages to `.anyone` contacts
never use exit relays, so they are not affected.

**The exit-country list says "Waiting for the network…"**
The list is prepared in the background as soon as the `anon` daemon reports that
it is fully bootstrapped, so it appears at that point with no extra wait. If it
says "Downloading the country database…", the offline country data is being
fetched over the Anyone network (first run, or about once a week).

**How do I send other apps through the SOCKS5 proxy?**
AnonChat does not change your system or browser proxy settings. For an app's
traffic to go through the Anyone network (and use the exit country you chose),
that app, or your system, has to be set to use the SOCKS5 proxy shown in the
Circuits tab (`127.0.0.1` and the port next to it, normally 9050). Apps that
are not set to use it are not routed. Where the app offers it, also choose
"proxy DNS when using SOCKS5" so name lookups are sent through the proxy too.

**What do the circuit states mean? ("Building… 1 of 3 relays")**
A circuit is built one relay at a time. While it is being built it shows
"Building…" (for ordinary circuits, how many of its three relays are in place so
far). Once every relay is connected it shows "Built" and can carry traffic. A
circuit that stays in "Building…" for long is stuck on a slow or unreachable
relay; `anon` gives up on it and builds another one by itself.

**What does "Request new circuit" do?**
It closes the circuits that carry your SOCKS5 (exit) traffic and immediately
starts a new one, so the next connections leave through a different path (still
within the exit country you chose). A download using the old circuit is
interrupted. Circuits used for messages to `.anyone` contacts are not touched.

**What is "Dynamic port"?**
The SOCKS5 proxy normally listens on `127.0.0.1:9050`. With Dynamic port on (the
default), AnonChat picks the next free port if 9050 is already taken, for
example by another Tor or Anyone client. The address in use is shown in the
Circuits tab. Changing the toggle takes effect the next time AnonChat starts.

**Does closing AnonChat stop everything?**
Yes. Quitting the app stops the whole backend: the local server, the `anon`
daemon and its SOCKS proxy. The app asks them to stop, waits for them to exit,
and force-kills anything that doesn't. If the app itself crashes or is killed,
the backend notices within a couple of seconds and shuts itself down. Only one
copy of the app can run at a time, so a second launch just brings the first
window to the front.

---

## First launch

**Windows blocks the installer.**
AnonChat isn't signed yet. "Windows protected your PC": More info → Run anyway.
"Smart App Control blocked an app": turn Smart App Control off in Windows Security →
App & browser control, then try again. This applies to all programs and may not be
reversible without resetting Windows.

**AnonChat says another program is using its port (47822).**
Everything that reaches your address is handed to that port on your computer. If another program
holds it, AnonChat stops instead of letting that program receive your messages. Close the other
program (or restart the computer) and start AnonChat again.

**The app is slow to start, or the relay map says "Locating relays…"**
On first launch, the `anon` daemon has to bootstrap onto the network and publish
your hidden service, and the relay-map geo database downloads over the onion
proxy. This is normal and usually completes within a minute or so — the map fills
in and messaging becomes available once bootstrap finishes. Subsequent launches
are much faster (cached state).

---

## Voice calls

**How do voice calls stay private?**
Signalling goes through the same end-to-end encrypted ratchet as messages; the audio
travels over a single connection through the Anyone network to your contact's hidden
service and is encrypted again with keys that exist only for that call. There is no
WebRTC, no STUN/TURN server and no UDP, so nothing can reveal your real IP address.

**Why is there a delay?**
Every call crosses the onion network in both directions (five relays plus the
rendezvous point). Expect about 2 to 3 seconds from mouth to ear: about a second of
network, plus a cushion of audio that rides out the route's pauses instead of cutting
out. Take turns speaking. The call card shows the current delay.

**I hear an echo.**
The other side's voice is played through the system's audio player, which its echo
cancellation takes into account. If you still hear your own voice coming back, the
other person's computer isn't cancelling it: headphones on their side remove it.

**The call says "Reconnecting..."**
A circuit broke. The caller's side rebuilds it automatically and the call resumes
(it gives up after about a minute).

**Can anyone call me?**
Only your contacts. You can switch incoming calls off in Settings > Privacy.

**Calls are not supported on this system.**
Calls need the Opus audio codec and microphone capture of the bundled Chromium
(any release of the desktop app has them). A microphone must be available.

## Messaging & delivery

**Can I message someone who's offline?**
Yes, with caveats. AnonChat is peer-to-peer with **no store-and-forward server**,
so there is no cloud mailbox. When a recipient is offline, your message is queued
in a **persistent local outbox** and retried every ~15 seconds — this survives app
restarts and keeps trying for the waiting time set for that chat: **1, 12 or 24 hours**
(24 by default). Read receipts, reactions and group notices wait up to 7 days. It is
delivered automatically when the recipient is reachable again: their app tells yours
when it comes back online.

The practical limitation: **your app must be running to deliver.** Delivery happens
when the recipient is online *and* your AnonChat is open to retry. This does not
have to be continuous, but both need to coincide at least once within the waiting
time. A message still undelivered after that is marked as not delivered.

**A message shows ⏳.**
That means the recipient isn't currently reachable — the message is safely queued
in the outbox and will send automatically once they're back (see above). You don't
need to resend. In a group, ⏳ shows while your message is handed to every member;
anyone who can't be reached gets it as soon as they can.
To see why it is waiting, open the network panel (antenna button) → **Status**: lines
marked `[AnonChat]` say what happened on the last tries to that address (shortened), for
example "address not found on the network (descriptor not found)" or "found its address,
but could not reach it (introduction failed)", and "delivered after N tries" once it gets
through. They are kept in memory only, and are gone when the app closes.

**Someone left a group but is still listed.**
Each member's app removes them when their notice arrives, and the admin's app then sends
everyone the new list. If you missed both (you were offline the whole time), the list is
corrected when the admin's app can reach you again.

**Messages to a contact who just came back online are still waiting.**
When a contact restarts, their hidden service publishes a **new descriptor with new
introduction points**, while your device may still hold the old one, and the network
won't look the address up again at the same directories for 15 minutes. AnonChat
handles this: when their app is back online it tells yours, and your app clears the
network's stale lookups (NEWNYM) and sends at once. The same happens when they write
to you. A route that stopped working is also replaced by itself after a failed try.
If messages to one contact still wait while that contact can write to you, use
**Rebuild network path** in the chat's ⋮ menu: it closes the old route, clears the
stale lookups and sends what is waiting.

**I can receive from a contact, but my messages to them always wait.**
Their app can reach yours, but your app can't reach theirs: their address isn't reachable
on the network right now, while they can still send. Look at the **Status** lines
`[AnonChat]` for the reason, and ask them to look at the **Service** line of their own
Status tab: "Reachable • intro points: 3" is normal; "Published, no introduction points"
means nobody can reach them at the moment. The usual causes are a computer (or virtual
machine) that slept or was paused overnight, its clock being wrong, or the same address
running on two computers at once. Restarting AnonChat on *their* side, with the clock
right, publishes their address afresh.

**I got a "safety number changed" / key-change warning.**
This means the contact's identity key no longer matches what you pinned. It can be
legitimate (they reinstalled or reset their identity) or, rarely, a sign of
interception. Re-verify the safety number with them out-of-band before continuing
to treat the conversation as secure. AnonChat never replaces a contact's keys by itself:
adding someone who is already a contact is refused. If they really reinstalled without a
backup, remove them, add them again and verify the new safety number; the *verified* mark
only shows for the keys you verified.
