/**
 * Fork (PWA): on-device speech synthesis via the Web Speech API
 * (`window.speechSynthesis`), backed by Android's system TTS engine
 * (Google Speech Services — Finnish voice data comes from
 * Settings → Language → TTS output, no Hermes config involved).
 *
 * Why this exists: server voices are single-language (a fi-FI Edge voice
 * reads English with a Finnish accent and vice versa). The device engine
 * speaks one utterance per sentence, each tagged with its own detected
 * language, so mixed Finnish/English replies read correctly. Free, offline,
 * zero gateway cost. Quality is below Edge Noora — the server ladder in
 * voice-playback.ts stays as the fallback.
 *
 * Detection is a sentence-level majority vote over stopwords (never a
 * single ä/ö trigger): capitalized non-stopwords are proper nouns and
 * excluded, diacritics are a tiebreak only, and no-signal sentences
 * (code, URLs, "OK") inherit the previous sentence's language.
 */

import { cutSentences } from './speech-text'

export type DeviceTtsLang = 'en' | 'fi'

export type DeviceTtsOutcome = 'done' | 'stopped' | 'unavailable'

export interface DeviceTtsHooks {
  isCurrent: () => boolean
  onSpeaking: () => void
  registerStop: (stop: (() => void) | null) => void
}

// Deliberately function words only. Ambiguous tokens ('on', 'he', 'me',
// 'no') are in NEITHER set — a wrong vote is worse than no vote when the
// other language's stopwords decide the sentence anyway.
const FI_STOPWORDS = new Set(
  'ja ei että tämä nämä nuo ne se hän te minä sinä mikä mitä missä miten miksi milloin kuka ketkä kaikki joka jotka kun kuin koska jotta jos mutta sekä tai vai niin myös vain vielä jo nyt sitten aina usein hyvin paljon vähän kanssa ilman jälkeen ennen yli en et emme ette eivät ovat oli olivat olisi ollut ole'.split(
    ' '
  )
)

const EN_STOPWORDS = new Set(
  'the a an i you your he she we they them his her our their is are was were be been and or but to of in for with that this these those it its as at by from not so if then than when what which who how why can will would could should have has had do does did there here all more most some any only very just about into over after before up out such like'.split(
    ' '
  )
)

const WORD_RE = /[A-Za-zÅÄÖåäö]+/g
const DIACRITIC_RE = /[äö]/i
const CAPITALIZED_RE = /^[A-ZÅÄÖ]/

export function detectSentenceLang(sentence: string, fallback: DeviceTtsLang): DeviceTtsLang {
  const tokens = sentence.match(WORD_RE) ?? []

  let fi = 0
  let en = 0
  let diacritics = 0

  for (const token of tokens) {
    const word = token.toLowerCase()

    // Stopwords match case-insensitively ("Tämä" still counts as Finnish).
    if (FI_STOPWORDS.has(word)) {
      fi += 1
      continue
    }

    if (EN_STOPWORDS.has(word)) {
      en += 1
      continue
    }

    // Capitalized non-stopwords are proper nouns ("Jyväskylä" in an
    // English sentence) — excluded from ALL evidence, including the
    // diacritic tiebreak.
    if (CAPITALIZED_RE.test(token)) {
      continue
    }

    if (DIACRITIC_RE.test(word)) {
      diacritics += 1
    }
  }

  if (fi !== en) {
    return fi > en ? 'fi' : 'en'
  }

  if (diacritics > 0) {
    return 'fi'
  }

  return fallback
}

export function defaultDeviceTtsLang(): DeviceTtsLang {
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fi')) {
    return 'fi'
  }

  return 'en'
}

export function isDeviceTtsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

const VOICES_TIMEOUT_MS = 1_500

function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const immediate = synth.getVoices()

  if (immediate.length > 0) {
    return Promise.resolve(immediate)
  }

  // Chrome loads voices lazily — the first getVoices() is empty and the
  // real list arrives via voiceschanged. Bound the wait; speaking with
  // lang set but no explicit voice still works (system default per lang).
  return new Promise(resolve => {
    const timer = window.setTimeout(() => {
      synth.removeEventListener('voiceschanged', onVoices)
      resolve(synth.getVoices())
    }, VOICES_TIMEOUT_MS)

    const onVoices = () => {
      window.clearTimeout(timer)
      synth.removeEventListener('voiceschanged', onVoices)
      resolve(synth.getVoices())
    }

    synth.addEventListener('voiceschanged', onVoices)
  })
}

function speakUtterance(
  synth: SpeechSynthesis,
  text: string,
  lang: DeviceTtsLang,
  voice: SpeechSynthesisVoice | null,
  hooks: DeviceTtsHooks
): Promise<'ended' | 'stopped'> {
  return new Promise(resolve => {
    let settled = false

    const finish = (value: 'ended' | 'stopped') => {
      if (settled) {
        return
      }

      settled = true
      hooks.registerStop(null)
      resolve(value)
    }

    hooks.registerStop(() => {
      try {
        synth.cancel()
      } finally {
        finish('stopped')
      }
    })

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = lang === 'fi' ? 'fi-FI' : 'en-US'

    if (voice) {
      utterance.voice = voice
    }

    utterance.onstart = () => hooks.onSpeaking()
    utterance.onend = () => finish('ended')
    utterance.onerror = () => finish('ended')

    synth.speak(utterance)
  })
}

/**
 * Speak already-sanitized text sentence by sentence, auto-detecting fi/en
 * per sentence. Resolves 'unavailable' when the Web Speech API is missing
 * so the caller falls through to the server ladder.
 */
export async function speakWithDeviceTts(
  text: string,
  hooks: DeviceTtsHooks
): Promise<DeviceTtsOutcome> {
  if (!isDeviceTtsSupported()) {
    return 'unavailable'
  }

  const synth = window.speechSynthesis
  const cut = cutSentences(text, true)
  const sentences = cut.sentences.length > 0 ? cut.sentences : [text]

  let voices: SpeechSynthesisVoice[] = []

  try {
    voices = await loadVoices(synth)
  } catch {
    voices = []
  }

  if (!hooks.isCurrent()) {
    return 'stopped'
  }

  const voiceFor = (lang: DeviceTtsLang): SpeechSynthesisVoice | null =>
    voices.find(candidate => candidate.lang.toLowerCase().startsWith(lang)) ?? null

  const fiVoice = voiceFor('fi')
  const enVoice = voiceFor('en')

  let lang = defaultDeviceTtsLang()

  for (const sentence of sentences) {
    if (!hooks.isCurrent()) {
      return 'stopped'
    }

    lang = detectSentenceLang(sentence, lang)

    const outcome = await speakUtterance(synth, sentence, lang, lang === 'fi' ? fiVoice : enVoice, hooks)

    if (outcome === 'stopped' || !hooks.isCurrent()) {
      return 'stopped'
    }
  }

  hooks.registerStop(null)

  return 'done'
}
