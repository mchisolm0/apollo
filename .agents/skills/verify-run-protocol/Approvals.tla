----------------------------- MODULE Approvals -----------------------------
(* One Hermes run asking for approvals, and everything that can answer them:
   the phone's thread screen, a cloud approval card answered from any phone,
   and away mode on the connector. Hermes is the authority: an answer settles
   only a request still pending in its queue. Parallel subagents can ask at
   once, and the run's status shows only the newest request, so the screen and
   the connector both read the run's events. *)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
  Requests,          \* request ids Hermes can mint in this run, e.g. {r1, r2}
  AtOnce,            \* TRUE: two requests can wait at once (parallel subagents)
  Away,              \* away mode is on for the whole run
  AnswersById,       \* FALSE: answers leave out request_id
  ClosesStaleCards,  \* FALSE: the bridge leaves a card open after its request moves on
  ReadsEvents,       \* FALSE: the connector knows only the request on the run's status
  OldestOpen,        \* FALSE: the screen shows the latest request, cleared by any answer
  NONE

VARIABLES
  queue,     \* Hermes's pending requests, oldest first
  asked,     \* requests Hermes has asked
  ended,     \* the run ended
  status,    \* the request on the run's status, or NONE
  stream,    \* the run's events, which the screen and the connector read in order
  read,      \* how many of them the thread screen has read
  cread,     \* how many of them the connector has read (run-approvals.mjs)
  answers,   \* answers on their way to Hermes, each [from, for]
  sent,      \* answers already sent, so each surface answers a request once
  outcome,   \* r -> NONE, "timeout", or the request the answer that settled r was for
  expired,   \* requests whose time ran out, so the screen and the connector drop them
  cards,     \* r -> "none", "open" or "closed": its cloud approval card
  stale,     \* cards the bridge marked to resolve and has not closed yet
  events,    \* cloud card answers the bridge has not passed to Hermes yet
  seen,      \* the status the connector's run monitor read, not yet acted on, or "unread"
  bridged    \* what the bridge last acted on: <<requests waiting, requests closed>>

vars == <<queue, asked, ended, status, stream, read, cread, answers, sent, outcome,
          expired, cards, stale, events, seen, bridged>>

Pending == {queue[i] : i \in 1..Len(queue)}
Without(s, r) == SelectSeq(s, LAMBDA x : x # r)
Range(s) == {s[i] : i \in 1..Len(s)}

(* The requests still open after a prefix of the stream, oldest first: an
   answer closes its request, or the oldest without an id, and the run's end
   closes them all (run-state.ts openApprovals, run-approvals.mjs). *)
RECURSIVE OpenIn(_)
OpenIn(s) ==
  IF s = <<>> THEN <<>>
  ELSE LET before == OpenIn(SubSeq(s, 1, Len(s) - 1))
           e == s[Len(s)]
       IN IF e[1] = "ask" THEN Append(before, e[2])
          ELSE IF e[1] = "answered"
            THEN (IF e[2] # NONE THEN Without(before, e[2])
                  ELSE IF before = <<>> THEN before ELSE Tail(before))
          ELSE <<>>
\* Every request answered or ended in a prefix of the stream.
Closed(s) == {r \in Requests : \E i \in 1..Len(s) : s[i][1] = "ask" /\ s[i][2] = r} \ Range(OpenIn(s))

(* Before the fix: the latest approval.request with no approval.responded or
   run end after it. *)
RECURSIVE LatestIn(_)
LatestIn(s) ==
  IF s = <<>> THEN NONE
  ELSE LET e == s[Len(s)] IN
       IF e[1] = "ask" THEN e[2]
       ELSE IF e[1] \in {"answered", "end"} THEN NONE
       ELSE LatestIn(SubSeq(s, 1, Len(s) - 1))

\* The request the thread screen shows: the oldest still open (run-state.ts currentApproval).
Shown ==
  IF OldestOpen
    THEN LET open == SelectSeq(OpenIn(SubSeq(stream, 1, read)), LAMBDA r : r \notin expired)
         IN IF open = <<>> THEN NONE ELSE open[1]
    ELSE LatestIn(SubSeq(stream, 1, read))

(* The requests the connector counts the run waiting on, given the status it
   read: the open ones from the events it read, plus the status's request
   unless it closed (run-approvals.mjs open). *)
ClosedHere == Closed(SubSeq(stream, 1, cread)) \cup expired
AsksFrom(s) ==
  LET fromStatus == IF s \in {"unread", NONE} THEN {} ELSE {s}
      closedHere == ClosedHere
  IN IF ReadsEvents
       THEN (Range(OpenIn(SubSeq(stream, 1, cread))) \cup fromStatus) \ closedHere
       ELSE fromStatus

Init ==
  /\ queue = <<>> /\ asked = {} /\ ended = FALSE /\ status = NONE
  /\ stream = <<>> /\ read = 0 /\ cread = 0
  /\ answers = {} /\ sent = {}
  /\ outcome = [r \in Requests |-> NONE] /\ expired = {}
  /\ cards = [r \in Requests |-> "none"]
  /\ stale = {} /\ events = {} /\ seen = "unread" /\ bridged = <<{}, {}>>

\* A tool asks for approval. Hermes parks the run on it, so the run's status
\* shows the newest request (api_server_runs.py _approval_notify).
Ask(r) ==
  /\ r \notin asked /\ ~ended
  /\ AtOnce \/ queue = <<>>
  /\ queue' = Append(queue, r)
  /\ asked' = asked \cup {r}
  /\ status' = r
  /\ stream' = Append(stream, <<"ask", r>>)
  /\ UNCHANGED <<ended, read, cread, answers, sent, outcome, expired, cards, stale, events, seen, bridged>>

\* Nobody answered in time: Hermes denies it and emits no event, so the status
\* and the stream keep showing it (approval_gateway_wait.py).
Timeout(r) ==
  /\ r \in Pending
  /\ queue' = Without(queue, r)
  /\ outcome' = [outcome EXCEPT ![r] = "timeout"]
  /\ UNCHANGED <<asked, ended, status, stream, read, cread, answers, sent, expired, cards, stale, events, seen, bridged>>

(* The screen and the connector drop a request once its time runs out, from
   its timestamp and Hermes's approvals.timeout. The connector waits a little
   longer, and both run on Hermes's clock, so this comes after Hermes's timeout. *)
Expire(r) ==
  /\ outcome[r] = "timeout" /\ r \notin expired
  /\ expired' = expired \cup {r}
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, cread, answers, sent, outcome, cards, stale, events, seen, bridged>>

\* With nothing pending, the turn can finish.
End ==
  /\ ~ended /\ queue = <<>>
  /\ ended' = TRUE
  /\ status' = NONE
  /\ stream' = Append(stream, <<"end", NONE>>)
  /\ UNCHANGED <<queue, asked, read, cread, answers, sent, outcome, expired, cards, stale, events, seen, bridged>>

\* The thread screen reads the next event from the run's stream.
Read ==
  /\ read < Len(stream)
  /\ read' = read + 1
  /\ UNCHANGED <<queue, asked, ended, status, stream, cread, answers, sent, outcome, expired, cards, stale, events, seen, bridged>>

\* The connector reads the next event from the run's stream (run-approvals.mjs follow).
ConnectorRead ==
  /\ cread < Len(stream)
  /\ cread' = cread + 1
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, answers, sent, outcome, expired, cards, stale, events, seen, bridged>>

Send(from, rs) ==
  /\ sent' = sent \cup {<<from, r>> : r \in rs}
  /\ answers' = answers \cup {[from |-> from, for |-> r] : r \in rs}

\* The person answers the request the thread screen shows (app.ts answerApproval).
AppAnswer ==
  /\ Shown # NONE /\ <<"app", Shown>> \notin sent
  /\ Send("app", {Shown})
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, cread, outcome, expired, cards, stale, events, seen, bridged>>

\* A phone answers an open card. The cloud resolves the card and appends an
\* action event under the card's key, runId:requestId (cloud/src/inbox.ts).
CardAnswer(r) ==
  /\ cards[r] = "open"
  /\ cards' = [cards EXCEPT ![r] = "closed"]
  /\ events' = events \cup {r}
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, cread, answers, sent, outcome, expired, stale, seen, bridged>>

\* The bridge answers Hermes from the event's key, and moves its cursor only
\* once Hermes took it or said it was gone (cloud.mjs poll).
BridgeAnswer(r) ==
  /\ r \in events /\ <<"card", r>> \notin sent
  /\ events' = events \ {r}
  /\ Send("card", {r})
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, cread, outcome, expired, cards, stale, seen, bridged>>

\* The connector's run monitor reads the run's status (notifications.mjs).
Poll ==
  /\ seen' = status
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, cread, answers, sent, outcome, expired, cards, stale, events, bridged>>

\* With away on, the monitor denies every request the run waits on, then reads
\* the run again (notifications.mjs, away.mjs deny).
AwayDeny ==
  /\ Away /\ seen # "unread"
  /\ LET due == {r \in AsksFrom(seen) : <<"away", r>> \notin sent}
     IN /\ due # {}
        /\ Send("away", due)
  /\ seen' = "unread"
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, cread, outcome, expired, cards, stale, events, bridged>>

\* The bridge gets the requests the run waits on and posts a card for each
\* (cloud.mjs runStatus). It marks a card to resolve once the events it read
\* show its request closed or timed out (run-approvals.mjs settled), or, knowing
\* only the status, once the request is off it. Away mode bridges only once
\* Hermes has nothing left to deny.
Bridge ==
  /\ seen # "unread"
  /\ ~(Away /\ AsksFrom(seen) \cap Pending # {})
  /\ LET asks == AsksFrom(seen) IN
     /\ stale' = IF ClosesStaleCards
                   THEN stale \cup {r \in Requests : cards[r] = "open" /\ r \notin asks /\ (~ReadsEvents \/ r \in ClosedHere)}
                   ELSE stale
     /\ cards' = [r \in Requests |-> IF r \in asks /\ cards[r] = "none" THEN "open" ELSE cards[r]]
     /\ bridged' = <<asks, ClosedHere>>
  /\ seen' = "unread"
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, cread, answers, sent, outcome, expired, events>>

\* The bridge resolves a marked card (cloud.mjs poll, patchCard).
CloseCard(r) ==
  /\ r \in stale
  /\ stale' = stale \ {r}
  /\ cards' = IF cards[r] = "open" THEN [cards EXCEPT ![r] = "closed"] ELSE cards
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, cread, answers, sent, outcome, expired, events, seen, bridged>>

\* Hermes takes an answer. With a request_id it settles exactly that request,
\* or answers 409 when it is gone; without one it settles the oldest pending
\* (tools/approval.py resolve_gateway_approval). Settling one puts the run
\* back to running and drops the approval from its status, even while another
\* request still waits, and its approval.responded event names the request only
\* when the answer did (api_server_runs.py _mark_run_event, _handle_run_approval).
HermesAnswer(a) ==
  /\ a \in answers
  /\ answers' = answers \ {a}
  /\ LET target == IF AnswersById THEN (IF a.for \in Pending THEN a.for ELSE NONE)
                   ELSE (IF queue # <<>> THEN queue[1] ELSE NONE)
     IN IF target = NONE
          THEN UNCHANGED <<queue, status, stream, outcome>>
          ELSE /\ queue' = Without(queue, target)
               /\ outcome' = [outcome EXCEPT ![target] = a.for]
               /\ status' = NONE
               /\ stream' = Append(stream, <<"answered", IF AnswersById THEN target ELSE NONE>>)
  /\ UNCHANGED <<asked, ended, read, cread, sent, expired, cards, stale, events, seen, bridged>>

Next ==
  \/ \E r \in Requests : Ask(r) \/ Timeout(r) \/ Expire(r) \/ CardAnswer(r) \/ BridgeAnswer(r) \/ CloseCard(r)
  \/ End \/ Read \/ ConnectorRead \/ AppAnswer \/ Poll \/ AwayDeny \/ Bridge
  \/ \E a \in answers : HermesAnswer(a)

Spec == Init /\ [][Next]_vars

\* Everything sent is answered, both readers have read the whole stream, time has
\* run out on every request Hermes timed out, and the bridge has acted on the
\* run as it is now.
Quiet ==
  /\ read = Len(stream) /\ cread = Len(stream)
  /\ answers = {} /\ events = {} /\ stale = {} /\ seen = "unread"
  /\ \A r \in Requests : outcome[r] = "timeout" => r \in expired
  /\ bridged = <<AsksFrom(status), ClosedHere>>

\* Rule 1: an answer settles only the request it was given for.
AnswerMatches == \A r \in Requests : outcome[r] \in {NONE, "timeout", r}

\* Rule 2: once quiet, the thread screen shows a request Hermes waits on whenever
\* there is one.
ScreenShows == Quiet => (Pending # {} => Shown \in Pending)

\* Rule 3: once quiet, every request Hermes waits on has an open card, so it
\* reaches a phone that isn't on the thread.
CardForEach == Quiet => \A r \in Pending : cards[r] = "open"

\* Rule 4: once quiet, every open card is for a request Hermes waits on.
CardsCurrent == Quiet => \A r \in Requests : cards[r] = "open" => r \in Pending
=============================================================================
