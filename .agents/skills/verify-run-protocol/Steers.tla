------------------------------- MODULE Steers -------------------------------
(* One thread from the phone: it is created with its first message, the person
   steers the running turn, and the thread is opened again after the run ends.
   Hermes's history has no steer ids, so the app counts the lines of the run's
   steer rows. Steers can repeat each other's words or the first message's, span
   two lines, share a row, and be saved out of order. *)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
  A, B, AB,         \* the words a message can carry: "a", "b", or "a" and "b" on two lines
  MaxSteers,
  OnTime,           \* every steer's reply reaches the app before its screen reads again
  KeepsUncertain,   \* FALSE: createThread deletes the thread on any failed start
  RereadsHistory,   \* FALSE: a reopen trusts history it read before the run's status
  CountsLines,      \* FALSE: the app counts each steer row as one steer
  UsesSince,        \* FALSE: the app counts steer rows from earlier runs too
  NONE

Ids == 1..MaxSteers
Prompt == A
Texts == {A, B, AB}
\* A message's lines. Steers Hermes read at once are one row of all their lines.
Lines(x) == IF x = AB THEN <<A, B>> ELSE <<x>>
\* A steer row an earlier run of the thread saved.
Earlier == <<{-1}, <<A>>>>

VARIABLES
  start,     \* "new", "running" (the app knows the run), "kept", "deleted"
  began,     \* Hermes started the run
  hist,      \* the user rows Hermes saved, as <<ids, lines>>; id 0 is the first message,
             \* a row's place is its message id
  waiting,   \* steers Hermes took and the agent has not read, oldest first
  unflushed, \* rows the agent read and Hermes has not saved yet, in the order it will save them
  ended,     \* the run ended
  named,     \* the steers pending_steer lists, as <<id, words>>
  said,      \* id -> the words of each steer the person sent
  posts,     \* steer requests on their way to Hermes
  replies,   \* "accepted" replies on their way back
  accepted,  \* steers Hermes took
  tracked,   \* steers the app recorded: [id, words], in the order recorded
  since,     \* how many rows the screen had drawn when the app recorded its first steer, or NONE
  rowsSeen,  \* the user rows the thread screen drew last, or NONE before it drew
  phase,     \* reopening: "idle", "history" (read), "status" (read), "done"
  h1,        \* the history the reopen read first
  lostBefore,\* pending_steer as the reopen read it
  lost,      \* the words the reopened thread names as undelivered
  known      \* the steers the app had recorded when it named them

vars == <<start, began, hist, waiting, unflushed, ended, named, said, posts, replies, accepted,
          tracked, since, rowsSeen, phase, h1, lostBefore, lost, known>>

