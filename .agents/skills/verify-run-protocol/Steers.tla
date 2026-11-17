------------------------------- MODULE Steers -------------------------------
(* One thread from the phone: it is created with its first message, the person
   steers the running turn, and the thread is opened again after the run ends.
   The app matches steers to history by their words, so a steer can repeat the
   first message or another steer. *)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
  Prompt,           \* the first message's words
  Texts,            \* words a steer can carry, e.g. {a, b}
  MaxSteers,
  OnTime,           \* every steer's reply reaches the app before its screen reads again
  SplitsRows,       \* FALSE: the app compares a steer with whole rows only
  KeepsUncertain,   \* FALSE: createThread deletes the thread on any failed start
  RereadsHistory,   \* FALSE: a reopen trusts history it read before the run's status
  CountsBefore,     \* FALSE: a steer counts as saved once any message has its words
  NONE

Ids == 1..MaxSteers

VARIABLES
  start,     \* "new", "running" (the app knows the run), "kept", "deleted"
  began,     \* Hermes started the run
  hist,      \* the user rows Hermes saved, as <<ids, words>>; id 0 is the first message
  waiting,   \* steers Hermes took and has not saved, oldest first
  ended,     \* the run ended
  named,     \* the steers pending_steer lists, as <<id, words>>
  said,      \* id -> the words of each steer the person sent
  posts,     \* steer requests on their way to Hermes
  replies,   \* "accepted" replies on their way back
  accepted,  \* steers Hermes took
  tracked,   \* steers the app recorded: [id, words, before], in the order recorded
  rowsSeen,  \* the user rows the thread screen drew last, or NONE before it drew
  phase,     \* reopening: "idle", "history" (read), "status" (read), "done"
  h1,        \* the history the reopen read first
  lostBefore,\* pending_steer as the reopen read it
  lost,      \* the words the reopened thread names as undelivered
  known      \* the steers the app had recorded when it named them

vars == <<start, began, hist, waiting, ended, named, said, posts, replies, accepted,
          tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

Words(s) == [i \in 1..Len(s) |-> s[i][2]]
Range(s) == {s[i] : i \in 1..Len(s)}
Count(s, x) == Cardinality({i \in 1..Len(s) : s[i] = x})
\* A row's words are a sequence: Hermes joins the steers it read at once into
\* one row. The app counts each steer inside a row (app.ts said).
Rows(h) == Words(h)
RowCount(rows, x) ==
  IF SplitsRows
    THEN Cardinality({kj \in (1..Len(rows)) \X (0..MaxSteers) :
                        kj[2] \in 1..Len(rows[kj[1]]) /\ rows[kj[1]][kj[2]] = x})
    ELSE Count(rows, <<x>>)
\* The app reads only once every steer reply has landed, unless replies can be late.
Settled == OnTime => replies = {}

\* The recorded steers a set of rows doesn't show yet (app.ts unseen): one counts
\* as shown once its words appear more often than `before`.
Unseen(rows) ==
  {i \in 1..Len(tracked) :
     IF CountsBefore THEN RowCount(rows, tracked[i].words) <= tracked[i].before
     ELSE RowCount(rows, tracked[i].words) = 0}
RECURSIVE InOrder(_)
InOrder(S) == IF S = {} THEN <<>>
              ELSE LET i == CHOOSE j \in S : \A k \in S : j <= k
                   IN <<tracked[i].words>> \o InOrder(S \ {i})

Init ==
  /\ start = "new" /\ began = FALSE /\ hist = <<>> /\ waiting = <<>>
  /\ ended = FALSE /\ named = <<>>
  /\ said = [i \in Ids |-> NONE]
  /\ posts = {} /\ replies = {} /\ accepted = {} /\ tracked = <<>>
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
       /\ hist' = IF b THEN <<<<{0}, <<Prompt>>>>>> ELSE <<>>
       /\ ended' = ~b
       /\ start' = IF reply = "ok" THEN "running"
                   ELSE IF reply = "refused" \/ ~KeepsUncertain THEN "deleted"
                   ELSE "kept"
  /\ UNCHANGED <<waiting, named, said, posts, replies, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The thread screen draws history while the run streams. Its user rows are
\* the history it read when it opened (app.ts transcript, withSteers).
Draw ==
  /\ start = "running" /\ ~ended /\ phase = "idle" /\ Settled
  /\ rowsSeen' = Rows(hist)
  /\ UNCHANGED <<start, began, hist, waiting, ended, named, said, posts, replies, accepted, tracked, phase, h1, lostBefore, lost, known>>

