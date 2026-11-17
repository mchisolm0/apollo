------------------------------- MODULE Steers -------------------------------
(* One thread from the phone: it is created with its first message, the person
   steers the running turn, and the thread is opened again after the run ends.
   The app matches steers to history by their words, so a steer can repeat the
   first message or another steer, or fill only part of a row. *)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
  A, B, AB,         \* the words a message can carry: "a", "b", or "a" and "b" on two lines
  MaxSteers,
  OnTime,           \* every steer's reply reaches the app before its screen reads again
  SplitsRows,       \* FALSE: the app compares a steer with whole rows only
  TakesLines,       \* FALSE: two steers can both count the same saved lines
  LongestFirst,     \* FALSE: steers take their lines in the order sent
  KeepsUncertain,   \* FALSE: createThread deletes the thread on any failed start
  RereadsHistory,   \* FALSE: a reopen trusts history it read before the run's status
  CountsBefore,     \* FALSE: a steer counts as saved once any message has its words
  NONE

Ids == 1..MaxSteers
Prompt == A
Texts == {A, B, AB}
\* A message's lines. Two steers Hermes read at once are one row of both's lines.
Lines(x) == IF x = AB THEN <<A, B>> ELSE <<x>>

VARIABLES
  start,     \* "new", "running" (the app knows the run), "kept", "deleted"
  began,     \* Hermes started the run
  hist,      \* the user rows Hermes saved, as <<ids, lines>>; id 0 is the first message
  waiting,   \* steers Hermes took and the agent has not read, oldest first
  unflushed, \* rows the agent read and Hermes has not saved yet, in the order it will save them
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

vars == <<start, began, hist, waiting, unflushed, ended, named, said, posts, replies, accepted,
          tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

Words(s) == [i \in 1..Len(s) |-> s[i][2]]
Range(s) == {s[i] : i \in 1..Len(s)}
Count(s, x) == Cardinality({i \in 1..Len(s) : s[i] = x})
RECURSIVE LinesOf(_)
LinesOf(s) == IF s = <<>> THEN <<>> ELSE Lines(Head(s)) \o LinesOf(Tail(s))
\* Whether x's lines run whole through `all` from line j.
RunAt(all, j, x) ==
  /\ j + Len(Lines(x)) - 1 <= Len(all)
  /\ \A m \in 1..Len(Lines(x)) : all[j + m - 1] = Lines(x)[m]
Rows(h) == [k \in 1..Len(h) |-> h[k][2]]
\* The app reads only once every steer reply has landed, unless replies can be late.
Settled == OnTime => replies = {}

\* The lines of row k a run of x from line j covers.
Cover(x, kj) == {<<kj[1], kj[2] + m - 1>> : m \in 1..Len(Lines(x))}
\* Where each free run of x's lines starts in the rows (app.ts freeRuns). No text
\* here can overlap itself, so every match is a run.
Starts(rows, x, taken) ==
  {kj \in (1..Len(rows)) \X (1..2 * MaxSteers) :
     /\ RunAt(rows[kj[1]], kj[2], x)
     /\ SplitsRows \/ (kj[2] = 1 /\ Len(rows[kj[1]]) = Len(Lines(x)))
     /\ TakesLines => Cover(x, kj) \cap taken = {}}
First(S) == CHOOSE s \in S : \A t \in S : s[1] < t[1] \/ (s[1] = t[1] /\ s[2] <= t[2])
RECURSIVE Nth(_, _)
Nth(S, n) == IF n = 1 THEN First(S) ELSE Nth(S \ {First(S)}, n - 1)
\* The order recorded steers take their lines in (app.ts reconcile): the two-line
\* steers first, unless LongestFirst is off. No text here has more than two.
Order ==
  LET idx == [i \in 1..Len(tracked) |-> i]
      long(i) == Len(Lines(tracked[i].words)) = 2
  IN IF LongestFirst THEN SelectSeq(idx, long) \o SelectSeq(idx, LAMBDA i : ~long(i)) ELSE idx
\* The first n steers in Order each take the first free run of their lines past
\* their `before` (app.ts reconcile): <<shown, lines taken>>.
RECURSIVE Take(_, _)
Take(rows, n) ==
  IF n = 0 THEN <<{}, {}>>
  ELSE LET prev == Take(rows, n - 1)
           t == tracked[Order[n]]
           need == IF CountsBefore THEN t.before ELSE 0
           S == Starts(rows, t.words, prev[2])
       IN IF Cardinality(S) > need
            THEN <<prev[1] \cup {Order[n]}, prev[2] \cup Cover(t.words, Nth(S, need + 1))>>
            ELSE prev
