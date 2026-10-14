# Project management from the linked mobile app

The linked phone shows **New project**, **Rename project**, and **Move chat to…** alongside the
project selector. Tap New project, enter a name, leave the folder blank for a fresh desktop
workspace, and tap Save. The desktop persists the project and opens a fresh chat; normal mirroring
brings that state back to the phone. Existing chats and files are preserved. A project is not an
automatically created GitHub repository.

Folders always belong to the linked desktop, not the phone's browser storage. An optional existing
PC folder can be typed into the form, but it must already be approved on the desktop. The phone
does not launch a desktop folder picker or grant filesystem access remotely. Leave the field blank
to create an isolated app-owned project folder without needing a desktop approval dialog.

Save waits for an acknowledged desktop result. Busy tasks, pending approvals, a stale active chat,
missing projects, unready/corrupt storage, folder approval failures and disk errors produce visible
errors rather than silent success. Chat membership changes persist before acknowledgement; they
change the selected workspace only and never move the old files or chat history. Rename preserves
the workspace path. Project changes are serialized and briefly prevent starting/switching chat work.

The phone uses correlated request IDs and stable create IDs. Duplicate frames and retries after an
unconfirmed response cannot silently create the same project again. Successful create IDs also
survive a desktop restart in the stored project list. Requests have a 30-second confirmation limit;
after a timeout, check the project list before retrying. A known desktop error permits correction;
an unconfirmed retry of the same action in the same phone page reuses its request. A phone page
reload clears its in-memory request cache, so check the authoritative project list before creating
again after a reload or connection closure.

Updated desktops advertise management capability through the chat mirror. Older desktops remain
navigable, but management buttons are disabled with an update/reconnect hint. Management controls
are touch-sized on mobile. The phone never optimistically persists a second project list of its
own, and successful saves request a fresh authoritative desktop snapshot.

Deploy the desktop build containing these handlers, then reload the linked phone page to receive
the updated controls. No native API or new approval mechanism is introduced by this feature.
