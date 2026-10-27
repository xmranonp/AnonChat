# Browser suites

Real `server.js` nodes (with the real Express, axios and socks-proxy-agent from `npm install`) and the real window in Chromium. Nodes
reach each other through a small fake SOCKS proxy (`fsocks.mjs`) that maps the test `.anyone` addresses to local ports, so the whole
outbound path except the onion hop itself is exercised. The desktop app's own API is stubbed where a suite needs it.

    npm install                                   # in the project root
    pip install playwright && playwright install chromium
    python3 tests/browser/run.py                  # every suite, one after another (about 40 minutes)
    python3 tests/browser/run.py groups backup    # only some

Each suite can also run on its own: `python3 tests/browser/groups.py [APP] [NODE_PATH] [OUT]` (all optional). Screenshots go to OUT,
a new temporary folder by default.

| Suite | What it checks |
| --- | --- |
| `circuits` | Network panel: circuits, the map, per-contact circuit |
| `emoji` | Emoji picker, search by English name, skin tones |
| `firstpass`, `novault`, `security`, `storage` | Encryption on this device: data key, PIN or passphrase, no keyring, history and media in IndexedDB |
| `backup` | Language pill; Create backup; restore on a fresh install; contacts and group members write again afterwards |
| `groups` | Groups with members who aren't each other's contacts, Requests, group picture, Erase everything |
| `notify`, `callnotice`, `ring` | Desktop notifications for messages, requests and calls; the ringing contact card |
| `pin` | Pinned chats |
| `audit_*` | Tests written for the pre-launch audit: hostile contact data, removed contacts, bursts, Escape, load and window sizes |
| `audit2_*` | Tests from the second audit pass: removing a group member (and a modified client's bad reaction), sending to someone offline and quitting, keeping order, the first message long after adding a contact, what the sender sees when the outcome came while the window was closed, group messages for members who were offline, your own address refused and names you didn't choose, Leave group on right-click, removing contacts and writing again |
| `audit3_cross` | Third pass: two people who both write first, on a network where each connection takes a while to open: every message arrives once, both ways, and later ones too |
| `audit3_deadpath` | Third pass: a failed try to a contact closes the route the last try to them used, at most once a minute; their address is looked up again at most every 5 minutes; when they come back online their app tells us, and then (if our messages to them are failing), or when "Rebuild network path" is pressed, the network's stale lookups are cleared (NEWNYM). A fake control port records the commands |
| `audit3_map` | Third pass: the Circuit map button in a conversation shows that contact's circuit the first time the panel opens (needs WebGL); during a call Ana makes, the route carrying it is marked in the Circuits tab and on the map, and unmarked when it ends |
| `audit3_callaudio` | Third pass: a call with the browser's test tone: the other side's voice plays through an audio player in the page (what echo cancellation listens to), the audio arrives and is decoded both ways, a 2–3 s delay counts as good, and hanging up stops the players |
| `audit4_fixes` | Fourth pass (audit fixes): adding someone already in your contacts is refused and their keys stay; a picture named like a program is saved with the ending of what it really is |
| `audit5_groups` | Fifth pass: your own group message shows at once (⏳ while it is handed over) in the group it was written in, even with an unreachable member; a member who missed a leave notice gets the new list from the admin; after a restore from a backup, each group's admin sends the current list |
| `audit6_fixes` | Sixth pass (audit fixes): a group message for a member who is offline waits 24 h at most, like a one-to-one message, not the queue's 7 days; the three selects in Settings have a name for a screen reader |
| `connection_test` | Test connection (conversation menu): the panel's steps with a contact up and down, the verdict, a waiting message going out when the test finds the contact again, Escape and Close, the API refusing strangers and bad addresses |
| `network_ready` | Waiting for the network (switch on, fake network program): nothing is sent below 100% or with a day-old relay list, and what waits goes out after one clear-out; our own address looked up through the network: found, not found (clear-out, then the details sent again), found again; the Status line and Test connection say so; the light beside the app name: amber while connecting, cyan when reachable and findable, amber when not findable or not published, red when the link to the app is lost |
| `spk_rotation` | The signed prekey is replaced every week: a contact still holding the old one can start a chat (the first message is read with the retired key); contacts take the new one from the profile, signature checked; retired keys are deleted after 60 days |

The code checks (`node tools/run-checks.mjs`) are separate and much faster; run both before a release.
