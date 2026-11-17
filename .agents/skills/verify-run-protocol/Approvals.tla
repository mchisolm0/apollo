----------------------------- MODULE Approvals -----------------------------
(* One Hermes run asking for approvals, and everything that can answer them:
   the phone's thread screen, a cloud approval card answered from any phone,
   and away mode on the connector. Hermes is the authority: an answer settles
   only a request still pending in its queue. *)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
  Requests,          \* request ids Hermes can mint in this run, e.g. {r1, r2}
  AtOnce,            \* TRUE: two requests can wait at once (parallel subagents)
  Away,              \* away mode is on for the whole run
  AnswersById,       \* FALSE: answers leave out request_id
  ClosesStaleCards,  \* FALSE: the bridge leaves a card open after its request moves on
  NONE

VARIABLES
  queue,     \* Hermes's pending requests, oldest first
  asked,     \* requests Hermes has asked
  ended,     \* the run ended
  status,    \* the request on the run's status, or NONE
  stream,    \* the run's events, which the thread screen reads in order
  read,      \* how many of them the thread screen has read
  answers,   \* answers on their way to Hermes, each [from, for]
  sent,      \* answers already sent, so each surface answers a request once
  outcome,   \* r -> NONE, "timeout", or the request the answer that settled r was for
  cards,     \* r -> "none", "open" or "closed": its cloud approval card
  stale,     \* cards the bridge marked to resolve and has not closed yet
  events,    \* cloud card answers the bridge has not passed to Hermes yet
  seen,      \* the status the connector's run monitor read, not yet acted on, or "unread"
  bridged    \* the last status the bridge acted on, or "unread"

vars == <<queue, asked, ended, status, stream, read, answers, sent, outcome,
          cards, stale, events, seen, bridged>>

