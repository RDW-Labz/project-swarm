// SPDX-License-Identifier: Apache-2.0
// Phase 17 practice run: writes a SYNTHETIC project (a scope of 100 tiny requirements in 5 stages, an empty ES-module skeleton, a test script) into a throwaway folder.
// This is a fixture generator, not app code: the project it writes lives in its own repo (never in project-swarm) and nothing in it is real.
// usage: node tests/fixtures/make-practice-project.mjs DIR
import fs from 'node:fs/promises';
import path from 'node:path';

// [name, what it does, example one, example two]
const FUNCTIONS = [
  // numbers (S1)
  ['clamp', 'clamp(n, min, max) returns n limited to the range min..max', 'clamp(5, 0, 3) returns 3', 'clamp(-2, 0, 3) returns 0'],
  ['lerp', 'lerp(a, b, t) returns the point t of the way from a to b', 'lerp(0, 10, 0.5) returns 5', 'lerp(2, 4, 0.25) returns 2.5'],
  ['roundTo', 'roundTo(n, places) rounds n to that many decimal places', 'roundTo(3.14159, 2) returns 3.14', 'roundTo(2.5, 0) returns 3'],
  ['sum', 'sum(list) adds the numbers in a list', 'sum([1, 2, 3]) returns 6', 'sum([]) returns 0'],
  ['mean', 'mean(list) returns the average of a non-empty list', 'mean([2, 4, 6]) returns 4', 'mean([1, 2]) returns 1.5'],
  ['median', 'median(list) returns the middle value of a non-empty list (the average of the two middle values when the length is even)', 'median([3, 1, 2]) returns 2', 'median([1, 2, 3, 4]) returns 2.5'],
  ['gcd', 'gcd(a, b) returns the greatest common divisor of two positive integers', 'gcd(12, 18) returns 6', 'gcd(7, 13) returns 1'],
  ['lcm', 'lcm(a, b) returns the least common multiple of two positive integers', 'lcm(4, 6) returns 12', 'lcm(3, 5) returns 15'],
  ['isPrime', 'isPrime(n) tells whether an integer n is prime', 'isPrime(7) returns true', 'isPrime(9) returns false and isPrime(1) returns false'],
  ['factorial', 'factorial(n) returns n! for an integer 0..20', 'factorial(5) returns 120', 'factorial(0) returns 1'],
  ['fibonacci', 'fibonacci(n) returns the nth Fibonacci number with fibonacci(0) = 0', 'fibonacci(10) returns 55', 'fibonacci(1) returns 1'],
  ['digitSum', 'digitSum(n) returns the sum of the digits of a non-negative integer', 'digitSum(1234) returns 10', 'digitSum(0) returns 0'],
  ['reverseNumber', 'reverseNumber(n) returns the digits of a non-negative integer in reverse order as a number', 'reverseNumber(1200) returns 21', 'reverseNumber(7) returns 7'],
  ['toBinary', 'toBinary(n) returns the binary text of a non-negative integer', 'toBinary(5) returns "101"', 'toBinary(0) returns "0"'],
  ['fromBinary', 'fromBinary(text) returns the integer for a binary text', 'fromBinary("101") returns 5', 'fromBinary("0") returns 0'],
  ['percent', 'percent(part, whole) returns part as a percentage of whole, rounded to one decimal place', 'percent(1, 3) returns 33.3', 'percent(50, 200) returns 25'],
  ['sign', 'sign(n) returns -1, 0 or 1 for a negative, zero or positive number', 'sign(-8) returns -1', 'sign(0) returns 0'],
  ['absDiff', 'absDiff(a, b) returns the absolute difference of two numbers', 'absDiff(3, 10) returns 7', 'absDiff(-2, -5) returns 3'],
  ['isEven', 'isEven(n) tells whether an integer is even', 'isEven(4) returns true', 'isEven(-3) returns false'],
  ['maxOf', 'maxOf(list) returns the largest number of a non-empty list', 'maxOf([3, 9, 2]) returns 9', 'maxOf([-1, -5]) returns -1'],
  // strings (S2)
  ['slugify', 'slugify(text) lowercases text, replaces runs of non-letters and non-digits with one dash, and trims dashes from the ends', 'slugify("Hello World") returns "hello-world"', 'slugify("  A  B! ") returns "a-b"'],
  ['capitalize', 'capitalize(text) makes the first letter upper case and leaves the rest as it is', 'capitalize("word") returns "Word"', 'capitalize("") returns ""'],
  ['titleCase', 'titleCase(text) capitalizes every word of text and lowercases the rest of each word', 'titleCase("hello big WORLD") returns "Hello Big World"', 'titleCase("a") returns "A"'],
  ['camelCase', 'camelCase(text) turns words separated by spaces, dashes or underscores into camelCase', 'camelCase("make it so") returns "makeItSo"', 'camelCase("my_var-name") returns "myVarName"'],
  ['snakeCase', 'snakeCase(text) turns words separated by spaces or dashes, or camelCase, into snake_case', 'snakeCase("Make It So") returns "make_it_so"', 'snakeCase("myVarName") returns "my_var_name"'],
  ['kebabCase', 'kebabCase(text) turns words separated by spaces or underscores, or camelCase, into kebab-case', 'kebabCase("Make It So") returns "make-it-so"', 'kebabCase("myVarName") returns "my-var-name"'],
  ['reverseText', 'reverseText(text) returns the characters of text in reverse order', 'reverseText("abc") returns "cba"', 'reverseText("") returns ""'],
  ['truncate', 'truncate(text, max) cuts text to at most max characters and ends it with "…" when it was cut (the dots count in max)', 'truncate("abcdefghij", 5) returns "abcd…"', 'truncate("abc", 5) returns "abc"'],
  ['padLeft', 'padLeft(text, width, fill) pads text on the left with fill (one character) up to width', 'padLeft("7", 3, "0") returns "007"', 'padLeft("abcd", 3, "0") returns "abcd"'],
  ['countWords', 'countWords(text) counts the words separated by whitespace', 'countWords("a b  c") returns 3', 'countWords("   ") returns 0'],
  ['isPalindrome', 'isPalindrome(text) tells whether text reads the same backwards, ignoring case and anything that is not a letter or digit', 'isPalindrome("A man, a plan, a canal: Panama") returns true', 'isPalindrome("hello") returns false'],
  ['vowelCount', 'vowelCount(text) counts the vowels a, e, i, o, u in text, ignoring case', 'vowelCount("Education") returns 5', 'vowelCount("rhythm") returns 0'],
  ['repeatText', 'repeatText(text, n, sep) joins n copies of text with sep', 'repeatText("ab", 3, "-") returns "ab-ab-ab"', 'repeatText("x", 0, ",") returns ""'],
  ['collapseSpaces', 'collapseSpaces(text) replaces every run of whitespace by one space and trims the ends', 'collapseSpaces("  a   b \\n c ") returns "a b c"', 'collapseSpaces("") returns ""'],
  ['initials', 'initials(name) returns the upper-case first letters of each word of a name', 'initials("ada lovelace") returns "AL"', 'initials("Plato") returns "P"'],
  ['caesar', 'caesar(text, shift) shifts each ASCII letter by shift places in the alphabet (wrapping, case kept) and leaves other characters', 'caesar("abc", 1) returns "bcd"', 'caesar("Zz!", 1) returns "Aa!"'],
  ['isAnagram', 'isAnagram(a, b) tells whether two words use the same letters the same number of times, ignoring case', 'isAnagram("Listen", "Silent") returns true', 'isAnagram("abc", "abd") returns false'],
  ['dedupeChars', 'dedupeChars(text) removes repeated characters, keeping the first of each', 'dedupeChars("banana") returns "ban"', 'dedupeChars("") returns ""'],
  ['stripTags', 'stripTags(html) removes every piece of text that starts with < and ends with >', 'stripTags("<b>Hi</b> there") returns "Hi there"', 'stripTags("no tags") returns "no tags"'],
  ['startsWithAny', 'startsWithAny(text, prefixes) tells whether text starts with any of the prefixes', 'startsWithAny("foobar", ["x", "foo"]) returns true', 'startsWithAny("bar", []) returns false'],
  // arrays (S3)
  ['unique', 'unique(list) removes duplicates, keeping the first of each and the order', 'unique([1, 2, 1, 3, 2]) returns [1, 2, 3]', 'unique([]) returns []'],
  ['chunk', 'chunk(list, size) splits a list into lists of at most size items', 'chunk([1, 2, 3, 4, 5], 2) returns [[1, 2], [3, 4], [5]]', 'chunk([], 3) returns []'],
  ['flatten', 'flatten(list) flattens one level of nested lists', 'flatten([1, [2, 3], [[4]]]) returns [1, 2, 3, [4]]', 'flatten([]) returns []'],
  ['zip', 'zip(a, b) pairs items of two lists up to the shorter length', 'zip([1, 2, 3], ["a", "b"]) returns [[1, "a"], [2, "b"]]', 'zip([], [1]) returns []'],
  ['range', 'range(start, end) returns the integers from start up to but not including end', 'range(2, 5) returns [2, 3, 4]', 'range(3, 3) returns []'],
  ['compact', 'compact(list) removes null, undefined, false, 0 and "" from a list', 'compact([0, 1, false, 2, "", 3, null]) returns [1, 2, 3]', 'compact([]) returns []'],
  ['take', 'take(list, n) returns the first n items', 'take([1, 2, 3], 2) returns [1, 2]', 'take([1], 5) returns [1]'],
  ['drop', 'drop(list, n) returns the list without its first n items', 'drop([1, 2, 3], 1) returns [2, 3]', 'drop([1], 5) returns []'],
  ['last', 'last(list) returns the last item, or undefined for an empty list', 'last([1, 2, 3]) returns 3', 'last([]) returns undefined'],
  ['nth', 'nth(list, n) returns the item at n, counting from the end when n is negative, or undefined when out of range', 'nth([10, 20, 30], -1) returns 30', 'nth([10], 4) returns undefined'],
  ['countBy', 'countBy(list, fn) returns an object counting items by the key fn gives', 'countBy([1, 2, 3, 4], n => (n % 2 ? "odd" : "even")) returns { odd: 2, even: 2 }', 'countBy([], x => x) returns {}'],
  ['partition', 'partition(list, fn) returns [items where fn is true, items where fn is false]', 'partition([1, 2, 3, 4], n => n > 2) returns [[3, 4], [1, 2]]', 'partition([], x => x) returns [[], []]'],
  ['intersection', 'intersection(a, b) returns the unique items of a that are also in b', 'intersection([1, 2, 3, 2], [2, 3, 4]) returns [2, 3]', 'intersection([1], []) returns []'],
  ['difference', 'difference(a, b) returns the items of a that are not in b', 'difference([1, 2, 3], [2]) returns [1, 3]', 'difference([], [1]) returns []'],
  ['union', 'union(a, b) returns the unique items of both lists, a first', 'union([1, 2], [2, 3]) returns [1, 2, 3]', 'union([], []) returns []'],
  ['rotate', 'rotate(list, n) moves the first n items to the end (n may be larger than the length)', 'rotate([1, 2, 3, 4], 1) returns [2, 3, 4, 1]', 'rotate([1, 2, 3], 4) returns [2, 3, 1]'],
  ['sortByKey', 'sortByKey(list, key) returns a new list of objects sorted ascending by the value at key', 'sortByKey([{ a: 2 }, { a: 1 }], "a") returns [{ a: 1 }, { a: 2 }]', 'sortByKey([], "a") returns []'],
  ['groupByLength', 'groupByLength(words) returns an object that relates each length to the list of words of that length', 'groupByLength(["a", "bb", "c"]) returns { 1: ["a", "c"], 2: ["bb"] }', 'groupByLength([]) returns {}'],
  ['minMax', 'minMax(list) returns [smallest, largest] of a non-empty list', 'minMax([3, 1, 2]) returns [1, 3]', 'minMax([5]) returns [5, 5]'],
  ['sumBy', 'sumBy(list, fn) adds the numbers fn gives for each item', 'sumBy([{ n: 1 }, { n: 4 }], o => o.n) returns 5', 'sumBy([], x => x) returns 0'],
  // objects (S4)
  ['pick', 'pick(obj, keys) returns an object with only the listed keys that exist', 'pick({ a: 1, b: 2 }, ["a", "z"]) returns { a: 1 }', 'pick({}, ["a"]) returns {}'],
  ['omit', 'omit(obj, keys) returns an object without the listed keys', 'omit({ a: 1, b: 2 }, ["a"]) returns { b: 2 }', 'omit({ a: 1 }, []) returns { a: 1 }'],
  ['mapValues', 'mapValues(obj, fn) returns an object with fn applied to each value', 'mapValues({ a: 1, b: 2 }, n => n * 2) returns { a: 2, b: 4 }', 'mapValues({}, x => x) returns {}'],
  ['invert', 'invert(obj) swaps keys and values (values become text keys)', 'invert({ a: "x", b: "y" }) returns { x: "a", y: "b" }', 'invert({}) returns {}'],
  ['deepGet', 'deepGet(obj, path) reads a value at a dotted path, or undefined when a step is missing', 'deepGet({ a: { b: 2 } }, "a.b") returns 2', 'deepGet({ a: 1 }, "x.y") returns undefined'],
  ['deepSet', 'deepSet(obj, path, value) returns a copy with value set at a dotted path, creating objects on the way (the input is not changed)', 'deepSet({}, "a.b", 1) returns { a: { b: 1 } }', 'deepSet({ a: 1 }, "b", 2) returns { a: 1, b: 2 }'],
  ['sortedKeys', 'sortedKeys(obj) returns the keys in alphabetical order', 'sortedKeys({ b: 1, a: 2 }) returns ["a", "b"]', 'sortedKeys({}) returns []'],
  ['sumValues', 'sumValues(obj) adds the numeric values of an object', 'sumValues({ a: 1, b: 2 }) returns 3', 'sumValues({}) returns 0'],
  ['isEmptyObject', 'isEmptyObject(obj) tells whether an object has no own keys', 'isEmptyObject({}) returns true', 'isEmptyObject({ a: 1 }) returns false'],
  ['withDefaults', 'withDefaults(obj, defaults) returns an object with defaults filled in for keys obj does not have', 'withDefaults({ a: 1 }, { a: 9, b: 2 }) returns { a: 1, b: 2 }', 'withDefaults({}, {}) returns {}'],
  ['countKeys', 'countKeys(obj) returns the number of own keys', 'countKeys({ a: 1, b: 2 }) returns 2', 'countKeys({}) returns 0'],
  ['toPairs', 'toPairs(obj) returns a list of [key, value] pairs', 'toPairs({ a: 1 }) returns [["a", 1]]', 'toPairs({}) returns []'],
  ['fromPairs', 'fromPairs(pairs) builds an object from [key, value] pairs', 'fromPairs([["a", 1], ["b", 2]]) returns { a: 1, b: 2 }', 'fromPairs([]) returns {}'],
  ['renameKey', 'renameKey(obj, from, to) returns a copy with one key renamed (unchanged when from is missing)', 'renameKey({ a: 1 }, "a", "b") returns { b: 1 }', 'renameKey({ a: 1 }, "x", "y") returns { a: 1 }'],
  ['filterKeys', 'filterKeys(obj, fn) returns an object with only the keys for which fn(key) is true', 'filterKeys({ ab: 1, c: 2 }, k => k.length > 1) returns { ab: 1 }', 'filterKeys({}, k => true) returns {}'],
  ['shallowEqual', 'shallowEqual(a, b) tells whether two objects have the same keys with identical values', 'shallowEqual({ a: 1 }, { a: 1 }) returns true', 'shallowEqual({ a: 1 }, { a: 2 }) returns false'],
  ['flattenKeys', 'flattenKeys(obj) flattens nested plain objects into dotted keys', 'flattenKeys({ a: { b: 1 }, c: 2 }) returns { "a.b": 1, c: 2 }', 'flattenKeys({}) returns {}'],
  ['unflattenKeys', 'unflattenKeys(obj) rebuilds nested objects from dotted keys', 'unflattenKeys({ "a.b": 1, c: 2 }) returns { a: { b: 1 }, c: 2 }', 'unflattenKeys({}) returns {}'],
  ['hasAllKeys', 'hasAllKeys(obj, keys) tells whether an object has every listed key', 'hasAllKeys({ a: 1, b: 2 }, ["a", "b"]) returns true', 'hasAllKeys({ a: 1 }, ["a", "b"]) returns false'],
  ['mergeShallow', 'mergeShallow(a, b) returns a new object with the keys of a then b (b wins)', 'mergeShallow({ a: 1 }, { a: 2, b: 3 }) returns { a: 2, b: 3 }', 'mergeShallow({}, {}) returns {}'],
  // dates and formats (S5)
  ['isLeapYear', 'isLeapYear(year) tells whether a year is a leap year', 'isLeapYear(2024) returns true', 'isLeapYear(1900) returns false'],
  ['daysInMonth', 'daysInMonth(year, month) returns the days in a month (month 1..12)', 'daysInMonth(2024, 2) returns 29', 'daysInMonth(2023, 4) returns 30'],
  ['addDays', 'addDays(isoDate, n) returns the ISO date (YYYY-MM-DD) n days later (UTC)', 'addDays("2024-02-28", 2) returns "2024-03-01"', 'addDays("2024-01-01", -1) returns "2023-12-31"'],
  ['diffDays', 'diffDays(a, b) returns the whole days from ISO date a to ISO date b (UTC)', 'diffDays("2024-01-01", "2024-01-31") returns 30', 'diffDays("2024-02-01", "2024-01-01") returns -31'],
  ['weekdayName', 'weekdayName(isoDate) returns the English weekday name of an ISO date (UTC)', 'weekdayName("2024-01-01") returns "Monday"', 'weekdayName("2024-01-07") returns "Sunday"'],
  ['isWeekend', 'isWeekend(isoDate) tells whether an ISO date (UTC) is a Saturday or Sunday', 'isWeekend("2024-01-06") returns true', 'isWeekend("2024-01-08") returns false'],
  ['formatBytes', 'formatBytes(n) writes a byte count with a unit (B, KB, MB, GB; 1024 steps; one decimal place, none for bytes)', 'formatBytes(1536) returns "1.5 KB"', 'formatBytes(12) returns "12 B"'],
  ['formatDuration', 'formatDuration(seconds) writes seconds as "1h 2m 3s", leaving out parts that are zero (0 is "0s")', 'formatDuration(3723) returns "1h 2m 3s"', 'formatDuration(60) returns "1m"'],
  ['parseDuration', 'parseDuration(text) reads "1h 2m 3s" style text into seconds', 'parseDuration("1h 2m 3s") returns 3723', 'parseDuration("45s") returns 45'],
  ['formatCurrency', 'formatCurrency(cents) writes a number of cents as dollars with two decimals and a leading $', 'formatCurrency(1999) returns "$19.99"', 'formatCurrency(5) returns "$0.05"'],
  ['ordinal', 'ordinal(n) writes a positive integer with its English ordinal suffix', 'ordinal(1) returns "1st" and ordinal(22) returns "22nd"', 'ordinal(11) returns "11th" and ordinal(103) returns "103rd"'],
  ['pluralize', 'pluralize(n, word) returns "1 word" for one and "n words" otherwise (add s)', 'pluralize(1, "cat") returns "1 cat"', 'pluralize(3, "cat") returns "3 cats"'],
  ['padTime', 'padTime(hours, minutes) writes a time as "HH:MM" with leading zeros', 'padTime(7, 5) returns "07:05"', 'padTime(23, 59) returns "23:59"'],
  ['startOfMonth', 'startOfMonth(isoDate) returns the first day of its month as an ISO date', 'startOfMonth("2024-03-17") returns "2024-03-01"', 'startOfMonth("2024-12-01") returns "2024-12-01"'],
  ['endOfMonth', 'endOfMonth(isoDate) returns the last day of its month as an ISO date', 'endOfMonth("2024-02-10") returns "2024-02-29"', 'endOfMonth("2023-04-01") returns "2023-04-30"'],
  ['quarterOf', 'quarterOf(isoDate) returns the quarter 1..4 of an ISO date', 'quarterOf("2024-05-01") returns 2', 'quarterOf("2024-12-31") returns 4'],
  ['ageOn', 'ageOn(birthIso, onIso) returns the age in whole years on a date', 'ageOn("2000-06-15", "2024-06-14") returns 23', 'ageOn("2000-06-15", "2024-06-15") returns 24'],
  ['relativeTime', 'relativeTime(seconds) writes a past duration as "just now" (under 60), "N minutes ago", "N hours ago" or "N days ago", using the largest whole unit and no plural for one ("1 minute ago")', 'relativeTime(30) returns "just now"', 'relativeTime(7200) returns "2 hours ago"'],
  ['clampDate', 'clampDate(isoDate, minIso, maxIso) returns the ISO date limited to the range', 'clampDate("2024-05-01", "2024-01-01", "2024-03-01") returns "2024-03-01"', 'clampDate("2023-01-01", "2024-01-01", "2024-03-01") returns "2024-01-01"'],
  ['dayOfYear', 'dayOfYear(isoDate) returns the day number in its year (January 1 is 1)', 'dayOfYear("2024-03-01") returns 61', 'dayOfYear("2023-12-31") returns 365'],
];
if (FUNCTIONS.length !== 100) throw new Error(`the practice scope needs 100 functions, has ${FUNCTIONS.length}`);

