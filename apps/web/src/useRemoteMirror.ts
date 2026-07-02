import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import {
  chunkArrayBuffer,
  concatArrayBuffers,
  forgetSkill,
  saveMemory,
  saveSkill,
  type BookSource,
  type BookSummary,
  type BuddyToolCall,
  type BuddyToolResultPayload,
  type MemoryNote,
  type Skill,
  type StoredChatMessage,
  type VisualBible,
  type VisualReaderStore,
} from "@visual-reader/core";
import type { LocalBackendId, ReaderSettings } from "@visual-reader/ui";
import type {
  AppSyncMessage,
  ChatLive,
  ChatMirror,
  CmdToDesktop,
  EngineInventory,
  EngineVram,
  PlannerCommand,
  PlannerMirror,
  SyncToPhone,
} from "./remote-sync.js";
import { restartApp } from "./runtime.js";

/**
 * PHONE MIRROR: a linked phone shows exactly what the desktop shows — its library, the open book,
 * that book's analysis (bible), and the render-affecting settings. The desktop is the source of
 * truth and pushes its state down the relay; the phone renders it and sends back high-level
 * commands (open a library book, go home). The engine stays on the desktop, so illustrate/analyse/
 * chat the phone triggers run there and stream their results back — the phone never needs its own
 * image model or data. (`isRemoteClient` ⇒ this tab IS the phone.)
 *
 * This hook owns the whole mirror: the hello snapshot, the single relay-handler registration (the
 * vrsync/vrcmd switch), the per-slice desktop→phone push effects, and the phone's debounced
 * settings relay. Chat/planner/host-tool machinery is declared lower in App.tsx, so the hook
 * exposes REFS for those seams (mirror payloads, apply-handlers, relayed-command runners) that the
 * host assigns via effects — the same late-binding pattern the inline code used, now as an explicit
 * interface instead of closure coupling.
 */

/** Outcome of a phone-triggered software update relayed back via vrsync:updateStatus. */
export interface UpdateResult {
  status: "uptodate" | "updated" | "needs-restart" | "error";
  message: string;
}

export interface RemoteMirrorDeps {
  /** True when this tab IS the phone (renders the desktop's mirror, relays commands up). */
  isRemoteClient: boolean;
  sendAppSync: (msg: AppSyncMessage) => void;
  /** Registers THE relay handler (single registration; reads live refs to stay current). */
  setAppSyncHandler: (fn: (msg: AppSyncMessage) => void) => void;
  libraryStore: VisualReaderStore;

  // Desktop state slices mirrored down to the phone (also the hello-snapshot contents).
  library: BookSummary[];
  settings: ReaderSettings;
  engineInventory: EngineInventory;
  memories: MemoryNote[];
  skills: Skill[];
  book: BookSource | undefined;
  bible: VisualBible | undefined;
  effectiveVram: EngineVram | undefined;

  // Phone-side adopt callbacks (apply a desktop push to local state).
  setLibrary: (books: BookSummary[]) => void;
  setSettings: (s: ReaderSettings) => void;
  applyInventory: (inv: EngineInventory) => void;
  setMemories: (notes: MemoryNote[]) => void;
  setSkills: (skills: Skill[]) => void;
  setBook: (book: BookSource | undefined) => void;
  setBible: (bible: VisualBible | undefined) => void;
  setRemoteVram: (vram: EngineVram | undefined) => void;
  setRemoteHost: (host: string | undefined) => void;

  // Desktop-side actions for phone-relayed commands.
  openBook: (source: BookSource) => void;
  closeBook: () => void;
  refreshSkills: () => void;
  /** vrcmd:chatPlanClear — the phone dismissed the working checklist; clear plan+workflow+memos. */
  clearBuddyPlan: () => void;

  // Host-owned refs the handler reads (declared in App.tsx, passed in so the single registration
  // sees live values).
  bookRef: MutableRefObject<BookSource | undefined>;
  settingsRef: MutableRefObject<ReaderSettings>;
  /** Book id the PHONE closed — passive re-pushes of that same book are ignored (no re-yank). */
  phoneExitedBookId: MutableRefObject<string | undefined>;
  buddyMessagesRef: MutableRefObject<StoredChatMessage[]>;
  activeBuddyIdRef: MutableRefObject<string>;
}

