const MESSAGE_TRANSLATE = "TRANS_THIS_TRANSLATE";
const GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";
const DEFAULT_SOURCE_LANGUAGE = "auto";
const DEFAULT_TARGET_LANGUAGE = "ru";

const SUPPORTED_SOURCE_LANGUAGES = new Set([
  "auto",
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
 * Направляет запросы перевода из content script в background context.
 * Background context выполняет cross-origin запрос, потому что в manifest.json
 * ему выданы host permissions для translate.googleapis.com.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_TRANSLATE) {
    return false;
  }

  translateSelection(message.text, message.sourceLanguage, message.targetLanguage)
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
 * Запрашивает перевод у публичного web-endpoint Google Translate.
 * Ответ включает основной перевод и словарные группы, когда endpoint
 * возвращает словарные значения для выбранного слова.
 *
 * @param {string} text Выделенный текст со страницы.
 * @param {string} sourceLanguage Код языка исходного текста.
 * @param {string} targetLanguage Код языка перевода.
 * @returns {Promise<{translation: string, sourceLanguage: string, dictionary: Array<{partOfSpeech: string, terms: string[], entries: Array<{word: string, reverseTranslations: string[]}>}>}>}
 */
async function translateSelection(text, sourceLanguage, targetLanguage) {
  const normalizedText = normalizeSelectedText(text);

  if (!normalizedText) {
    throw new Error("Выделите слово или предложение для перевода.");
  }

  const safeSourceLanguage = normalizeSourceLanguage(sourceLanguage);
  const safeTargetLanguage = normalizeTargetLanguage(targetLanguage);
  const url = buildTranslateUrl(normalizedText, safeSourceLanguage, safeTargetLanguage);
  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Google Translate вернул HTTP ${response.status}.`);
  }

  const payload = await response.json();

  return parseTranslatePayload(payload, safeSourceLanguage);
}

/**
 * Нормализует выделенный текст так, чтобы запрос содержал только видимый контент.
 *
 * @param {string} text Выделенный текст со страницы.
 * @returns {string} Текст с нормализованными пробелами.
 */
function normalizeSelectedText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Возвращает поддерживаемый код языка исходного текста или код языка по умолчанию.
 *
 * @param {string} language Код языка исходного текста из content script.
 * @returns {string} Поддерживаемый код языка исходного текста.
 */
function normalizeSourceLanguage(language) {
  const normalizedLanguage = String(language || "").trim();

  if (SUPPORTED_SOURCE_LANGUAGES.has(normalizedLanguage)) {
    return normalizedLanguage;
  }

  return DEFAULT_SOURCE_LANGUAGE;
}

/**
 * Возвращает поддерживаемый код языка перевода или код языка по умолчанию.
 *
 * @param {string} language Код языка перевода из content script.
 * @returns {string} Поддерживаемый код языка перевода.
 */
function normalizeTargetLanguage(language) {
  const normalizedLanguage = String(language || "").trim();

  if (SUPPORTED_TARGET_LANGUAGES.has(normalizedLanguage)) {
    return normalizedLanguage;
  }

  return DEFAULT_TARGET_LANGUAGE;
}

/**
 * Собирает URL запроса к translate.googleapis.com с выбранным языком источника
 * и языком перевода.
 *
 * @param {string} text Выделенный текст со страницы.
 * @param {string} sourceLanguage Код языка исходного текста.
 * @param {string} targetLanguage Код языка перевода.
 * @returns {URL} URL запроса к web-endpoint Google Translate.
 */
function buildTranslateUrl(text, sourceLanguage, targetLanguage) {
  const url = new URL(GOOGLE_TRANSLATE_URL);

  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sourceLanguage);
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
 * Преобразует ответ translate.googleapis.com в UI-модель расширения.
 *
 * @param {unknown} payload Разобранный JSON-ответ от translate.googleapis.com.
 * @param {string} requestedSourceLanguage Код языка источника, переданный в запросе.
 * @returns {{translation: string, sourceLanguage: string, dictionary: Array<{partOfSpeech: string, terms: string[], entries: Array<{word: string, reverseTranslations: string[]}>}>}} UI-модель перевода.
 */
function parseTranslatePayload(payload, requestedSourceLanguage) {
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
    sourceLanguage: response.src || requestedSourceLanguage || DEFAULT_SOURCE_LANGUAGE,
    dictionary: parseDictionary(response.dict)
  };
}

/**
 * Преобразует словарные группы из ответа Google Translate в готовые для UI записи.
 *
 * @param {unknown} dictionary Секция словаря из ответа Google Translate.
 * @returns {Array<{partOfSpeech: string, terms: string[], entries: Array<{word: string, reverseTranslations: string[]}>}>} Словарные группы.
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
