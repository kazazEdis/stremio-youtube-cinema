# Getting a film's name out of a YouTube title

Channels do not publish titles. They publish marketing, and the film's name is
somewhere inside it:

    🍕Cavalry Command (1963) Full HD Movie | John Agar, Richard Arlen
    New World Disorder FULL MOVIE | Rutger Hauer | Action Movies | The Midnight Screening
    They Killed Their High School Bully | Full Crime Thriller Movie | Free Movie | Caged Birds
    笑傲江湖II東方不敗 (Swordsman II)｜李連杰、關之琳｜粵語中字｜美亞影院

Every rule in `src/transform/title.js` exists because a real channel broke the
previous one. The tests pin the cases; this page explains the shape of the
problem.

## Cleaning is a *transform*, not an extraction

It used to run during the fetch, which meant the cleaned title was stored as
though it were a fact. Improving a heuristic then forced a re-clean of the whole
catalogue — done three times in one day. Storing only `rawTitle` and deriving
the name at transform time makes a title fix cost a replay, never a re-fetch.

## The two layouts that look identical

    <Title> | <Genre> | <Star>        ->  the title is first
    <Hook>  | <Genre> | <Title>       ->  the title is last

There is no shape-based way to tell `… | Action Western Movie | Michael Paré`
from `… | Free Movie | Caged Birds`. **Person-shape and title-shape are the same
shape** — `Warning Shot`, `Caged Birds`, `Final Instinct` and `Moving Parts` all
read as names. Three separate attempts to exploit that were measured and
rejected:

| attempt | net | why it failed |
|---|---|---|
| treat a trailing name-shaped segment as a credit | −37 | the two layouts above |
| deprioritise lone name-shaped segments | −137 | same, from the other side |
| relax the tier-2 rule everywhere | +49 | promoted genre tails over real titles |

## Rules that did survive

- **The year is the dependable anchor.** Channels attach it to the title and
  never to the cast or the marketing tail.
- **Position beats tidiness in the opening segment.** Marketing is glued *onto*
  real titles as often as it stands alone, so requiring an untouched segment
  handed the pick to whatever came later and happened to be clean — which on
  these channels is the star. The catalogue grew films called "Rutger Hauer".
  93 of them, found by matching clean titles against the index's credits table.
- **A genre vocabulary separates a title from a tag.** `New World Disorder FULL
  MOVIE` leaves real words after both strips; `Action Movies` leaves nothing.
- **The print label is not the film's name.** `WIDESCREEN`, `DUTCH`,
  `(English Dub)`, `(Subtítulos en Español)`. 470 uploads on one channel failed
  for this alone. Only a *trailing* run, and only a bracket holding nothing
  else — `The English Patient` keeps its language.
- **An article alone cannot be what a strip leaves behind.** `The Korean` became
  `The`, which then matched whatever it liked.

## The floor that stays wrong on purpose

`looksLikeHook` requires six words. Lowering it to five is worth **+55** exact
index matches and is still wrong: a five-word Title-Cased segment is the
commonest shape a real film of this era has, and convicting it drops the pick to
the star.

    The Last Man On Earth        ->  Vincent Price
    The Hunchback Of Notre Dame  ->  Lon Chaney
    Attack Of The Crab Monsters  ->  Roger Corman

Because of that floor, a bare `with` has to stay a cast-hint veto even though
`with` is ordinary title English — it is catching hooks the floor misses. The
compromise: `with` inside a segment of five words or more is a hook, under five
it joins two noun phrases. `Poker with Pistols` survives; `Trapped With A Killer
Dog` does not.
