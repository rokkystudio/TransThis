const MESSAGE_TRANSLATE = "TRANS_THIS_TRANSLATE";
const GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";
const DEFAULT_TARGET_LANGUAGE = "ru";

const SUPPORTED_TARGET_LANGUAGES = new Set([
  "ar",
  "de",
  "en",
  "es",
  "fr",
  "it",
  "ja",
  "ko",
  "pl",
  "pt",
  "ru",
  "tr",
  "uk",
  "zh-CN"
]);

/**
 * Routes translation requests from the content script to the background context.
 * The background context owns the cross-origin request because it has host permissions
 * for translate.googleapis.com in manifest.json.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_TRANSLATE) {
    return false;
  }

  translateSelection(message.text, message.targetLanguage)
    .then((result) => {
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Не удалось получить перевод."
      });
    });

  return true;
});

/**
 * Requests an automatic-source translation from Google Translate's public web endpoint.
 * The response includes a plain translation and dictionary groups when the endpoint
 * returns entries for the selected word.
 *
 * @param {string} text Selected text from the page.
 * @param {string} targetLanguage Target language code.
 * @returns {Promise<{translation: string, sourceLanguage: string, dictionary: Array<{partOfSpeech: string, terms: string[], entries: Array<{word: string, reverseTranslations: string[]}>}>}>}
 */
async function translateSelection(text, targetLanguage) {
  const normalizedText = normalizeSelectedText(text);

  if (!normalizedText) {
    throw new Error("Выделите слово или предложение для перевода.");
  }

  const safeTargetLanguage = normalizeTargetLanguage(targetLanguage);
  const url = buildTranslateUrl(normalizedText, safeTargetLanguage);
  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Google Translate вернул HTTP ${response.status}.`);
  }

  const payload = await response.json();

  return parseTranslatePayload(payload);
}

/**
 * Normalizes selected page text so the request contains visible content only.
 *
 * @param {string} text Selected text from the page.
 * @returns {string} Text with collapsed whitespace.
 */
function normalizeSelectedText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns a supported target language code or the default target language.
 *
 * @param {string} language Target language code from the content script.
 * @returns {string} Supported target language code.
 */
function normalizeTargetLanguage(language) {
  const normalizedLanguage = String(language || "").trim();

  if (SUPPORTED_TARGET_LANGUAGES.has(normalizedLanguage)) {
    return normalizedLanguage;
  }

  return DEFAULT_TARGET_LANGUAGE;
}

/**
 * Builds the translate.googleapis.com request URL with source language detection.
 *
 * @param {string} text Selected text from the page.
 * @param {string} targetLanguage Target language code.
 * @returns {URL} Request URL for the Google Translate web endpoint.
 */
function buildTranslateUrl(text, targetLanguage) {
  const url = new URL(GOOGLE_TRANSLATE_URL);

  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", targetLanguage);
  url.searchParams.set("hl", targetLanguage);
  url.searchParams.append("dt", "t");
  url.searchParams.append("dt", "bd");
  url.searchParams.set("dj", "1");
  url.searchParams.set("source", "input");
  url.searchParams.set("q", text);

  return url;
}

/**
 * Converts the Google Translate endpoint response into the extension's UI model.
 *
 * @param {unknown} payload Parsed JSON response from translate.googleapis.com.
 * @returns {{translation: string, sourceLanguage: string, dictionary: Array<{partOfSpeech: string, terms: string[], entries: Array<{word: string, reverseTranslations: string[]}>}>}} Translation model.
 */
function parseTranslatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Google Translate вернул неожиданный ответ.");
  }

  const response = /** @type {{sentences?: Array<{trans?: string}>, src?: string, dict?: Array<{pos?: string, terms?: string[], entry?: Array<{word?: string, reverse_translation?: string[]}>}>}} */ (payload);
  const translation = Array.isArray(response.sentences)
    ? response.sentences.map((sentence) => sentence.trans || "").join("").trim()
    : "";

  if (!translation) {
    throw new Error("Google Translate не вернул перевод.");
  }

  return {
    translation,
    sourceLanguage: response.src || "auto",
    dictionary: parseDictionary(response.dict)
  };
}

/**
 * Converts dictionary groups returned by Google Translate into display-ready entries.
 *
 * @param {unknown} dictionary Dictionary section from the Google Translate response.
 * @returns {Array<{partOfSpeech: string, terms: string[], entries: Array<{word: string, reverseTranslations: string[]}>}>} Dictionary groups.
 */
function parseDictionary(dictionary) {
  if (!Array.isArray(dictionary)) {
    return [];
  }

  return dictionary.map((group) => {
    const sourceGroup = /** @type {{pos?: string, terms?: string[], entry?: Array<{word?: string, reverse_translation?: string[]}>}} */ (group);

    return {
      partOfSpeech: sourceGroup.pos || "",
      terms: Array.isArray(sourceGroup.terms)
        ? sourceGroup.terms.filter((term) => typeof term === "string" && term.trim())
        : [],
      entries: Array.isArray(sourceGroup.entry)
        ? sourceGroup.entry
          .filter((entry) => entry && typeof entry.word === "string" && entry.word.trim())
          .map((entry) => ({
            word: entry.word || "",
            reverseTranslations: Array.isArray(entry.reverse_translation)
              ? entry.reverse_translation.filter((translation) => typeof translation === "string" && translation.trim())
              : []
          }))
        : []
    };
  }).filter((group) => group.terms.length || group.entries.length);
}
