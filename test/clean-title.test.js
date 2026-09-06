/**
 * cleanTitle against real channel formats.
 *
 * Every case here is an actual YouTube title from the catalog, because the
 * failures this function has are not the ones you invent at a desk — the naive
 * "first segment without marketing words" rule looked obviously right and
 * silently returned cast lists for a third of the catalog.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanTitle, extractYear } from '../src/transform/title.js';

test('the year parenthetical anchors the title', () => {
  // Marketing wraps the title on both sides with no pipe to split on.
  assert.equal(
    cleanTitle('NEW HD RESTORATION🍕 The Crawling Hand (1963) Sci-Fi Horror Classic, FULL HD MOVIE', 'PizzaFlix'),
    'The Crawling Hand');
  assert.equal(
    cleanTitle('🍕The Florodora Girl (MGM,1930) Full HD Movie, Marion Davies', 'PizzaFlix'),
    'The Florodora Girl');
  assert.equal(
    cleanTitle('A Killer on the Run! Clearing the Way with Bullets (1962) Pulp Crime Noir', 'Cult Cinema Classics'),
    'Clearing the Way with Bullets');
  assert.equal(
    cleanTitle('THE LATIN QUARTER CLAN! 💥 Without Warning (1973) [French Audio]', 'Cult Cinema Classics'),
    'Without Warning');
});

test('the channel brand is stripped from its own uploads', () => {
  // Left in place it is carried into the normalized key and matches nothing,
  // which silently rejected this channel's entire 2,204-film catalog.
  assert.equal(cleanTitle('Wu Tang Collection - The Eight Immortals', 'Wu Tang Collection'),
               'The Eight Immortals');
  assert.equal(cleanTitle('Wu Tang Collection - THE IRON MONKEY - (ENGLISH Subtitled)- CHEN KUAN TAI',
                          'Wu Tang Collection'),
               'THE IRON MONKEY');
});

test('a cast list never wins over the title', () => {
  assert.equal(cleanTitle('Bagheera Full Movie (HD) |  Prabhu Deva, Amyra Dastur', 'Shemaroo Movies'),
               'Bagheera');
  assert.equal(cleanTitle('Bollywood COMEDY Movie | Fool N Final | FULL MOVIE (HD) | Sunny Deol, Shahid Kapoor',
                          'Shemaroo Movies'),
               'Fool N Final');
});

test('titles that merely look like cast lists or marketing survive', () => {
  // One comma joining a lowercase continuation is a title, not a cast list.
  assert.equal(cleanTitle('The Good, the Bad and the Ugly | Western', 'Grjngo'),
               'The Good, the Bad and the Ugly');
  // A dash with no space on either side is part of the word.
  assert.equal(cleanTitle('Spider-Man', 'X'), 'Spider-Man');
  // A dash segment with lowercase is a subtitle, not a shouted performer name.
  assert.equal(cleanTitle('Ace Ventura - Pet Detective', 'X'), 'Ace Ventura - Pet Detective');
});

test('the spec §2 example still holds', () => {
  assert.equal(cleanTitle('FULL MOVIE | The Sea Wolf (1941) | Free Drama 4K', 'Movie Central'),
               'The Sea Wolf');
});

test('extractYear reads the raw title, not the cleaned one', () => {
  // cleanTitle drops the year now, so the year must come off the raw string.
  const raw = '🍕Cavalry Command (1963) Full HD Movie | John Agar';
  assert.equal(cleanTitle(raw, 'PizzaFlix'), 'Cavalry Command');
  assert.equal(extractYear(raw), 1963);
});

test('a title with no usable content falls back rather than returning empty', () => {
  assert.equal(cleanTitle('FULL MOVIE', 'X'), 'FULL MOVIE');
  assert.ok(cleanTitle('🍕🍕🍕', 'X').length > 0);
});

test('a clickbait hook never beats the title it precedes', () => {
  // These channels lead with a plot sentence and put the film second. Scoring
  // by length picks the hook every time, which is how 1,496 Movie Central
  // uploads resolved to nothing.
  assert.equal(
    cleanTitle('Single Mother Fights To Save Her Daughter From Armed Invaders | Warning Shot | Full Thriller', 'Movie Central'),
    'Warning Shot');
  assert.equal(
    cleanTitle('The True Story Of WWII Ace Paddy Finucane | The Shamrock Spitfire | Full War Movie', 'Movie Central'),
    'The Shamrock Spitfire');
  assert.equal(
    cleanTitle('Sasquatch Is On A Killing Rampage | Full Movie | Horror | Legend Of Sasquatch', 'Movie Central'),
    'Legend Of Sasquatch');
});

test('trailing cast segments never win', () => {
  assert.equal(
    cleanTitle('Hunt Club | Full Movie | Action Survival | Mickey Rourke | Casper Van Dien', 'Movie Central'),
    'Hunt Club');
  assert.equal(
    cleanTitle('Maze | Full Movie | Action Prison Drama | True Jailbreak Story', 'Movie Central'),
    'Maze');
});

test('the year parenthetical may carry genre words after the year', () => {
  assert.equal(cleanTitle('Docteur Justice (1975 Action film) with John Phillip Law', 'Cult Cinema Classics'),
               'Docteur Justice');
  assert.equal(cleanTitle('Silent Night, Bloody Night (1972 Horror) The night earth became an inferno', 'Cult Cinema Classics'),
               'Silent Night, Bloody Night');
});

test('hook detection counts title words, not the marketing around them', () => {
  // "Cavalry Command (1963) Full HD Movie" is three title words plus noise.
  // Counting the noise pushed it past the hook threshold and lost the film.
  assert.equal(cleanTitle('🍕Cavalry Command (1963) Full HD Movie | John Agar', 'PizzaFlix'),
               'Cavalry Command');
});

test('a long title is not mistaken for a hook', () => {
  // These are real films whose titles run past the hook length threshold. What
  // distinguishes them is typesetting: a title keeps "to", "a", "in" lowercase,
  // while a clickbait hook Title-Cases every word. Getting this wrong dropped
  // 109 already-published films.
  assert.equal(
    cleanTitle('A Minute to Pray a Second to Die | WESTERN | English | Free Spaghetti Western', 'Grjngo'),
    'A Minute to Pray a Second to Die');
  assert.equal(
    cleanTitle('ONE OF THE MOST AUDACIOUS BANK ROBBERIES OF ALL TIME | A Nightingale Sang in Berkeley Square', 'X'),
    'A Nightingale Sang in Berkeley Square');
});

test('a parenthesised year outranks the hook and cast vetoes', () => {
  // The segment carrying the year also carries the title, so it must win even
  // when it looks like a hook or names a cast member.
  assert.equal(
    cleanTitle('THOU SHALT NOT KILL... ⚔️ Absolution (1978) | Classic Psychological Thriller', 'X'),
    'Absolution');
  assert.equal(
    cleanTitle('All Tied Up (1993) with Teri Hatcher | Crime Movie', 'X'),
    'All Tied Up');
});

test('short punctuated titles are not hooks', () => {
  // Spaghetti westerns are full of titles that punctuate like clickbait.
  // Length is what separates a punchy title from a plot summary.
  assert.equal(cleanTitle("Don't Wait, Django... Shoot! | Spaghetti Western", 'Grjngo'),
               "Don't Wait, Django... Shoot!");
});

test('a colon marks a title, not a hook', () => {
  assert.equal(cleanTitle('Blood Hunters: Rise Of The Hybrids | Full Movie | Action Supernatural', 'X'),
               'Blood Hunters: Rise Of The Hybrids');
  assert.equal(cleanTitle('Buckaroo: The Winchester Does Not Forgive | English | Western', 'X'),
               'Buckaroo: The Winchester Does Not Forgive');
});

test('cast names are identified by arriving in a run, not by shape', () => {
  // "Warning Shot" and "Mickey Rourke" are both two capitalised words; shape
  // cannot separate them. Cast credits come two or more together at the end.
  assert.equal(
    cleanTitle("Dig Your Grave Friend... Sabata's Coming | Richard Harrison | Fernando Sancho", 'X'),
    "Dig Your Grave Friend... Sabata's Coming");
  // A lone name-shaped segment between marketing is a title, not a credit.
  assert.equal(
    cleanTitle('Single Mother Fights To Save Her Daughter | Warning Shot | Full Thriller', 'X'),
    'Warning Shot');
  // Marketing is not a person even when shaped like one, or the whole list
  // reads as one cast run and the title is lost.
  assert.equal(
    cleanTitle('Hunt Club | Full Movie | Action Survival | Mickey Rourke | Casper Van Dien', 'X'),
    'Hunt Club');
});

test('the lead segment is never a cast credit', () => {
  // "Doc Hooker's Bunch | DUB TAYLOR" opens with the title and follows with an
  // actor; treating the pair as a cast run swallowed both.
  assert.equal(cleanTitle("Doc Hooker's Bunch | DUB TAYLOR | Funny Western | Cowboy Movie", 'X'),
               "Doc Hooker's Bunch");
  assert.equal(cleanTitle('Gentleman Killer | Anthony Steffen | Spaghetti Western | English', 'X'),
               'Gentleman Killer');
});

test('a segment untouched by the marketing strip beats a genre tag', () => {
  // "Black Drama", "Funny Western" and "Aromanian Full Movie" all shrink under
  // the strip; a real title rarely contains marketing words at all. Without
  // this the genre tag won whenever the title looked like a hook.
  assert.equal(
    cleanTitle('Go Tell It On The Mountain | FULL MOVIE | Ving Rhames, Alfre Woodard | Black Drama', 'X'),
    'Go Tell It On The Mountain');
  assert.equal(
    cleanTitle("I'm Not Famous But I'm Aromanian | Aromanian Full Movie | Comedy Drama Romance", 'X'),
    "I'm Not Famous But I'm Aromanian");
});

test('ellipses and exclamation marks are not hook markers', () => {
  // Titles of this era are full of them. Casing already catches the hooks that
  // use them, so punctuation only produced false positives.
  assert.equal(
    cleanTitle('Have a Good Funeral, My Friend... Sartana Will Pay | Gianni Garko | Western Movie', 'X'),
    'Have a Good Funeral, My Friend... Sartana Will Pay');
  assert.equal(cleanTitle('God Made Them... I Kill Them | WESTERN MOVIE FOR FREE', 'X'),
               'God Made Them... I Kill Them');
});

test('marketing glued onto the opening title does not hand the pick to the star', () => {
  // The Midnight Screening writes "<Title> FULL MOVIE | <Star> | <Genre> |
  // <Channel>". The star's segment is the only untouched one, so requiring an
  // untouched segment published 93 films named after actors -- "Rutger Hauer",
  // "Ray Liotta", "William Shatner". The opening segment wins instead when
  // something is still left of it once marketing and genre words are removed.
  assert.equal(
    cleanTitle('New World Disorder FULL MOVIE | Rutger Hauer | Action Movies | The Midnight Screening', 'X'),
    'New World Disorder');
  assert.equal(
    cleanTitle('Falcon Down FULL MOVIE | William Shatner | Action Movies | The Midnight Screening', 'X'),
    'Falcon Down');
});

test('the relaxed opening rule does not promote a genre tail', () => {
  // The same relaxation, applied anywhere but the first segment, turns the tail
  // into the film: "Hemingway Fishing Drama" and "Seriously Amazing Action
  // Thriller" both survive the marketing strip with two words intact.
  assert.equal(
    cleanTitle('The Old Man And The Sea | FULL MOVIE | Anthony Quinn, Gary Cole | Hemingway Fishing Drama', 'X'),
    'The Old Man And The Sea');
  assert.equal(
    cleanTitle('He Is Hunting A War Criminal | Seriously Amazing Action Thriller Movie | Here Be Dragons', 'X'),
    'Here Be Dragons');
});

test('a title that ends in a lone star keeps the hook-first layout intact', () => {
  // "<Hook> | <Genre> | <Title>" and "<Title> | <Genre> | <Star>" are the same
  // shape, so a trailing name-shaped segment cannot be treated as a credit.
  assert.equal(
    cleanTitle('They Killed Their High School Bully | Full Crime Thriller Movie | Free Movie | Caged Birds', 'X'),
    'Caged Birds');
  assert.equal(
    cleanTitle('Sasquatch Is On A Killing Rampage | Full Movie | Horror Movie | Legend Of Sasquatch', 'X'),
    'Legend Of Sasquatch');
});

test('"with" is read three ways, and length is what tells them apart', () => {
  // A credit ("with Teri Hatcher"), a title joining two noun phrases, and a
  // clickbait clause hanging a phrase off the end. Vetoing every "with" cost
  // the titles; vetoing none of them cost eleven hooks, because looksLikeHook
  // floors at six words and these run five. A title spends its words on the two
  // nouns and stays short; a hook has already said something before it gets
  // there.
  assert.equal(cleanTitle('Poker with Pistols | GEORGE HILTON | Full Western Movie | Cowboy Film', 'X'),
               'Poker with Pistols');
  assert.equal(cleanTitle('Roll With It | FULL MOVIE | Chondra Pierce | Comedy', 'X'),
               'Roll With It');
  assert.equal(cleanTitle('Go with God, Gringo | 8K UHD-2 | English | Western Movie', 'X'),
               'Go with God, Gringo');

  assert.equal(cleanTitle('Trapped With A Killer Dog | Unchained | Adrien Brody | Crime Thriller Movie', 'X'),
               'Unchained');
  assert.equal(cleanTitle('Justice Comes With A Price | Final Instinct | Full Free Action Movie', 'X'),
               'Final Instinct');
  assert.equal(cleanTitle('Trapped in the Arctic With Sharks | Ice Sharks | Shark Month Movie | Full Survival Thriller', 'X'),
               'Ice Sharks');
});

test('the six-word hook floor is load-bearing and stays', () => {
  // Lowering it to five is worth +55 exact index matches across the corpus and
  // is still wrong: a five-word Title-Cased segment is the commonest shape a
  // real film of this era has, and these are indistinguishable from a hook.
  // Convicting them drops the pick through to whatever follows, which on these
  // channels is the star. Measured losses included "The Last Man On Earth" ->
  // "Vincent Price" and "The Hunchback Of Notre Dame" -> "Lon Chaney".
  assert.equal(cleanTitle('The Last Man On Earth | FULL MOVIE | Vincent Price | Sci-Fi Horror', 'X'),
               'The Last Man On Earth');
  assert.equal(cleanTitle('The Hunchback Of Notre Dame | Full Movie | Lon Chaney | Silent Drama', 'X'),
               'The Hunchback Of Notre Dame');
  assert.equal(cleanTitle('Attack Of The Crab Monsters | FULL MOVIE | Roger Corman | Horror', 'X'),
               'Attack Of The Crab Monsters');
});

test('the print label is not part of the film name', () => {
  // Channels carrying several dubs of one film label the print in the title.
  // Left in, it goes into the normalized key and matches nothing — 470 Wu Tang
  // uploads reached no candidate at all for this reason alone.
  assert.equal(cleanTitle('The Shaolin Invincibles WIDESCREEN', 'X'), 'The Shaolin Invincibles');
  assert.equal(cleanTitle('Kung Fu King DUTCH', 'X'), 'Kung Fu King');
  assert.equal(cleanTitle('New big Boss (English Dub)', 'X'), 'New big Boss');
  // Accents must not hide a tag from a word list spelled without them.
  assert.equal(cleanTitle('Shaolin Vs Manchu (Subtítulos en Español)', 'X'), 'Shaolin Vs Manchu');
});

test('a language in the middle of a title is part of the title', () => {
  // Only a trailing run counts, and only a bracket holding nothing else.
  assert.equal(cleanTitle('The English Patient', 'X'), 'The English Patient');
  assert.equal(cleanTitle('Spanish Harlem', 'X'), 'Spanish Harlem');
  assert.equal(cleanTitle('Subway', 'X'), 'Subway');
  assert.equal(cleanTitle('The Sub (1994)', 'X'), 'The Sub');
});

test('a print label is never allowed to eat the title', () => {
  // "The Korean" ends in a language and is not labelled with one. Stripping it
  // left "The", which then matched whatever it pleased. An article on its own
  // is not a title, so it cannot be what a strip leaves behind.
  assert.equal(
    cleanTitle('The Korean FULL MOVIE | Action Movies | Josiah D. Lee | The Midnight Screening', 'X'),
    'The Korean');
  assert.equal(cleanTitle('Django ITALIAN', 'X'), 'Django');
  // "Uncut" and "Uncensored" are title words as often as labels, so they only
  // count inside a bracket: this one lost its second word and matched the 1929
  // New Orleans instead.
  assert.equal(cleanTitle('New Orleans Uncensored | English Full Movie | Film-Noir Crime Drama', 'X'),
               'New Orleans Uncensored');
});