export function useRemoteMirror(deps: RemoteMirrorDeps) {
  const {
    isRemoteClient,
    sendAppSync,
    setAppSyncHandler,
    libraryStore,
    library,
    settings,
    engineInventory,
    memories,
    skills,
    book,
    bible,
    effectiveVram,
    setLibrary,
    setSettings,
    applyInventory,
    setMemories,
    setSkills,
    setBook,
    setBible,
    setRemoteVram,
    setRemoteHost,
    openBook,
    closeBook,
    refreshSkills,
    clearBuddyPlan,
    bookRef,
    settingsRef,
    phoneExitedBookId,
    buddyMessagesRef,
    activeBuddyIdRef,
  } = deps;

  // The planner (tasks + calendar) state is declared lower in App.tsx, so the hello snapshot and
  // the phone's apply-handler reach it through refs kept current by effects there (the same pattern
  // as buildSnapshotRef).
  const plannerMirrorRef = useRef<PlannerMirror>({
    tasks: [],
    calendarEvents: [],
    calendarMonth: new Date().toISOString(),
    calendarLoading: false,
    googleConnected: false,
  });
  const applyPlannerRef = useRef<(p: PlannerMirror) => void>(() => {});
  const plannerCommandRef = useRef<(c: PlannerCommand) => void>(() => {});
  // The landing-page chat (buddy) lives lower in App.tsx too, so the hello snapshot + the phone's
  // apply-handler + the desktop's relayed-command runner reach it through refs (same pattern as the
  // planner). `chatMirrorRef` holds the latest mirror for the snapshot; `applyChatRef` is the phone's
  // adopt-the-desktop's-chat setter; `chatCommandRef` runs a phone-relayed chat command on the desktop.
  const chatMirrorRef = useRef<ChatMirror>({ sessions: [], activeId: "", messages: [], persona: "assistant", busy: false });
  const applyChatRef = useRef<(c: ChatMirror) => void>(() => {});
  const chatCommandRef = useRef<(c: CmdToDesktop) => void>(() => {});
  // The live in-flight-turn state (streaming/thinking/activity/steps/pending approvals/usage) — held
  // in a ref so the connect snapshot carries it and the throttled push effect (in App.tsx) can land
  // a trailing send; `applyChatLiveRef` is the phone's adopt-the-live-state setter.
  const chatLiveRef = useRef<ChatLive>({ streaming: "", thinking: "", activity: "", steps: [], agentApprovals: [] });
  const applyChatLiveRef = useRef<(l: ChatLive) => void>(() => {});
  const chatLiveSentAt = useRef(0);
  const chatLiveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // DESKTOP: open a PC file (that the phone tapped in a /find result) as a book — assigned in
  // App.tsx, since the importer/openBook wiring is declared later; the early-registered relay
  // handler reaches it here.
  const openLocalFileRef = useRef<(path: string) => void>(() => {});
  // DESKTOP: probe/auto-start a self-hosted engine the PHONE tapped Connect for (it owns the network +
  // filesystem). Assigned in App.tsx, since onConnectLocalServer is declared later.
  const connectLocalServerRef = useRef<(backend: LocalBackendId, url: string) => void>(() => {});
  // DESKTOP: download the managed ffmpeg the PHONE tapped the button for (it owns the filesystem).
  // Assigned in App.tsx, since onDownloadFfmpeg is declared later.
  const downloadFfmpegRef = useRef<() => void>(() => {});
  // PHONE: debounce for the vrcmd:settings relay + the timestamp of the last local settings edit,
  // for the vrsync:settings echo guard (see onSettingsChange).
  const phoneSettingsRelayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const phoneSettingsEditAt = useRef(0);
  // Phone-triggered software update: the DESKTOP runs it via this ref (assigned in App.tsx, since
  // onSoftwareUpdate is declared later); the PHONE holds the in-flight request here so a relayed
  // vrsync:updateStatus can resolve it + reload.
  const runUpdateForPhoneRef = useRef<() => void>(() => {});
  const phoneUpdatePending = useRef<{ resolve: (r: UpdateResult) => void; onProgress: (m: string) => void } | undefined>(
    undefined,
  );
  // Desktop-runtime host tools (find_files/run_command/write_file/screenshot) the PHONE relays here:
  // the desktop runs them via runHostToolForRemoteRef and replies vrsync:hostToolResult, resolved
  // through this per-requestId map.
  const runHostToolForRemoteRef = useRef<(call: BuddyToolCall, cwd?: string) => Promise<BuddyToolResultPayload>>(async () => ({}));
  const hostToolPending = useRef(new Map<number, (p: BuddyToolResultPayload) => void>());
  // PHONE: lazy image-card fetches awaiting the desktop's vrsync:fileData reply, keyed by reqId.
  const fileFetchPending = useRef(new Map<number, (r: { bytes?: ArrayBuffer; mime?: string }) => void>());
  // Partial chunks of an in-flight chunked file fetch (vrsync:fileData), keyed by reqId.
  const fileChunkBufs = useRef(new Map<number, { parts: (ArrayBuffer | undefined)[]; got: number; mime?: string }>());
  // PHONE: inline-image bytes fetched back for stripped messages, kept by attachment id so the restored
  // picture survives the mirror re-pushing its image-less version; plus the ids being fetched right now.
  const restoredImages = useRef(new Map<string, { bytes: ArrayBuffer; mimeType: string }>());
  const fetchingImageIds = useRef(new Set<string>());
  const fileFetchSeq = useRef(0);
  const hostToolReqId = useRef(0);

  const buildSnapshot = useCallback(
    (): SyncToPhone => ({
      type: "vrsync:state",
      host: "this desktop",
      library,
      settings,
      inventory: engineInventory,
      planner: plannerMirrorRef.current,
      chat: chatMirrorRef.current,
      live: chatLiveRef.current,
      memories,
      skills,
      ...(book ? { book } : {}),
      ...(bible ? { bible } : {}),
      ...(effectiveVram ? { vram: effectiveVram } : {}),
    }),
    [library, settings, engineInventory, book, bible, memories, skills, effectiveVram],
  );
  const buildSnapshotRef = useRef(buildSnapshot);
  buildSnapshotRef.current = buildSnapshot;

  // Register the relay handler once: the PHONE applies the desktop's state pushes; the DESKTOP
  // answers the phone's commands. (Reads live refs so the single registration stays current.)
  useEffect(() => {
    setAppSyncHandler((msg) => {
      if (isRemoteClient) {
        switch (msg.type) {
          case "vrsync:state":
            setLibrary(msg.library);
            setSettings(msg.settings);
            applyInventory(msg.inventory);
            applyPlannerRef.current(msg.planner);
            applyChatRef.current(msg.chat);
            applyChatLiveRef.current(msg.live);
            setMemories(msg.memories);
            setSkills(msg.skills);
            setBook(msg.book);
            setBible(msg.bible);
            setRemoteVram(msg.vram);
            setRemoteHost(msg.host);
            break;
          case "vrsync:library":
            setLibrary(msg.library);
            break;
          case "vrsync:settings":
            // ECHO GUARD: the desktop re-mirrors every settings frame we relay up — while a local edit
            // is still in flight (debounce pending, or applied within the last moments), that echo is
            // OLDER than what the user has typed since; applying it would eat their keystrokes.
            if (phoneSettingsRelayTimer.current !== undefined || Date.now() - phoneSettingsEditAt.current < 1500) break;
            setSettings(msg.settings);
            break;
          case "vrsync:inventory":
            applyInventory(msg);
            break;
          case "vrsync:planner":
            applyPlannerRef.current(msg);
            break;
          case "vrsync:memories":
            setMemories(msg.memories);
            break;
          case "vrsync:skills":
            setSkills(msg.skills);
            break;
          case "vrsync:vram":
            setRemoteVram(msg.vram);
            break;
          case "vrsync:chat":
            applyChatRef.current(msg);
            break;
          case "vrsync:chatLive":
            applyChatLiveRef.current(msg);
            break;
          case "vrsync:book":
            // Don't re-yank the reader into a book they CLOSED on the phone: the desktop keeps it open
            // and re-mirrors it on every bible/image update, story beat, or re-render. Ignore those
            // passive re-pushes of the SAME closed book (a DIFFERENT id is a genuine new open → adopt).
            if (msg.book && msg.book.id === phoneExitedBookId.current && !bookRef.current) {
              setBible(msg.bible); // keep the bible fresh so a re-open is current
              break;
            }
            if (msg.book?.id !== phoneExitedBookId.current) phoneExitedBookId.current = undefined;
            setBook(msg.book);
            setBible(msg.bible);
            break;
          case "vrsync:hostToolResult": {
            // The desktop ran a host tool the phone relayed; hand the result to the waiting request.
            const r = hostToolPending.current.get(msg.requestId);
            if (r) {
              hostToolPending.current.delete(msg.requestId);
              r(msg.payload);
            }
            break;
          }
          case "vrsync:fileData": {
            // The desktop is returning a file's bytes (vrcmd:fetchFile), CHUNKED — accumulate until all
            // `total` pieces arrive, then reassemble and resolve. `total === 0` ⇒ the desktop couldn't find it.
            const r = fileFetchPending.current.get(msg.reqId);
            if (!r) {
              fileChunkBufs.current.delete(msg.reqId); // late chunk after a timeout — drop the partial
              break;
            }
            if (msg.total === 0) {
              fileFetchPending.current.delete(msg.reqId);
              fileChunkBufs.current.delete(msg.reqId);
              r({});
              break;
            }
            let acc = fileChunkBufs.current.get(msg.reqId);
            if (!acc) {
              acc = { parts: new Array<ArrayBuffer | undefined>(msg.total), got: 0 };
              fileChunkBufs.current.set(msg.reqId, acc);
            }
            if (msg.mime) acc.mime = msg.mime;
            if (msg.bytes && acc.parts[msg.seq] === undefined) {
              acc.parts[msg.seq] = msg.bytes;
              acc.got += 1;
            }
            if (acc.got >= msg.total) {
              fileChunkBufs.current.delete(msg.reqId);
              fileFetchPending.current.delete(msg.reqId);
              r({ bytes: concatArrayBuffers(acc.parts as ArrayBuffer[]), ...(acc.mime ? { mime: acc.mime } : {}) });
            }
            break;
          }
          case "vrsync:updateStatus": {
            // Progress/result of an update the phone asked for. "working" → progress; otherwise it's
            // the final outcome — resolve the in-flight request, and reload to the new UI if applied.
            const p = phoneUpdatePending.current;
            if (msg.status === "working") {
              p?.onProgress(msg.message);
            } else {
              phoneUpdatePending.current = undefined;
              p?.resolve({ status: msg.status, message: msg.message });
              if (msg.reload) setTimeout(() => window.location.reload(), 2500);
            }
            break;
          }
          default:
            break; // commands are desktop-bound
        }
      } else {
        switch (msg.type) {
          case "vrcmd:hello":
            sendAppSync(buildSnapshotRef.current());
            break;
          case "vrcmd:open":
            void libraryStore
              .getBook(msg.bookId)
              .then((s) => {
                if (s) openBook(s);
              })
              .catch(() => {});
            break;
          case "vrcmd:libraryDelete":
            // The phone deleted a library book; delete it HERE (we own the library) — our library
            // change-effect then re-pushes vrsync:library WITHOUT the book, so it stays gone.
            void libraryStore
              .removeBook(msg.bookId)
              .then(() => libraryStore.listBooks())
              .then(setLibrary)
              .catch(() => {});
            break;
          case "vrcmd:home":
            setBook(undefined);
            closeBook();
            break;
          case "vrcmd:settings":
            // The phone edited settings (it has no engine of its own); apply them here so the
            // desktop renders with them. Our own change-effect re-mirrors them back to the phone.
            setSettings(msg.settings);
            break;
          case "vrcmd:planner":
            // The phone triggered a Tasks/Calendar action; run it here (we own the data) and the
            // planner mirror re-pushes the result.
            plannerCommandRef.current(msg.command);
            break;
          case "vrcmd:memory":
            // The phone edited the Memory panel; save the whole list HERE (we own the store) — our
            // memories-mirror effect then re-pushes vrsync:memories with the saved result.
            void saveMemory(libraryStore, msg.notes).then(setMemories).catch(() => {});
            break;
          case "vrcmd:skillSave":
            // The phone saved a skill; save it HERE (we own the store) and reload → the skills-mirror
            // effect re-pushes vrsync:skills with the result.
            void saveSkill(libraryStore, { name: msg.name, description: msg.description, body: msg.body })
              .then(() => refreshSkills())
              .catch(() => {});
            break;
          case "vrcmd:skillDelete":
            void forgetSkill(libraryStore, msg.name).then(() => refreshSkills()).catch(() => {});
            break;
          case "vrcmd:chatSend":
          case "vrcmd:chatSwitch":
          case "vrcmd:chatNew":
          case "vrcmd:chatDelete":
          case "vrcmd:chatDeleteMessage":
          case "vrcmd:chatRename":
          case "vrcmd:chatPersona":
          case "vrcmd:chatClear":
          case "vrcmd:chatCancel":
          case "vrcmd:chatApproveTool":
          case "vrcmd:chatDismissTool":
          case "vrcmd:chatAgentApprove":
          case "vrcmd:chatAgentDeny":
            // The phone drove the landing-page chat; run it HERE on our buddy handlers (we own the
            // models + the working folder), and the chat mirror re-pushes the result to the phone.
            chatCommandRef.current(msg);
            break;
          case "vrcmd:chatPlanClear":
            // The phone dismissed the working checklist — clear it HERE (we own it) so the ChatLive
            // mirror stops re-pushing it.
            clearBuddyPlan();
            break;
          case "vrcmd:update":
            // The phone asked us to update: run the same pull+rebuild+reload, streaming status back.
            runUpdateForPhoneRef.current();
            break;
          case "vrcmd:restart":
            // The phone asked us to fully relaunch (Settings → Restart app on the phone).
            void restartApp().catch(() => {});
            break;
          case "vrcmd:openLocalFile":
            // The phone tapped a desktop file (a /find result) to open into the reader; read + import
            // it HERE (we have the filesystem), and the opened book mirrors back to the phone.
            void openLocalFileRef.current(msg.path);
            break;
          case "vrcmd:connectLocalServer":
            // The phone tapped Connect for AUTOMATIC1111 / ComfyUI; probe + auto-start it HERE (we have
            // the network + install folder), and the resulting settings mirror back via vrsync:settings.
            connectLocalServerRef.current(msg.backend, msg.url);
            break;
          case "vrcmd:downloadFfmpeg":
            // The phone tapped "Download ffmpeg"; fetch it HERE (we have the filesystem) — progress
            // mirrors back via the engine inventory's ffmpegProgress field.
            downloadFfmpegRef.current();
            break;
          case "vrcmd:hostTool":
            // The phone's buddy hit a desktop-runtime tool (files/command/screenshot); run it HERE
            // (we have the runtime + the working folder) and relay the result back. ALWAYS reply —
            // a rejection with no reply would stall the phone's turn until its 600s timeout.
            void runHostToolForRemoteRef.current(msg.call, msg.cwd)
              .catch((err): BuddyToolResultPayload => ({ command: { stdout: "", stderr: err instanceof Error ? err.message : String(err), code: -1 } }))
              .then((payload) => sendAppSync({ type: "vrsync:hostToolResult", requestId: msg.requestId, payload }));
            break;
          case "vrcmd:fetchFile": {
            // The phone asked for the full bytes of a file card whose bytes the mirror stripped (a large
            // or older generated image). Find it in our FULL history (we kept the bytes) and send it back
            // CHUNKED, so a big image syncs in pieces instead of being dropped for blowing one tunnel frame.
            const reqId = msg.reqId;
            const fileId = msg.id;
            void (async () => {
              let found: { bytes?: ArrayBuffer; mime?: string } | undefined;
              for (const m of buddyMessagesRef.current) {
                const a = m.attachments?.find((x) => x.id === fileId && x.bytes);
                if (a?.bytes) {
                  found = { bytes: a.bytes, mime: a.mime };
                  break;
                }
                // A live (un-stripped) inline image carrying this id also serves the bytes.
                if (m.image && "bytes" in m.image && m.image.id === fileId) {
                  found = { bytes: m.image.bytes, mime: m.image.mimeType };
                  break;
                }
              }
              // After a desktop reload the in-memory messages are byte-less (bytes were externalized) —
              // serve them from the chat blob store instead so the phone can still fetch older images.
              if (!found?.bytes) {
                const blob = await libraryStore.getImageBlob?.(activeBuddyIdRef.current, fileId).catch(() => undefined);
                if (blob) found = { bytes: blob.bytes, mime: blob.mimeType };
              }
              if (!found?.bytes) {
                sendAppSync({ type: "vrsync:fileData", reqId, seq: 0, total: 0 }); // not found
              } else {
                const chunks = chunkArrayBuffer(found.bytes);
                chunks.forEach((chunk, seq) =>
                  sendAppSync({
                    type: "vrsync:fileData",
                    reqId,
                    seq,
                    total: chunks.length,
                    bytes: chunk,
                    ...(seq === 0 && found!.mime ? { mime: found!.mime } : {}),
                  }),
                );
              }
            })();
            break;
          }
          default:
            break;
        }
      }
    });
    // Setters/refs are stable; the callbacks (openBook/closeBook/applyInventory/refreshSkills/
    // clearBuddyPlan) re-register the handler when they change — registration is idempotent (a
    // single overwritten slot), so extra re-runs are harmless.
  }, [
    isRemoteClient,
    setAppSyncHandler,
    sendAppSync,
    setBible,
    libraryStore,
    openBook,
    closeBook,
    applyInventory,
    setLibrary,
    setSettings,
    setMemories,
    setSkills,
    setBook,
    setRemoteVram,
    setRemoteHost,
    refreshSkills,
    clearBuddyPlan,
    bookRef,
    phoneExitedBookId,
    buddyMessagesRef,
    activeBuddyIdRef,
  ]);

  // Desktop: push each slice of state to a linked phone as it changes — granularly, so a settings
  // tweak doesn't resend the whole book (no-op without a linked phone: `sendAppSync` only writes
  // when the host bridge is open).
  useEffect(() => {
    if (!isRemoteClient) sendAppSync({ type: "vrsync:library", library });
  }, [isRemoteClient, sendAppSync, library]);
  useEffect(() => {
    if (!isRemoteClient) sendAppSync({ type: "vrsync:settings", settings });
  }, [isRemoteClient, sendAppSync, settings]);
  useEffect(() => {
    if (!isRemoteClient) sendAppSync({ type: "vrsync:book", ...(book ? { book } : {}), ...(bible ? { bible } : {}) });
  }, [isRemoteClient, sendAppSync, book, bible]);
  useEffect(() => {
    if (!isRemoteClient) sendAppSync({ type: "vrsync:inventory", ...engineInventory });
  }, [isRemoteClient, sendAppSync, engineInventory]);
  useEffect(() => {
    // Mirror the assistant's remembered notes to a linked phone so its Memory panel isn't empty.
    if (!isRemoteClient) sendAppSync({ type: "vrsync:memories", memories });
  }, [isRemoteClient, sendAppSync, memories]);
  useEffect(() => {
    // Mirror the assistant's saved skills to a linked phone so its Skills panel isn't empty.
    if (!isRemoteClient) sendAppSync({ type: "vrsync:skills", skills });
  }, [isRemoteClient, sendAppSync, skills]);
  useEffect(() => {
    // Tick the phone's VRAM indicator. Its own lightweight push (not folded into the heavier
    // inventory mirror) so a ~4s GPU reading doesn't re-send the whole installed-model inventory.
    if (!isRemoteClient) sendAppSync({ type: "vrsync:vram", ...(effectiveVram ? { vram: effectiveVram } : {}) });
  }, [isRemoteClient, sendAppSync, effectiveVram]);

  // Settings edits: on the desktop, apply locally (it owns the engine). On a linked PHONE, also push
  // the change to the desktop (vrcmd:settings) so the render the phone triggers uses it — the desktop
  // applies it and re-mirrors it back. The relay is DEBOUNCED (typing a URL/key was one full-settings
  // frame per keystroke) and the echo window above keeps the desktop's re-mirror of our own edit from
  // clobbering newer local typing (last-write-wins over relay latency ate characters).
  const onSettingsChange = useCallback(
    (next: ReaderSettings) => {
      setSettings(next);
      if (!isRemoteClient) return;
      phoneSettingsEditAt.current = Date.now();
      clearTimeout(phoneSettingsRelayTimer.current);
      phoneSettingsRelayTimer.current = setTimeout(() => {
        phoneSettingsRelayTimer.current = undefined;
        sendAppSync({ type: "vrcmd:settings", settings: settingsRef.current });
      }, 400);
    },
    [isRemoteClient, sendAppSync, setSettings, settingsRef],
  );

  return {
    plannerMirrorRef,
    applyPlannerRef,
    plannerCommandRef,
    chatMirrorRef,
    applyChatRef,
    chatCommandRef,
    chatLiveRef,
    applyChatLiveRef,
    chatLiveSentAt,
    chatLiveTimer,
    openLocalFileRef,
    connectLocalServerRef,
    downloadFfmpegRef,
    /** Reads live state without re-binding callers — the host bridge pushes a fresh snapshot on
     * every (re)connect (a phone already on the relay won't re-`hello` when only the desktop's
     * bridge dropped). */
    buildSnapshotRef,
    runUpdateForPhoneRef,
    phoneUpdatePending,
    runHostToolForRemoteRef,
    hostToolPending,
    fileFetchPending,
    fileChunkBufs,
    restoredImages,
    fetchingImageIds,
    fileFetchSeq,
    hostToolReqId,
    onSettingsChange,
  };
}