\* The person steers the running turn (app.ts steerRun). The composer allows it
\* only while no steer request is on its way (app.contract canSteer).
Steer(i, x) ==
  /\ start = "running" /\ rowsSeen # NONE /\ phase # "done"
  /\ posts = {} /\ replies = {}
  /\ said[i] = NONE /\ (IF i = 1 THEN TRUE ELSE said[i - 1] # NONE)
  /\ said' = [said EXCEPT ![i] = x]
  /\ posts' = posts \cup {i}
  /\ UNCHANGED <<start, began, hist, waiting, ended, named, replies, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

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
  /\ UNCHANGED <<start, began, hist, ended, named, said, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The app records an accepted steer, with how often its words already show:
\* in the rows drawn, plus recorded steers with those words still unseen.
Record(i) ==
  /\ i \in replies
  /\ replies' = replies \ {i}
  /\ LET x == said[i]
         rows == IF rowsSeen = NONE THEN <<>> ELSE rowsSeen
     IN tracked' = Append(tracked, [id |-> i, words |-> x,
          before |-> RowCount(rows, x) + Cardinality({j \in Unseen(rows) : tracked[j].words = x})])
  /\ UNCHANGED <<start, began, hist, waiting, ended, named, said, posts, accepted, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The reply is lost, so the app shows an error for a steer Hermes has.
LoseReply(i) ==
  /\ ~OnTime /\ i \in replies
  /\ replies' = replies \ {i}
  /\ UNCHANGED <<start, began, hist, waiting, ended, named, said, posts, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The agent reads every steer waiting, and Hermes saves them as one user row,
\* their words joined by newlines (interrupt_control.py _drain_pending_steer).
Deliver ==
  /\ ~ended /\ waiting # <<>>
  /\ hist' = Append(hist, <<{waiting[k][1] : k \in 1..Len(waiting)}, Words(waiting)>>)
  /\ waiting' = <<>>
  /\ UNCHANGED <<start, began, ended, named, said, posts, replies, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The turn ends. Finishing names every steer still waiting in pending_steer;
\* a hard stop drops them unnamed (interrupt_control.py).
End ==
  /\ began /\ ~ended
  /\ ended' = TRUE
  /\ \/ named' = waiting
     \/ named' = <<>>
  /\ waiting' = <<>>
  /\ UNCHANGED <<start, began, hist, said, posts, replies, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* Opening the thread reads its history, then its run's status (app.ts transcript).
ReadHistory ==
  /\ start = "running" /\ phase = "idle" /\ Settled
  /\ h1' = Rows(hist)
  /\ phase' = "history"
  /\ UNCHANGED <<start, began, hist, waiting, ended, named, said, posts, replies, accepted, tracked, rowsSeen, lostBefore, lost, known>>

\* Still running: the thread streams with the history it read.
ReadStatus ==
  /\ phase = "history" /\ Settled
  /\ IF ended
       THEN /\ lostBefore' = Words(named) /\ phase' = "status" /\ UNCHANGED rowsSeen
       ELSE /\ rowsSeen' = h1 /\ phase' = "idle" /\ UNCHANGED lostBefore
  /\ UNCHANGED <<start, began, hist, waiting, ended, named, said, posts, replies, accepted, tracked, h1, lost, known>>

\* The run ended. History read before the status can miss a steer saved as the
\* run ended, so it is read once more when a steer is unseen. A steer neither
\* saved nor named never reached the run either.
Settle ==
  /\ phase = "status" /\ Settled
  /\ LET rows == IF RereadsHistory /\ Unseen(h1) # {} THEN Rows(hist) ELSE h1
         missed == InOrder(Unseen(rows))
     IN lost' = lostBefore \o SelectSeq(missed, LAMBDA x : x \notin Range(lostBefore))
  /\ known' = {tracked[k].id : k \in 1..Len(tracked)}
  /\ phase' = "done"
  /\ UNCHANGED <<start, began, hist, waiting, ended, named, said, posts, replies, accepted, tracked, rowsSeen, h1, lostBefore>>

Next ==
  \/ Create \/ Draw \/ Deliver \/ End \/ ReadHistory \/ ReadStatus \/ Settle
  \/ \E i \in Ids, x \in Texts : Steer(i, x)
  \/ \E i \in Ids : HermesSteer(i) \/ Record(i) \/ LoseReply(i)

Spec == Init /\ [][Next]_vars

\* Rule 1: the app never deletes a thread whose run began.
KeepsStarted == began => start # "deleted"

\* Rule 2: the reopened thread names each steer Hermes never saved once, and no
\* other. That is each unsaved steer pending_steer named or the app had recorded:
\* one whose reply never landed and that a hard stop dropped is known to nobody.
Saved == UNION {hist[k][1] : k \in 1..Len(hist)}
Undelivered(x) ==
  Cardinality({i \in accepted \ Saved :
                 said[i] = x /\ (i \in known \/ \E k \in 1..Len(named) : named[k][1] = i)})
UndeliveredExact ==
  phase = "done" => \A x \in Texts \cup {Prompt} : Count(lost, x) = Undelivered(x)
=============================================================================