Pending == {queue[i] : i \in 1..Len(queue)}
Without(s, r) == SelectSeq(s, LAMBDA x : x # r)

Init ==
  /\ queue = <<>> /\ asked = {} /\ ended = FALSE /\ status = NONE
  /\ stream = <<>> /\ read = 0
  /\ answers = {} /\ sent = {}
  /\ outcome = [r \in Requests |-> NONE]
  /\ cards = [r \in Requests |-> "none"]
  /\ stale = {} /\ events = {} /\ seen = "unread" /\ bridged = "unread"

(* The request the thread screen shows: the latest approval.request with no
   approval.responded or run end after it (run-state.ts currentApproval). *)
RECURSIVE ShownIn(_)
ShownIn(s) ==
  IF s = <<>> THEN NONE
  ELSE LET e == s[Len(s)] IN
       IF e[1] = "ask" THEN e[2]
       ELSE IF e[1] \in {"answered", "end"} THEN NONE
       ELSE ShownIn(SubSeq(s, 1, Len(s) - 1))
Shown == ShownIn(SubSeq(stream, 1, read))

\* A tool asks for approval. Hermes parks the run on it, so the run's status
\* shows the newest request (api_server_runs.py _approval_notify).
Ask(r) ==
  /\ r \notin asked /\ ~ended
  /\ AtOnce \/ queue = <<>>
  /\ queue' = Append(queue, r)
  /\ asked' = asked \cup {r}
  /\ status' = r
  /\ stream' = Append(stream, <<"ask", r>>)
  /\ UNCHANGED <<ended, read, answers, sent, outcome, cards, stale, events, seen, bridged>>

\* Nobody answered in time: Hermes denies it and emits no event, so the status
\* and the stream keep showing it (approval_gateway_wait.py).
Timeout(r) ==
  /\ r \in Pending
  /\ queue' = Without(queue, r)
  /\ outcome' = [outcome EXCEPT ![r] = "timeout"]
  /\ UNCHANGED <<asked, ended, status, stream, read, answers, sent, cards, stale, events, seen, bridged>>

\* With nothing pending, the turn can finish.
End ==
  /\ ~ended /\ queue = <<>>
  /\ ended' = TRUE
  /\ status' = NONE
  /\ stream' = Append(stream, <<"end", NONE>>)
  /\ UNCHANGED <<queue, asked, read, answers, sent, outcome, cards, stale, events, seen, bridged>>

\* The thread screen reads the next event from the run's stream.
Read ==
  /\ read < Len(stream)
  /\ read' = read + 1
  /\ UNCHANGED <<queue, asked, ended, status, stream, answers, sent, outcome, cards, stale, events, seen, bridged>>

Send(from, r) ==
  /\ <<from, r>> \notin sent
  /\ sent' = sent \cup {<<from, r>>}
  /\ answers' = answers \cup {[from |-> from, for |-> r]}

\* The person answers the request the thread screen shows (app.ts answerApproval).
AppAnswer ==
  /\ Shown # NONE
  /\ Send("app", Shown)
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, outcome, cards, stale, events, seen, bridged>>

\* A phone answers an open card. The cloud resolves the card and appends an
\* action event under the card's key, runId:requestId (cloud/src/inbox.ts).
CardAnswer(r) ==
  /\ cards[r] = "open"
  /\ cards' = [cards EXCEPT ![r] = "closed"]
  /\ events' = events \cup {r}
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, answers, sent, outcome, stale, seen, bridged>>

\* The bridge answers Hermes from the event's key, and moves its cursor only
\* once Hermes took it or said it was gone (cloud.mjs poll).
BridgeAnswer(r) ==
  /\ r \in events
  /\ events' = events \ {r}
  /\ Send("card", r)
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, outcome, cards, stale, seen, bridged>>

\* The connector's run monitor reads the run's status (notifications.mjs).
Poll ==
  /\ seen' = status
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, answers, sent, outcome, cards, stale, events, bridged>>

\* With away on, the monitor denies the request on the status it read, and
\* hands the status to the bridge only when Hermes says that request is gone
\* (away.mjs deny).
AwayDeny ==
  /\ Away /\ seen \notin {"unread", NONE}
  /\ <<"away", seen>> \notin sent
  /\ Send("away", seen)
  /\ seen' = "unread"
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, outcome, cards, stale, events, bridged>>

\* The bridge gets the status: it marks the run's other cards to resolve, and
\* posts a card for the request on the status (cloud.mjs runStatus).
Bridge ==
  /\ seen # "unread"
  /\ ~(Away /\ seen # NONE /\ seen \in Pending)
  /\ stale' = IF ClosesStaleCards
                THEN stale \cup {r \in Requests : cards[r] = "open" /\ r # seen}
                ELSE stale
  /\ cards' = IF seen # NONE /\ cards[seen] = "none"
                THEN [cards EXCEPT ![seen] = "open"] ELSE cards
  /\ seen' = "unread"
  /\ bridged' = seen
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, answers, sent, outcome, events>>

\* The bridge resolves a marked card (cloud.mjs poll, patchCard).
CloseCard(r) ==
  /\ r \in stale
  /\ stale' = stale \ {r}
  /\ cards' = IF cards[r] = "open" THEN [cards EXCEPT ![r] = "closed"] ELSE cards
  /\ UNCHANGED <<queue, asked, ended, status, stream, read, answers, sent, outcome, events, seen, bridged>>

\* Hermes takes an answer. With a request_id it settles exactly that request,
\* or answers 409 when it is gone; without one it settles the oldest pending
\* (tools/approval.py resolve_gateway_approval). Settling one puts the run
\* back to running and drops the approval from its status, even while another
\* request still waits (api_server_runs.py _mark_run_event).
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
               /\ stream' = Append(stream, <<"answered", target>>)
  /\ UNCHANGED <<asked, ended, read, sent, cards, stale, events, seen, bridged>>

Next ==
  \/ \E r \in Requests : Ask(r) \/ Timeout(r) \/ CardAnswer(r) \/ BridgeAnswer(r) \/ CloseCard(r)
  \/ End \/ Read \/ AppAnswer \/ Poll \/ AwayDeny \/ Bridge
  \/ \E a \in answers : HermesAnswer(a)

Spec == Init /\ [][Next]_vars

\* Everything sent is answered, the screen has read the whole stream, and the
\* bridge has acted on the current status.
Quiet ==
  /\ read = Len(stream) /\ answers = {} /\ events = {} /\ stale = {}
  /\ seen = "unread" /\ bridged = status

\* Rule 1: an answer settles only the request it was given for.
AnswerMatches == \A r \in Requests : outcome[r] \in {NONE, "timeout", r}

\* Rule 2: once quiet, every request Hermes waits on can be answered: the
\* thread screen shows it or its cloud card is open.
PendingVisible == Quiet => \A r \in Pending : Shown = r \/ cards[r] = "open"

\* Rule 3: once quiet, the only open card is for the request on the status.
CardsCurrent == Quiet => \A r \in Requests : cards[r] = "open" => r = status
=============================================================================
