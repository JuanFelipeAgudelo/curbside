# Messages to passengers

Drivers reach every passenger the evening before a run, and again from the curb until they are in
the car. They message, they do not call (the owner, 2026-09-28): **WhatsApp first, else a text
message**. Teams cannot be opened from a phone number. Built in `public/messages.js`.

## The app never sends

Curbside fills in the driver's own message and **opens** WhatsApp or Messages with it. The driver
reads it, edits it if they want, and sends it. The agent may draft a message and give the link; it
never sends one, and it never marks a passenger as messaged on its own: the driver ticks that,
because the app cannot see a message sent, and a draft opened but never sent must not read as done.

## One message per kind of trip

Picked by the tag dispatch printed on the passenger's row:

| Kind | Tags |
|---|---|
| Departures | D, GBD |
| Arrivals | A, GBA |
| Medical | MED |
| Shuttle | S |
| Everything else | HO, TD, no tag |

Each driver writes their own words for each kind. The default is the owner's own message:

> Dear [NAME],
> I have the pleasure of being your driver from [FROM] to [TO] for flight [FLIGHT].
> I'll meet you outside [DOOR] at [TIME].
> Does this work for you?
>
> Please let me know if there's anything I can do to make your trip smoother.
> See you [DAY]!
> -[MY NAME]

The others differ only in their second and third lines:

- Arrivals: "...from [FROM] to [TO]." then "I'll meet you outside baggage claim when flight [FLIGHT] lands at [TIME]."
- Medical: "...from [FROM] to [TO] for your [APPOINTMENT] appointment." then "I'll meet you outside [DOOR] at [TIME]."
- Shuttle and everything else: "...from [FROM] to [TO]." then "I'll meet you outside [DOOR] at [TIME]."

## The fields

| Field | Fills with |
|---|---|
| `[NAME]` | For a row of two or more (a party, or a name with "&"): "Family Castillo". For one person: "Brother Castillo", "Sister Castillo" or "Castillo", **which the app cannot know and never guesses from a name**: it asks the driver the first time, and remembers the answer for that passenger. |
| `[LAST NAME]` | The surname: the part before the comma ("Castillo, Ana" → Castillo). |
| `[FROM]`, `[TO]` | The places a passenger knows: an airport by its code (JFK), anywhere else the site dispatch printed (Warwick, Fishkill). Never the door: "Main Lobby" says nothing about which one. |
| `[DOOR]` | The pickup's door as dispatch printed it ("A-res WRK", "Baggage Claim"); the place when the door is blank. |
| `[FLIGHT]` | The flight number (flights only). |
| `[APPOINTMENT]` | The appointment time (medical). |
| `[TIME]` | The passenger's own pickup time, not the run's start. An arrival: the landing, the live estimate once the flight is checked, the printed time before that, dispatch's time at the stop last. Anyone else: dispatch's time at their door (the driver's own time if they set one). |
| `[DAY]` | "today", "tomorrow", "on Tuesday" within the week, "on Tue 6 Oct" further out. |
| `[MY NAME]` | The driver's name, as they typed it in their settings. |

**A field with nothing to fill stays in brackets** (`[FLIGHT]` when the sheet has no flight), so the
driver sees it in the draft before sending. Field names are matched in any case and spacing.

## The evening before, and the day itself

- **The evening before:** the draft, as above ("See you tomorrow").
- **On the day of the run:** an empty chat. At the curb the driver writes their own.
- **After a change:** if the plan the driver told a passenger has changed since (a re-sent sheet or
  the driver's own correction: the time, door, from, to, flight, appointment, day or phone), the
  passenger counts as **not messaged again**, shown in red: "MESSAGED 6:12p · CHANGED SINCE" and what
  changed ("time 7:30a (was 7:00a)"). The new draft starts with "Update:" on its own line. A flight
  running late is not a change of plan (the time said is the printed one); a flight filled in where
  there was none is not a change either.

## The evening list

"MESSAGES FOR TUE 29 SEP · 4 LEFT": every passenger of the first day with a run not yet started, with
their pickup time and place, the number and its two buttons, ticked as the driver goes
("MESSAGED 7:02p"). **A passenger with no number is listed and flagged, never left out**: 61 of 411
passengers in the sample had none, and those are the ones that slip through otherwise.

## The number

WhatsApp needs the country code:

- a number starting `+`: its digits (8 to 15 of them);
- starting `00`: the digits after it (8 to 15 left);
- 10 digits starting 2–9 (a US number): `1` in front;
- 11 digits starting `1`: as is;
- anything else: **no WhatsApp button** (it could open a chat with the wrong person), TEXT only, and
  a line saying the number has no country code and where to fix it.

Links: WhatsApp `https://wa.me/<digits>?text=<the message, URL-encoded>`; a text message
`sms:+<digits>?&body=<the message, URL-encoded>` (the one form both iPhone and Android read).
A party's other members' numbers, when printed, get their own pair.

## No lecture

The app does not explain the deadline for messaging or restate the rule: the driver has done this a
thousand times. The list is the feature.