Words(s) == [i \in 1..Len(s) |-> s[i][2]]
RECURSIVE LinesOf(_)
LinesOf(s) == IF s = <<>> THEN <<>> ELSE Lines(Head(s)) \o LinesOf(Tail(s))
\* The app's view of a row: whether it is a steer row (display_kind), and its lines.
Rows(h) == [k \in 1..Len(h) |-> <<h[k][1] # {0}, h[k][2]>>]
\* The app reads only once every steer reply has landed, unless replies can be late.
Settled == OnTime => replies = {}

\* The lines of this run's steer rows: steer rows newer than the history the
\* first steer saw (app.ts unseen).
RECURSIVE SumLines(_, _)
SumLines(rows, k) ==
  IF k > Len(rows) THEN 0
  ELSE (IF rows[k][1] /\ (~UsesSince \/ since = NONE \/ k > since)
          THEN (IF CountsLines THEN Len(rows[k][2]) ELSE 1) ELSE 0)
       + SumLines(rows, k + 1)
\* The first recorded steers fill the saved lines; the rest are unseen.
RECURSIVE Filled(_, _)
Filled(left, i) ==
  IF i > Len(tracked) \/ left <= 0 THEN i - 1
  ELSE Filled(left - (IF CountsLines THEN Len(Lines(tracked[i].words)) ELSE 1), i + 1)
Unseen(rows) == (Filled(SumLines(rows, 1), 1) + 1)..Len(tracked)
UnseenWords(rows) == [k \in 1..Cardinality(Unseen(rows)) |-> tracked[Filled(SumLines(rows, 1), 1) + k].words]

Init ==
  /\ start = "new" /\ began = FALSE /\ hist = <<Earlier>> /\ waiting = <<>> /\ unflushed = <<>>
  /\ ended = FALSE /\ named = <<>>
  /\ said = [i \in Ids |-> NONE]
  /\ posts = {} /\ replies = {} /\ accepted = {} /\ tracked = <<>> /\ since = NONE
  /\ rowsSeen = NONE /\ phase = "idle" /\ h1 = <<>> /\ lostBefore = <<>> /\ lost = <<>> /\ known = {}

(* createThread makes the session, then asks Hermes for the run. A 4xx means
   Hermes refused it; a lost reply or a 5xx says nothing about whether it began.
   The app keeps the thread unless Hermes refused (app.ts createThread). Only a
   reply tells the app the run's id, so only then can it steer. *)
Create ==
  /\ start = "new"
  /\ \E b \in BOOLEAN, reply \in {"ok", "refused", "unknown"} :
       /\ reply = "ok" => b
       /\ reply = "refused" => ~b
       /\ began' = b
       /\ hist' = IF b THEN Append(hist, <<{0}, Lines(Prompt)>>) ELSE hist
       /\ ended' = ~b
       /\ start' = IF reply = "ok" THEN "running"
                   ELSE IF reply = "refused" \/ ~KeepsUncertain THEN "deleted"
                   ELSE "kept"
  /\ UNCHANGED <<waiting, unflushed, named, said, posts, replies, accepted, tracked, since, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The thread screen draws history while the run streams (app.ts transcript, withSteers).
Draw ==
  /\ start = "running" /\ ~ended /\ phase = "idle" /\ Settled
  /\ rowsSeen' = Rows(hist)
  /\ UNCHANGED <<start, began, hist, waiting, unflushed, ended, named, said, posts, replies, accepted, tracked, since, phase, h1, lostBefore, lost, known>>

\* The person steers the running turn (app.ts steerRun). The composer allows it
\* only while no steer request is on its way (app.contract canSteer).
Steer(i, x) ==
  /\ start = "running" /\ rowsSeen # NONE /\ phase # "done"
  /\ posts = {} /\ replies = {}
  /\ said[i] = NONE /\ (IF i = 1 THEN TRUE ELSE said[i - 1] # NONE)
  /\ said' = [said EXCEPT ![i] = x]
  /\ posts' = posts \cup {i}
  /\ UNCHANGED <<start, began, hist, waiting, unflushed, ended, named, replies, accepted, tracked, since, rowsSeen, phase, h1, lostBefore, lost, known>>

\* Hermes queues a steer while the run is running, else answers 409
\* run_not_accepting_steer (api_server_runs.py _handle_steer_run).
HermesSteer(i) ==
  /\ i \in posts
  /\ posts' = posts \ {i}
  /\ IF ~ended
       THEN /\ waiting' = Append(waiting, <<i, said[i]>>)
            /\ accepted' = accepted \cup {i}
            /\ replies' = replies \cup {i}
       ELSE UNCHANGED <<waiting, accepted, replies>>
  /\ UNCHANGED <<start, began, hist, unflushed, ended, named, said, tracked, since, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The app records an accepted steer. The first one also notes the newest row the
\* screen drew (app.ts steerRun).
Record(i) ==
  /\ i \in replies
  /\ replies' = replies \ {i}
  /\ tracked' = Append(tracked, [id |-> i, words |-> said[i]])
  /\ since' = IF since = NONE THEN Len(rowsSeen) ELSE since
  /\ UNCHANGED <<start, began, hist, waiting, unflushed, ended, named, said, posts, accepted, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The reply is lost, so the app shows an error for a steer Hermes has.
LoseReply(i) ==
  /\ ~OnTime /\ i \in replies
  /\ replies' = replies \ {i}
  /\ UNCHANGED <<start, began, hist, waiting, unflushed, ended, named, said, posts, accepted, tracked, since, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The agent reads every steer waiting as one user row, their lines joined by
\* newlines (interrupt_control.py _drain_pending_steer). After a tool batch the row
\* goes last (agent_runtime_helpers.py apply_pending_steer_to_tool_results); just
\* before a model call it goes right after the newest tool result
\* (turn_iteration_prep.py), ahead of rows not saved yet. A retry can do that
\* again, so the row can land anywhere among the unsaved ones.
Deliver ==
  /\ ~ended /\ waiting # <<>>
  /\ LET row == <<{waiting[k][1] : k \in 1..Len(waiting)}, LinesOf(Words(waiting))>>
     IN \E p \in 0..Len(unflushed) :
          unflushed' = SubSeq(unflushed, 1, p) \o <<row>> \o SubSeq(unflushed, p + 1, Len(unflushed))
  /\ waiting' = <<>>
  /\ UNCHANGED <<start, began, hist, ended, named, said, posts, replies, accepted, tracked, since, rowsSeen, phase, h1, lostBefore, lost, known>>

\* Hermes saves the rows the agent read (_flush_messages_to_session_db).
Flush ==
  /\ unflushed # <<>>
  /\ hist' = hist \o unflushed
  /\ unflushed' = <<>>
  /\ UNCHANGED <<start, began, waiting, ended, named, said, posts, replies, accepted, tracked, since, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The turn ends. Finishing names every steer still waiting in pending_steer;
\* a hard stop drops them unnamed (interrupt_control.py). Rows already read are saved.
End ==
  /\ began /\ ~ended
  /\ ended' = TRUE
  /\ hist' = hist \o unflushed /\ unflushed' = <<>>
  /\ \/ named' = waiting
     \/ named' = <<>>
  /\ waiting' = <<>>
  /\ UNCHANGED <<start, began, said, posts, replies, accepted, tracked, since, rowsSeen, phase, h1, lostBefore, lost, known>>

\* Opening the thread reads its history, then its run's status (app.ts transcript).
ReadHistory ==
  /\ start = "running" /\ phase = "idle" /\ Settled
  /\ h1' = Rows(hist)
  /\ phase' = "history"
  /\ UNCHANGED <<start, began, hist, waiting, unflushed, ended, named, said, posts, replies, accepted, tracked, since, rowsSeen, lostBefore, lost, known>>

\* Still running: the thread streams with the history it read.
ReadStatus ==
  /\ phase = "history" /\ Settled
  /\ IF ended
       THEN /\ lostBefore' = Words(named) /\ phase' = "status" /\ UNCHANGED rowsSeen
       ELSE /\ rowsSeen' = h1 /\ phase' = "idle" /\ UNCHANGED lostBefore
  /\ UNCHANGED <<start, began, hist, waiting, unflushed, ended, named, said, posts, replies, accepted, tracked, since, h1, lost, known>>

\* Drops unseen steers from the end until n of pending_steer's lines are covered.
RECURSIVE DropNamed(_, _)
DropNamed(s, n) ==
  IF n <= 0 \/ s = <<>> THEN s
  ELSE DropNamed(SubSeq(s, 1, Len(s) - 1), n - Len(Lines(s[Len(s)])))

\* The run ended. History read before the status can miss a steer saved as the
\* run ended, so it is read once more when a steer is unseen. pending_steer names
\* the last steers sent; unseen steers before its lines never reached the run.
Settle ==
  /\ phase = "status" /\ Settled
  /\ LET rows == IF RereadsHistory /\ Unseen(h1) # {} THEN Rows(hist) ELSE h1
     IN lost' = DropNamed(UnseenWords(rows), Len(LinesOf(lostBefore))) \o lostBefore
  /\ known' = {tracked[k].id : k \in 1..Len(tracked)}
  /\ phase' = "done"
  /\ UNCHANGED <<start, began, hist, waiting, unflushed, ended, named, said, posts, replies, accepted, tracked, since, rowsSeen, h1, lostBefore>>

Next ==
  \/ Create \/ Draw \/ Deliver \/ Flush \/ End \/ ReadHistory \/ ReadStatus \/ Settle
  \/ \E i \in Ids, x \in Texts : Steer(i, x)
  \/ \E i \in Ids : HermesSteer(i) \/ Record(i) \/ LoseReply(i)

Spec == Init /\ [][Next]_vars

\* Rule 1: the app never deletes a thread whose run began.
KeepsStarted == began => start # "deleted"

\* Rule 2: the reopened thread's note holds the lines of each steer Hermes never
\* saved, in the order sent, and no others. That is each unsaved steer
\* pending_steer named or the app had recorded: one whose reply never landed and
\* that a hard stop dropped is known to nobody. The note joins its steers with
\* newlines, so it is judged by lines: "a" and "b" read the same as one "a\nb".
Saved == UNION {hist[k][1] : k \in 1..Len(hist)}
Unsaved == {i \in accepted \ Saved : i \in known \/ \E k \in 1..Len(named) : named[k][1] = i}
UnsavedWords == LET ids == SelectSeq([i \in Ids |-> i], LAMBDA i : i \in Unsaved)
                IN [k \in 1..Len(ids) |-> said[ids[k]]]
UndeliveredExact == phase = "done" => LinesOf(lost) = LinesOf(UnsavedWords)
=============================================================================