\* The recorded steers a set of rows doesn't show yet (app.ts unseen).
Unseen(rows) == (1..Len(tracked)) \ Take(rows, Len(tracked))[1]
RECURSIVE InOrder(_)
InOrder(S) == IF S = {} THEN <<>>
              ELSE LET i == CHOOSE j \in S : \A k \in S : j <= k
                   IN <<tracked[i].words>> \o InOrder(S \ {i})

Init ==
  /\ start = "new" /\ began = FALSE /\ hist = <<>> /\ waiting = <<>> /\ unflushed = <<>>
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
       /\ hist' = IF b THEN <<<<{0}, Lines(Prompt)>>>> ELSE <<>>
       /\ ended' = ~b
       /\ start' = IF reply = "ok" THEN "running"
                   ELSE IF reply = "refused" \/ ~KeepsUncertain THEN "deleted"
                   ELSE "kept"
  /\ UNCHANGED <<unflushed, waiting, named, said, posts, replies, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The thread screen draws history while the run streams. Its user rows are
\* the history it read when it opened (app.ts transcript, withSteers).
Draw ==
  /\ start = "running" /\ ~ended /\ phase = "idle" /\ Settled
  /\ rowsSeen' = Rows(hist)
  /\ UNCHANGED <<unflushed, start, began, hist, waiting, ended, named, said, posts, replies, accepted, tracked, phase, h1, lostBefore, lost, known>>

\* The person steers the running turn (app.ts steerRun). The composer allows it
\* only while no steer request is on its way (app.contract canSteer).
Steer(i, x) ==
  /\ start = "running" /\ rowsSeen # NONE /\ phase # "done"
  /\ posts = {} /\ replies = {}
  /\ said[i] = NONE /\ (IF i = 1 THEN TRUE ELSE said[i - 1] # NONE)
  /\ said' = [said EXCEPT ![i] = x]
  /\ posts' = posts \cup {i}
  /\ UNCHANGED <<unflushed, start, began, hist, waiting, ended, named, replies, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* Hermes queues a steer while the run is running, else answers 409
\* run_not_accepting_steer (api_server_runs.py _handle_steer_run).
HermesSteer(i) ==
  /\ i \in posts
  /\ posts' = posts \ {i}
  /\ IF ~ended
       THEN /\ waiting' = Append(waiting, <<i, said[i]>>)
            /\ accepted' = accepted \cup {i}
            /\ replies' = replies \cup {i}
       ELSE UNCHANGED <<unflushed, waiting, accepted, replies>>
  /\ UNCHANGED <<unflushed, start, began, hist, ended, named, said, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The app records an accepted steer, with the runs of its lines free in the rows
\* drawn once the steers recorded before it took theirs (app.ts steerRun). With
\* TakesLines off it counts every run, plus recorded steers with those words
\* still unseen.
Record(i) ==
  /\ i \in replies
  /\ replies' = replies \ {i}
  /\ LET x == said[i]
         rows == IF rowsSeen = NONE THEN <<>> ELSE rowsSeen
         free == Cardinality(Starts(rows, x, Take(rows, Len(tracked))[2]))
         same == Cardinality({j \in Unseen(rows) : tracked[j].words = x})
     IN tracked' = Append(tracked, [id |-> i, words |-> x,
          before |-> free + (IF TakesLines THEN 0 ELSE same)])
  /\ UNCHANGED <<unflushed, start, began, hist, waiting, ended, named, said, posts, accepted, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The reply is lost, so the app shows an error for a steer Hermes has.
LoseReply(i) ==
  /\ ~OnTime /\ i \in replies
  /\ replies' = replies \ {i}
  /\ UNCHANGED <<unflushed, start, began, hist, waiting, ended, named, said, posts, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The agent reads every steer waiting as one user row, their lines joined by
\* newlines (interrupt_control.py _drain_pending_steer). After a tool batch the row
\* goes last (agent_runtime_helpers.py apply_pending_steer_to_tool_results); just
\* before the next model call it goes right after the newest tool result, ahead
\* of a row from that batch not saved yet (turn_iteration_prep.py).
Deliver ==
  /\ ~ended /\ waiting # <<>>
  /\ LET row == <<{waiting[k][1] : k \in 1..Len(waiting)}, LinesOf(Words(waiting))>>
         n == Len(unflushed)
     IN \/ unflushed' = Append(unflushed, row)
        \/ n > 0 /\ unflushed' = SubSeq(unflushed, 1, n - 1) \o <<row, unflushed[n]>>
  /\ waiting' = <<>>
  /\ UNCHANGED <<start, began, hist, ended, named, said, posts, replies, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* Hermes saves the rows the agent read (_flush_messages_to_session_db).
