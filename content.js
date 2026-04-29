(() => {
  const MESSAGE_TRANSLATE = "TRANS_THIS_TRANSLATE";
  const STORAGE_TARGET_LANGUAGE = "transThisTargetLanguage";
  const DEFAULT_TARGET_LANGUAGE = "ru";
  const BUTTON_ID = "transthis-translate-button";
  const PANEL_ID = "transthis-panel";
  const CONTROLLER_KEY = "__transThisContentController";
  const EDGE_OFFSET = 12;
  const PANEL_WIDTH = 340;
  const SELECTION_SHOW_DELAY = 80;
  const EXTENSION_CONTEXT_MESSAGE = "Расширение было перезагружено. Обновите страницу и выделите текст снова.";

  const LANGUAGES = [
    ["ru", "Русский"],
    ["en", "English"],
    ["de", "Deutsch"],
    ["fr", "Français"],
    ["es", "Español"],
    ["it", "Italiano"],
    ["pt", "Português"],
    ["uk", "Українська"],
    ["pl", "Polski"],
    ["tr", "Türkçe"],
    ["zh-CN", "中文"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["ar", "العربية"]
  ];

  let selectedText = "";
  let selectedRect = null;
  let targetLanguage = DEFAULT_TARGET_LANGUAGE;
  let requestId = 0;
  let ignoreSelectionChangeUntil = 0;
  let selectionTimer = 0;
  let isPointerSelecting = false;
  let isDestroyed = false;
  let extensionContextAvailable = true;
  let translateButton = null;
  let panel = null;
  let languageSelect = null;
  let panelContent = null;
  let registeredListeners = [];

  destroyPreviousController();
  registerController();
  initializeTransThis();

  /**
   * Starts the content script instance and subscribes it to page events.
   */
  function initializeTransThis() {
    loadTargetLanguage();
    addListener(document, "pointerdown", handleDocumentSelectionStart, true);
    addListener(document, "mousedown", handleDocumentSelectionStart, true);
    addListener(document, "pointerup", handleDocumentSelectionEnd, true);
    addListener(document, "mouseup", handleDocumentSelectionEnd, true);
    addListener(document, "selectionchange", handleSelectionChange);
    addListener(document, "keydown", handleDocumentKeyDown, true);
    addListener(document, "keyup", handleDocumentKeyUp, true);
    addListener(window, "resize", hideTransThisUi, true);
    addListener(window, "scroll", hideTranslateButton, true);
  }

  /**
   * Stops the previous content script instance when the browser injects the script again.
   */
  function destroyPreviousController() {
    const controller = globalThis[CONTROLLER_KEY];

    if (controller && typeof controller.destroy === "function") {
      controller.destroy();
    }
  }

  /**
   * Registers the current content script instance for cleanup by later injections.
   */
  function registerController() {
    globalThis[CONTROLLER_KEY] = {
      destroy: destroyTransThis
    };
  }

  /**
   * Adds a page event listener and stores its wrapped handler for cleanup.
   *
   * @param {EventTarget} target Event target.
   * @param {string} type Event type.
   * @param {EventListener} handler Event handler.
   * @param {boolean|AddEventListenerOptions} [options] Listener options.
   */
  function addListener(target, type, handler, options) {
    const wrappedHandler = wrapEventHandler(handler);

    target.addEventListener(type, wrappedHandler, options);
    registeredListeners.push({ target, type, handler: wrappedHandler, options });
  }

  /**
   * Wraps page event handlers so an invalidated extension context disables the stale instance.
   *
   * @param {EventListener} handler Event handler.
   * @returns {EventListener} Guarded event handler.
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
   * Removes page listeners and injected UI nodes owned by this content script instance.
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

    if (translateButton) {
      translateButton.remove();
      translateButton = null;
    }

    if (panel) {
      panel.remove();
      panel = null;
      languageSelect = null;
      panelContent = null;
    }

    if (globalThis[CONTROLLER_KEY] && globalThis[CONTROLLER_KEY].destroy === destroyTransThis) {
      delete globalThis[CONTROLLER_KEY];
    }
  }

  /**
   * Reads the saved target language from extension storage and applies it to the selector.
   */
  function loadTargetLanguage() {
    if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.local) {
      return;
    }

    try {
      chrome.storage.local.get({ [STORAGE_TARGET_LANGUAGE]: DEFAULT_TARGET_LANGUAGE }, (items) => {
        if (isDestroyed) {
          return;
        }

        const errorMessage = getRuntimeLastErrorMessage();

        if (errorMessage) {
          handleRuntimeErrorMessage(errorMessage);
          return;
        }

        targetLanguage = items[STORAGE_TARGET_LANGUAGE] || DEFAULT_TARGET_LANGUAGE;

        if (languageSelect) {
          languageSelect.value = targetLanguage;
        }
      });
    } catch (error) {
      handleExtensionApiError(error);
    }
  }

  /**
   * Hides the extension UI when a pointer starts outside of it and marks page selection as active.
   *
   * @param {MouseEvent|PointerEvent} event Pointer or mouse down event from the page.
   */
  function handleDocumentSelectionStart(event) {
    if (isTransThisElement(event.target)) {
      markUiInteraction();
      return;
    }

    isPointerSelecting = true;
    hideTransThisUi();
  }

  /**
   * Reads the completed page selection after the pointer is released and shows the translation button.
   *
   * @param {MouseEvent|PointerEvent} event Pointer or mouse up event from the page.
   */
  function handleDocumentSelectionEnd(event) {
    if (isTransThisElement(event.target)) {
      return;
    }

    isPointerSelecting = false;
    queueSelectionInspection();
  }

  /**
   * Hides the extension UI when the page selection becomes empty and inspects completed selections.
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

      if (!isPointerSelecting) {
        queueSelectionInspection();
      }
    }, 0);
  }

  /**
   * Closes the extension UI with Escape.
   *
   * @param {KeyboardEvent} event Key down event from the page.
   */
  function handleDocumentKeyDown(event) {
    if (event.key === "Escape") {
      hideTransThisUi();
    }
  }

  /**
   * Inspects keyboard-based selections after key release.
   *
   * @param {KeyboardEvent} event Key up event from the page.
   */
  function handleDocumentKeyUp(event) {
    if (event.key !== "Escape") {
      isPointerSelecting = false;
      queueSelectionInspection();
    }
  }

  /**
   * Schedules selection reading after Chromium browsers finish updating the Selection object.
   */
  function queueSelectionInspection() {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(inspectSelection, SELECTION_SHOW_DELAY);
  }

  /**
   * Shows the translate button for a visible selected text range and hides the UI otherwise.
   */
  function inspectSelection() {
    if (isDestroyed || Date.now() < ignoreSelectionChangeUntil) {
      return;
    }

    const selectionState = readCurrentSelection();

    if (!selectionState) {
      hideTransThisUi();
      return;
    }

    selectedText = selectionState.text;
    selectedRect = selectionState.rect;
    showTranslateButton(selectionState.rect);
  }

  /**
   * Creates and positions the icon-only translation button near the current selection.
   *
   * @param {DOMRect} rect Selection rectangle in viewport coordinates.
   */
  function showTranslateButton(rect) {
    hidePanel();

    if (!translateButton) {
      translateButton = document.createElement("button");
      translateButton.id = BUTTON_ID;
      translateButton.className = "transthis-translate-button";
      translateButton.type = "button";
      translateButton.setAttribute("aria-label", "Перевести выделенный текст");
      translateButton.innerHTML = getTranslateIconSvg();
      translateButton.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        markUiInteraction();
      });
      translateButton.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        markUiInteraction();
      });
      translateButton.addEventListener("click", handleTranslateButtonClick);
      document.documentElement.appendChild(translateButton);
    }

    const left = clamp(rect.right + 8, EDGE_OFFSET, window.innerWidth - 44 - EDGE_OFFSET);
    const top = clamp(rect.bottom + 8, EDGE_OFFSET, window.innerHeight - 44 - EDGE_OFFSET);

    translateButton.style.left = `${left}px`;
    translateButton.style.top = `${top}px`;
    translateButton.hidden = false;
  }

  /**
   * Opens the translation panel and starts translation for the current selected text.
   *
   * @param {MouseEvent} event Button click event.
   */
  function handleTranslateButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    markUiInteraction();
    hideTranslateButton();

    if (!selectedText || !selectedRect) {
      return;
    }

    showPanel(selectedRect);
    requestTranslation();
  }

  /**
   * Creates the draggable translation panel and positions it near the selected text.
   *
   * @param {DOMRect} rect Selection rectangle in viewport coordinates.
   */
  function showPanel(rect) {
    if (!panel) {
      panel = buildPanel();
      document.documentElement.appendChild(panel);
    }

    panel.hidden = false;
    languageSelect.value = targetLanguage;
    setPanelState("loading");

    const left = clamp(rect.left, EDGE_OFFSET, window.innerWidth - PANEL_WIDTH - EDGE_OFFSET);
    const top = clamp(rect.bottom + 10, EDGE_OFFSET, window.innerHeight - 160 - EDGE_OFFSET);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  /**
   * Builds the panel DOM with a draggable header, language selector, and translation content area.
   *
   * @returns {HTMLDivElement} Translation panel element.
   */
  function buildPanel() {
    const root = document.createElement("div");
    root.id = PANEL_ID;
    root.className = "transthis-panel";
    root.addEventListener("mousedown", (event) => {
      markUiInteraction();
      event.stopPropagation();
    });

    const header = document.createElement("div");
    header.className = "transthis-panel__header";
    header.addEventListener("pointerdown", startPanelDrag);

    const title = document.createElement("div");
    title.className = "transthis-panel__title";
    title.textContent = "TransThis";

    const closeButton = document.createElement("button");
    closeButton.className = "transthis-panel__close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Закрыть перевод");
    closeButton.innerHTML = getCloseIconSvg();
    closeButton.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideTransThisUi();
    });

    header.append(title, closeButton);

    const controls = document.createElement("div");
    controls.className = "transthis-panel__controls";

    const directionLabel = document.createElement("span");
    directionLabel.className = "transthis-panel__direction";
    directionLabel.textContent = "Авто →";

    languageSelect = document.createElement("select");
    languageSelect.className = "transthis-panel__select";
    languageSelect.setAttribute("aria-label", "Язык перевода");
    languageSelect.addEventListener("mousedown", markUiInteraction);
    languageSelect.addEventListener("change", handleLanguageChange);

    for (const [value, label] of LANGUAGES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      languageSelect.appendChild(option);
    }

    controls.append(directionLabel, languageSelect);

    panelContent = document.createElement("div");
    panelContent.className = "transthis-panel__content";

    root.append(header, controls, panelContent);

    return root;
  }

  /**
   * Stores the selected target language and refreshes the visible translation.
   */
  function handleLanguageChange() {
    targetLanguage = languageSelect.value || DEFAULT_TARGET_LANGUAGE;
    saveTargetLanguage();

    if (panel && !panel.hidden && selectedText) {
      setPanelState("loading");
      requestTranslation();
    }
  }

  /**
   * Saves the target language in extension storage when the runtime context is available.
   */
  function saveTargetLanguage() {
    if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.local) {
      return;
    }

    try {
      chrome.storage.local.set({ [STORAGE_TARGET_LANGUAGE]: targetLanguage }, () => {
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
   * Sends the selected text to the background service worker and renders the response.
   */
  function requestTranslation() {
    const currentRequestId = ++requestId;
    const currentText = selectedText;
    const currentLanguage = targetLanguage;

    if (!isExtensionContextValid()) {
      renderError(EXTENSION_CONTEXT_MESSAGE);
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: MESSAGE_TRANSLATE,
        text: currentText,
        targetLanguage: currentLanguage
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

        renderTranslation(response.result, isSingleWord(currentText));
      });
    } catch (error) {
      if (!handleExtensionApiError(error)) {
        renderError(error instanceof Error ? error.message : "Не удалось выполнить перевод.");
      }
    }
  }

  /**
   * Renders a loading state in the panel content area.
   *
   * @param {"loading"} state Panel state.
   */
  function setPanelState(state) {
    if (state === "loading") {
      panelContent.innerHTML = "";

      const loader = document.createElement("div");
      loader.className = "transthis-panel__loader";
      loader.textContent = "Переводим…";
      panelContent.appendChild(loader);
    }
  }

  /**
   * Renders the translation result and dictionary meanings for a single selected word.
   *
   * @param {{translation: string, sourceLanguage: string, dictionary: Array<{partOfSpeech: string, terms: string[], entries: Array<{word: string, reverseTranslations: string[]}>}>}} result Translation result from the background service worker.
   * @param {boolean} showDictionary Whether dictionary groups should be rendered.
   */
  function renderTranslation(result, showDictionary) {
    panelContent.innerHTML = "";

    const translation = document.createElement("div");
    translation.className = "transthis-panel__translation";
    translation.textContent = result.translation;
    panelContent.appendChild(translation);

    if (!showDictionary || !Array.isArray(result.dictionary) || result.dictionary.length === 0) {
      return;
    }

    const dictionary = document.createElement("div");
    dictionary.className = "transthis-panel__dictionary";

    for (const group of result.dictionary) {
      const section = document.createElement("section");
      section.className = "transthis-panel__dictionary-group";

      if (group.partOfSpeech) {
        const heading = document.createElement("div");
        heading.className = "transthis-panel__dictionary-heading";
        heading.textContent = group.partOfSpeech;
        section.appendChild(heading);
      }

      const list = document.createElement("ul");
      list.className = "transthis-panel__dictionary-list";

      const words = group.entries.length
        ? group.entries.map((entry) => entry.word)
        : group.terms;

      for (const word of words) {
        const item = document.createElement("li");
        item.textContent = word;
        list.appendChild(item);
      }

      section.appendChild(list);
      dictionary.appendChild(section);
    }

    panelContent.appendChild(dictionary);
  }

  /**
   * Renders an error message in the panel content area.
   *
   * @param {string} message Error message.
   */
  function renderError(message) {
    if (!panelContent) {
      return;
    }

    panelContent.innerHTML = "";

    const error = document.createElement("div");
    error.className = "transthis-panel__error";
    error.textContent = message;
    panelContent.appendChild(error);
  }

  /**
   * Starts dragging the translation panel by its header.
   *
   * @param {PointerEvent} event Pointer down event from the header.
   */
  function startPanelDrag(event) {
    if (!panel || event.button !== 0 || event.target.closest(".transthis-panel__close")) {
      return;
    }

    event.preventDefault();
    markUiInteraction();

    const startX = event.clientX;
    const startY = event.clientY;
    const rect = panel.getBoundingClientRect();
    const startLeft = rect.left;
    const startTop = rect.top;

    headerSetPointerCapture(event.currentTarget, event.pointerId);

    const movePanel = (moveEvent) => {
      const nextLeft = clamp(startLeft + moveEvent.clientX - startX, EDGE_OFFSET, window.innerWidth - rect.width - EDGE_OFFSET);
      const nextTop = clamp(startTop + moveEvent.clientY - startY, EDGE_OFFSET, window.innerHeight - rect.height - EDGE_OFFSET);

      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
    };

    const stopDrag = () => {
      document.removeEventListener("pointermove", movePanel, true);
      document.removeEventListener("pointerup", stopDrag, true);
      document.removeEventListener("pointercancel", stopDrag, true);
    };

    document.addEventListener("pointermove", movePanel, true);
    document.addEventListener("pointerup", stopDrag, true);
    document.addEventListener("pointercancel", stopDrag, true);
  }

  /**
   * Captures pointer events for the panel header when the browser supports it.
   *
   * @param {EventTarget} target Header element.
   * @param {number} pointerId Pointer identifier.
   */
  function headerSetPointerCapture(target, pointerId) {
    if (target && typeof target.setPointerCapture === "function") {
      target.setPointerCapture(pointerId);
    }
  }

  /**
   * Hides both the button and translation panel.
   */
  function hideTransThisUi() {
    ++requestId;
    window.clearTimeout(selectionTimer);
    hideTranslateButton();
    hidePanel();
  }

  /**
   * Hides the icon-only translation button.
   */
  function hideTranslateButton() {
    if (translateButton) {
      translateButton.hidden = true;
    }
  }

  /**
   * Hides the translation panel.
   */
  function hidePanel() {
    if (panel) {
      panel.hidden = true;
    }
  }

  /**
   * Marks a short interval in which selection changes caused by panel interaction are ignored.
   */
  function markUiInteraction() {
    ignoreSelectionChangeUntil = Date.now() + 500;
  }

  /**
   * Checks whether an event target belongs to the extension UI.
   *
   * @param {EventTarget|null} target Event target.
   * @returns {boolean} True when the target is inside the extension UI.
   */
  function isTransThisElement(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(target.closest(`#${BUTTON_ID}, #${PANEL_ID}`));
  }

  /**
   * Reads selected page text and its visible rectangle.
   *
   * @returns {{text: string, rect: DOMRect}|null} Visible selection state.
   */
  function readCurrentSelection() {
    const selection = window.getSelection();
    const text = normalizeSelectedText(selection ? selection.toString() : "");

    if (!selection || selection.rangeCount === 0 || !text) {
      return null;
    }

    const rect = getSelectionRect(selection);

    if (!rect) {
      return null;
    }

    return { text, rect };
  }

  /**
   * Returns the visible rectangle for the active selection.
   *
   * @param {Selection} selection Current page selection.
   * @returns {DOMRect|null} Selection rectangle.
   */
  function getSelectionRect(selection) {
    const range = selection.getRangeAt(0).cloneRange();
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
   * Normalizes selected page text for display and translation.
   *
   * @param {string} text Selected text.
   * @returns {string} Text with collapsed whitespace.
   */
  function normalizeSelectedText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Checks whether the selected text contains a single word token.
   *
   * @param {string} text Selected text.
   * @returns {boolean} True for a single selected word.
   */
  function isSingleWord(text) {
    return normalizeSelectedText(text).split(" ").length === 1;
  }

  /**
   * Returns whether Chrome extension APIs belong to the active runtime context.
   *
   * @returns {boolean} True when the content script can call extension APIs.
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
   * Reads chrome.runtime.lastError and converts invalidated-context access into a UI error.
   *
   * @returns {string} Runtime error message or an empty string.
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
   * Handles a runtime error message and renders a stable extension-context message when needed.
   *
   * @param {string} message Runtime error message.
   */
  function handleRuntimeErrorMessage(message) {
    if (isExtensionContextError(message)) {
      handleInvalidatedExtensionContext();
      return;
    }

    renderError(message || "Не удалось выполнить перевод.");
  }

  /**
   * Handles errors thrown by Chrome extension APIs.
   *
   * @param {unknown} error Error thrown from an extension API.
   * @returns {boolean} True when the error belongs to an invalidated extension context.
   */
  function handleExtensionApiError(error) {
    if (!isExtensionContextError(error)) {
      return false;
    }

    handleInvalidatedExtensionContext();
    return true;
  }

  /**
   * Marks the stale content script as detached from extension APIs and shows a reload hint when a panel is open.
   */
  function handleInvalidatedExtensionContext() {
    extensionContextAvailable = false;
    ++requestId;
    window.clearTimeout(selectionTimer);
    hideTranslateButton();

    if (panel && !panel.hidden && panelContent) {
      renderError(EXTENSION_CONTEXT_MESSAGE);
      return;
    }

    hidePanel();
  }

  /**
   * Checks whether a thrown value or message describes an invalidated extension context.
   *
   * @param {unknown} error Error object or message.
   * @returns {boolean} True when the extension runtime context is invalid.
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
   * Clamps a number between minimum and maximum values.
   *
   * @param {number} value Value to clamp.
   * @param {number} min Minimum value.
   * @param {number} max Maximum value.
   * @returns {number} Clamped value.
   */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  /**
   * Returns an inline SVG translate icon without visible text.
   *
   * @returns {string} SVG markup.
   */
  function getTranslateIconSvg() {
    return `
      <svg class="transthis-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 4.75h8.5a3.25 3.25 0 0 1 3.25 3.25v1.7a3.25 3.25 0 0 1-3.25 3.25H9.3l-3.1 2.45a.75.75 0 0 1-1.2-.59v-1.9A3.25 3.25 0 0 1 1.75 9.7V8A3.25 3.25 0 0 1 5 4.75Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
        <path d="M14.5 11.25H19A3.25 3.25 0 0 1 22.25 14.5v1.25A3.25 3.25 0 0 1 19 19h-.1v1.55a.75.75 0 0 1-1.19.61L14.9 19h-3.4a3.24 3.24 0 0 1-3.08-2.22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
        <path d="M7.2 8.75h4.7m-2.35-2.2v4.4m6.25 4.3h2.8m-1.4-1.4v2.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      </svg>
    `;
  }

  /**
   * Returns an inline SVG close icon without visible text.
   *
   * @returns {string} SVG markup.
   */
  function getCloseIconSvg() {
    return `
      <svg class="transthis-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6.75 6.75 17.25 17.25M17.25 6.75 6.75 17.25" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
  }
})();