const STAGES = ['Numbers', 'Text', 'Lists', 'Objects', 'Dates and formats'];

export function practiceScope() {
  const lines = ['# Scope: Practice utilities', 'Version: 1', '', '## Overview', 'A synthetic library of 100 small pure functions, written to practise the swarm. Each is a plain ES module under src with its own test file under tests. There is no real product here.', '', '## Stages'];
  STAGES.forEach((title, i) => lines.push(`- S${i + 1}: ${title}`));
  lines.push('');
  FUNCTIONS.forEach(([name, what, a, b], i) => {
    if (i % 20 === 0) lines.push(`## S${i / 20 + 1} ${STAGES[i / 20]}`);
    lines.push(`### R-${String(i + 1).padStart(3, '0')} The function ${name} is exported from its own module: ${what}.`, 'Acceptance:', `- ${a}`, `- ${b}`, `- The module src/${name}.mjs exports ${name} and has a test file tests/${name}.test.mjs that checks both examples with node:test.`, '');
  });
  lines.push('## Context', '- package.json', '', '## Sensitive', '- none', '', '## Protected', '- .env', '');
  return lines.join('\n');
}

export async function writePracticeProject(dir) {
  await fs.mkdir(path.join(dir, 'docs', 'scope'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
  await fs.writeFile(path.join(dir, 'docs', 'scope', 'scope.md'), practiceScope());
  await fs.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'swarm-practice', version: '0.0.0', private: true, type: 'module', scripts: { test: 'node --test tests/' } }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'README.md'), '# swarm-practice\n\nA synthetic project for practising the swarm: 100 tiny pure functions. Nothing here is real. Local only.\n');
  await fs.writeFile(path.join(dir, '.gitignore'), '.swarm/\nnode_modules/\n.project-swarm.json\n');
  await fs.writeFile(path.join(dir, 'src', '.gitkeep'), '');
  await fs.writeFile(path.join(dir, 'tests', '.gitkeep'), '');
  return FUNCTIONS.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node tests/fixtures/make-practice-project.mjs DIR'); process.exit(2); }
  const n = await writePracticeProject(path.resolve(dir));
  console.log(`wrote ${n} requirements to ${path.resolve(dir)}`);
}