Flush ==
  /\ unflushed # <<>>
  /\ hist' = hist \o unflushed
  /\ unflushed' = <<>>
  /\ UNCHANGED <<start, began, waiting, ended, named, said, posts, replies, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* The turn ends. Finishing names every steer still waiting in pending_steer;
\* a hard stop drops them unnamed (interrupt_control.py). Rows already read are saved.
End ==
  /\ began /\ ~ended
  /\ ended' = TRUE
  /\ hist' = hist \o unflushed /\ unflushed' = <<>>
  /\ \/ named' = waiting
     \/ named' = <<>>
  /\ waiting' = <<>>
  /\ UNCHANGED <<start, began, said, posts, replies, accepted, tracked, rowsSeen, phase, h1, lostBefore, lost, known>>

\* Opening the thread reads its history, then its run's status (app.ts transcript).
ReadHistory ==
  /\ start = "running" /\ phase = "idle" /\ Settled
  /\ h1' = Rows(hist)
  /\ phase' = "history"
  /\ UNCHANGED <<unflushed, start, began, hist, waiting, ended, named, said, posts, replies, accepted, tracked, rowsSeen, lostBefore, lost, known>>

\* Still running: the thread streams with the history it read.
ReadStatus ==
  /\ phase = "history" /\ Settled
  /\ IF ended
       THEN /\ lostBefore' = Words(named) /\ phase' = "status" /\ UNCHANGED rowsSeen
       ELSE /\ rowsSeen' = h1 /\ phase' = "idle" /\ UNCHANGED lostBefore
  /\ UNCHANGED <<unflushed, start, began, hist, waiting, ended, named, said, posts, replies, accepted, tracked, h1, lost, known>>

\* The run ended. History read before the status can miss a steer saved as the
\* run ended, so it is read once more when a steer is unseen. A steer neither
\* saved nor named never reached the run either. A steer counts as named when its
\* lines run whole through pending_steer (app.ts transcript named).
Settle ==
  /\ phase = "status" /\ Settled
  /\ LET rows == IF RereadsHistory /\ Unseen(h1) # {} THEN Rows(hist) ELSE h1
         missed == InOrder(Unseen(rows))
         all == LinesOf(lostBefore)
         isNamed(x) == \E j \in 1..Len(all) : RunAt(all, j, x)
     IN lost' = lostBefore \o SelectSeq(missed, LAMBDA x : ~isNamed(x))
  /\ known' = {tracked[k].id : k \in 1..Len(tracked)}
  /\ phase' = "done"
  /\ UNCHANGED <<unflushed, start, began, hist, waiting, ended, named, said, posts, replies, accepted, tracked, rowsSeen, h1, lostBefore>>

Next ==
  \/ Create \/ Draw \/ Deliver \/ Flush \/ End \/ ReadHistory \/ ReadStatus \/ Settle
  \/ \E i \in Ids, x \in Texts : Steer(i, x)
  \/ \E i \in Ids : HermesSteer(i) \/ Record(i) \/ LoseReply(i)

Spec == Init /\ [][Next]_vars

\* Rule 1: the app never deletes a thread whose run began.
KeepsStarted == began => start # "deleted"

\* Rule 2: the reopened thread's note holds the lines of each steer Hermes never
\* saved, once, and no others. That is each unsaved steer pending_steer named or
\* the app had recorded: one whose reply never landed and that a hard stop
\* dropped is known to nobody. The note joins its steers with newlines, so it is
\* judged by lines: "a" and "b" read the same as one "a\nb", and history can't
\* tell them apart either.
Saved == UNION {hist[k][1] : k \in 1..Len(hist)}
Unsaved == {i \in accepted \ Saved : i \in known \/ \E k \in 1..Len(named) : named[k][1] = i}
LinesUnsaved(l) ==
  Cardinality({im \in Unsaved \X {1, 2} :
                 im[2] <= Len(Lines(said[im[1]])) /\ Lines(said[im[1]])[im[2]] = l})
UndeliveredExact ==
  phase = "done" => \A l \in {A, B} : Count(LinesOf(lost), l) = LinesUnsaved(l)
=============================================================================
