(() => {
  const MESSAGE_TRANSLATE = "TRANS_THIS_TRANSLATE";
  const STORAGE_SOURCE_LANGUAGE = "transThisSourceLanguage";
  const STORAGE_TARGET_LANGUAGE = "transThisTargetLanguage";
  const DEFAULT_SOURCE_LANGUAGE = "auto";
  const DEFAULT_TARGET_LANGUAGE = "ru";
  const BUTTON_ID = "transthis-translate-button";
  const PANEL_ID = "transthis-panel";
  const GOOGLE_TRANSLATE_STYLE_ID = "transthis-google-translate-style";
  const CONTROLLER_KEY = "__transThisContentController";
  const EDGE_OFFSET = 8;
  const BUTTON_OFFSET_Y = 8;
  const PANEL_OFFSET_Y = 8;
  const SELECTION_SHOW_DELAY = 80;
  const POINTER_SELECTION_RETRY_DELAY = 120;
  const POINTER_SELECTION_FALLBACK_DELAY = 650;
  const EXTENSION_CONTEXT_MESSAGE = "Расширение было перезагружено. Обновите страницу и выделите текст снова.";
  const GOOGLE_HOST_PATTERN = /(^|\.)google\./i;
  const GOOGLE_NATIVE_TRANSLATE_SELECTORS = [
    ".EyBRub",
    "[jscontroller=\"KSk4yc\"]",
    "[data-async-type=\"ctxm\"]",
    "[data-bkt=\"translate\"]",
    "a[href*=\"translate.google.com/translate\"]",
    "a[href*=\"client=search\"][href*=\"translate\"]"
  ];
  const LANGUAGE_LABELS = new Map([
    ["auto", "Автоматически"],
    ["ar", "العربية"],
    ["de", "Deutsch"],
    ["en", "English"],
    ["es", "Español"],
    ["fr", "Français"],
    ["it", "Italiano"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["pl", "Polski"],
    ["pt", "Português"],
    ["ru", "Русский"],
    ["tr", "Türkçe"],
    ["uk", "Українська"],
    ["zh-CN", "中文"]
  ]);

  let selectedText = "";
  let selectedRect = null;
  let selectionRange = null;
  let sourceLanguage = DEFAULT_SOURCE_LANGUAGE;
  let targetLanguage = DEFAULT_TARGET_LANGUAGE;
  let requestId = 0;
  let ignoreSelectionChangeUntil = 0;
  let selectionTimer = 0;
  let selectionStartedAt = 0;
  let isPointerSelecting = false;
  let isDestroyed = false;
  let extensionContextAvailable = true;
  let googleTranslateStyleElement = null;
  let googleTranslateObserver = null;
  let translateButton = null;
  let panel = null;
  let sourceLanguageSelect = null;
  let targetLanguageSelect = null;
  let panelContent = null;
  let statusElement = null;
  let panelPointerId = null;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let panelOriginX = 0;
  let panelOriginY = 0;
  let panelX = 0;
  let panelY = 0;
  let registeredListeners = [];

  destroyPreviousController();
  registerController();
  initializeTransThis();

  /**
   * Запускает экземпляр content script, подключает стили,
   * подписки на события страницы и подавление нативного перевода Google.
   */
  function initializeTransThis() {
    loadLanguageSettings();
    addListener(document, "pointerdown", handleDocumentSelectionStart, true);
    addListener(document, "mousedown", handleDocumentSelectionStart, true);
    addListener(document, "touchstart", handleDocumentSelectionStart, true);
    addListener(document, "pointerup", handleDocumentSelectionEnd, true);
    addListener(document, "mouseup", handleDocumentSelectionEnd, true);
    addListener(document, "touchend", handleDocumentSelectionEnd, true);
    addListener(document, "pointercancel", handleDocumentSelectionEnd, true);
    addListener(window, "pointerup", handleDocumentSelectionEnd, true);
    addListener(window, "mouseup", handleDocumentSelectionEnd, true);
    addListener(window, "touchend", handleDocumentSelectionEnd, true);
    addListener(document, "selectionchange", handleSelectionChange, true);
    addListener(document, "keydown", handleDocumentKeyDown, true);
    addListener(document, "keyup", handleDocumentKeyUp, true);
    addListener(window, "resize", handleViewportChange, { passive: true });
    addListener(document, "scroll", handleViewportChange, { capture: true, passive: true });
    addListener(document, "pointerdown", handleOutsidePointerDown, true);

    if (shouldSuppressGoogleNativeTranslate()) {
      installGoogleTranslateSuppression();
    }
  }

  /**
   * Останавливает предыдущий экземпляр content script перед повторной инъекцией.
   */
  function destroyPreviousController() {
    const controller = globalThis[CONTROLLER_KEY];

    if (controller && typeof controller.destroy === "function") {
      controller.destroy();
    }
  }

  /**
   * Регистрирует текущий экземпляр content script для последующей очистки.
   */
  function registerController() {
    globalThis[CONTROLLER_KEY] = {
      destroy: destroyTransThis
    };
  }

  /**
   * Добавляет обработчик события страницы и сохраняет его для очистки.
   *
   * @param {EventTarget} target Цель события.
   * @param {string} type Тип события.
   * @param {EventListener} handler Обработчик события.
   * @param {boolean|AddEventListenerOptions} [options] Параметры подписки.
   */
  function addListener(target, type, handler, options) {
    const wrappedHandler = wrapEventHandler(handler);

    target.addEventListener(type, wrappedHandler, options);
    registeredListeners.push({ target, type, handler: wrappedHandler, options });
  }

  /**
   * Оборачивает обработчик событий страницы и отключает устаревший экземпляр
   * при потере контекста расширения.
   *
   * @param {EventListener} handler Обработчик события.
   * @returns {EventListener} Защищённый обработчик.
   */
  function wrapEventHandler(handler) {
    return (event) => {
      if (isDestroyed) {
        return;
      }

      try {
        handler(event);
      } catch (error) {
        if (!handleExtensionApiError(error)) {
          throw error;
        }
      }
    };
  }

  /**
   * Удаляет подписки, DOM-узлы и наблюдатели, принадлежащие текущему экземпляру.
   */
  function destroyTransThis() {
    if (isDestroyed) {
      return;
    }

    isDestroyed = true;
    ++requestId;
    window.clearTimeout(selectionTimer);

    for (const listener of registeredListeners) {
      listener.target.removeEventListener(listener.type, listener.handler, listener.options);
    }

    registeredListeners = [];

    if (googleTranslateObserver) {
      googleTranslateObserver.disconnect();
      googleTranslateObserver = null;
    }

    if (googleTranslateStyleElement) {
      googleTranslateStyleElement.remove();
      googleTranslateStyleElement = null;
    }

    if (translateButton) {
      translateButton.remove();
      translateButton = null;
    }

    if (panel) {
      panel.remove();
      panel = null;
      sourceLanguageSelect = null;
      targetLanguageSelect = null;
      panelContent = null;
      statusElement = null;
    }

    if (globalThis[CONTROLLER_KEY] && globalThis[CONTROLLER_KEY].destroy === destroyTransThis) {
      delete globalThis[CONTROLLER_KEY];
    }
  }

  /**
   * Загружает сохранённые языки исходного текста и перевода из storage
   * и применяет их к селекторам окна перевода.
   */
  function loadLanguageSettings() {
    if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.local) {
      return;
    }

    try {
      chrome.storage.local.get({
        [STORAGE_SOURCE_LANGUAGE]: DEFAULT_SOURCE_LANGUAGE,
        [STORAGE_TARGET_LANGUAGE]: DEFAULT_TARGET_LANGUAGE
      }, (items) => {
        if (isDestroyed) {
          return;
        }

        const errorMessage = getRuntimeLastErrorMessage();

        if (errorMessage) {
          handleRuntimeErrorMessage(errorMessage);
          return;
        }

        sourceLanguage = normalizeSourceLanguage(items[STORAGE_SOURCE_LANGUAGE]);
        targetLanguage = normalizeTargetLanguage(items[STORAGE_TARGET_LANGUAGE]);
        syncLanguageSelectors();
      });
    } catch (error) {
      handleExtensionApiError(error);
    }
  }

  /**
   * Сохраняет выбранные языки исходного текста и перевода в storage.
   */
  function saveLanguageSettings() {
    if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.local) {
      return;
    }

    try {
      chrome.storage.local.set({
        [STORAGE_SOURCE_LANGUAGE]: sourceLanguage,
        [STORAGE_TARGET_LANGUAGE]: targetLanguage
      }, () => {
        const errorMessage = getRuntimeLastErrorMessage();

        if (errorMessage) {
          handleRuntimeErrorMessage(errorMessage);
        }
      });
    } catch (error) {
      handleExtensionApiError(error);
    }
  }

  /**
   * Применяет текущие значения языков к селекторам окна перевода.
   */
  function syncLanguageSelectors() {
    if (sourceLanguageSelect) {
      sourceLanguageSelect.value = sourceLanguage;
    }

    if (targetLanguageSelect) {
      targetLanguageSelect.value = targetLanguage;
    }
  }

  /**
   * Скрывает UI при начале выделения на странице и не вмешивается в события,
   * пришедшие из элементов расширения.
   *
   * @param {MouseEvent|PointerEvent|TouchEvent} event Событие начала выделения.
   */
  function handleDocumentSelectionStart(event) {
    if (isTransThisElement(event.target)) {
      markUiInteraction();
      return;
    }

    selectionStartedAt = Date.now();
    isPointerSelecting = true;
    hideTransThisUi();
  }

  /**
   * Запускает чтение выделения после завершения выделения на странице.
   *
   * @param {MouseEvent|PointerEvent|TouchEvent} event Событие завершения выделения.
   */
  function handleDocumentSelectionEnd(event) {
    if (isTransThisElement(event.target)) {
      return;
    }

    isPointerSelecting = false;
    queueSelectionInspection();
  }

  /**
   * Обновляет состояние кнопки перевода после изменения выделения.
   */
  function handleSelectionChange() {
    if (Date.now() < ignoreSelectionChangeUntil) {
      return;
    }

    window.setTimeout(() => {
      if (isDestroyed || Date.now() < ignoreSelectionChangeUntil) {
        return;
      }

      const selectionState = readCurrentSelection();

      if (!selectionState) {
        hideTransThisUi();
        return;
      }

      queueSelectionInspection(isPointerSelecting ? POINTER_SELECTION_RETRY_DELAY : SELECTION_SHOW_DELAY);
    }, 0);
  }

  /**
   * Закрывает UI по клавише Escape.
   *
   * @param {KeyboardEvent} event Событие нажатия клавиши.
   */
  function handleDocumentKeyDown(event) {
    if (event.key === "Escape") {
      hideTransThisUi();
    }
  }

  /**
   * Проверяет выделение после клавиатурного изменения.
   *
   * @param {KeyboardEvent} event Событие отпускания клавиши.
   */
  function handleDocumentKeyUp(event) {
    if (event.key !== "Escape") {
      isPointerSelecting = false;
      queueSelectionInspection();
    }
  }

  /**
   * Закрывает UI при нажатии вне кнопки и окна перевода.
   *
   * @param {PointerEvent} event Событие pointerdown страницы.
   */
  function handleOutsidePointerDown(event) {
    if (isTransThisElement(event.target)) {
      markUiInteraction();
      return;
    }

    hideTransThisUi();
  }

  /**
   * Перепозиционирует кнопку и окно в пределах viewport.
   */
  function handleViewportChange() {
    if (translateButton && !translateButton.hidden && selectionRange) {
      const rect = getSelectionRect(selectionRange);

      if (rect) {
        selectedRect = rect;
        showTranslateButton(rect);
      }
    }

    if (panel && !panel.hidden) {
      setPanelPosition(panelX, panelY);
    }
  }

  /**
   * Планирует чтение выделения после обновления объекта Selection браузером.
   *
   * @param {number} [delay] Задержка перед чтением выделения.
   */
  function queueSelectionInspection(delay = SELECTION_SHOW_DELAY) {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(inspectSelection, delay);
  }

  /**
   * Показывает кнопку перевода для текущего видимого выделения.
   */
  function inspectSelection() {
    if (isDestroyed || Date.now() < ignoreSelectionChangeUntil) {
      return;
    }

    if (isPointerSelecting) {
      if (Date.now() - selectionStartedAt < POINTER_SELECTION_FALLBACK_DELAY) {
        queueSelectionInspection(POINTER_SELECTION_RETRY_DELAY);
        return;
      }

      isPointerSelecting = false;
    }

    const selectionState = readCurrentSelection();

    if (!selectionState) {
      hideTransThisUi();
      return;
    }

    selectedText = selectionState.text;
    selectedRect = selectionState.rect;
    selectionRange = selectionState.range;
    showTranslateButton(selectionState.rect);
  }

  /**
   * Показывает кнопку перевода под прямоугольником выделения.
   *
   * @param {DOMRect} rect Прямоугольник выделения в координатах viewport.
   */
  function showTranslateButton(rect) {
    hidePanel();

    if (!translateButton) {
      translateButton = buildTranslateButton();
      document.documentElement.appendChild(translateButton);
    }

    translateButton.hidden = false;

    const buttonRect = measureElement(translateButton);
    const left = rect.left + rect.width / 2 - buttonRect.width / 2;
    const top = rect.bottom + BUTTON_OFFSET_Y;
    const clampedLeft = clamp(left, EDGE_OFFSET, window.innerWidth - buttonRect.width - EDGE_OFFSET);
    const clampedTop = clamp(top, EDGE_OFFSET, window.innerHeight - buttonRect.height - EDGE_OFFSET);

    translateButton.style.left = `${clampedLeft}px`;
    translateButton.style.top = `${clampedTop}px`;
  }

  /**
   * Создаёт кнопку перевода с подписью.
   *
   * @returns {HTMLButtonElement} Кнопка перевода.
   */
  function buildTranslateButton() {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "Перевести";
    button.hidden = true;
    button.setAttribute("aria-label", "Перевести выделенный текст");
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      markUiInteraction();
    });
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      markUiInteraction();
    });
    button.addEventListener("click", handleTranslateButtonClick);

    return button;
  }

  /**
   * Открывает окно перевода и запускает запрос перевода.
   *
   * @param {MouseEvent} event Событие клика по кнопке перевода.
   */
  function handleTranslateButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    markUiInteraction();
    hideTranslateButton();

    if (!selectedText || !selectedRect) {
      return;
    }

    ensurePanel();
    renderLoading();
    openPanelNearSelection();
    requestTranslation();
  }

  /**
   * Создаёт окно перевода при первом открытии.
   */
  function ensurePanel() {
    if (panel) {
      return;
    }

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.addEventListener("pointerdown", handlePanelPointerDown);
    panel.addEventListener("mousedown", (event) => {
      markUiInteraction();
      event.stopPropagation();
    });

    const controls = document.createElement("div");
    controls.className = "transthis-panel__controls";

    sourceLanguageSelect = buildLanguageSelect(true);
    sourceLanguageSelect.className = "transthis-panel__source-language";
    sourceLanguageSelect.setAttribute("aria-label", "Язык исходного текста");
    sourceLanguageSelect.addEventListener("change", handleSourceLanguageChange);

    const directionElement = document.createElement("span");
    directionElement.className = "transthis-panel__direction";
    directionElement.textContent = "→";

    targetLanguageSelect = buildLanguageSelect(false);
    targetLanguageSelect.className = "transthis-panel__target-language";
    targetLanguageSelect.setAttribute("aria-label", "Язык перевода");
    targetLanguageSelect.addEventListener("change", handleTargetLanguageChange);

    prepareLanguageSelect(sourceLanguageSelect);
    prepareLanguageSelect(targetLanguageSelect);

    panelContent = document.createElement("div");
    panelContent.className = "transthis-panel__content";

    statusElement = document.createElement("div");
    statusElement.className = "transthis-panel__status";

    controls.append(sourceLanguageSelect, directionElement, targetLanguageSelect);
    panel.append(controls, panelContent, statusElement);
    document.documentElement.appendChild(panel);
    syncLanguageSelectors();
  }

  /**
   * Создаёт селектор языка.
   *
   * @param {boolean} includeAuto Добавляет пункт автоматического определения.
   * @returns {HTMLSelectElement} Селектор языка.
   */
  function buildLanguageSelect(includeAuto) {
    const select = document.createElement("select");

    for (const [languageCode, languageLabel] of LANGUAGE_LABELS) {
      if (!includeAuto && languageCode === "auto") {
        continue;
      }

      const option = document.createElement("option");
      option.value = languageCode;
      option.textContent = languageLabel;
      select.appendChild(option);
    }

    return select;
  }

  /**
   * Подготавливает селектор языка к работе внутри перетаскиваемого окна.
   *
   * @param {HTMLSelectElement} select Селектор языка.
   */
  function prepareLanguageSelect(select) {
    select.dataset.noDrag = "1";
    select.addEventListener("pointerdown", (event) => {
      markUiInteraction();
      event.stopPropagation();
    });
    select.addEventListener("mousedown", (event) => {
      markUiInteraction();
      event.stopPropagation();
    });
  }

  /**
   * Применяет выбранный язык исходного текста и повторяет запрос перевода.
   */
  function handleSourceLanguageChange() {
    if (!sourceLanguageSelect) {
      return;
    }

    sourceLanguage = normalizeSourceLanguage(sourceLanguageSelect.value);
    saveLanguageSettings();

    if (!panel || panel.hidden || !selectedText) {
      return;
    }

    renderLoading();
    requestTranslation();
  }

  /**
   * Применяет выбранный язык перевода и повторяет запрос для текущего выделения.
   */
  function handleTargetLanguageChange() {
    if (!targetLanguageSelect) {
      return;
    }

    targetLanguage = normalizeTargetLanguage(targetLanguageSelect.value);
    saveLanguageSettings();

    if (!panel || panel.hidden || !selectedText) {
      return;
    }

    renderLoading();
    requestTranslation();
  }

  /**
   * Открывает окно перевода под текущим выделением.
   */
  function openPanelNearSelection() {
    if (!panel || !selectedRect) {
      return;
    }

    panel.hidden = false;

    const panelRect = measureElement(panel);
    const left = selectedRect.left + selectedRect.width / 2 - panelRect.width / 2;
    const top = selectedRect.bottom + PANEL_OFFSET_Y;

    setPanelPosition(left, top);
  }

  /**
   * Отрисовывает состояние загрузки в области содержимого окна перевода.
   */
  function renderLoading() {
    if (!panelContent || !statusElement) {
      return;
    }

    syncLanguageSelectors();
    panelContent.className = "transthis-panel__content is-loading";
    panelContent.innerHTML = "";

    const loader = document.createElement("div");
    loader.className = "transthis-panel__loader";
    loader.textContent = "Переводим…";
    panelContent.appendChild(loader);
    statusElement.textContent = "";
  }

  /**
   * Отрисовывает результат перевода и словарные значения для одиночного слова.
   *
   * @param {{translation?: string, sourceLanguage?: string, dictionary?: Array<{partOfSpeech?: string, terms?: string[], entries?: Array<{word?: string, reverseTranslations?: string[]}>}>}} result Результат перевода из background script.
   * @param {boolean} showDictionary Признак отображения словарных значений.
   */
  function renderTranslationResult(result, showDictionary) {
    if (!panelContent || !statusElement) {
      return;
    }

    const translatedText = result && typeof result.translation === "string"
      ? result.translation.trim()
      : "";

    syncLanguageSelectors();
    panelContent.className = "transthis-panel__content";
    panelContent.innerHTML = "";

    if (!translatedText) {
      renderError("Google Translate не вернул перевод.");
      return;
    }

    const translationValue = document.createElement("div");
    translationValue.className = "transthis-panel__translation-value";
    translationValue.textContent = translatedText;
    panelContent.appendChild(translationValue);

    if (showDictionary) {
      const dictionaryElement = buildDictionaryElement(result && Array.isArray(result.dictionary) ? result.dictionary : []);

      if (dictionaryElement) {
        panelContent.appendChild(dictionaryElement);
      }
    }

    statusElement.textContent = "";
  }

  /**
   * Формирует DOM-узел со словарными значениями перевода одиночного слова.
   *
   * @param {Array<{partOfSpeech?: string, terms?: string[], entries?: Array<{word?: string, reverseTranslations?: string[]}>}>} dictionary Словарные группы из ответа Google Translate.
   * @returns {HTMLDivElement|null} Узел словарных значений или null.
   */
  function buildDictionaryElement(dictionary) {
    if (!Array.isArray(dictionary) || dictionary.length === 0) {
      return null;
    }

    const dictionaryElement = document.createElement("div");
    dictionaryElement.className = "transthis-panel__dictionary";

    for (const group of dictionary) {
      const dictionaryItems = collectDictionaryItems(group);

      if (dictionaryItems.length === 0) {
        continue;
      }

      const section = document.createElement("section");
      section.className = "transthis-panel__dictionary-group";

      if (group && typeof group.partOfSpeech === "string" && group.partOfSpeech.trim()) {
        const heading = document.createElement("div");
        heading.className = "transthis-panel__dictionary-heading";
        heading.textContent = group.partOfSpeech.trim();
        section.appendChild(heading);
      }

      const list = document.createElement("ul");
      list.className = "transthis-panel__dictionary-list";

      for (const itemText of dictionaryItems) {
        const item = document.createElement("li");
        item.textContent = itemText;
        list.appendChild(item);
      }

      section.appendChild(list);
      dictionaryElement.appendChild(section);
    }

    return dictionaryElement.childElementCount ? dictionaryElement : null;
  }

  /**
   * Возвращает уникальный список словарных значений из словарной группы.
   *
   * @param {{terms?: string[], entries?: Array<{word?: string}>}|undefined} group Словарная группа.
   * @returns {string[]} Уникальные словарные значения.
   */
  function collectDictionaryItems(group) {
    const items = [];

    if (group && Array.isArray(group.entries) && group.entries.length) {
      for (const entry of group.entries) {
        if (entry && typeof entry.word === "string" && entry.word.trim()) {
          items.push(entry.word.trim());
        }
      }
    }

    if (items.length === 0 && group && Array.isArray(group.terms)) {
      for (const term of group.terms) {
        if (typeof term === "string" && term.trim()) {
          items.push(term.trim());
        }
      }
    }

    return Array.from(new Set(items));
  }

  /**
   * Отправляет текст в background script и обновляет окно перевода ответом.
   */
  function requestTranslation() {
    const currentRequestId = ++requestId;
    const currentText = selectedText;
    const currentSourceLanguage = sourceLanguage;
    const currentTargetLanguage = targetLanguage;

    if (!isExtensionContextValid()) {
      renderError(EXTENSION_CONTEXT_MESSAGE);
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: MESSAGE_TRANSLATE,
        text: currentText,
        sourceLanguage: currentSourceLanguage,
        targetLanguage: currentTargetLanguage
      }, (response) => {
        if (currentRequestId !== requestId || !panel || panel.hidden) {
          return;
        }

        const errorMessage = getRuntimeLastErrorMessage();

        if (errorMessage) {
          handleRuntimeErrorMessage(errorMessage);
          return;
        }

        if (!response || !response.ok) {
          renderError(response && response.error ? response.error : "Не удалось выполнить перевод.");
          return;
        }

        renderTranslationResult(response.result || {}, isSingleWord(currentText));
      });
    } catch (error) {
      if (!handleExtensionApiError(error)) {
        renderError(error instanceof Error ? error.message : "Не удалось выполнить перевод.");
      }
    }
  }

  /**
   * Выводит сообщение об ошибке в области содержимого окна перевода.
   *
   * @param {string} message Сообщение об ошибке.
   */
  function renderError(message) {
    if (!panelContent || !statusElement) {
      return;
    }

    syncLanguageSelectors();
    panelContent.className = "transthis-panel__content";
    panelContent.innerHTML = "";

    const errorElement = document.createElement("div");
    errorElement.className = "transthis-panel__error";
    errorElement.textContent = message;
    panelContent.appendChild(errorElement);
    statusElement.textContent = "";
  }

  /**
   * Запускает перетаскивание окна перевода по нажатию в любой точке окна,
   * кроме интерактивных элементов управления.
   *
   * @param {PointerEvent} event Событие pointerdown окна перевода.
   */
  function handlePanelPointerDown(event) {
    if (!panel || event.button !== 0) {
      return;
    }

    if (isPanelInteractiveElement(event.target)) {
      markUiInteraction();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    markUiInteraction();

    panelPointerId = event.pointerId;
    dragOriginX = event.clientX;
    dragOriginY = event.clientY;
    panelOriginX = panelX;
    panelOriginY = panelY;

    panel.classList.add("is-dragging");

    if (typeof panel.setPointerCapture === "function") {
      panel.setPointerCapture(event.pointerId);
    }

    panel.addEventListener("pointermove", handlePanelPointerMove);
    panel.addEventListener("pointerup", handlePanelPointerUp);
    panel.addEventListener("pointercancel", handlePanelPointerUp);
  }

  /**
   * Возвращает признак интерактивного элемента внутри окна перевода.
   *
   * @param {EventTarget|null} target Цель события внутри окна.
   * @returns {boolean} Признак интерактивного элемента.
   */
  function isPanelInteractiveElement(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(target.closest("[data-no-drag], select, option, button, input, textarea, a"));
  }

  /**
   * Перемещает окно перевода вслед за указателем.
   *
   * @param {PointerEvent} event Событие pointermove окна перевода.
   */
  function handlePanelPointerMove(event) {
    if (!panel || panelPointerId !== event.pointerId) {
      return;
    }

    const nextX = panelOriginX + (event.clientX - dragOriginX);
    const nextY = panelOriginY + (event.clientY - dragOriginY);

    setPanelPosition(nextX, nextY);
  }

  /**
   * Завершает перетаскивание окна перевода и возвращает обычную прозрачность.
   *
   * @param {PointerEvent} event Событие pointerup или pointercancel окна перевода.
   */
  function handlePanelPointerUp(event) {
    if (!panel || panelPointerId !== event.pointerId) {
      return;
    }

    panelPointerId = null;
    panel.classList.remove("is-dragging");

    if (typeof panel.releasePointerCapture === "function") {
      panel.releasePointerCapture(event.pointerId);
    }

    panel.removeEventListener("pointermove", handlePanelPointerMove);
    panel.removeEventListener("pointerup", handlePanelPointerUp);
    panel.removeEventListener("pointercancel", handlePanelPointerUp);
  }

  /**
   * Устанавливает позицию окна перевода в границах viewport.
   *
   * @param {number} left Координата X окна.
   * @param {number} top Координата Y окна.
   */
  function setPanelPosition(left, top) {
    if (!panel) {
      return;
    }

    const panelRect = measureElement(panel);
    const clampedLeft = clamp(left, EDGE_OFFSET, window.innerWidth - panelRect.width - EDGE_OFFSET);
    const clampedTop = clamp(top, EDGE_OFFSET, window.innerHeight - panelRect.height - EDGE_OFFSET);

    panelX = clampedLeft;
    panelY = clampedTop;
    panel.style.left = `${clampedLeft}px`;
    panel.style.top = `${clampedTop}px`;
  }

  /**
   * Измеряет размер элемента, не показывая его пользователю.
   *
   * @param {HTMLElement} element Элемент для измерения.
   * @returns {DOMRect} Размер и положение элемента.
   */
  function measureElement(element) {
    const hidden = element.hidden;
    const previousVisibility = element.style.visibility;
    const previousPointerEvents = element.style.pointerEvents;

    if (hidden) {
      element.hidden = false;
      element.style.visibility = "hidden";
      element.style.pointerEvents = "none";
    }

    const rect = element.getBoundingClientRect();

    if (hidden) {
      element.hidden = true;
      element.style.visibility = previousVisibility;
      element.style.pointerEvents = previousPointerEvents;
    }

    return rect;
  }

  /**
   * Скрывает кнопку и окно перевода.
   */
  function hideTransThisUi() {
    ++requestId;
    window.clearTimeout(selectionTimer);
    hideTranslateButton();
    hidePanel();
  }

  /**
   * Скрывает кнопку перевода.
   */
  function hideTranslateButton() {
    if (translateButton) {
      translateButton.hidden = true;
    }
  }

  /**
   * Скрывает окно перевода и завершает перетаскивание.
   */
  function hidePanel() {
    if (!panel) {
      return;
    }

    panel.hidden = true;
    panel.classList.remove("is-dragging");
    panelPointerId = null;
  }

  /**
   * Отмечает короткий интервал, в котором изменение выделения
   * из-за взаимодействия с UI не обрабатывается.
   */
  function markUiInteraction() {
    ignoreSelectionChangeUntil = Date.now() + 500;
  }

  /**
   * Проверяет, относится ли целевой узел события к элементам расширения.
   *
   * @param {EventTarget|null} target Цель события.
   * @returns {boolean} Признак попадания в элементы расширения.
   */
  function isTransThisElement(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(target.closest(`#${BUTTON_ID}, #${PANEL_ID}`));
  }

  /**
   * Считывает текущее выделение страницы вместе с диапазоном и прямоугольником.
   *
   * @returns {{text: string, rect: DOMRect, range: Range}|null} Состояние видимого выделения.
   */
  function readCurrentSelection() {
    const selection = window.getSelection();
    const text = normalizeSelectedText(selection ? selection.toString() : "");

    if (!selection || selection.rangeCount === 0 || !text || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    const rect = getSelectionRect(range);

    if (!rect) {
      return null;
    }

    return { text, rect, range };
  }

  /**
   * Возвращает видимый прямоугольник диапазона выделения.
   *
   * @param {Range} range Диапазон выделения.
   * @returns {DOMRect|null} Прямоугольник выделения.
   */
  function getSelectionRect(range) {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);

    if (rects.length) {
      return rects[rects.length - 1];
    }

    const rect = range.getBoundingClientRect();

    if (rect.width || rect.height) {
      return rect;
    }

    return null;
  }

  /**
   * Нормализует текст выделения для UI и запроса перевода.
   *
   * @param {string} text Выделенный текст.
   * @returns {string} Текст с нормализованными пробелами.
   */
  function normalizeSelectedText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Возвращает признак одиночного слова в текущем выделении.
   *
   * @param {string} text Выделенный текст.
   * @returns {boolean} Признак одиночного слова.
   */
  function isSingleWord(text) {
    return normalizeSelectedText(text).split(" ").length === 1;
  }

  /**
   * Возвращает поддерживаемый язык исходного текста.
   *
   * @param {string} language Код языка.
   * @returns {string} Поддерживаемый код языка.
   */
  function normalizeSourceLanguage(language) {
    const normalizedLanguage = String(language || "").trim();

    if (LANGUAGE_LABELS.has(normalizedLanguage)) {
      return normalizedLanguage;
    }

    return DEFAULT_SOURCE_LANGUAGE;
  }

  /**
   * Возвращает поддерживаемый язык перевода.
   *
   * @param {string} language Код языка.
   * @returns {string} Поддерживаемый код языка.
   */
  function normalizeTargetLanguage(language) {
    const normalizedLanguage = String(language || "").trim();

    if (LANGUAGE_LABELS.has(normalizedLanguage) && normalizedLanguage !== "auto") {
      return normalizedLanguage;
    }

    return DEFAULT_TARGET_LANGUAGE;
  }

  /**
   * Возвращает признак валидности контекста расширения для вызова API.
   *
   * @returns {boolean} Признак доступности runtime API.
   */
  function isExtensionContextValid() {
    if (!extensionContextAvailable) {
      return false;
    }

    try {
      return Boolean(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch (error) {
      extensionContextAvailable = false;
      return false;
    }
  }

  /**
   * Возвращает сообщение из chrome.runtime.lastError.
   *
   * @returns {string} Сообщение об ошибке runtime API.
   */
  function getRuntimeLastErrorMessage() {
    try {
      return chrome.runtime.lastError ? chrome.runtime.lastError.message || "Не удалось выполнить перевод." : "";
    } catch (error) {
      handleExtensionApiError(error);
      return EXTENSION_CONTEXT_MESSAGE;
    }
  }

  /**
   * Обрабатывает сообщение runtime API и переводит потерю контекста
   * в стабильное сообщение для UI.
   *
   * @param {string} message Сообщение runtime API.
   */
  function handleRuntimeErrorMessage(message) {
    if (isExtensionContextError(message)) {
      handleInvalidatedExtensionContext();
      return;
    }

    renderError(message || "Не удалось выполнить перевод.");
  }

  /**
   * Обрабатывает ошибки Chrome extension API.
   *
   * @param {unknown} error Ошибка extension API.
   * @returns {boolean} Признак ошибки потери контекста.
   */
  function handleExtensionApiError(error) {
    if (!isExtensionContextError(error)) {
      return false;
    }

    handleInvalidatedExtensionContext();
    return true;
  }

  /**
   * Отключает текущий экземпляр content script после потери контекста
   * и показывает подсказку перезагрузить страницу.
   */
  function handleInvalidatedExtensionContext() {
    extensionContextAvailable = false;
    ++requestId;
    window.clearTimeout(selectionTimer);
    hideTranslateButton();

    if (panel && !panel.hidden) {
      renderError(EXTENSION_CONTEXT_MESSAGE);
      return;
    }

    hidePanel();
  }

  /**
   * Проверяет, описывает ли ошибка потерю контекста расширения.
   *
   * @param {unknown} error Ошибка или её текст.
   * @returns {boolean} Признак потери контекста расширения.
   */
  function isExtensionContextError(error) {
    const message = error instanceof Error
      ? error.message
      : String(error || "");

    return message.includes("Extension context invalidated")
      || message.includes("context invalidated")
      || message.includes("Extension context was invalidated");
  }

  /**
   * Ограничивает число минимальным и максимальным значениями.
   *
   * @param {number} value Значение.
   * @param {number} min Минимум.
   * @param {number} max Максимум.
   * @returns {number} Ограниченное значение.
   */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  /**
   * Возвращает признак необходимости подавлять нативный перевод Google.
   *
   * @returns {boolean} Признак включения подавления.
   */
  function shouldSuppressGoogleNativeTranslate() {
    return GOOGLE_HOST_PATTERN.test(location.hostname);
  }

  /**
   * Подключает стили, перехват событий и наблюдатель для нативного интерфейса перевода Google.
   */
  function installGoogleTranslateSuppression() {
    const currentStyle = document.getElementById(GOOGLE_TRANSLATE_STYLE_ID);

    if (currentStyle) {
      currentStyle.remove();
    }

    googleTranslateStyleElement = document.createElement("style");
    googleTranslateStyleElement.id = GOOGLE_TRANSLATE_STYLE_ID;
    googleTranslateStyleElement.textContent = createGoogleTranslateSuppressionStyles();
    document.documentElement.appendChild(googleTranslateStyleElement);

    hideGoogleNativeTranslateNodes(document.documentElement);

    googleTranslateObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            hideGoogleNativeTranslateNodes(node);
          }
        }
      }
    });

    googleTranslateObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    addListener(document, "pointerdown", interceptGoogleNativeTranslate, true);
    addListener(document, "click", interceptGoogleNativeTranslate, true);
  }

  /**
   * Формирует CSS для скрытия нативных узлов перевода Google.
   *
   * @returns {string} CSS для скрытия интерфейса перевода Google.
   */
  function createGoogleTranslateSuppressionStyles() {
    const selectors = GOOGLE_NATIVE_TRANSLATE_SELECTORS.join(",\n");

    return `
      ${selectors} {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
  }

  /**
   * Скрывает нативные узлы перевода Google внутри переданного корня.
   *
   * @param {ParentNode} root Корневой узел для поиска элементов.
   */
  function hideGoogleNativeTranslateNodes(root) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return;
    }

    for (const selector of GOOGLE_NATIVE_TRANSLATE_SELECTORS) {
      const nodes = root.querySelectorAll(selector);

      for (const node of nodes) {
        if (node instanceof HTMLElement) {
          hideGoogleNativeTranslateNode(node);
        }
      }
    }

    if (root instanceof HTMLElement && isGoogleNativeTranslateNode(root)) {
      hideGoogleNativeTranslateNode(root);
    }
  }

  /**
   * Применяет скрытие к конкретному нативному элементу перевода Google.
   *
   * @param {HTMLElement} node Нативный узел перевода Google.
   */
  function hideGoogleNativeTranslateNode(node) {
    node.style.setProperty("display", "none", "important");
    node.style.setProperty("visibility", "hidden", "important");
    node.style.setProperty("opacity", "0", "important");
    node.style.setProperty("pointer-events", "none", "important");
    node.setAttribute("aria-hidden", "true");
  }

  /**
   * Перехватывает клики и pointer-события по нативным элементам перевода Google.
   *
   * @param {Event} event Событие страницы.
   */
  function interceptGoogleNativeTranslate(event) {
    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    const nativeTranslateTarget = target.closest(GOOGLE_NATIVE_TRANSLATE_SELECTORS.join(","));

    if (!nativeTranslateTarget) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  /**
   * Проверяет принадлежность узла к нативному интерфейсу перевода Google.
   *
   * @param {HTMLElement} node Узел страницы.
   * @returns {boolean} Признак принадлежности к интерфейсу перевода Google.
   */
  function isGoogleNativeTranslateNode(node) {
    if (node.matches(GOOGLE_NATIVE_TRANSLATE_SELECTORS.join(","))) {
      return true;
    }

    if (node.tagName === "A") {
      const anchor = /** @type {HTMLAnchorElement} */ (node);
      const text = (anchor.textContent || "").trim().toLowerCase();

      if (anchor.href.includes("translate.google.com/translate")) {
        return true;
      }

      if (text === "перевести эту страницу") {
        return true;
      }
    }

    return false;
  }
})();
