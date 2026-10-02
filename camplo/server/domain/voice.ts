/**
 * Camplo's voice: plain words, no filler, no corporate gloss. Pure helpers shared by the chat agent, the
 * briefing writer and the memory layer.
 */

/** Hard-banned words → the plain word a person would use. Applied after every model answer as a backstop. */
type Rep = string | ((suffix: string) => string);
const BANNED: Array<[RegExp, Rep]> = [
  [/\bdelv(?:e|es|ed|ing) into\b/gi, 'look at'], [/\bdelv(?:e|es|ed|ing)\b/gi, 'dig'],
  [/\bunlock(s|ed|ing)?\b/gi, (x) => 'open' + ({ s: 's', ed: 'ed', ing: 'ing' }[x] ?? '') + ' up'],
  [/\bcomprehensive\b/gi, 'full'], [/\btapestry\b/gi, 'mix'], [/\b(?:a )?testament to\b/gi, 'proof of'],
  [/\bever-evolving\b/gi, 'changing'], [/\bseamless(ly)?\b/gi, (x) => 'smooth' + x], [/\brevolutionary\b/gi, 'new'],
  [/\bempower(s|ed|ing)?\b/gi, (x) => 'help' + x], [/\bjourney\b/gi, 'process'], [/\btransformation\b/gi, 'change'],
  [/\bgame[- ]changer\b/gi, 'big win'], [/\bcutting[- ]edge\b/gi, 'latest'], [/\binnovative\b/gi, 'new'],
  [/\bholistic\b/gi, 'whole'], [/\brobust\b/gi, 'solid'], [/\bsynerg(?:y|ies)\b/gi, 'fit'], [/\bauthentic\b/gi, 'real'],
  [/\bleverag(e|es|ed|ing)\b/gi, (x) => ({ e: 'use', es: 'uses', ed: 'used', ing: 'using' }[x.toLowerCase()] ?? 'use')],
  [/\becosystem\b/gi, 'setup'],
];
/** Filler openers removed outright (with the comma/that that follows). */
const FILLER = /\b(?:it is|it's) (?:worth noting|important to (?:understand|note)) that\s*|\b(?:in conclusion|furthermore|moreover),\s*/gi;

function matchCase(src: string, out: string): string {
  if (src.length > 1 && src === src.toUpperCase()) return out.toUpperCase();
  return src[0] === src[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out;
}

/** Rewrite banned words and strip filler phrases, keeping markdown and links intact. */
export function scrub(text: string): string {
  let out = text.replace(new RegExp(FILLER.source + '([a-z])?', 'gi'), (_m: string, c: string | undefined, off: number, all: string) => {
    if (!c) return '';
    const before = all.slice(0, off).trimEnd();
    return !before || /[.!?:\n*]$/.test(before) ? c.toUpperCase() : c;
  });
  for (const [re, rep] of BANNED) {
    out = out.replace(re, (m: string, g1?: unknown) => matchCase(m, typeof rep === 'string' ? rep : rep(typeof g1 === 'string' ? g1 : '')));
  }
  return out;
}

export function bannedHits(text: string): string[] {
  const hits: string[] = [];
  for (const [re] of BANNED) { re.lastIndex = 0; const m = text.match(re); if (m) hits.push(m[0].toLowerCase()); }
  return hits;
}

export type ConversationType = 'greeting' | 'thanks' | 'venting' | 'about_assistant' | 'off_topic' | 'work';

/** Rough classification so small talk can use the quick tier with a reduced context. */
export function classify(message: string): ConversationType {
  const m = message.trim().toLowerCase();
  const short = m.length <= 60;
  if (short && /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening)|morning|howdy|hiya|what'?s up)\b[\s!.,?a-z]*$/.test(m) && !/\b(lead|campaign|sla|cpl|page)\b/.test(m)) return 'greeting';
  if (short && /^(thanks|thank you|thx|ty|cheers|great,? thanks|perfect|awesome|nice one|appreciate it)\b/.test(m)) return 'thanks';
  if (/\b(who|what) are you\b|\bare you (an? )?(ai|bot|human|real)\b|\bwhat can you do\b|\bdo you remember\b|\bhow do you work\b/.test(m)) return 'about_assistant';
  if (/\b(i'?m|i am|so) (tired|frustrated|stressed|annoyed|exhausted|done|fed up)\b|\b(this is|it'?s) (so )?(annoying|frustrating|ridiculous)\b|\bugh+\b/.test(m)) return 'venting';
  if (/\b(weather|recipe|movie|football|song|joke|poem|bitcoin price)\b/.test(m) && !/\b(lead|campaign|sla|cpl|ad|page|client)\b/.test(m)) return 'off_topic';
  return 'work';
}

/**
 * Memory defence: a memory candidate must be an operational fact or a working preference, never an instruction
 * aimed at the assistant, a credential, or personal venting.
 */
export function safeMemory(fact: string): boolean {
  const f = fact.trim();
  if (f.length < 8 || f.length > 300) return false;
  if (/\b(ignore|disregard|override|forget)\b.*\b(instruction|prompt|rule|previous|above)s?\b|\bsystem prompt\b|\byou (must|should) (always|never) (say|reply|answer|obey)\b|\bjailbreak\b|\bpretend\b/i.test(f)) return false;
  if (/\b(sk-|gsk_|xox[bp]-|AKIA)[A-Za-z0-9]|\bpassword\b|\bapi key\b|\btoken\b/i.test(f)) return false;
  if (/\b(i hate|i'?m (sad|depressed|tired|exhausted)|my (wife|husband|girlfriend|boyfriend|kids?))\b/i.test(f)) return false;
  return true;
}

/** Heuristic: an explicit "remember / from now on / I prefer" statement from the user. */
export function explicitPreference(message: string): string | null {
  const m = message.trim().replace(/\s+/g, ' ');
  const hit = m.match(/^(?:please )?(?:remember(?: that)?|note(?: that)?|from now on,?|going forward,?|for future reference,?)\s+(.{8,240})$/i) ?? m.match(/^(i prefer .{6,240}|we (?:always|never|usually) .{6,240}|our .{3,40} (?:is|are) .{3,200})$/i);
  if (!hit) return null;
  const fact = hit[1].replace(/[.!]+$/, '');
  return safeMemory(fact) ? fact : null;
}
